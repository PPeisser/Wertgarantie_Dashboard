// Wertgarantie Performance Dashboard: Mailversand über dashboard@wgaustria.at.
// Aktuell zwei Aktionen:
// - "test": verschickt eine einzelne Testmail, um die SMTP-Verbindung zu
//   prüfen (mit x-cron-secret-Header geschützt).
// - "send": generischer Versand (Betreff/Empfänger/HTML), ebenfalls über
//   x-cron-secret geschützt - Basis für künftige Dashboard-Mailfunktionen
//   (z.B. automatische Reports), noch ohne eigenen Aufrufer im Dashboard.
//
// Secrets (Supabase Dashboard -> Project Settings -> Edge Functions ->
// Secrets, Projekt gfyjftwlombhmwirbyse):
//   SMTP_HOST, SMTP_PORT, SMTP_USERNAME, SMTP_PASSWORD,
//   SMTP_FROM_EMAIL, SMTP_FROM_NAME, CRON_SECRET

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

async function sendMail(subject: string, to: string, html: string) {
  const fromEmail = Deno.env.get("SMTP_FROM_EMAIL")!;
  const fromName = Deno.env.get("SMTP_FROM_NAME") || "Wertgarantie Dashboard";
  const client = getSmtpClient();
  try {
    await client.send({
      from: `${fromName} <${fromEmail}>`,
      to,
      subject,
      html,
      content: "Bitte verwenden Sie einen E-Mail-Client mit HTML-Unterstützung.",
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
    try {
      await sendMail(subject, to, html);
      return json({ ok: true });
    } catch (e) {
      return json({ error: "Mailversand fehlgeschlagen: " + String(e) }, 500);
    }
  }

  return json({ error: "Unbekannter type" }, 400);
});
