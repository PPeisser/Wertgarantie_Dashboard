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

// Storage-Keys akzeptieren nicht jedes Zeichen aus einem Original-Dateinamen
// (Bug-Report 10.09.2026: eine Mail "WG: Akquise Detailübersicht 2024-2026
// Stand 2026-08 AT" mit Anhang "26-08_Gehaltsprämie 2026 Neue FH AT.xlsx"
// scheiterte beim Storage-Upload mit "StorageApiError: Invalid key" wegen
// des Umlauts "ä" im Dateinamen - die Mail wurde trotz des Fehlers als
// gelesen markiert (siehe successUids-Fix unten) und ging dadurch komplett
// verloren, ohne je in pending_imports zu landen). Ersetzt für den Storage-
// KEY alles außerhalb von ASCII-Buchstaben/Ziffern/._- durch "_" - der
// ORIGINALE Dateiname bleibt unverändert in pending_imports.filename
// gespeichert (nur für den Objektpfad selbst muss er ASCII-sicher sein).
function sanitizeStorageKeyPart(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "_");
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
// size (node.size, laut RFC 3501 body-fld-octets immer Teil der
// BODYSTRUCTURE, KEIN zusätzlicher Server-Roundtrip nötig) wird mitgenommen,
// damit übergroße Anhänge VOR dem eigentlichen Download aussortiert werden
// können - siehe MAX_EXCEL_ATTACHMENT_BYTES-Kommentar unten.
function findExcelParts(node: BodyPart, out: { part: string; filename: string; encoding: string; size: number }[] = []) {
  if (!node) return out;
  const filename = node.dispositionParameters?.filename || node.parameters?.name;
  if (filename && isExcelAttachment(filename) && node.part) {
    out.push({ part: node.part, filename, encoding: String(node.encoding || "").toLowerCase(), size: Number(node.size) || 0 });
  }
  if (node.childNodes) {
    for (const child of node.childNodes) findExcelParts(child, out);
  }
  return out;
}
// Bug-Report 28.09.2026 ("ständig Mietdateien, aktuelle Tagesauswertung wird
// nicht hochgeladen"): eine Mail vom 25.09.2026 ("WG: Produktion
// mietenstattkaufen (MsK) per 25.09.2026 - AT+DE", UID 45) brachte NEBEN den
// beiden kleinen, längst funktionierenden AT/DE_CW-FH_Produktion.xlsx (~600
// bzw. ~290 KB) noch einen ~15 MB-Anhang "20260925_Reporting_MsK.xlsx" mit
// (Logs: "downloaded 20260925_Reporting_MsK.xlsx" lief jedes Mal an, aber
// KEIN "inserted pending_imports row"/"marked seen"/"done"/"fatal" danach -
// die Function wurde beim Verarbeiten dieses riesigen Anhangs vom Laufzeit-
// Limit hart abgebrochen, nicht mit einer regulären JS-Exception, die das
// bestehende try/catch je Mail hätte auffangen können). Da die Mail dadurch
// NIE als gelesen markiert wurde, holte JEDER Cron-Lauf (alle 15 Min.)
// dieselbe UID 45 erneut komplett von vorne - inkl. der beiden längst
// erfolgreich importierten Miete-Dateien (Symptom 1: "ständig Mietdateien,
// die er aber bereits am Samstag bekommen hat") UND blockierte dabei jeden
// Poll-Durchlauf schon auf dieser einen alten Mail, bevor er je zu einer
// NEUEN, ungelesenen Mail (z.B. der aktuellen Tagesauswertung) kommen konnte
// (Symptom 2). Fix: Anhänge über dem Limit werden anhand der bereits
// vorliegenden BODYSTRUCTURE-Größe (kein Download nötig) übersprungen, BEVOR
// rawFetchLiteral() aufgerufen wird - das verhindert den Absturz. Ein
// übersprungener Anhang zählt NICHT als Fehler (kein messageHadError), damit
// die Mail trotzdem als gelesen markiert wird, sobald ihre anderen Anhänge
// (hier: die beiden Miete-Dateien) erfolgreich verarbeitet wurden - sonst
// bliebe die Mail wegen desselben zu großen Anhangs für immer ungelesen und
// hängen.
//
// Folgefix 28.09.2026 (Nutzervorgabe: "die müssen hochgeladen werden - alle
// Anhänge egal wie groß, die Mietliste hat aktuell schon 16 MB"): die
// ursprüngliche 3 MB-Schwelle war als Business-Limit zu niedrig gewählt und
// hätte reguläre, wachsende Anhänge (Mietliste) mit ausgesperrt. Die
// eigentliche Absturzursache war stattdessen die ineffiziente Byte-Lese-
// und Base64-Decode-Logik (siehe readLiteral()/decodeBase64Bytes() unten,
// jetzt auf O(n) statt O(n²) bzw. ohne JS-String-Zwischenkopien umgebaut) -
// mit diesem Fix sollten auch deutlich größere Anhänge zuverlässig
// durchlaufen. Diese Schwelle ist daher NICHT mehr als Geschäftslimit
// gedacht, sondern nur noch als defensive Notbremse gegen eine wirklich
// pathologische Datei (die sonst den gesamten 15-Minuten-Zyklus dauerhaft
// blockieren könnte) - großzügig über jeder realistischen Mail-
// Anhangsgröße gewählt (die meisten Mailserver deckeln Anhänge ohnehin bei
// 25-50 MB).
const MAX_EXCEL_ATTACHMENT_BYTES = 80 * 1024 * 1024;

