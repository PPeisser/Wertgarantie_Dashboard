// After-Sales: Zugangsverwaltung. Wird NUR serverseitig von der admin-users
// Edge Function des Dashboard-Projekts aufgerufen (Einstellungen → Admin-
// Panel → After-Sales-Zugänge), geschützt über x-sync-secret (== SYNC_SECRET
// hier == EVENTS_SYNC_SECRET im Dashboard-Projekt, gleiches Secret wie
// sync-user).
//
// Rollen in profiles: 'admin' (alle Dashboard-Nutzer, per sync-user gespiegelt,
// sehen alles) und 'fachhaendler' (sieht nur Daten seiner FH-Nummer).
// as_managed=true markiert Zugänge, die HIER angelegt wurden - nur die dürfen
// hier gelöscht/umbenannt werden; gespiegelte Dashboard-Nutzer verwaltet
// weiterhin das Dashboard.

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

  if (op === "list") {
    const { data, error } = await admin.from("profiles")
      .select("id,email,name,role,fh_nr,as_managed,aftersales_access,must_change_password,created_at")
      .order("as_managed", { ascending: false }).order("fh_nr").order("email");
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, users: data, defaultPassword: DEFAULT_PASSWORD });
  }

  if (op === "create") {
    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const fhNr = String(body.fh_nr || "").trim();
    const role = ROLES.includes(String(body.role)) ? String(body.role) : "fachhaendler";
    if (!name || !email || !fhNr) return json({ error: "Name, E-Mail und FH-Nummer sind Pflicht" }, 400);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "Ungültige E-Mail-Adresse" }, 400);
    const { data, error } = await admin.auth.admin.createUser({
      email, password: DEFAULT_PASSWORD, email_confirm: true,
      user_metadata: { name }, app_metadata: { role, fh_nr: fhNr },
    });
    if (error) {
      const msg = /already|registered|exists/i.test(error.message) ? "Diese E-Mail-Adresse hat bereits einen Zugang" : error.message;
      return json({ error: msg }, 400);
    }
    await admin.from("profiles").update({
      name, role, fh_nr: fhNr, as_managed: true, aftersales_access: true, must_change_password: true,
    }).eq("id", data.user.id);
    return json({ ok: true, id: data.user.id, defaultPassword: DEFAULT_PASSWORD });
  }

  const userId = String(body.userId || "");
  if (!userId) return json({ error: "userId erforderlich" }, 400);
  const { data: target } = await admin.from("profiles").select("id,email,as_managed,role").eq("id", userId).maybeSingle();
  if (!target) return json({ error: "Nutzer nicht gefunden" }, 404);

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
