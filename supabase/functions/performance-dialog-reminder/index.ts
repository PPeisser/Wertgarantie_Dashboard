// Performance Dialog: erinnert Mitarbeiter automatisch an das monatliche
// Protokoll für den abgeschlossenen Vormonat. Läuft täglich per pg_cron
// (siehe schema.sql, Job "performance-dialog-reminder-daily") - prüft
// anhand der aktuellen Wiener Ortszeit:
//   - Freitag (jeder, ab dem ersten im Monat): wöchentliche Erinnerung an
//     alle Mitarbeiter mit noch offenem Vormonats-Protokoll.
//   - 15. des Monats: zusätzliche, einmalige Mail, falls weiterhin offen.
// Sendet über die bestehende dashboard-mailer-Funktion (send-Action, per
// CRON_SECRET geschützt) - keine doppelte SMTP-Logik.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

// Dieselben 6 Mitarbeiter wie PERF_GOALS_BY_EMPLOYEE in index.html - bei
// Personalwechsel an BEIDEN Stellen pflegen (kein gemeinsames Modul zwischen
// Client und Edge Function, daher bewusste Duplizierung dieser kurzen Liste).
const PERF_EMPLOYEES = [
  "Klaus Witting", "Florian Hasibeder", "Peter Peißer", "Helmut Otto",
  "Dominik Szendi", "Thomas Eitzinger",
];

const MONATE = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
];

// Wiener Ortszeit (Europe/Vienna) statt UTC, da "erster Freitag"/"15." aus
// Sicht der Mitarbeiter in Österreich gemeint sind, nicht des Server-UTC.
function viennaNow(): { year: number; month: number; day: number; weekday: number } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Vienna", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  });
  const parts = fmt.formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: +get("year"), month: +get("month"), day: +get("day"),
    weekday: weekdayMap[get("weekday")] ?? -1,
  };
}

function prevMonth(year: number, month: number) {
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

async function sendReminderMail(to: string, subject: string, html: string): Promise<boolean> {
  const url = Deno.env.get("SUPABASE_URL")! + "/functions/v1/dashboard-mailer";
  const secret = Deno.env.get("CRON_SECRET")!;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-cron-secret": secret },
      body: JSON.stringify({ type: "send", to, subject, html }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const secret = req.headers.get("x-cron-secret") || "";
  if (!secret || secret !== Deno.env.get("CRON_SECRET")) {
    return json({ error: "Nicht autorisiert" }, 401);
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Performance Dialog kann von einem Admin im Performance Dialog – ADMIN
  // PopUp per Schalter deaktiviert werden (dashboard_kv-Key
  // "performance_dialog_enabled") - solange das der Fall ist, sollen auch
  // keine Erinnerungsmails verschickt werden.
  const { data: flagRow } = await admin
    .from("dashboard_kv").select("value").eq("key", "performance_dialog_enabled").maybeSingle();
  if (flagRow?.value !== "1") {
    return json({ ok: true, skipped: "Performance Dialog ist deaktiviert" });
  }

  const now = viennaNow();
  const isFriday = now.weekday === 5;
  const isFifteenth = now.day === 15;
  if (!isFriday && !isFifteenth) {
    return json({ ok: true, skipped: "weder Freitag noch der 15. (Wien)" });
  }

  // Freigeschalteter Berichtsmonat (dashboard_kv-Key "perf_active_period",
  // Format "YYYY-MM") - deckungsgleiche Logik wie loadPerfActivePeriod() im
  // Client: schaltet automatisch nur dann auf den neuen Vormonat weiter,
  // wenn seit dem letzten Abgleich ein neuer Kalendermonat begonnen hat
  // (erkannt via "perf_active_period_synced_default") - ein Admin kann
  // dazwischen per PopUp jederzeit einen beliebigen ANDEREN Monat
  // freischalten (auch einen älteren), ohne dass diese Wahl beim nächsten
  // Cron-Lauf sofort wieder überschrieben wird.
  const defaultPeriod = prevMonth(now.year, now.month);
  const defaultYm = `${defaultPeriod.year}-${String(defaultPeriod.month).padStart(2, "0")}`;
  const { data: activeRow } = await admin
    .from("dashboard_kv").select("value").eq("key", "perf_active_period").maybeSingle();
  const { data: syncedRow } = await admin
    .from("dashboard_kv").select("value").eq("key", "perf_active_period_synced_default").maybeSingle();
  let activeYm = activeRow?.value;
  if (!activeYm || syncedRow?.value !== defaultYm) {
    activeYm = defaultYm;
    const nowIso = new Date().toISOString();
    await admin.from("dashboard_kv").upsert({ key: "perf_active_period", value: activeYm, updated_at: nowIso });
    await admin.from("dashboard_kv").upsert({ key: "perf_active_period_synced_default", value: defaultYm, updated_at: nowIso });
  }
  const [year, month] = activeYm.split("-").map(Number);

  const { data: reportRows, error: repErr } = await admin
    .from("performance_dialog_reports").select("employee").eq("year", year).eq("month", month);
  if (repErr) return json({ error: repErr.message }, 500);
  const submitted = new Set((reportRows || []).map((r) => r.employee as string));

  const missing = PERF_EMPLOYEES.filter((e) => !submitted.has(e));
  if (!missing.length) return json({ ok: true, period: `${MONATE[month - 1]} ${year}`, missing: 0 });

  const { data: profiles, error: profErr } = await admin
    .from("profiles").select("name,email").in("name", missing);
  if (profErr) return json({ error: profErr.message }, 500);

  const periodLabel = `${MONATE[month - 1]} ${year}`;
  let sentFriday = 0, sentFifteenth = 0;
  const noEmail: string[] = [];

  for (const emp of missing) {
    const profile = (profiles || []).find((p) => p.name === emp);
    if (!profile?.email) { noEmail.push(emp); continue; }

    if (isFriday) {
      const ok = await sendReminderMail(
        profile.email,
        `Erinnerung: Performance Dialog ${periodLabel}`,
        `<div style="font-family:'Segoe UI',Arial,sans-serif;color:#10202C">
          <p>Hallo ${emp},</p>
          <p>bitte vergiss nicht, deinen Performance Dialog für <b>${periodLabel}</b> im Wertgarantie Performance Dashboard auszufüllen.</p>
          <p>Liebe Grüße<br>Wertgarantie Performance Dashboard</p>
        </div>`,
      );
      if (ok) sentFriday++;
    }
    if (isFifteenth) {
      const ok = await sendReminderMail(
        profile.email,
        `Letzte Erinnerung: Performance Dialog ${periodLabel} noch offen`,
        `<div style="font-family:'Segoe UI',Arial,sans-serif;color:#10202C">
          <p>Hallo ${emp},</p>
          <p>dein Performance Dialog für <b>${periodLabel}</b> ist noch immer nicht abgegeben - bitte hole das zeitnah nach.</p>
          <p>Liebe Grüße<br>Wertgarantie Performance Dashboard</p>
        </div>`,
      );
      if (ok) sentFifteenth++;
    }
  }

  return json({ ok: true, period: periodLabel, missing: missing.length, sentFriday, sentFifteenth, noEmail });
});
