// After-Sales: "Passwort vergessen" (öffentlich, verify_jwt=false).
// Erzeugt über die Admin-API einen Recovery-Token und verschickt den Link
// selbst über SMTP (statt Supabase-Auth-Mails) - so braucht es weder eine
// eigene Auth-SMTP-Konfiguration noch einen Redirect-Allowlist-Eintrag:
// der Link führt auf die After-Sales-App, die den token_hash per
// sb.auth.verifyOtp({type:"recovery"}) einlöst.
//
// Antwortet IMMER mit ok, damit nicht erkennbar ist, ob eine Adresse existiert.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CORS_HEADERS, appUrl, escapeHtml, json } from "../_shared/common.ts";
import { sendOne } from "../_shared/smtp.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Ungültiger Body" }, 400); }
  if (body.action !== "forgot") return json({ error: "Unbekannte Aktion" }, 400);

  const email = String(body.email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ ok: true });

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: prof } = await admin.from("profiles").select("id,name,role,aftersales_access")
    .ilike("email", email).maybeSingle();
  if (!prof || !prof.aftersales_access || !["admin", "fachhaendler"].includes(prof.role)) return json({ ok: true });

  const { data, error } = await admin.auth.admin.generateLink({ type: "recovery", email });
  const hash = data?.properties?.hashed_token;
  if (error || !hash) {
    console.error("generateLink failed", error);
    return json({ ok: true });
  }
  const link = `${appUrl()}/?reset=${encodeURIComponent(hash)}`;
  const html = `<div style="font-family:'Segoe UI',Arial,sans-serif;color:#10202C;font-size:15px;line-height:1.6">
<img src="${appUrl()}/logo.png" alt="Wertgarantie" width="180" style="display:block;margin-bottom:18px">
<p>Hallo ${escapeHtml(prof.name || "")},</p>
<p>für Ihren Zugang zum <b>Wertgarantie After-Sales-Tool</b> wurde ein neues Passwort angefordert.</p>
<p><a href="${link}" style="display:inline-block;background:#009FE3;color:#fff;padding:12px 24px;border-radius:999px;text-decoration:none;font-weight:700">Neues Passwort festlegen</a></p>
<p style="font-size:12.5px;color:#5D7284">Der Link ist 1 Stunde gültig. Falls Sie das nicht angefordert haben, können Sie diese Mail ignorieren.</p></div>`;
  try {
    await sendOne({ to: [email], subject: "Wertgarantie After-Sales-Tool: Passwort zurücksetzen", html });
  } catch (e) {
    console.error("forgot mail failed", e);
  }
  return json({ ok: true });
});
