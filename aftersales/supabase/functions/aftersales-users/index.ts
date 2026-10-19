// After-Sales: Zugangsverwaltung. Wird NUR serverseitig von der admin-users
// Edge Function des Dashboard-Projekts aufgerufen (Einstellungen → After-
// Sales-Tool → Zugänge verwalten), geschützt über x-sync-secret (== SYNC_SECRET
// hier == EVENTS_SYNC_SECRET im Dashboard-Projekt, gleiches Secret wie
// sync-user).
//
// Rollen in profiles: 'admin' (alle Dashboard-Nutzer, per sync-user gespiegelt,
// sehen alles) und 'fachhaendler' (sieht nur Daten seiner FH-Nummer).
// as_managed=true markiert Zugänge, die HIER angelegt wurden - nur die dürfen
// hier gelöscht/umbenannt werden; gespiegelte Dashboard-Nutzer verwaltet
// weiterhin das Dashboard.
//
// Seit 19.10.2026 dürfen alle Dashboard-Rollen Zugänge verwalten (Einstellungen
// im Dashboard). admin-users schickt caller_is_admin mit: Nicht-Admins dürfen
// nur Fachhändler-Zugänge anlegen/ändern, keine Admin-Zugänge.
// payload.dealer (aus fh_contacts des Dashboards) befüllt as_dealers vor.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CORS_HEADERS, json } from "../_shared/common.ts";

