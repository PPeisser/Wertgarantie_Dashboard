// Nutzer-Synchronisation zwischen dem Performance-Dashboard-Projekt und
// diesem Events-Projekt.
//
// Zwei Vertrauensmodelle in einer Function:
// - Aktionen "create"/"delete"/"set_password"/"reset_password"/"bulk_create":
//   Server-zu-Server-Aufrufe vom Dashboard-Projekt (admin-users Edge
//   Function), geschützt über den Header x-sync-secret (== SYNC_SECRET hier
//   == EVENTS_SYNC_SECRET im Dashboard-Projekt).
// - Aktion "syncMyPasswordToDashboard": Selbstbedienung direkt vom
//   eingeloggten Event-Admin-Nutzer im Browser aufgerufen, authentifiziert
//   über dessen eigenes Supabase-Auth-Token dieses Projekts (kein Secret –
//   die E-Mail kommt aus der Session, nie vom Client). Spiegelt das neue
//   Passwort zurück ins Dashboard-Projekt (sync-from-events Edge Function).
//
// Läuft serverseitig, nutzt den service_role Key nur hier, nie im Browser-Code.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-sync-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Erstpasswort für synchronisierte Nutzer – muss beim ersten Login im
// Event-Admin-Panel geändert werden (siehe must_change_password).
const DEFAULT_PASSWORD = "WertGARANTIE";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

// Best-effort: schlägt der Sync zurück ins Dashboard fehl (z.B. Secrets noch
// nicht hinterlegt), bricht die Passwortänderung hier trotzdem nicht ab.
async function syncToDashboard(email: string, password: string) {
  const url = Deno.env.get("DASHBOARD_SYNC_URL");
  const secret = Deno.env.get("DASHBOARD_SYNC_SECRET");
  if (!url || !secret) return "not_configured";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-events-sync-secret": secret },
      body: JSON.stringify({ action: "set_password", email, password }),
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

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Ungültiger Body" }, 400); }

  // Selbstbedienung: eigenes Auth-Token statt Secret, wirkt nur auf den
  // eigenen Account (E-Mail kommt aus dem Token, nicht vom Client).
  if (body.action === "syncMyPasswordToDashboard") {
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "Fehlender Authorization-Header" }, 401);

    const { data: { user }, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !user || !user.email) return json({ error: "Ungültige Session" }, 401);

    const newPassword = String(body.newPassword || "");
    if (!newPassword) return json({ error: "newPassword erforderlich" }, 400);

    const dashboardSync = await syncToDashboard(user.email, newPassword);
    return json({ ok: true, dashboardSync });
  }

  const secret = req.headers.get("x-sync-secret") || "";
  if (!secret || secret !== Deno.env.get("SYNC_SECRET")) {
    return json({ error: "Nicht autorisiert" }, 401);
  }

  async function createOne(email: string, name: string | null) {
    const { data: existing } = await admin.from("profiles").select("id").eq("email", email).maybeSingle();
    if (existing) return { email, status: "exists" };

    const { data, error } = await admin.auth.admin.createUser({
      email, password: DEFAULT_PASSWORD, email_confirm: true, user_metadata: { name },
    });
    if (error) return { email, status: "error", message: error.message };

    await admin.from("profiles").update({ must_change_password: true, name }).eq("id", data.user.id);
    return { email, status: "created" };
  }

  async function deleteOne(email: string) {
    const { data: profile } = await admin.from("profiles").select("id").eq("email", email).maybeSingle();
    if (!profile) return { email, status: "not_found" };

    const { error } = await admin.auth.admin.deleteUser(profile.id);
    if (error) return { email, status: "error", message: error.message };
    return { email, status: "deleted" };
  }

  // mustChange=false: Nutzer hat das Passwort selbst gewählt (Dashboard
  // Self-Service). mustChange=true: Admin hat im Dashboard zurückgesetzt,
  // der übernommene Wert ist ein Übergangspasswort.
  async function setPassword(email: string, password: string, mustChange: boolean) {
    const { data: profile } = await admin.from("profiles").select("id").eq("email", email).maybeSingle();
    if (!profile) return { email, status: "not_found" };

    const { error } = await admin.auth.admin.updateUserById(profile.id, { password });
    if (error) return { email, status: "error", message: error.message };

    await admin.from("profiles").update({ must_change_password: mustChange }).eq("id", profile.id);
    return { email, status: "password_updated" };
  }

  if (body.action === "create") {
    const email = String(body.email || "").trim();
    if (!email) return json({ error: "email erforderlich" }, 400);
    return json(await createOne(email, (body.name as string) || null));
  }

  if (body.action === "delete") {
    const email = String(body.email || "").trim();
    if (!email) return json({ error: "email erforderlich" }, 400);
    return json(await deleteOne(email));
  }

  // Passwort-Synchronisation vom Dashboard-Projekt (siehe supabase/functions/
  // admin-users): "set_password" bei Selbstbedienung, "reset_password" bei
  // Admin-Reset im Dashboard.
  if (body.action === "set_password" || body.action === "reset_password") {
    const email = String(body.email || "").trim();
    const password = String(body.password || "");
    if (!email || !password) return json({ error: "email und password erforderlich" }, 400);
    return json(await setPassword(email, password, body.action === "reset_password"));
  }

  // Einmaliger Bulk-Import bestehender Dashboard-Nutzer.
  if (body.action === "bulk_create") {
    const users = Array.isArray(body.users) ? body.users as { email: string; name?: string }[] : [];
    const results = [];
    for (const u of users) {
      if (!u.email) continue;
      results.push(await createOne(u.email.trim(), u.name || null));
    }
    return json({ ok: true, results });
  }

  return json({ error: "Unbekannte action" }, 400);
});
