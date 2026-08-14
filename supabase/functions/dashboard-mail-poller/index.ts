// Automatischer Excel-Mail-Import (input@wgaustria.at).
// Läuft periodisch (pg_cron, siehe Migration) und macht bewusst NICHT das
// Parsen der Excel-Datei selbst - das übernimmt weiterhin der bereits
// vorhandene, ausführlich getestete clientseitige Parser (parseAuswertung in
// index.html), sobald ein Nutzer die Seite öffnet/aktualisiert
// (processPendingImports). Diese Function ist nur der "Briefträger":
// - verbindet sich per IMAP mit dem Postfach input@wgaustria.at
// - sucht ungelesene Mails mit .xlsx/.xls-Anhang
// - lädt den Anhang in den privaten Storage-Bucket "mail-imports" hoch
// - legt dafür eine Zeile in public.pending_imports an (status "pending")
// - markiert die Mail als gelesen, damit sie nicht doppelt verarbeitet wird
//
// Secrets (Supabase Dashboard -> Project Settings -> Edge Functions ->
// Secrets, Projekt gfyjftwlombhmwirbyse):
//   IMAP_HOST, IMAP_PORT, IMAP_USERNAME, IMAP_PASSWORD, CRON_SECRET

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { ImapFlow } from "npm:imapflow@1";
import { simpleParser } from "npm:mailparser@3";

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

async function pollMailbox(admin: ReturnType<typeof createClient>) {
  const host = Deno.env.get("IMAP_HOST")!;
  const port = parseInt(Deno.env.get("IMAP_PORT") || "993", 10);
  const user = Deno.env.get("IMAP_USERNAME")!;
  const pass = Deno.env.get("IMAP_PASSWORD")!;

  const client = new ImapFlow({
    host,
    port,
    secure: true,
    auth: { user, pass },
    logger: false,
  });

  let imported = 0;
  let skipped = 0;
  const errors: string[] = [];

  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const uids = await client.search({ seen: false }, { uid: true });
      for (const uid of uids || []) {
        try {
          const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
          if (!msg || !msg.source) continue;
          const parsed = await simpleParser(msg.source as Uint8Array);
          const excelAttachments = (parsed.attachments || []).filter((a) => isExcelAttachment(a.filename));

          if (!excelAttachments.length) {
            skipped++;
          } else {
            for (const att of excelAttachments) {
              const path = `pending/${crypto.randomUUID()}-${att.filename}`;
              const { error: upErr } = await admin.storage
                .from("mail-imports")
                .upload(path, att.content, {
                  contentType: att.contentType || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                  upsert: false,
                });
              if (upErr) { errors.push(`Upload ${att.filename}: ${upErr.message}`); continue; }

              const { error: insErr } = await admin.from("pending_imports").insert({
                filename: att.filename,
                storage_path: path,
                source_subject: parsed.subject || null,
                source_from: parsed.from?.text || null,
              });
              if (insErr) { errors.push(`DB-Insert ${att.filename}: ${insErr.message}`); continue; }
              imported++;
            }
          }
          // Erst nach erfolgreicher Verarbeitung als gelesen markieren - bei
          // einem Fehler bleibt die Mail ungelesen und wird beim nächsten
          // Durchlauf erneut versucht.
          await client.messageFlagsAdd({ uid: String(uid) }, ["\\Seen"], { uid: true });
        } catch (e) {
          errors.push(`Mail ${uid}: ${String(e)}`);
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
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
    const result = await pollMailbox(admin);
    return json({ ok: true, ...result });
  } catch (e) {
    return json({ error: "Mail-Abruf fehlgeschlagen: " + String(e) }, 500);
  }
});
