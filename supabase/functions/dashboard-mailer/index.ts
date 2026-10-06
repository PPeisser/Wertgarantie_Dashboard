// Wertgarantie Performance Dashboard: Mailversand über dashboard@wgaustria.at.
// Aktionen:
// - "test": verschickt eine einzelne Testmail, um die SMTP-Verbindung zu
//   prüfen (mit x-cron-secret-Header geschützt).
// - "send": generischer Versand (Betreff/Empfänger/HTML, optional Anhang),
//   ebenfalls über x-cron-secret geschützt - Basis für künftige
//   Dashboard-Mailfunktionen (z.B. automatische Reports).
// - "sendPdf": PDF-Versand direkt aus dem Dashboard (Button "Versenden" bei
//   den PDF-Exporten) - Auth über die Nutzer-Session (Authorization-Header),
//   NICHT über x-cron-secret, da jeder eingeloggte Nutzer sein eigenes PDF
//   versenden darf, ohne das Cron-Secret im Browser-Code zu benötigen.
//
// Secrets (Supabase Dashboard -> Project Settings -> Edge Functions ->
// Secrets, Projekt gfyjftwlombhmwirbyse):
//   SMTP_HOST, SMTP_PORT, SMTP_USERNAME, SMTP_PASSWORD,
//   SMTP_FROM_EMAIL, SMTP_FROM_NAME, CRON_SECRET
//
// Bug-Report 06.10.2026 ("Mailversand aus dem Dashboard schlägt fehl"):
// reproduziert über die SQL-Testbrücke - ein Anhang von ca. 1MB ging noch
// durch, ab ca. 3MB stürzte die Function mit "CPU Time exceeded" /
// WORKER_RESOURCE_LIMIT ab (Logs: function_logs zeigte exakt diese Meldung
// zum Zeitpunkt des fehlgeschlagenen PDF-Versands). Ursache: die bisher
// verwendete Bibliothek denomailer@1.6.0 baut den MIME-Body/Anhang
// offenbar CPU-ineffizient zusammen - schon ein paar MB Anhang (ein ganz
// normal großes, mehrseitiges Performance-Dialog-/Auswertungs-PDF mit
// Diagrammen) reichten für den Absturz. Exakt dieselbe Fehlerklasse wie
// beim dashboard-mail-poller-Vorfall vom 28.09.2026 (dort beim Empfangen,
// hier beim Versenden) - denomailer konnte dafür aber nicht wie damals die
// eigene Rohimplementierung einfach ersetzen, da es dort schon einer war.
// Fix: eigener, schlanker SMTP-Client direkt über Deno.connectTls/
// Deno.startTls (kein Umweg über eine Bibliothek, die den Anhang intern
// nochmal anfasst) - der Base64-Anhang wird nur EINMAL mit einer billigen
// Array-Join-Schleife in 76-Zeichen-Zeilen umbrochen (RFC 2045), nicht
// nochmal dekodiert oder sonst transformiert. HTML-Body ebenfalls als
// Base64-Teil (MIME multipart/mixed) - vermeidet dadurch zusätzlich jedes
// SMTP-"Dot-Stuffing"-Risiko (Base64-Alphabet enthält nie eine Zeile, die
// mit "." beginnt). Verifiziert per SQL-Testbrücke mit synthetischen
// Anhängen bis 8MB (deutlich über jeder realistischen PDF-Größe aus
// diesem Dashboard) - keine Abstürze mehr.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

interface Attachment {
  filename: string;
  content: string; // bereits Base64-kodiert
  contentType?: string;
}

// RFC 2045: Base64-Zeilen max. 76 Zeichen. Array-Push+Join statt Regex/
// Zeichen-für-Zeichen-Konkatenation - bei mehreren MB Anhang ist das der
// entscheidende Unterschied zwischen Millisekunden und einem CPU-Zeit-
// Absturz (siehe Bug-Report oben).
function wrapBase64(b64: string): string {
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
  return lines.join("\r\n");
}

function b64Encode(s: string): string {
  return btoa(s);
}

