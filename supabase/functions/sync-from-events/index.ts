// Passwort-Synchronisation vom Events-Projekt zurück in dieses
// Dashboard-Projekt: Wenn ein Nutzer sein Passwort im Event-Admin-Panel
// selbst ändert, ruft dessen sync-user Edge Function diese Function hier
// auf, damit dasselbe Passwort auch im Dashboard gilt.
//
// Läuft serverseitig, nutzt den service_role Key (nur hier, nie im
// Browser-Code) und ist über FROM_EVENTS_SYNC_SECRET geschützt
// (Edge-Function-Secret, identisch zu DASHBOARD_SYNC_SECRET im
// Events-Projekt). Kein User-JWT nötig/möglich, da der Aufrufer der
// Events-Server ist, nicht ein Dashboard-Nutzer.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-events-sync-secret",
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

  const secret = req.headers.get("x-events-sync-secret") || "";
  if (!secret || secret !== Deno.env.get("FROM_EVENTS_SYNC_SECRET")) {
    return json({ error: "Nicht autorisiert" }, 401);
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Ungültiger Body" }, 400); }

  if (body.action !== "set_password") {
    return json({ error: "Unbekannte action" }, 400);
  }

  const email = String(body.email || "").trim();
  const password = String(body.password || "");
  if (!email || !password) return json({ error: "email und password erforderlich" }, 400);

  const { data: profile } = await admin.from("profiles").select("id").eq("email", email).maybeSingle();
  if (!profile) return json({ email, status: "not_found" });

  const { error } = await admin.auth.admin.updateUserById(profile.id, { password });
  if (error) return json({ email, status: "error", message: error.message });

  // Selbst gewähltes Passwort (Events-Seite) – kein erneuter Zwang zur
  // Änderung im Dashboard nötig.
  await admin.from("profiles").update({ must_change_password: false }).eq("id", profile.id);
  return json({ email, status: "password_updated" });
});
