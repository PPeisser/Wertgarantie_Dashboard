// Event-Landingpage: Mailversand.
// - action "confirmation": Bestätigungsmail an eine einzelne Anmeldung
//   (wird vom öffentlichen Anmeldeformular direkt nach dem Insert aufgerufen).
// - action "report": Status-Mail mit dem aktuellen Gesamt-Anmeldestand an alle
//   konfigurierten Empfänger einer Häufigkeit (täglich/wöchentlich). Wird von
//   einem pg_cron-Job aufgerufen und ist über CRON_SECRET geschützt.
//
// Läuft serverseitig in Supabase, nutzt den service_role Key (nur hier, nie im
// Browser-Code) sowie SMTP-Zugangsdaten, die als Edge-Function-Secrets
// hinterlegt werden müssen (Supabase Dashboard -> Edge Functions -> Secrets):
//   SMTP_HOST, SMTP_PORT, SMTP_USERNAME, SMTP_PASSWORD,
//   SMTP_FROM_EMAIL, SMTP_FROM_NAME, CRON_SECRET

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const FIELD_LABELS: Record<string, string> = {
  vorname: "Vorname", nachname: "Name", plz: "PLZ", ort: "Ort",
  geburtsdatum: "Geburtsdatum", akp_nummer: "AKP-Nummer", fh_nummer: "FH-Nummer",
  fachhaendler: "Fachhändler", telefon: "Telefonnummer", email: "E-Mail-Adresse",
  anreise_auto: "Anreise mit Auto", bemerkungen: "Sonstige Bemerkungen",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function fmtDate(d: string) {
  return new Date(d + "T00:00:00").toLocaleDateString("de-AT", {
    weekday: "long", day: "2-digit", month: "2-digit", year: "numeric",
  });
}
function fmtTime(t: string | null) {
  return t ? t.slice(0, 5) : "";
}
function escapeHtml(s: unknown) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string
  ));
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
  const fromName = Deno.env.get("SMTP_FROM_NAME") || "Wertgarantie Veranstaltungen";
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

async function handleConfirmation(admin: ReturnType<typeof createClient>, registrationId: string) {
  const { data: reg, error: regErr } = await admin
    .from("registrations").select("*").eq("id", registrationId).maybeSingle();
  if (regErr || !reg) return json({ error: "Anmeldung nicht gefunden" }, 404);
  if (reg.confirmation_sent_at) return json({ ok: true, skipped: "already_sent" });
  if (!reg.email) return json({ ok: true, skipped: "no_email" });

  const [{ data: event }, { data: eventDate }] = await Promise.all([
    admin.from("events").select("*").eq("id", reg.event_id).maybeSingle(),
    admin.from("event_dates").select("*").eq("id", reg.event_date_id).maybeSingle(),
  ]);
  if (!event || !eventDate) return json({ error: "Veranstaltung/Termin nicht gefunden" }, 404);

  const vorname = reg.data?.vorname ? String(reg.data.vorname) : "";
  const greeting = vorname ? `Hallo ${escapeHtml(vorname)},` : "Hallo,";

  const detailRows = Object.entries(FIELD_LABELS)
    .filter(([key]) => reg.data && reg.data[key] !== undefined && reg.data[key] !== "")
    .map(([key, label]) => `<tr><td style="padding:4px 12px 4px 0;color:#5D7284">${escapeHtml(label)}</td><td style="padding:4px 0;font-weight:600">${escapeHtml(reg.data[key])}</td></tr>`)
    .join("");

  const html = `
  <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:560px;margin:0 auto;color:#10202C">
    <div style="background:#10202C;padding:22px 26px;border-radius:14px 14px 0 0">
      <span style="color:#fff;font-weight:800;font-size:16px">Wertgarantie</span>
    </div>
    <div style="border:1px solid #DCE7EE;border-top:none;border-radius:0 0 14px 14px;padding:26px">
      <p>${greeting}</p>
      <p>vielen Dank für Ihre Anmeldung zu <strong>${escapeHtml(event.title)}</strong>. Wir haben Ihre Anmeldung erhalten.</p>
      <div style="background:#F0FAFF;border:1px solid #009FE3;border-radius:12px;padding:16px 18px;margin:18px 0">
        <div style="font-weight:800;color:#062A3F;margin-bottom:4px">Ihr Termin</div>
        <div>${escapeHtml(fmtDate(eventDate.event_date))}</div>
        <div>${escapeHtml(fmtTime(eventDate.start_time))}${eventDate.end_time ? "–" + escapeHtml(fmtTime(eventDate.end_time)) : ""} Uhr</div>
        <div>${escapeHtml(eventDate.location)}</div>
      </div>
      ${detailRows ? `<div style="margin:18px 0"><div style="font-weight:800;color:#062A3F;margin-bottom:6px">Ihre Angaben</div><table>${detailRows}</table></div>` : ""}
      <p style="color:#5D7284;font-size:13px;margin-top:24px">Diese E-Mail wurde automatisch versendet. Bei Fragen wenden Sie sich bitte an die Kontaktperson Ihrer Veranstaltung.</p>
    </div>
  </div>`;

  await sendMail(`Anmeldebestätigung – ${event.title}`, reg.email, html);
  await admin.from("registrations").update({ confirmation_sent_at: new Date().toISOString() }).eq("id", reg.id);
  return json({ ok: true });
}