// BODY[<part>]-Fetches liefern den rohen (noch kodierten) Content-Transfer-
// Encoding-Text des MIME-Teils - bei Anhängen praktisch immer base64, aber
// zur Sicherheit anhand der bodyStructure-Angabe geprüft statt blind
// anzunehmen.
//
// Bug-Report 28.09.2026, Folgefix (Nutzervorgabe: "alle Anhänge, egal wie
// groß, müssen hochgeladen werden - die Mietliste hat aktuell schon 16 MB"):
// die bisherige Implementierung ging über new TextDecoder().decode(bytes)
// (voller JS-String, wegen UTF-16 ca. doppelt so groß wie die Rohbytes),
// dann .replace() (nochmal eine volle Kopie) und dann atob() (nochmal ein
// voller "Binärstring", ebenfalls UTF-16, also nochmal ~2x). Bei einem
// ~15 MB-base64-Text (≈20 MB Rohbytes) waren dadurch zeitweise mehrere
// Zwischenkopien von zusammen 100+ MB gleichzeitig im Speicher - der
// wahrscheinlichste Grund für den harten (nicht per try/catch fangbaren)
// Laufzeit-Absturz kurz nach dem Decode. decodeBase64Bytes() arbeitet direkt
// auf den Rohbytes (kein JS-String-Umweg) und schreibt in einen einmal
// vorab dimensionierten Ausgabepuffer - Spitzenspeicher liegt dadurch nur
// noch bei ca. 1,3x der Rohbytes-Größe statt einem Vielfachen.
const B64_LOOKUP: Int16Array = (() => {
  const table = new Int16Array(256).fill(-1);
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (let i = 0; i < chars.length; i++) table[chars.charCodeAt(i)] = i;
  return table;
})();

function decodeBase64Bytes(src: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(src.length * 3 / 4));
  let outLen = 0;
  let bits = 0, bitCount = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === 13 || c === 10 || c === 32 || c === 9) continue; // CR/LF/Space/Tab
    if (c === 61) break; // "=" Padding -> Ende der Nutzdaten
    const v = B64_LOOKUP[c];
    if (v < 0) continue; // unbekanntes Zeichen defensiv überspringen
    bits = (bits << 6) | v;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      out[outLen++] = (bits >> bitCount) & 0xff;
    }
  }
  return out.subarray(0, outLen);
}