// Minimaler, eigenständiger SMTP-Client (EHLO/STARTTLS/AUTH LOGIN/MAIL/
// RCPT/DATA/QUIT) - bewusst OHNE externe Mail-Bibliothek, siehe Bug-Report
// oben. Unterstützt Port 465 (implizites TLS) und 587/sonstige (STARTTLS).
async function sendSmtpMail(opts: {
  to: string; subject: string; html: string; attachments?: Attachment[];
}) {
  const host = Deno.env.get("SMTP_HOST")!;
  const port = parseInt(Deno.env.get("SMTP_PORT") || "587", 10);
  const username = Deno.env.get("SMTP_USERNAME")!;
  const password = Deno.env.get("SMTP_PASSWORD")!;
  const fromEmail = Deno.env.get("SMTP_FROM_EMAIL")!;
  const fromName = Deno.env.get("SMTP_FROM_NAME") || "Wertgarantie Dashboard";

  let conn: Deno.Conn = port === 465
    ? await Deno.connectTls({ hostname: host, port })
    : await Deno.connect({ hostname: host, port });

  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let buf = new Uint8Array(0);

  async function fill() {
    const chunk = new Uint8Array(4096);
    const n = await conn.read(chunk);
    if (n === null) throw new Error("SMTP-Verbindung unerwartet geschlossen");
    const merged = new Uint8Array(buf.length + n);
    merged.set(buf); merged.set(chunk.subarray(0, n), buf.length);
    buf = merged;
  }
  // SMTP-Steuerzeilen sind winzig (kein CPU-Risiko wie beim Anhang) - die
  // einfache fill()-Variante reicht hier aus.
  async function readLine(): Promise<string> {
    for (;;) {
      for (let i = 0; i < buf.length - 1; i++) {
        if (buf[i] === 13 && buf[i + 1] === 10) {
          const line = dec.decode(buf.subarray(0, i));
          buf = buf.slice(i + 2);
          return line;
        }
      }
      await fill();
    }
  }
  // Eine SMTP-Antwort kann mehrzeilig sein ("250-..." je Zwischenzeile,
  // "250 ..." markiert die letzte Zeile). Gibt die letzte Zeile zurück.
  async function readResponse(): Promise<string> {
    let last = "";
    for (;;) {
      last = await readLine();
      if (last.length < 4 || last[3] !== "-") return last;
    }
  }
  function expect(line: string, codes: string[]) {
    if (!codes.some((c) => line.startsWith(c))) {
      throw new Error(`Unerwartete SMTP-Antwort (erwartet ${codes.join("/")}) : ${line}`);
    }
  }
  async function send(s: string) {
    const data = enc.encode(s);
    let written = 0;
    while (written < data.length) written += await conn.write(data.subarray(written));
  }
  async function sendCmd(cmd: string, expectCodes: string[]): Promise<string> {
    await send(cmd + "\r\n");
    const resp = await readResponse();
    expect(resp, expectCodes);
    return resp;
  }

  try {
    expect(await readResponse(), ["220"]);
    await sendCmd(`EHLO ${host}`, ["250"]);

    if (port !== 465) {
      await sendCmd("STARTTLS", ["220"]);
      conn = await Deno.startTls(conn as Deno.TcpConn, { hostname: host });
      // Nach STARTTLS ist der alte Lesepuffer ungültig (gehörte zur
      // Klartext-Verbindung) - zurücksetzen, dann erneut EHLO (RFC 3207).
      buf = new Uint8Array(0);
      await sendCmd(`EHLO ${host}`, ["250"]);
    }

    await sendCmd("AUTH LOGIN", ["334"]);
    await sendCmd(b64Encode(username), ["334"]);
    await sendCmd(b64Encode(password), ["235"]);

    await sendCmd(`MAIL FROM:<${fromEmail}>`, ["250"]);
    await sendCmd(`RCPT TO:<${opts.to}>`, ["250"]);
    await sendCmd("DATA", ["354"]);

    const boundary = "wgdash-" + crypto.randomUUID();
    const headers =
      `From: ${fromName} <${fromEmail}>\r\n` +
      `To: ${opts.to}\r\n` +
      `Subject: ${opts.subject}\r\n` +
      `MIME-Version: 1.0\r\n` +
      `Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n`;

    const htmlPart =
      `--${boundary}\r\n` +
      `Content-Type: text/html; charset=UTF-8\r\n` +
      `Content-Transfer-Encoding: base64\r\n\r\n` +
      wrapBase64(b64Encode(unescape(encodeURIComponent(opts.html)))) + "\r\n\r\n";

    const attachmentParts = (opts.attachments || []).map((a) =>
      `--${boundary}\r\n` +
      `Content-Type: ${a.contentType || "application/octet-stream"}; name="${a.filename}"\r\n` +
      `Content-Transfer-Encoding: base64\r\n` +
      `Content-Disposition: attachment; filename="${a.filename}"\r\n\r\n` +
      wrapBase64(a.content) + "\r\n\r\n",
    ).join("");

    const closing = `--${boundary}--\r\n`;

    await send(headers + htmlPart + attachmentParts + closing + ".\r\n");
    expect(await readResponse(), ["250"]);

    await send("QUIT\r\n").catch(() => {});
  } finally {
    try { conn.close(); } catch { /* Verbindung ist ohnehin am Ende */ }
  }
}

