// Wertgarantie Performance Dashboard: Mailversand über dashboard@wgaustria.at.
// Aktionen:
// - "test": verschickt eine einzelne Testmail, um die SMTP-Verbindung zu
//   prüfen (mit x-cron-secret-Header geschützt).
// - "send": generischer Versand (Betreff/Empfänger/HTML), ebenfalls über
//   x-cron-secret geschützt - Basis für künftige Dashboard-Mailfunktionen
//   (z.B. automatische Reports).
// - "sendPdf": PDF-Versand direkt aus dem Dashboard (Button "Versenden" bei
//   den PDF-Exporten) - Auth über die Nutzer-Session (Authorization-Header),
//   NICHT über x-cron-secret, da jeder eingeloggte Nutzer sein eigenes PDF
//   versenden darf, ohne das Cron-Secret im Browser-Code zu benötigen.
//
// Secrets (Supabase Dashboard -> Project Settings -> Edge Functions ->
// Secrets, Projekt gfyjftwlombhmwirbyse):
//   SMTP_HOST, SMTP_PORT, SMTP_USERNAME, SMTP_PASSWORD,
//   SMTP_FROM_EMAIL, SMTP_FROM_NAME, CRON_SECRET

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

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

function getSmtpClient() {
  const hostname = Deno.env.get("SMTP_HOST")!;
  const port = parseInt(Deno.env.get("SMTP_PORT") || "587", 10);
  const username = Deno.env.get("SMTP_USERNAME")!;
  const password = Deno.env.get("SMTP_PASSWORD")!;
  return new SMTPClient({
    connection: { hostname, port, tls: port === 465, auth: { username, password } },
  });
}

interface Attachment {
  filename: string;
  content: string;
  encoding: "base64";
  contentType?: string;
}

// denomailer 1.6.0 schreibt den Dateinamen in Content-Type/Content-Disposition
// OHNE Anführungszeichen (z.B. "filename=Anhang.pdf" statt korrekt
// "filename=\"Anhang.pdf\""). Viele Mail-Clients (u.a. Gmail/Outlook)
// erkennen so einen Anhang gar nicht erst als Anhang - die Mail kommt an,
// aber ohne sichtbaren Anhang. Da die Bibliothek den Namen nur roh
// aneinanderhängt (`"name=" + attachment.filename`), reicht es, die
// Anführungszeichen hier schon im übergebenen filename mitzuliefern.
function quoteFilename(name: string): string {
  return `"${name.replace(/"/g, "")}"`;
}

async function sendMail(subject: string, to: string, html: string, attachments?: Attachment[]) {
  const fromEmail = Deno.env.get("SMTP_FROM_EMAIL")!;
  const fromName = Deno.env.get("SMTP_FROM_NAME") || "Wertgarantie Dashboard";
  const client = getSmtpClient();
  try {
    // NICHT gleichzeitig "content" UND "html" setzen - denomailer 1.6.0 baut
    // dabei eine korrupte MIME-Nachricht (kaputter Absender/Betreff, Rohtext/
    // Base64 statt Inhalt, Anhang verschwindet), siehe
    // https://github.com/EC-Nordbund/denomailer/issues/74. Nur "html".
    await client.send({
      from: `${fromName} <${fromEmail}>`,
      to,
      subject,
      html,
      ...(attachments && attachments.length ? { attachments } : {}),
    });
  } finally {
    await client.close();
  }
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
        filename: quoteFilename(attachmentFilename),
        content: attachmentBase64,
        encoding: "base64",
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
      filename: quoteFilename(String(body.attachmentFilename || "Anhang.pdf")),
      content: attachmentBase64,
      encoding: "base64" as const,
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