function decodeMimePart(bytes: Uint8Array, encoding: string): Uint8Array {
  if (encoding === "base64") return decodeBase64Bytes(bytes);
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
  // Für den großen Literal-Payload selbst (der Excel-Anhang, potenziell
  // mehrere MB) bewusst NICHT über ein readExact()-artiges Pattern mit fill(): fill() baut bei
  // JEDEM 64KB-Socket-Read das komplette bisherige Array per new
  // Uint8Array(buf.length+n)+set()+set() neu auf - bei z.B. 15 MB sind das
  // ~230 Durchläufe mit insgesamt mehreren GB an Kopierarbeit (O(n²)) und
  // zeitweise mehrere große Arrays gleichzeitig im Speicher. readLiteral()
  // kennt die Zielgröße vorab (aus dem "{n}"-Literal-Präfix) und schreibt
  // direkt an der richtigen Stelle in einen EINMAL dimensionierten
  // Ausgabepuffer - Spitzenspeicher bleibt dadurch bei ca. 1x n statt einem
  // Vielfachen (Bug-Report 28.09.2026, Folgefix: wahrscheinliche
  // Mitursache des Absturzes bei großen Anhängen).
  async function readLiteral(n: number): Promise<Uint8Array> {
    const out = new Uint8Array(n);
    let filled = 0;
    if (buf.length > 0) {
      const take = Math.min(buf.length, n);
      out.set(buf.subarray(0, take), 0);
      filled = take;
      buf = buf.slice(take);
    }
    while (filled < n) {
      const remaining = n - filled;
      const chunk = new Uint8Array(Math.min(65536, remaining));
      const r = await conn.read(chunk);
      if (r === null) throw new Error("IMAP-Verbindung unerwartet geschlossen");
      out.set(chunk.subarray(0, r), filled);
      filled += r;
    }
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
      if (m) literal = await readLiteral(parseInt(m[1], 10));
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
        // Bug-Report 10.09.2026: früher wurde die Mail am Ende dieses Blocks
        // IMMER als erfolgreich verarbeitet markiert (successUids.push), auch
        // wenn ein einzelner Anhang beim Upload/Insert fehlgeschlagen war (der
        // Fehler landete nur im errors-Array). Dadurch verschwand die Mail
        // dauerhaft aus der ungelesenen Suche ({seen:false}), ohne je in
        // pending_imports zu landen - kein Retry mehr möglich. Jetzt bleibt
        // eine Mail mit einem gescheiterten Anhang ungelesen und wird beim
        // nächsten Cron-Lauf (alle 15 Min.) automatisch erneut versucht.
        let messageHadError = false;
        try {
          const excelParts = findExcelParts(msg.bodyStructure);
          log("excel parts", msg.uid, excelParts);

          if (!excelParts.length) {
            skipped++;
          } else {
            for (const ep of excelParts) {
              // Bug-Report 28.09.2026 (siehe MAX_EXCEL_ATTACHMENT_BYTES oben):
              // übergroße Anhänge NICHT herunterladen (stürzt die Function
              // ab) - bewusst OHNE messageHadError, damit die Mail trotzdem
              // als gelesen gilt, sobald ihre übrigen Anhänge durchlaufen.
              if (ep.size > MAX_EXCEL_ATTACHMENT_BYTES) {
                const msg2 = `Anhang ${ep.filename} übersprungen (${ep.size} Bytes > Limit ${MAX_EXCEL_ATTACHMENT_BYTES}) - zu groß für den automatischen Import, bitte bei Bedarf manuell über das Admin-Panel einspielen.`;
                errors.push(msg2); log("attachment too large", ep.filename, ep.size); skipped++;
                continue;
              }
              // Timeout großzügiger als zuvor (25s -> 90s): mit der jetzt
              // höheren MAX_EXCEL_ATTACHMENT_BYTES-Schwelle müssen auch
              // deutlich größere Dateien über eine ggf. langsame IMAP-
              // Verbindung vollständig durchgeladen werden können.
              const raw = await withTimeout(
                rawFetchLiteral(host, port, user, pass, msg.uid, ep.part),
                90000,
                `rawFetchLiteral uid=${msg.uid} part=${ep.part}`,
              );
              const bytes = decodeMimePart(raw, ep.encoding);
              log("downloaded", ep.filename, { rawBytes: raw.length, decodedBytes: bytes.length, encoding: ep.encoding });

              const path = `pending/${crypto.randomUUID()}-${sanitizeStorageKeyPart(ep.filename)}`;
              const { error: upErr } = await withTimeout(
                admin.storage.from("mail-imports").upload(path, bytes, {
                  contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                  upsert: false,
                }),
                60000,
                `storage upload ${ep.filename}`,
              );
              if (upErr) { errors.push(`Upload ${ep.filename}: ${upErr.message}`); log("upload error", upErr); messageHadError = true; continue; }

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
              if (insErr) { errors.push(`DB-Insert ${ep.filename}: ${insErr.message}`); log("insert error", insErr); messageHadError = true; continue; }
              log("inserted pending_imports row for", ep.filename);
              imported++;
            }
          }
          if (!messageHadError) successUids.push(msg.uid);
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
    // Von 55s auf 120s angehoben (Folgefix 28.09.2026): mit der höheren
    // MAX_EXCEL_ATTACHMENT_BYTES-Schwelle kann ein Durchlauf mit mehreren
    // größeren Anhängen insgesamt länger dauern als zuvor - 120s liegt
    // weiterhin klar unter der 15-Minuten-Taktung des Cron-Jobs.
    const result = await withTimeout(pollMailbox(admin), 120000, "pollMailbox gesamt");
    log("done", result);
    return json({ ok: true, ...result });
  } catch (e) {
    log("fatal", String(e));
    return json({ error: "Mail-Abruf fehlgeschlagen: " + String(e) }, 500);
  }
});