async function sendMail(subject: string, to: string, html: string, attachments?: Attachment[]) {
  await sendSmtpMail({ to, subject, html, attachments });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Ungültiger Body" }, 400); }

  if (body.type === "sendPdf") {
    // Auth über die normale Nutzer-Session, nicht über x-cron-secret - jeder
    // eingeloggte Nutzer darf ein PDF (an sich selbst oder eine andere
    // Adresse) versenden.
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "Fehlender Authorization-Header" }, 401);
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data: { user }, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !user) return json({ error: "Ungültige Session" }, 401);

    const to = String(body.to || "");
    const subject = String(body.subject || "");
    const html = String(body.html || "");
    const attachmentBase64 = String(body.attachmentBase64 || "");
    const attachmentFilename = String(body.attachmentFilename || "Dashboard.pdf");
    if (!to || !subject || !html || !attachmentBase64) {
      return json({ error: "to, subject, html, attachmentBase64 erforderlich" }, 400);
    }
    try {
      await sendMail(subject, to, html, [{
        filename: attachmentFilename.replace(/"/g, ""),
        content: attachmentBase64,
        contentType: "application/pdf",
      }]);
      return json({ ok: true });
    } catch (e) {
      return json({ error: "Mailversand fehlgeschlagen: " + String(e) }, 500);
    }
  }

  const secret = req.headers.get("x-cron-secret") || "";
  if (!secret || secret !== Deno.env.get("CRON_SECRET")) {
    return json({ error: "Nicht autorisiert" }, 401);
  }

  if (body.type === "test") {
    const to = String(body.to || "");
    if (!to) return json({ error: "to erforderlich" }, 400);
    try {
      await sendMail(
        "Wertgarantie Dashboard – SMTP-Test",
        to,
        `<div style="font-family:'Segoe UI',Arial,sans-serif;color:#10202C"><p>Diese Testmail bestätigt, dass die SMTP-Verbindung des Dashboard-Projekts funktioniert.</p><p>Gesendet: ${new Date().toLocaleString("de-AT")}</p></div>`,
      );
      return json({ ok: true });
    } catch (e) {
      return json({ error: "SMTP-Test fehlgeschlagen: " + String(e) }, 500);
    }
  }

  if (body.type === "send") {
    const to = String(body.to || "");
    const subject = String(body.subject || "");
    const html = String(body.html || "");
    if (!to || !subject || !html) return json({ error: "to, subject, html erforderlich" }, 400);
    const attachmentBase64 = String(body.attachmentBase64 || "");
    const attachments = attachmentBase64 ? [{
      filename: String(body.attachmentFilename || "Anhang.pdf").replace(/"/g, ""),
      content: attachmentBase64,
      contentType: String(body.attachmentContentType || "application/pdf"),
    }] : undefined;
    try {
      await sendMail(subject, to, html, attachments);
      return json({ ok: true });
    } catch (e) {
      return json({ error: "Mailversand fehlgeschlagen: " + String(e) }, 500);
    }
  }

  return json({ error: "Unbekannter type" }, 400);
});
