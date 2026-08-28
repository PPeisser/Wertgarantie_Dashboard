// Selbst-Abmeldung: der unauffällige Link am Ende der Bestätigungs-/
// Reminder-Mail (siehe event-mailer/cancelLinkHtml) führt hierher.
//
// WICHTIG: GET führt NUR eine Bestätigungsseite mit einem "Ja, abmelden"-
// Button an, POST löscht wirklich. Viele Firmen-Mailserver/Security-Gateways
// rufen jeden Link in eingehenden Mails automatisch per GET ab, um ihn auf
// Schadsoftware zu prüfen ("Link-Prefetching") - würde ein bloßes GET schon
// abmelden, würde das die Anmeldung löschen, bevor die Person die Mail
// überhaupt gesehen hat (das ist real passiert). Ein Formular-POST wird von
// solchen Scannern nicht ausgelöst, nur von einem echten Klick auf den
// Button im Browser.
//
// Die registration_id in der URL ist eine UUID und dient als Zugriffs-Token
// (kein Login nötig). Löscht die Anmeldung unwiderruflich, aber nur bis 48h
// vor dem Termin; danach nur noch über den Veranstalter.
//
// Läuft serverseitig, nutzt den service_role Key nur hier, nie im Browser.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function escapeHtml(s: unknown) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string
  ));
}

function page(title: string, message: string, bodyExtra = "") {
  const html = `<!doctype html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)} – Wertgarantie</title>
<meta name="robots" content="noindex">
<style>
  body{margin:0;background:#EEF3F7;color:#10202C;font-family:"Segoe UI",system-ui,-apple-system,Arial,sans-serif;
       display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
  .card{background:#fff;border-radius:18px;box-shadow:0 12px 28px -10px rgba(6,42,63,.14);
        padding:36px 32px;max-width:440px;text-align:center}
  .badge{display:inline-flex;align-items:center;background:#10202C;border-radius:10px;padding:8px 14px;
         color:#fff;font-weight:800;font-size:15px;margin-bottom:20px}
  h1{font-size:19px;margin:0 0 10px;color:#062A3F}
  p{color:#5D7284;font-size:14.5px;line-height:1.6;margin:0}
  .termin{background:#F0FAFF;border:1px solid #009FE3;border-radius:12px;padding:14px 16px;margin:18px 0;
          text-align:left;font-size:14px;color:#062A3F;font-weight:600}
  .btn{display:inline-block;border:none;border-radius:10px;padding:12px 22px;font-size:14.5px;font-weight:700;
       font-family:inherit;cursor:pointer;margin-top:20px}
  .btn-danger{background:#E0234E;color:#fff}
  .btn-ghost{background:#EEF3F7;color:#5D7284;margin-top:10px}
</style>
</head>
<body>
  <div class="card">
    <div class="badge">Wertgarantie</div>
    <h1>${escapeHtml(title)}</h1>
    <p>${message}</p>
    ${bodyExtra}
  </div>
</body>
</html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// event_date/start_time werden ohne Zeitzone gespeichert (Wandzeit
// Österreich) - identische Umrechnung wie im event-mailer.
function viennaLocalToUtc(dateStr: string, timeStr: string): Date {
  const naiveUtc = new Date(`${dateStr}T${timeStr}Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Vienna", timeZoneName: "shortOffset",
  }).formatToParts(naiveUtc);
  const tzName = parts.find((p) => p.type === "timeZoneName")?.value || "GMT+1";
  const offsetHours = parseInt(tzName.replace("GMT", "") || "1", 10);
  return new Date(naiveUtc.getTime() - offsetHours * 3600000);
}
function fmtDate(d: string) {
  return new Date(d + "T00:00:00").toLocaleDateString("de-AT", {
    weekday: "long", day: "2-digit", month: "2-digit", year: "numeric",
  });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const id = (url.searchParams.get("id") || "").trim();

  if (!id) {
    return page("Ungültiger Link", "Dieser Abmelde-Link ist ungültig. Bitte wende dich an die Person, von der du die Einladung erhalten hast.");
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: reg } = await admin.from("registrations").select("*").eq("id", id).maybeSingle();
  if (!reg) {
    return page("Anmeldung nicht gefunden", "Diese Anmeldung wurde nicht gefunden – möglicherweise hast du dich bereits abgemeldet.");
  }

  const { data: eventDate } = await admin.from("event_dates").select("*").eq("id", reg.event_date_id).maybeSingle();
  if (!eventDate) {
    return page("Termin nicht gefunden", "Zu dieser Anmeldung wurde kein Termin mehr gefunden. Bitte wende dich an die Person, von der du die Einladung erhalten hast.");
  }

  const eventDateTime = viennaLocalToUtc(eventDate.event_date, eventDate.start_time);
  const hoursUntil = (eventDateTime.getTime() - Date.now()) / 3600000;
  if (hoursUntil < 48) {
    return page(
      "Abmeldung nicht mehr möglich",
      "Eine Online-Abmeldung ist ab 48 Stunden vor der Veranstaltung leider nicht mehr möglich. Bitte wende dich direkt an die Person, von der du die Einladung erhalten hast.",
    );
  }

  if (req.method === "POST") {
    await admin.from("registrations").delete().eq("id", id);
    return page("Du wurdest abgemeldet", "Deine Anmeldung wurde storniert. Schade, dass es diesmal nicht klappt – vielleicht bei einer der nächsten Veranstaltungen!");
  }

  // GET zeigt nur eine Bestätigungsseite, löscht aber noch nichts (siehe
  // Kommentar oben - schützt vor automatischem Link-Prefetching durch
  // Mail-Security-Gateways).
  const { data: event } = await admin.from("events").select("title").eq("id", reg.event_id).maybeSingle();
  const terminInfo = `
    <div class="termin">
      ${event ? escapeHtml(event.title) + "<br>" : ""}
      ${escapeHtml(fmtDate(eventDate.event_date))}${eventDate.location ? " · " + escapeHtml(eventDate.location) : ""}
    </div>`;
  // url.href zeigt innerhalb der Edge Function auf die interne Routing-URL
  // (http://<project>.supabase.co/cancel-registration?id=...), nicht auf die
  // öffentliche URL - deshalb die action explizit aus SUPABASE_URL bauen.
  const actionUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/cancel-registration?id=${encodeURIComponent(id)}`;
  const form = `
    <form method="POST" action="${escapeHtml(actionUrl)}">
      <button type="submit" class="btn btn-danger">Ja, endgültig abmelden</button>
    </form>`;
  return page(
    "Wirklich abmelden?",
    "Möchtest du deine Anmeldung zu dieser Veranstaltung stornieren?" + terminInfo,
    form,
  );
});
