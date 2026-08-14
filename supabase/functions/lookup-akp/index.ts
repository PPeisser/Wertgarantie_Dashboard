// AKP/FH-Datenabgleich für das Events-Projekt: Wird nach jeder
// Veranstaltungsanmeldung serverseitig aufgerufen (siehe match-registration
// Edge Function im Events-Projekt), um die im Anmeldeformular eingegebene
// AKP-/FH-Nummer mit den echten Stammdaten aus diesem Dashboard-Projekt
// abzugleichen. Der Registrant sieht davon nichts – das Ergebnis landet nur
// in registrations.matched_akp fürs Admin-Panel/CSV-Export.
//
// Geschützt über x-events-lookup-secret (Edge-Function-Secret, identisch zu
// DASHBOARD_LOOKUP_SECRET im Events-Projekt).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-events-lookup-secret",
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

  const secret = req.headers.get("x-events-lookup-secret") || "";
  if (!secret || secret !== Deno.env.get("EVENTS_LOOKUP_SECRET")) {
    return json({ error: "Nicht autorisiert" }, 401);
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Ungültiger Body" }, 400); }

  const akpNr = String(body.akp_nr || "").trim();
  const fhNrInput = String(body.fh_nr || "").trim();

  let akp: Record<string, unknown> | null = null;
  if (akpNr) {
    const { data } = await admin
      .from("akp_contacts")
      .select("nr, fh_nr, vorname, nachname, firma, strasse, plz, ort, telefon, email")
      .eq("nr", akpNr)
      .maybeSingle();
    akp = data || null;
  }

  const fhNr = fhNrInput || (akp?.fh_nr as string) || "";
  let fh: Record<string, unknown> | null = null;
  if (fhNr) {
    const { data } = await admin
      .from("fh_contacts")
      .select("fh_nr, strasse, plz, ort, telefon, email, ansprechpartner, segmentierung")
      .eq("fh_nr", fhNr)
      .maybeSingle();
    fh = data || null;
  }

  return json({ akp, fh, matched_at: new Date().toISOString() });
});
