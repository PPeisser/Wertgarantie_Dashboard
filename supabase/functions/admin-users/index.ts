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

  // After-Sales-Tool (Zugänge für Fachhändler, Einstellungen → After-Sales-
  // Zugänge): darf JEDE Dashboard-Rolle, sobald ein Admin das Tool unter
  // Admin-Panel → Funktionen freigeschaltet hat (dashboard_kv
  // "aftersales_enabled"). Admin-Zugänge im Tool anlegen/ändern dürfen nur
  // Dashboard-Admins (caller_is_admin, geprüft in aftersales-users).
  // Die Nutzer leben im Event-Projekt (aftersales-users Edge Function) -
  // gleiche URL-Basis + gleiches Secret wie der Events-Sync.
  if (action === "aftersales") {
    if (profErr || !profile || !["admin", "aussendienst", "trainer"].includes(profile.role)) {
      return json({ error: "Kein Zugriff" }, 403);
    }
    const isAdmin = profile.role === "admin";
    if (!isAdmin) {
      const { data: kv } = await admin.from("dashboard_kv").select("value").eq("key", "aftersales_enabled").maybeSingle();
      if (kv?.value !== "1") return json({ error: "Das After-Sales-Tool ist derzeit nicht freigeschaltet" }, 403);
    }
    const syncUrl = Deno.env.get("EVENTS_SYNC_URL");
    const secret = Deno.env.get("EVENTS_SYNC_SECRET");
    if (!syncUrl || !secret) return json({ error: "After-Sales-Verbindung nicht konfiguriert (EVENTS_SYNC_URL/SECRET fehlen)" }, 500);
    const payload: Record<string, unknown> = { ...((body.payload || {}) as Record<string, unknown>), caller_is_admin: isAdmin, caller_email: user.email };
    // Händlerdaten fürs Vorbefüllen im After-Sales-Tool: Adresse, E-Mail
    // Geschäft, Telefon, Homepage aus fh_contacts; der Händlername steht dort
    // nicht (Spalte leer), sondern nur im Tages-Snapshot (wg-state ->
    // latest.fh, wie fhResolveNameOrt() im Dashboard) - daher zusätzlich per
    // aftersales_fh_lookup(). Unbekannte FH-Nummern werden beim Anlegen
    // abgelehnt, damit Zugänge immer zu unserem Datenstand passen.
    if ((payload.op === "create" || payload.op === "dealer_sync") && payload.fh_nr) {
      const fhNr = String(payload.fh_nr).trim();
      const [{ data: fh }, { data: snap }] = await Promise.all([
        admin.from("fh_contacts").select("strasse,plz,ort,email,telefon,homepage").eq("fh_nr", fhNr).maybeSingle(),
        admin.rpc("aftersales_fh_lookup", { p_fh_nr: fhNr }),
      ]);
      if (!fh && !snap) {
        return json({ error: `FH-Nummer ${fhNr} ist in unserem Datenstand nicht bekannt` }, 400);
      }
      payload.dealer = {
        name: snap?.name || null,
        strasse: fh?.strasse || null,
        plz: fh?.plz || snap?.plz || null,
        ort: fh?.ort || snap?.ort || null,
        email: fh?.email || null,
        telefon: fh?.telefon || null,
        homepage: fh?.homepage || null,
      };
    }
    const url = syncUrl.replace(/sync-user\/?$/, "aftersales-users");
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-sync-secret": secret },
        body: JSON.stringify(payload),
      });
      const j = await res.json().catch(() => ({ error: "Ungültige Antwort vom After-Sales-Tool" }));
      return json(j, res.ok ? 200 : res.status);
    } catch (e) {
      return json({ error: "After-Sales-Tool nicht erreichbar: " + String(e) }, 502);
    }
  }

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
