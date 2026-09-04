// Selbst-Abmeldung: reine JSON-API, aufgerufen von der statischen Seite
// events/abmelden.html (siehe dort). Der unauffällige Abmelde-Link am Ende
// der Bestätigungs-/Reminder-Mail (siehe event-mailer/cancelLinkHtml) führt
// zu dieser Seite, NICHT direkt zu dieser Edge Function.
//
// Grund für den Umweg über eine statische Seite: Supabase Edge Functions
// können bei GET-Requests grundsätzlich kein HTML ausliefern - die
// Plattform schreibt "Content-Type: text/html" bei GET-Antworten
// zwangsweise auf "text/plain" um (offiziell dokumentiert, kein Bug). Ein
// direkter Link auf diese Function hätte also im Browser nur den rohen
// HTML-Quelltext als Text angezeigt, statt einer gerenderten Seite.
//
// GET liefert nur Infos zur Anzeige (Termin, ob Abmeldung noch möglich
// ist), löscht nichts. POST löscht wirklich - abmelden.html löst den POST
// erst beim tatsächlichen Klick auf den Button aus (nicht schon beim
// Laden), damit automatisches Link-Prefetching durch
// Firmen-Mail-Security-Gateways keine Anmeldung löschen kann (das ist real
// passiert).
//
// Die registration_id in der URL ist eine UUID und dient als
// Zugriffs-Token (kein Login nötig). Löscht die Anmeldung unwiderruflich,
// aber nur bis 48h vor dem Termin; danach nur noch über den Veranstalter.
//
// Läuft serverseitig, nutzt den service_role Key nur hier, nie im Browser.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "GET" && req.method !== "POST") {
    return json({ status: "error", error: "Method not allowed" }, 405);
  }

  const url = new URL(req.url);
  const id = (url.searchParams.get("id") || "").trim();
  if (!id) return json({ status: "not_found" });

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: reg } = await admin.from("registrations").select("*").eq("id", id).maybeSingle();
  if (!reg) return json({ status: "not_found" });

  const [{ data: event }, { data: eventDate }] = await Promise.all([
    admin.from("events").select("title").eq("id", reg.event_id).maybeSingle(),
    admin.from("event_dates").select("*").eq("id", reg.event_date_id).maybeSingle(),
  ]);
  if (!eventDate) return json({ status: "no_event_date" });

  const eventDateTime = viennaLocalToUtc(eventDate.event_date, eventDate.start_time);
  const hoursUntil = (eventDateTime.getTime() - Date.now()) / 3600000;
  if (hoursUntil < 48) return json({ status: "expired" });

  if (req.method === "POST") {
    await admin.from("registrations").delete().eq("id", id);
    return json({ status: "cancelled" });
  }

  return json({
    status: "confirm",
    event: { title: event?.title || "" },
    eventDate: {
      event_date: eventDate.event_date,
      start_time: eventDate.start_time,
      location: eventDate.location,
    },
  });
});
