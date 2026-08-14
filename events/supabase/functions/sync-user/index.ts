// Nutzer-Synchronisation vom Performance-Dashboard-Projekt in dieses
// Events-Projekt: Wenn im Dashboard ein Nutzer angelegt oder gelöscht wird,
// ruft dessen admin-users Edge Function diese Function hier auf, damit
// derselbe Nutzer auch Zugriff auf das Event-Admin-Panel hat/verliert.
//
// Läuft serverseitig, nutzt den service_role Key (nur hier, nie im
// Browser-Code) und ist über SYNC_SECRET geschützt (Edge-Function-Secret,
// identisch zu EVENTS_SYNC_SECRET im Dashboard-Projekt).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-sync-secret",
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const secret = req.headers.get("x-sync-secret") || "";
  if (!secret || secret !== Deno.env.get("SYNC_SECRET")) {
    return json({ error: "Nicht autorisiert" }, 401);
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Ungültiger Body" }, 400); }

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
