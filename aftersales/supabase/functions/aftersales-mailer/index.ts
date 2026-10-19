// After-Sales: Versand der personalisierten Einladungsmails (Link zur
// Landingpage) - einzeln oder gesammelt. Aufruf aus dem Tool mit dem
// Supabase-Token des eingeloggten Nutzers; Admins dürfen alle Datensätze
// versenden, Fachhändler nur die ihrer eigenen FH-Nummer.
//
// POST {action:"send", recordIds:[...]}  (max. 50 pro Aufruf - der Browser teilt größere Mengen auf)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CORS_HEADERS, json } from "../_shared/common.ts";
import { inviteMail } from "../_shared/templates.ts";
import { SmtpSession } from "../_shared/smtp.ts";

const MAX_PER_CALL = 50;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: { user } } = await admin.auth.getUser(token);
  if (!user) return json({ error: "Ungültige Session" }, 401);
  const { data: me } = await admin.from("profiles").select("role,fh_nr,aftersales_access,name").eq("id", user.id).maybeSingle();
  if (!me || !me.aftersales_access || !["admin", "fachhaendler"].includes(me.role)) {
    return json({ error: "Kein Zugriff auf das After-Sales-Tool" }, 403);
  }

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Ungültiger Body" }, 400); }
  if (body.action !== "send") return json({ error: "Unbekannte Aktion" }, 400);

  const ids = (Array.isArray(body.recordIds) ? body.recordIds : []).map(String).slice(0, MAX_PER_CALL);
  if (!ids.length) return json({ error: "Keine Datensätze gewählt" }, 400);

  let q = admin.from("as_records").select("*").in("id", ids);
  if (me.role !== "admin") q = q.eq("fh_nr", me.fh_nr || "__none__");
  const { data: recs, error } = await q;
  if (error) return json({ error: error.message }, 500);

  const dealerNames = new Map<string, string>();
  async function dealerName(fh: string) {
    if (!dealerNames.has(fh)) {
      const { data } = await admin.from("profiles").select("name").eq("fh_nr", fh).eq("role", "fachhaendler").limit(1);
      dealerNames.set(fh, data?.[0]?.name || "");
    }
    return dealerNames.get(fh)!;
  }

  const results: { id: string; ok: boolean; error?: string }[] = [];
  const sendable = (recs || []).filter((r) => {
    let err = "";
    if (r.status === "abgeschlossen") err = "bereits abgeschlossen";
    else if (r.status === "storniert") err = "storniert";
    else if (!r.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email)) err = "keine gültige E-Mail-Adresse";
    if (err) results.push({ id: r.id, ok: false, error: err });
    return !err;
  });

  if (sendable.length) {
    const s = new SmtpSession();
    try {
      await s.open();
    } catch (e) {
      return json({ error: "SMTP-Verbindung fehlgeschlagen: " + String(e) }, 502);
    }
    try {
      for (const r of sendable) {
        try {
          const m = inviteMail(r, await dealerName(r.fh_nr));
          // Link soll ab Versand wieder volle 30 Tage gelten.
          const messageId = await s.send({ to: [r.email], subject: m.subject, html: m.html });
          const now = new Date();
          await admin.from("as_records").update({
            status: ["importiert", "fehler", "bounce"].includes(r.status) ? "versendet" : r.status,
            sent_at: now.toISOString(), send_count: (r.send_count || 0) + 1, send_error: null,
            expires_at: new Date(now.getTime() + 30 * 864e5).toISOString(),
          }).eq("id", r.id);
          await admin.from("as_events").insert({ record_id: r.id, type: "sent", meta: { messageId, by: user.email } });
          results.push({ id: r.id, ok: true });
        } catch (e) {
          const msg = String(e).slice(0, 300);
          await admin.from("as_records").update({ status: r.status === "importiert" ? "fehler" : r.status, send_error: msg }).eq("id", r.id);
          await admin.from("as_events").insert({ record_id: r.id, type: "send_failed", meta: { error: msg } });
          results.push({ id: r.id, ok: false, error: msg });
          // Nach einem SMTP-Fehler ist die Session evtl. unbrauchbar → neu verbinden.
          try { await s.close(); await s.open(); } catch { /* nächster Versuch scheitert ggf. ebenfalls */ }
        }
      }
    } finally {
      await s.close();
    }
  }
  for (const id of ids) if (!results.some((r) => r.id === id)) results.push({ id, ok: false, error: "nicht gefunden / kein Zugriff" });
  return json({ ok: true, sent: results.filter((r) => r.ok).length, results });
});
