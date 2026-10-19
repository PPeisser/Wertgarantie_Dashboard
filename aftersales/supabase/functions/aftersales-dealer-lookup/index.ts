// After-Sales: Händlerdaten aus unserem FH-Datenstand (Dashboard-Projekt)
// fürs Tool (Reiter "Händlerdaten & Logo"). Aufruf mit dem Token des
// eingeloggten Nutzers; Admins dürfen jede FH-Nummer laden und suchen,
// Fachhändler nur ihre eigene. Die Abfrage selbst läuft über lookup-akp im
// Dashboard-Projekt (gleiche Secrets wie match-registration:
// DASHBOARD_LOOKUP_URL / DASHBOARD_LOOKUP_SECRET).
//
// POST {fh_nr}  → {dealer: {fh_nr,name,strasse,plz,ort,email,telefon,homepage} | null}
// POST {search} → {results: [{fh_nr,name,plz,ort}]}   (nur Admins)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CORS_HEADERS, json } from "../_shared/common.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: { user } } = await admin.auth.getUser(token);
  if (!user) return json({ error: "Ungültige Session" }, 401);
  const { data: me } = await admin.from("profiles").select("role,fh_nr,aftersales_access").eq("id", user.id).maybeSingle();
  if (!me || !me.aftersales_access || !["admin", "fachhaendler"].includes(me.role)) {
    return json({ error: "Kein Zugriff auf das After-Sales-Tool" }, 403);
  }
  const isAdmin = me.role === "admin";

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Ungültiger Body" }, 400); }

  const url = Deno.env.get("DASHBOARD_LOOKUP_URL");
  const secret = Deno.env.get("DASHBOARD_LOOKUP_SECRET");
  if (!url || !secret) return json({ error: "Verbindung zum FH-Datenstand nicht konfiguriert" }, 500);
  const call = async (payload: unknown) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-events-lookup-secret": secret },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error("FH-Datenstand nicht erreichbar (" + res.status + ")");
    return await res.json();
  };

  try {
    if (body.search !== undefined) {
      if (!isAdmin) return json({ error: "Nur für Admins" }, 403);
      const j = await call({ search: String(body.search || "").slice(0, 80) });
      return json({ results: j.results || [] });
    }
    const fhNr = String(body.fh_nr || "").trim();
    if (!fhNr) return json({ error: "FH-Nummer fehlt" }, 400);
    if (!isAdmin && fhNr !== me.fh_nr) return json({ error: "Kein Zugriff auf diese FH-Nummer" }, 403);
    const j = await call({ fh_nr: fhNr });
    const f = j.fh;
    return json({
      dealer: f ? {
        fh_nr: fhNr, name: f.name || null, strasse: f.strasse || null, plz: f.plz || null, ort: f.ort || null,
        email: f.email || null, telefon: f.telefon || null, homepage: f.homepage || null,
      } : null,
    });
  } catch (e) {
    return json({ error: String(e instanceof Error ? e.message : e) }, 502);
  }
});
