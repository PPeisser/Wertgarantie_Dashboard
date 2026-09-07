// Wertgarantie Performance Dashboard: Benachrichtigungsmail an alle Nutzer
// mit Rolle "admin" oder "aussendienst" (= Gebietsleiter/Außendienst),
// sobald im Dashboard eine Akquiseliste (AKQ-Liste-Blatt aus
// Auswertung_TAG.xlsx) erfolgreich eingespielt wurde (Nutzervorgabe
// 07.09.2026). Rolle "trainer" bekommt bewusst KEINE Mail (siehe
// Rückfrage/Antwort vom selben Tag) - es gibt in profiles.role keine
// eigene "gl"-Rolle, "Gebietsleiter" ist hier ein Geschäftsbegriff für die
// Außendienst-Accounts, keine eigene Auth-Rolle.
//
// Aufruf: vom Client (index.html, nach erfolgreichem parseAuswertung() +
// mergeSnapshot() mit vorhandenem snap.akq) mit der Session des gerade
// eingeloggten Nutzers - Auth wie bei dashboard-mailers "sendPdf": jeder
// eingeloggte Nutzer darf einen erfolgreichen Import melden, ohne das
// Cron-Secret im Browser zu benötigen. ZUSÄTZLICH per x-cron-secret
// erreichbar (Admin-/Ops-Zwecke, z.B. eine einzelne Demomail an eine
// bestimmte Adresse per body.test:true - siehe unten) - analog zum
// bestehenden "test"-Modus von dashboard-mailer.
//
// Feature-Flag: dashboard_kv-Key "akq_import_notify_enabled" (Text "0" =
// deaktiviert, alles andere/fehlend = aktiviert) - ein Admin kann die
// Benachrichtigung darüber jederzeit ausschalten, ohne Code-Änderung.
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET (bereits
// vorhanden, siehe dashboard-mailer) - kein neues Secret nötig, der
// eigentliche Versand läuft über dashboard-mailers "send"-Aktion
// (server-zu-server mit x-cron-secret), keine eigene SMTP-Logik hier.

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

const SUBJECT = "Wertgarantie Dashboard // Akquiseliste eingespielt";

function buildHtml(): string {
  const stand = new Date().toLocaleString("de-AT", { dateStyle: "short", timeStyle: "short" });
  return `<div style="font-family:'Segoe UI',Arial,sans-serif;color:#10202C">
    <p>Hallo,</p>
    <p>die <b>Akquiseliste</b> im Wertgarantie Performance Dashboard wurde soeben aktualisiert und steht ab sofort mit den neuesten Daten zur Verfügung.</p>
    <p>Einfach im Dashboard vorbeischauen, um die aktuellen Akquise-Zahlen einzusehen.</p>
    <p style="font-size:11px;color:#5D7284">Automatische Benachrichtigung · Stand: ${stand} Uhr</p>
    <p>Liebe Grüße<br>Wertgarantie Performance Dashboard</p>
  </div>`;
}

async function sendMail(dashboardMailerUrl: string, cronSecret: string, to: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(dashboardMailerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-cron-secret": cronSecret },
      body: JSON.stringify({ type: "send", to, subject: SUBJECT, html: buildHtml() }),
    });
    if (!res.ok) {
      const t = await res.text();
      return { ok: false, error: `HTTP ${res.status}: ${t}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const cronSecret = Deno.env.get("CRON_SECRET") || "";
  const headerSecret = req.headers.get("x-cron-secret") || "";
  const authedViaSecret = !!cronSecret && headerSecret === cronSecret;

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  if (!authedViaSecret) {
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "Fehlender Authorization-Header" }, 401);
    const { data: { user }, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !user) return json({ error: "Ungültige Session" }, 401);
  }

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* leerer Body ist ok (Standardaufruf ohne Parameter) */ }

  const dashboardMailerUrl = Deno.env.get("SUPABASE_URL")! + "/functions/v1/dashboard-mailer";

  // Testmodus: einzelne Demomail an eine explizite Adresse, OHNE die
  // echten Empfänger (Admins/Außendienst) zu kontaktieren - nur mit
  // gültigem x-cron-secret nutzbar (Admin-/Ops-Werkzeug).
  if (body.test === true) {
    if (!authedViaSecret) return json({ error: "Testmodus nur mit x-cron-secret erlaubt" }, 403);
    const to = String(body.to || "").trim();
    if (!to) return json({ error: "'to' erforderlich im Testmodus" }, 400);
    const r = await sendMail(dashboardMailerUrl, cronSecret, to);
    if (!r.ok) return json({ error: r.error }, 502);
    return json({ ok: true, testMode: true, sent: [to] });
  }

  // Feature-Flag prüfen (Default: aktiviert)
  const { data: kvRow } = await admin
    .from("dashboard_kv").select("value").eq("key", "akq_import_notify_enabled").maybeSingle();
  const enabled = kvRow ? kvRow.value !== "0" : true;
  if (!enabled) return json({ ok: true, skipped: true, reason: "disabled" });

  const { data: profiles, error: profErr } = await admin
    .from("profiles").select("email,name,role").in("role", ["admin", "aussendienst"]);
  if (profErr) return json({ error: profErr.message }, 500);

  const emails = [...new Set((profiles || [])
    .map((p) => (p.email || "").trim().toLowerCase())
    .filter(Boolean))];
  if (!emails.length) return json({ ok: true, sent: [], failed: [] });

  const failed: string[] = [];
  for (const to of emails) {
    const r = await sendMail(dashboardMailerUrl, cronSecret, to);
    if (!r.ok) failed.push(to);
  }

  return json({ ok: true, sent: emails.filter((e) => !failed.includes(e)), failed });
});