async function handleReport(admin: ReturnType<typeof createClient>, frequency: "daily" | "weekly") {
  const { data: recipients } = await admin
    .from("email_recipients").select("*").eq("frequency", frequency).eq("active", true);
  if (!recipients || !recipients.length) return json({ ok: true, skipped: "no_recipients" });

  const { data: events } = await admin.from("events").select("*").eq("is_active", true).limit(1);
  const event = events && events[0];
  if (!event) return json({ ok: true, skipped: "no_active_event" });

  const { data: dates } = await admin
    .from("event_dates").select("*").eq("event_id", event.id).order("sort_order").order("event_date");
  const { data: regs } = await admin
    .from("registrations").select("event_date_id").eq("event_id", event.id);

  const counts: Record<string, number> = {};
  (regs || []).forEach((r) => { counts[r.event_date_id] = (counts[r.event_date_id] || 0) + 1; });
  const total = (regs || []).length;

  const rows = (dates || []).map((d) => `
    <tr>
      <td style="padding:6px 14px 6px 0">${escapeHtml(fmtDate(d.event_date))}</td>
      <td style="padding:6px 14px 6px 0">${escapeHtml(fmtTime(d.start_time))}${d.end_time ? "–" + escapeHtml(fmtTime(d.end_time)) : ""} Uhr</td>
      <td style="padding:6px 14px 6px 0">${escapeHtml(d.location)}</td>
      <td style="padding:6px 0;font-weight:800;text-align:right">${counts[d.id] || 0}</td>
    </tr>`).join("");

  const freqLabel = frequency === "daily" ? "Täglicher" : "Wöchentlicher";
  const html = `
  <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:640px;margin:0 auto;color:#10202C">
    <div style="background:#10202C;padding:22px 26px;border-radius:14px 14px 0 0">
      <span style="color:#fff;font-weight:800;font-size:16px">Wertgarantie</span>
    </div>
    <div style="border:1px solid #DCE7EE;border-top:none;border-radius:0 0 14px 14px;padding:26px">
      <p style="margin-top:0">${freqLabel} Anmeldestand für <strong>${escapeHtml(event.title)}</strong>, Stand ${new Date().toLocaleString("de-AT")}.</p>
      <div style="background:#ECF2F6;border-radius:12px;padding:14px 18px;margin:18px 0;font-weight:800;font-size:20px;color:#062A3F">
        ${total} Anmeldung${total === 1 ? "" : "en"} gesamt
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead><tr style="color:#5D7284;font-size:11.5px;text-transform:uppercase;text-align:left">
          <th style="padding-bottom:6px">Datum</th><th style="padding-bottom:6px">Uhrzeit</th><th style="padding-bottom:6px">Ort</th><th style="padding-bottom:6px;text-align:right">Anmeldungen</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="color:#5D7284;font-size:13px;margin-top:24px">Diese E-Mail wurde automatisch versendet.</p>
    </div>
  </div>`;

  const subject = `${freqLabel} Anmeldestand – ${event.title} (${total} gesamt)`;
  for (const r of recipients) {
    await sendMail(subject, r.email, html);
  }
  return json({ ok: true, sent: recipients.length });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Ungültiger Body" }, 400); }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  if (body.type === "confirmation") {
    const registrationId = String(body.registration_id || "");
    if (!registrationId) return json({ error: "registration_id erforderlich" }, 400);
    try {
      return await handleConfirmation(admin, registrationId);
    } catch (e) {
      return json({ error: "Mailversand fehlgeschlagen: " + String(e) }, 500);
    }
  }

  if (body.type === "report") {
    const secret = req.headers.get("x-cron-secret") || "";
    if (!secret || secret !== Deno.env.get("CRON_SECRET")) {
      return json({ error: "Nicht autorisiert" }, 401);
    }
    const frequency = body.frequency === "weekly" ? "weekly" : "daily";
    try {
      return await handleReport(admin, frequency);
    } catch (e) {
      return json({ error: "Mailversand fehlgeschlagen: " + String(e) }, 500);
    }
  }

  return json({ error: "Unbekannter type" }, 400);
});
