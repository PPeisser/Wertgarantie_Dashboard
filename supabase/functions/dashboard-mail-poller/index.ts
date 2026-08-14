// Automatischer Excel-Mail-Import (input@wgaustria.at).
// Läuft periodisch (pg_cron, siehe Migration) und macht bewusst NICHT das
// Parsen der Excel-Datei selbst - das übernimmt weiterhin der bereits
// vorhandene, ausführlich getestete clientseitige Parser (parseAuswertung in
// index.html), sobald ein Nutzer die Seite öffnet/aktualisiert
// (processPendingImports). Diese Function ist nur der "Briefträger":
// - verbindet sich per IMAP mit dem Postfach input@wgaustria.at (über die
//   npm-Bibliothek imapflow für Verbindung/Suche/bodyStructure - das
//   funktioniert zuverlässig)
// - findet Excel-Anhänge über die bodyStructure und holt NUR diesen MIME-
//   Teil über eine eigene, minimale IMAP-Rohimplementierung (rawFetchLiteral,
//   direkt über Deno.connectTls) ab. Grund: sowohl fetchOne({source:true})
//   als auch client.download() (Stream) UND fetchOne({bodyParts:[...]})
//   (gepuffert) sind bei echten Testläufen am 14.08.2026 beim eigentlichen
//   Byte-Transfer der Literal-Daten hängen geblieben - offenbar eine
//   Inkompatibilität zwischen imapflows Socket-Handling und der Deno-
//   Laufzeitumgebung von Supabase Edge Functions.
// - lädt den Anhang in den privaten Storage-Bucket "mail-imports" hoch
// - legt dafür eine Zeile in public.pending_imports an (status "pending")
// - markiert die Mail als gelesen, damit sie nicht doppelt verarbeitet wird
//
// Secrets (Supabase Dashboard -> Project Settings -> Edge Functions ->
// Secrets, Projekt gfyjftwlombhmwirbyse):
//   IMAP_HOST, IMAP_PORT, IMAP_USERNAME, IMAP_PASSWORD, CRON_SECRET

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { ImapFlow } from "npm:imapflow@1";

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