export const DEFAULT_PASSWORD = "WG_AfterSales_2027";
const ROLES = ["admin", "fachhaendler"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const secret = Deno.env.get("SYNC_SECRET");
  if (!secret || req.headers.get("x-sync-secret") !== secret) return json({ error: "Unauthorized" }, 401);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Ungültiger Body" }, 400); }
  const op = String(body.op || "");
  const callerIsAdmin = body.caller_is_admin === true;

  // Händlerdaten aus dem Dashboard-Datenstand übernehmen. overwrite=false:
  // nur leere Felder ergänzen (nichts überschreiben, was der Händler selbst
  // gepflegt hat); das Logo bleibt in jedem Fall erhalten.
  const DEALER_FIELDS = ["name", "strasse", "plz", "ort", "email", "telefon", "homepage"] as const;
  async function applyDealer(fhNr: string, overwrite: boolean) {
    const d = body.dealer as Record<string, string | null> | undefined;
    if (!d || !fhNr) return "no_data";
    const { data: existing } = await admin.from("as_dealers").select("*").eq("fh_nr", fhNr).maybeSingle();
    const row: Record<string, unknown> = { fh_nr: fhNr, updated_at: new Date().toISOString() };
    for (const k of DEALER_FIELDS) {
      const incoming = d[k] || null;
      row[k] = overwrite ? (incoming ?? existing?.[k] ?? null) : (existing?.[k] || incoming);
    }
    const { error } = await admin.from("as_dealers").upsert(row, { onConflict: "fh_nr" });
    return error ? "failed" : "ok";
  }

  if (op === "dealer_sync") {
    const fhNr = String(body.fh_nr || "").trim();
    if (!fhNr) return json({ error: "FH-Nummer fehlt" }, 400);
    if (!body.dealer) return json({ error: "Keine Stammdaten zu FH " + fhNr + " in der FH-Datenbank gefunden" }, 404);
    return json({ ok: true, dealer: await applyDealer(fhNr, true) });
  }

  if (op === "list") {
    const { data, error } = await admin.from("profiles")
      .select("id,email,name,role,fh_nr,as_managed,aftersales_access,must_change_password,created_at")
      .order("as_managed", { ascending: false }).order("fh_nr").order("email");
    if (error) return json({ error: error.message }, 500);
    const { data: dealers } = await admin.from("as_dealers").select("fh_nr,name,logo_url");
    return json({ ok: true, users: data, dealers: dealers || [], defaultPassword: DEFAULT_PASSWORD });
  }

  if (op === "create") {
    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const fhNr = String(body.fh_nr || "").trim();
    const role = ROLES.includes(String(body.role)) ? String(body.role) : "fachhaendler";
    if (!name || !email || !fhNr) return json({ error: "Name, E-Mail und FH-Nummer sind Pflicht" }, 400);
    if (role === "admin" && !callerIsAdmin) return json({ error: "Admin-Zugänge dürfen nur Dashboard-Admins anlegen" }, 403);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "Ungültige E-Mail-Adresse" }, 400);
    const { data, error } = await admin.auth.admin.createUser({
      email, password: DEFAULT_PASSWORD, email_confirm: true,
      user_metadata: { name }, app_metadata: { role, fh_nr: fhNr },
    });
    if (error) {
      const msg = /already|registered|exists/i.test(error.message) ? "Diese E-Mail-Adresse hat bereits einen Zugang" : error.message;
      return json({ error: msg }, 400);
    }
    // Der Auth-Trigger legt das Profil zunächst mit Rolle 'admin' an (Default
    // für gespiegelte Dashboard-Nutzer). Schlägt das Umstellen fehl, darf der
    // Zugang auf keinen Fall als Admin bestehen bleiben → wieder löschen.
    // (Bug-Report 19.10.2026: profiles_role_check erlaubte nur 'admin', der
    // neue Fachhändler blieb als Admin ohne FH-Nummer stehen.)
    const { error: profErr } = await admin.from("profiles").update({
      name, role, fh_nr: fhNr, as_managed: true, aftersales_access: true, must_change_password: true,
    }).eq("id", data.user.id);
    if (profErr) {
      await admin.auth.admin.deleteUser(data.user.id);
      return json({ error: "Zugang konnte nicht angelegt werden: " + profErr.message }, 500);
    }
    const dealer = await applyDealer(fhNr, false);
    return json({ ok: true, id: data.user.id, defaultPassword: DEFAULT_PASSWORD, dealer });
  }

  const userId = String(body.userId || "");
  if (!userId) return json({ error: "userId erforderlich" }, 400);
  const { data: target } = await admin.from("profiles").select("id,email,as_managed,role").eq("id", userId).maybeSingle();
  if (!target) return json({ error: "Nutzer nicht gefunden" }, 404);
  if (!callerIsAdmin && (target.role === "admin" || body.role === "admin")) {
    return json({ error: "Admin-Zugänge dürfen nur Dashboard-Admins ändern" }, 403);
  }

  if (op === "update") {
    const upd: Record<string, unknown> = {};
    if (body.fh_nr !== undefined) upd.fh_nr = String(body.fh_nr || "").trim() || null;
    if (body.aftersales_access !== undefined) upd.aftersales_access = !!body.aftersales_access;
    if (target.as_managed) {
      if (body.name !== undefined) upd.name = String(body.name || "").trim() || null;
      if (body.role !== undefined && ROLES.includes(String(body.role))) upd.role = String(body.role);
    }
    if (target.as_managed && upd.fh_nr === null) return json({ error: "FH-Nummer ist Pflicht" }, 400);
    const { error } = await admin.from("profiles").update(upd).eq("id", userId);
    if (error) return json({ error: error.message }, 400);
    return json({ ok: true });
  }

  if (op === "reset_password") {
    if (!target.as_managed) {
      return json({ error: "Dashboard-Nutzer nutzen ihr Dashboard-Passwort – bitte im Dashboard zurücksetzen." }, 400);
    }
    const { error } = await admin.auth.admin.updateUserById(userId, { password: DEFAULT_PASSWORD });
    if (error) return json({ error: error.message }, 400);
    await admin.from("profiles").update({ must_change_password: true }).eq("id", userId);
    return json({ ok: true, defaultPassword: DEFAULT_PASSWORD });
  }

  if (op === "delete") {
    if (!target.as_managed) return json({ error: "Dashboard-Nutzer werden über das Dashboard gelöscht." }, 400);
    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error) return json({ error: error.message }, 400);
    return json({ ok: true });
  }

  return json({ error: "Unbekannte Operation" }, 400);
});
