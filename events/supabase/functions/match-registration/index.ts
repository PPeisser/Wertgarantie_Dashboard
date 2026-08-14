// Serverseitiger AKP/FH-Datenabgleich nach einer Veranstaltungsanmeldung.
// Wird von index.html direkt nach dem Insert der Anmeldung aufgerufen
// (best-effort, ohne Auswirkung auf die Anmeldebestätigung fürs Publikum)
// und gleicht die eingegebene AKP-/FH-Nummer mit den Stammdaten aus dem
// Dashboard-Projekt ab (lookup-akp Edge Function dort). Das Ergebnis wird
// unsichtbar für den Teilnehmer in registrations.matched_akp gespeichert
// und im Admin-Panel/CSV-Export angezeigt.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Ungültiger Body" }, 400); }

  const registrationId = String(body.registration_id || "").trim();
  if (!registrationId) return json({ error: "registration_id erforderlich" }, 400);

  const { data: reg } = await admin
    .from("registrations")
    .select("id, data")
    .eq("id", registrationId)
    .maybeSingle();
  if (!reg) return json({ error: "Anmeldung nicht gefunden" }, 404);

  const regData = (reg.data as Record<string, unknown>) || {};
  // "0" ist die Konvention im Anmeldeformular für "AKP-/FH-Nummer nicht
  // bekannt" und wird wie eine leere Angabe behandelt (kein Lookup-Versuch).
  let akpNr = String(regData.akp_nummer || "").trim();
  if (akpNr === "0") akpNr = "";
  let fhNr = String(regData.fh_nummer || "").trim();
  if (fhNr === "0") fhNr = "";
  if (!akpNr && !fhNr) return json({ ok: true, skipped: "keine AKP-/FH-Nummer angegeben" });

  const lookupUrl = Deno.env.get("DASHBOARD_LOOKUP_URL");
  const lookupSecret = Deno.env.get("DASHBOARD_LOOKUP_SECRET");
  if (!lookupUrl || !lookupSecret) return json({ ok: false, error: "not_configured" });

  try {
    const res = await fetch(lookupUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-events-lookup-secret": lookupSecret },
      body: JSON.stringify({ akp_nr: akpNr, fh_nr: fhNr }),
    });
    if (!res.ok) return json({ ok: false, error: "lookup_failed" });
    const matched = await res.json();
    await admin.from("registrations").update({ matched_akp: matched }).eq("id", registrationId);
    return json({ ok: true, matched });
  } catch (e) {
    return json({ ok: false, error: String(e) });
  }
});