function isExcelAttachment(filename: string | undefined) {
  return !!filename && /\.(xlsx|xls)$/i.test(filename);
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Timeout (${ms}ms) bei: ${label}`)), ms)),
  ]);
}

const log = (...args: unknown[]) => console.log("[dashboard-mail-poller]", ...args);

// deno-lint-ignore no-explicit-any
type BodyPart = any;

// Läuft die (ggf. verschachtelte) bodyStructure einer Mail ab und sammelt
// alle Teile, die wie ein Excel-Anhang aussehen (per Dateiname erkannt -
// entweder als "attachment"-Disposition oder als benanntes Content-Type-
// Parameter, je nachdem wie der sendende Mail-Client den Anhang markiert).
function findExcelParts(node: BodyPart, out: { part: string; filename: string; encoding: string }[] = []) {
  if (!node) return out;
  const filename = node.dispositionParameters?.filename || node.parameters?.name;
  if (filename && isExcelAttachment(filename) && node.part) {
    out.push({ part: node.part, filename, encoding: String(node.encoding || "").toLowerCase() });
  }
  if (node.childNodes) {
    for (const child of node.childNodes) findExcelParts(child, out);
  }
  return out;
}

// BODY[<part>]-Fetches liefern den rohen (noch kodierten) Content-Transfer-
// Encoding-Text des MIME-Teils - bei Anhängen praktisch immer base64, aber
// zur Sicherheit anhand der bodyStructure-Angabe geprüft statt blind
// anzunehmen.
function decodeMimePart(bytes: Uint8Array, encoding: string): Uint8Array {
  if (encoding === "base64") {
    const text = new TextDecoder().decode(bytes).replace(/[\r\n\s]/g, "");
    const bin = atob(text);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return bytes; // 7bit/8bit/binary - bereits Rohbytes
}

// Minimaler, eigenständiger IMAP-Client (nur LOGIN/SELECT/UID FETCH/LOGOUT)
// direkt über Deno.connectTls - bewusst OHNE imapflow, siehe Erklärung oben.
// Holt genau einen MIME-Teil (per BODY.PEEK[part], .PEEK = ohne die Mail
// dabei als gelesen zu markieren) als rohe (noch kodierte) Bytes.
async function rawFetchLiteral(
  host: string, port: number, user: string, pass: string,
  uid: number, part: string,
): Promise<Uint8Array> {
  const conn = await Deno.connectTls({ hostname: host, port });
  let buf = new Uint8Array(0);
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  async function fill() {
    const chunk = new Uint8Array(65536);
    const n = await conn.read(chunk);
    if (n === null) throw new Error("IMAP-Verbindung unerwartet geschlossen");
    const merged = new Uint8Array(buf.length + n);
    merged.set(buf); merged.set(chunk.subarray(0, n), buf.length);
    buf = merged;
  }
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
  async function readExact(n: number): Promise<Uint8Array> {
    while (buf.length < n) await fill();
    const out = buf.slice(0, n);
    buf = buf.slice(n);
    return out;
  }
  async function send(s: string) {
    await conn.write(enc.encode(s + "\r\n"));
  }
  async function waitTagged(tag: string) {
    for (;;) {
      const line = await readLine();
      if (line.startsWith(tag + " ")) {
        if (!/\bOK\b/i.test(line)) throw new Error(`IMAP-Fehler (${tag}): ${line}`);
        return;
      }
    }
  }
  const q = (s: string) => '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';

  try {
    await readLine(); // Server-Greeting
    let t = 0;

    t++; await send(`a${t} LOGIN ${q(user)} ${q(pass)}`); await waitTagged(`a${t}`);
    t++; await send(`a${t} SELECT INBOX`); await waitTagged(`a${t}`);

    t++;
    const fetchTag = `a${t}`;
    await send(`${fetchTag} UID FETCH ${uid} (BODY.PEEK[${part}])`);

    let literal: Uint8Array | null = null;
    for (;;) {
      const line = await readLine();
      if (line.startsWith(fetchTag + " ")) {
        if (!/\bOK\b/i.test(line)) throw new Error(`IMAP-Fehler (${fetchTag}): ${line}`);
        break;
      }
      const m = line.match(/\{(\d+)\}\s*$/);
      if (m) literal = await readExact(parseInt(m[1], 10));
    }
    if (!literal) throw new Error(`Kein Literal in FETCH-Antwort für uid=${uid} part=${part} gefunden`);

    t++; await send(`a${t} LOGOUT`).catch(() => {});
    return literal;
  } finally {
    try { conn.close(); } catch { /* Verbindung ist ohnehin am Ende */ }
  }
}

async function pollMailbox(admin: ReturnType<typeof createClient>) {
  const host = Deno.env.get("IMAP_HOST")!;
  const port = parseInt(Deno.env.get("IMAP_PORT") || "993", 10);
  const user = Deno.env.get("IMAP_USERNAME")!;
  const pass = Deno.env.get("IMAP_PASSWORD")!;

  log("connecting", { host, port, user });
  const client = new ImapFlow({ host, port, secure: true, auth: { user, pass }, logger: false });

  let imported = 0;
  let skipped = 0;
  const errors: string[] = [];

  await withTimeout(client.connect(), 15000, "IMAP connect");
  log("connected");
  try {
    const lock = await withTimeout(client.getMailboxLock("INBOX"), 10000, "getMailboxLock");
    log("mailbox locked");
    try {
      const successUids: number[] = [];
      for await (const msg of client.fetch(
        { seen: false },
        { uid: true, envelope: true, bodyStructure: true },
      )) {
        log("message", msg.uid, { subject: msg.envelope?.subject });
        try {
          const excelParts = findExcelParts(msg.bodyStructure);
          log("excel parts", msg.uid, excelParts);

          if (!excelParts.length) {
            skipped++;
          } else {
            for (const ep of excelParts) {
              const raw = await withTimeout(
                rawFetchLiteral(host, port, user, pass, msg.uid, ep.part),
                25000,
                `rawFetchLiteral uid=${msg.uid} part=${ep.part}`,
              );
              const bytes = decodeMimePart(raw, ep.encoding);
              log("downloaded", ep.filename, { rawBytes: raw.length, decodedBytes: bytes.length, encoding: ep.encoding });

              const path = `pending/${crypto.randomUUID()}-${ep.filename}`;
              const { error: upErr } = await withTimeout(
                admin.storage.from("mail-imports").upload(path, bytes, {
                  contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                  upsert: false,
                }),
                20000,
                `storage upload ${ep.filename}`,
              );
              if (upErr) { errors.push(`Upload ${ep.filename}: ${upErr.message}`); log("upload error", upErr); continue; }

              const { error: insErr } = await withTimeout(
                admin.from("pending_imports").insert({
                  filename: ep.filename,
                  storage_path: path,
                  source_subject: msg.envelope?.subject || null,
                  source_from: msg.envelope?.from?.[0]
                    ? `${msg.envelope.from[0].name || ""} <${msg.envelope.from[0].address}>`.trim()
                    : null,
                }),
                10000,
                `db insert ${ep.filename}`,
              );
              if (insErr) { errors.push(`DB-Insert ${ep.filename}: ${insErr.message}`); log("insert error", insErr); continue; }
              log("inserted pending_imports row for", ep.filename);
              imported++;
            }
          }
          successUids.push(msg.uid);
        } catch (e) {
          log("error processing uid", msg.uid, String(e));
          errors.push(`Mail ${msg.uid}: ${String(e)}`);
        }
      }
      // Nur erfolgreich verarbeitete Mails als gelesen markieren - bei einem
      // Fehler bleibt die Mail ungelesen und wird beim nächsten Durchlauf
      // erneut versucht.
      if (successUids.length) {
        await withTimeout(
          client.messageFlagsAdd({ uid: successUids.join(",") }, ["\\Seen"], { uid: true }),
          10000,
          "messageFlagsAdd",
        );
        log("marked seen", successUids);
      }
    } finally {
      lock.release();
      log("lock released");
    }
  } finally {
    await client.logout().catch((e) => log("logout error (ignored)", String(e)));
    log("logged out");
  }

  return { imported, skipped, errors };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const secret = req.headers.get("x-cron-secret") || "";
  if (!secret || secret !== Deno.env.get("CRON_SECRET")) {
    return json({ error: "Nicht autorisiert" }, 401);
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    const result = await withTimeout(pollMailbox(admin), 55000, "pollMailbox gesamt");
    log("done", result);
    return json({ ok: true, ...result });
  } catch (e) {
    log("fatal", String(e));
    return json({ error: "Mail-Abruf fehlgeschlagen: " + String(e) }, 500);
  }
});
