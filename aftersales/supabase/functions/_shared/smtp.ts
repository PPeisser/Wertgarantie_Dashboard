// Schlanker SMTP-Client fürs After-Sales-Tool (Vorbild: dashboard-mailer im
// Dashboard-Projekt - bewusst ohne externe Mail-Bibliothek). Eine Verbindung
// kann mehrere Mails nacheinander senden (Sammelversand).
//
// Secrets (Supabase → Edge Functions → Secrets): bevorzugt AS_SMTP_HOST,
// AS_SMTP_PORT, AS_SMTP_USERNAME, AS_SMTP_PASSWORD, AS_SMTP_FROM_EMAIL,
// AS_SMTP_FROM_NAME (eigenes Postfach aftersales@...). Fehlen sie, werden die
// bestehenden SMTP_* Secrets des Projekts verwendet.

export type Attachment = { filename: string; content: string; contentType?: string };
export type Mail = {
  to: string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  attachments?: Attachment[];
};

function env(name: string): string | undefined {
  return Deno.env.get("AS_" + name) || Deno.env.get(name) || undefined;
}

export function fromAddress(): string {
  return env("SMTP_FROM_EMAIL") || "";
}

function wrapBase64(b64: string): string {
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
  return lines.join("\r\n");
}
function utf8Base64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
// RFC 2047 für Betreff/Absendername mit Umlauten.
function encodeHeader(s: string): string {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${utf8Base64(s)}?=`;
}
function asciiFilename(s: string): string {
  return s.replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue")
    .replace(/Ä/g, "Ae").replace(/Ö/g, "Oe").replace(/Ü/g, "Ue").replace(/ß/g, "ss")
    .replace(/[^\w.-]+/g, "_");
}
export function htmlToText(html: string): string {
  return html.replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|tr|h\d|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n").trim();
}

export class SmtpSession {
  private conn!: Deno.Conn;
  private buf = new Uint8Array(0);
  private enc = new TextEncoder();
  private dec = new TextDecoder();
  private host = env("SMTP_HOST")!;
  private port = parseInt(env("SMTP_PORT") || "587", 10);

  async open() {
    if (!this.host) throw new Error("SMTP nicht konfiguriert (SMTP_HOST fehlt)");
    this.buf = new Uint8Array(0);
    this.conn = this.port === 465
      ? await Deno.connectTls({ hostname: this.host, port: this.port })
      : await Deno.connect({ hostname: this.host, port: this.port });
    this.expect(await this.readResponse(), ["220"]);
    await this.cmd(`EHLO ${this.host}`, ["250"]);
    if (this.port !== 465) {
      await this.cmd("STARTTLS", ["220"]);
      this.conn = await Deno.startTls(this.conn as Deno.TcpConn, { hostname: this.host });
      this.buf = new Uint8Array(0);
      await this.cmd(`EHLO ${this.host}`, ["250"]);
    }
    await this.cmd("AUTH LOGIN", ["334"]);
    await this.cmd(btoa(env("SMTP_USERNAME")!), ["334"]);
    await this.cmd(btoa(env("SMTP_PASSWORD")!), ["235"]);
  }

  async send(mail: Mail): Promise<string> {
    const fromEmail = env("SMTP_FROM_EMAIL")!;
    const fromName = env("SMTP_FROM_NAME") || "Wertgarantie After-Sales";
    const rcpts = [...new Set(mail.to.map((t) => t.trim()).filter(Boolean))];
    if (!rcpts.length) throw new Error("Kein Empfänger");
    await this.cmd(`MAIL FROM:<${fromEmail}>`, ["250"]);
    for (const r of rcpts) await this.cmd(`RCPT TO:<${r}>`, ["250", "251"]);
    await this.cmd("DATA", ["354"]);

    const domain = fromEmail.split("@")[1] || "localhost";
    const messageId = `<${crypto.randomUUID()}@${domain}>`;
    const mixed = "wgas-m-" + crypto.randomUUID();
    const alt = "wgas-a-" + crypto.randomUUID();
    let msg =
      `From: ${encodeHeader(fromName)} <${fromEmail}>\r\n` +
      `To: ${rcpts.join(", ")}\r\n` +
      (mail.replyTo ? `Reply-To: ${mail.replyTo}\r\n` : "") +
      `Subject: ${encodeHeader(mail.subject)}\r\n` +
      `Date: ${new Date().toUTCString().replace("GMT", "+0000")}\r\n` +
      `Message-ID: ${messageId}\r\n` +
      `MIME-Version: 1.0\r\n` +
      `Content-Type: multipart/mixed; boundary="${mixed}"\r\n\r\n` +
      `--${mixed}\r\n` +
      `Content-Type: multipart/alternative; boundary="${alt}"\r\n\r\n` +
      `--${alt}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n` +
      wrapBase64(utf8Base64(mail.text || htmlToText(mail.html))) + "\r\n" +
      `--${alt}\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n` +
      wrapBase64(utf8Base64(mail.html)) + "\r\n" +
      `--${alt}--\r\n`;
    for (const a of mail.attachments || []) {
      const fn = asciiFilename(a.filename);
      msg += `--${mixed}\r\n` +
        `Content-Type: ${a.contentType || "application/octet-stream"}; name="${fn}"\r\n` +
        `Content-Transfer-Encoding: base64\r\n` +
        `Content-Disposition: attachment; filename="${fn}"\r\n\r\n` +
        wrapBase64(a.content) + "\r\n";
    }
    msg += `--${mixed}--\r\n.\r\n`;
    await this.write(msg);
    this.expect(await this.readResponse(), ["250"]);
    return messageId;
  }

  async close() {
    try { await this.write("QUIT\r\n"); } catch { /* egal */ }
    try { this.conn.close(); } catch { /* egal */ }
  }

  // ---- intern ----
  private async fill() {
    const chunk = new Uint8Array(4096);
    const n = await this.conn.read(chunk);
    if (n === null) throw new Error("SMTP-Verbindung unerwartet geschlossen");
    const merged = new Uint8Array(this.buf.length + n);
    merged.set(this.buf); merged.set(chunk.subarray(0, n), this.buf.length);
    this.buf = merged;
  }
  private async readLine(): Promise<string> {
    for (;;) {
      for (let i = 0; i < this.buf.length - 1; i++) {
        if (this.buf[i] === 13 && this.buf[i + 1] === 10) {
          const line = this.dec.decode(this.buf.subarray(0, i));
          this.buf = this.buf.slice(i + 2);
          return line;
        }
      }
      await this.fill();
    }
  }
  private async readResponse(): Promise<string> {
    for (;;) {
      const line = await this.readLine();
      if (line.length < 4 || line[3] !== "-") return line;
    }
  }
  private expect(line: string, codes: string[]) {
    if (!codes.some((c) => line.startsWith(c))) throw new Error(`SMTP-Fehler: ${line}`);
  }
  private async write(s: string) {
    const data = this.enc.encode(s);
    let w = 0;
    while (w < data.length) w += await this.conn.write(data.subarray(w));
  }
  private async cmd(c: string, codes: string[]) {
    await this.write(c + "\r\n");
    const r = await this.readResponse();
    this.expect(r, codes);
    return r;
  }
}

export async function sendOne(mail: Mail): Promise<string> {
  const s = new SmtpSession();
  try {
    await s.open();
    return await s.send(mail);
  } finally {
    await s.close();
  }
}
