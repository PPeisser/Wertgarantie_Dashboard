// Admin-Nutzerverwaltung (Anlegen, Löschen, Passwort zurücksetzen) und
// Selbstbedienung fürs eigene Passwort. Läuft serverseitig in Supabase und
// nutzt den service_role Key, der niemals im Browser-Code (index.html)
// landen darf. Verwaltungs-Aktionen sind auf role = 'admin' beschränkt;
// "syncMyPassword" darf jeder eingeloggte Nutzer für sich selbst aufrufen.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Erstpasswort für neu angelegte Nutzer – muss beim ersten Login geändert werden.
const DEFAULT_PASSWORD = "WertGARANTIE";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

// Spiegelt Anlegen/Löschen/Passwortänderungen ins getrennte Event-Admin-Projekt
// (siehe events/supabase/functions/sync-user). Best-effort: schlägt der Sync
// fehl (z.B. Secrets noch nicht hinterlegt), bricht die Dashboard-Aktion
// trotzdem nicht ab – der Status wird nur in der Antwort mitgegeben.
async function syncToEvents(
  action: "create" | "delete" | "set_password" | "reset_password",
  email: string,
  extra?: { name?: string | null; password?: string },
) {
  const url = Deno.env.get("EVENTS_SYNC_URL");
  const secret = Deno.env.get("EVENTS_SYNC_SECRET");
  if (!url || !secret) return "not_configured";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-sync-secret": secret },
      body: JSON.stringify({ action, email, ...extra }),
    });
    const j = await res.json().catch(() => ({} as Record<string, unknown>));
    if (!res.ok) return "failed";
    return (j.status as string) || "ok";
  } catch {
    return "failed";
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "Fehlender Authorization-Header" }, 401);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const { data: { user }, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !user) return json({ error: "Ungültige Session" }, 401);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Ungültiger Body" }, 400); }
  const action = body.action;

  // Selbstbedienung: Jeder eingeloggte Nutzer darf NUR sein eigenes
  // Events-Passwort synchronisieren (E-Mail kommt aus der Session, nicht
  // vom Client) – kein Admin-Check nötig, kein Zugriff auf fremde Accounts.
  if (action === "syncMyPassword") {
    const newPassword = String(body.newPassword || "");
    if (!newPassword) return json({ error: "newPassword erforderlich" }, 400);
    if (!user.email) return json({ ok: true, eventsSync: "no_email" });
    const eventsSync = await syncToEvents("set_password", user.email, { password: newPassword });
    return json({ ok: true, eventsSync });
  }

  const { data: profile, error: profErr } = await admin
    .from("profiles").select("role").eq("id", user.id).maybeSingle();
  if (profErr || !profile || profile.role !== "admin") {
    return json({ error: "Nur Admins dürfen Nutzer verwalten" }, 403);
  }

  if (action === "createUser") {
    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim();
    const role = ["admin", "trainer"].includes(String(body.role)) ? String(body.role) : "aussendienst";
    if (!name || !email) return json({ error: "Name und E-Mail erforderlich" }, 400);

    const { data, error } = await admin.auth.admin.createUser({
      email, password: DEFAULT_PASSWORD, email_confirm: true, user_metadata: { name },
    });
    if (error) return json({ error: error.message }, 400);

    await admin.from("profiles").update({ name, role, must_change_password: true }).eq("id", data.user.id);
    const eventsSync = await syncToEvents("create", email, { name });
    return json({ ok: true, id: data.user.id, eventsSync });
  }

  if (action === "deleteUser") {
    const userId = String(body.userId || "");
    if (!userId) return json({ error: "userId erforderlich" }, 400);
    if (userId === user.id) return json({ error: "Der eigene Account kann nicht gelöscht werden" }, 400);

    const { data: toDelete } = await admin.from("profiles").select("email").eq("id", userId).maybeSingle();

    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error) return json({ error: error.message }, 400);

    const eventsSync = toDelete?.email ? await syncToEvents("delete", toDelete.email) : "no_email";
    return json({ ok: true, eventsSync });
  }

  if (action === "resetPassword") {
    const userId = String(body.userId || "");
    const newPassword = String(body.newPassword || "");
    if (!userId || !newPassword) return json({ error: "userId und newPassword erforderlich" }, 400);

    const { data: target } = await admin.from("profiles").select("email").eq("id", userId).maybeSingle();

    const { error } = await admin.auth.admin.updateUserById(userId, { password: newPassword });
    if (error) return json({ error: error.message }, 400);

    await admin.from("profiles").update({ must_change_password: true }).eq("id", userId);
    const eventsSync = target?.email
      ? await syncToEvents("reset_password", target.email, { password: newPassword })
      : "no_email";
    return json({ ok: true, eventsSync });
  }

  return json({ error: "Unbekannte Aktion" }, 400);
});
