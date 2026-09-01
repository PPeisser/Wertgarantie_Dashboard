// Performance Dialog: KI-gestützter Jahres-/Monatsbericht (Admin-Only,
// on-demand). Fasst die im gewählten Zeitraum abgegebenen Performance-
// Dialog-Protokolle zusammen und gleicht Monate/Mitarbeiter ab -
// ZUSÄTZLICH zu den bestehenden Einzel-/Monatsprotokollen, ersetzt diese
// nicht (siehe Nutzervorgabe 22.08.2026). Nutzt die Anthropic Messages API
// mit erzwungenem Tool-Call, damit die Antwort garantiert dem erwarteten
// JSON-Schema entspricht (keine Freitext-Parsing-Fehler).
//
// Zeitraum (Nutzervorgabe 01.09.2026): optionaler "month"-Parameter im
// Request-Body schaltet von "ganzes Jahr, Trend über alle Monate" auf
// "genau ein Monat" um - dafür werden Query/Tool-Schema/Prompt/Response-
// Form unten jeweils zwischen den beiden Modi verzweigt. Kein Monat
// angegeben -> unverändertes Jahresbericht-Verhalten (Abwärtskompatibilität).
//
// Auth: normale Nutzer-Session (Authorization-Header), serverseitig auf
// role="admin" geprüft - anders als dashboard-mailer/performance-dialog-
// reminder NICHT über x-cron-secret, da dies eine gezielte Admin-Aktion
// per Klick ist, kein Cron-Job.
//
// Secret: ANTHROPIC_API_KEY (Supabase Dashboard -> Project Settings ->
// Edge Functions -> Secrets, vom Nutzer am 22.08.2026 hinterlegt).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

const MONATE = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
];

const PERF_GOAL_TITLES: Record<number, string> = {
  1: "Persönliches Produktionsziel",
  2: "Persönliches Akquise-Ziel",
  3: "Mieten statt Kaufen",
  4: "Steigerung der Premium-Option bei Telekommunikation",
  5: "Steigerung der Gebrauchtgeräte-Quote",
};

const PERF_QUESTIONS: [string, string][] = [
  ["massnahmen", "Welche Maßnahmen haben im letzten Monat auf das Ziel eingezahlt?"],
  ["gut", "Was hat gut funktioniert?"],
  ["nicht_mehr", "Was werde ich nicht mehr machen?"],
  ["unterstuetzung", "Wo brauche ich Unterstützung und von wem?"],
];

function pct(v: number | null | undefined): string {
  return v == null ? "–" : (v * 100).toFixed(1).replace(".", ",") + " %";
}

// Textform der "Auswertung aus dem System" je Ziel - dieselben Feldnamen
// wie perfGoalSnapshot()/perfGoalSystemHtml() im Client (index.html), aber
// als Klartext statt HTML, da hier keine Anzeige, sondern ein KI-Prompt
// gefüttert wird. Bewusste Duplizierung (kein gemeinsames Modul zwischen
// Client und Edge Function), wie bei den anderen Funktionen dieses Projekts.
// deno-lint-ignore no-explicit-any
function formatSnapshot(goalId: number, snap: any): string {
  if (!snap) return "(keine Kennzahlen)";
  if (goalId === 1) {
    const jp = snap.jahr_ziel > 0 ? (snap.jahr_ist / snap.jahr_ziel * 100).toFixed(1) : null;
    const mp = snap.monat_ziel > 0 ? (snap.monat_ist / snap.monat_ziel * 100).toFixed(1) : null;
    return `Jahr ${snap.year}: ${snap.jahr_ist} / ${snap.jahr_ziel || "–"} Stk.${jp ? ` (${jp} %)` : ""}; ` +
      `Monat ${MONATE[snap.month - 1]}: ${snap.monat_ist} / ${snap.monat_ziel || "–"} Stk.${mp ? ` (${mp} %)` : ""}`;
  }
  if (goalId === 2) {
    const sp = snap.staffeln_ziel > 0 ? (snap.staffeln_ist / snap.staffeln_ziel * 100).toFixed(1) : null;
    return `Akquisestufen ${snap.year}: ${snap.staffeln_ist} / ${snap.staffeln_ziel || "–"}${sp ? ` (${sp} %)` : ""}; ` +
      `Aktivierungsquote: ${pct(snap.aktivierung_quote)} (${snap.aktivierung_aktiv} von ${snap.aktivierung_angelegt} FH mit mind. 1 Vertrag ${snap.year})`;
  }
  if (goalId === 3) {
    return `Neu gewonnene Miet-FH ${snap.year}: ${snap.neu_fh_jahr}; Vormonat: ${snap.neu_fh_vormonat}; ` +
      `Mietverträge Jahr: ${snap.jahr_ist} / ${snap.jahr_ziel}; Mietverträge Vormonat: ${snap.monat_ist} / ${snap.monat_ziel}`;
  }
  if (goalId === 4) {
    return `PO-Quote (gewichtet): ${pct(snap.po_quote)} - Ziel mind. ${(snap.ziel * 100).toFixed(0)} %`;
  }
  if (goalId === 5) {
    return `GW-Quote aktuell: ${pct(snap.gw_quote_lj)} - Ziel mind. ${(snap.ziel * 100).toFixed(0)} % (Vorjahr: ${pct(snap.gw_quote_vj)})`;
  }
  return "(unbekanntes Ziel)";
}

// deno-lint-ignore no-explicit-any
function formatReportForPrompt(rep: any): string {
  const goals = rep.goals || [];
  const parts = goals.map((g: any) => {
    const title = PERF_GOAL_TITLES[g.goal_id] || `Ziel ${g.goal_id}`;
    const kennzahlen = formatSnapshot(g.goal_id, g.snapshot);
    const antworten = PERF_QUESTIONS.map(([key, label]) => `  - ${label}\n    ${(g.answers && g.answers[key]) || "(keine Antwort)"}`).join("\n");
    return `  [${title}]\n  Kennzahlen: ${kennzahlen}\n${antworten}`;
  }).join("\n\n");
  return `### ${rep.employee} - ${MONATE[rep.month - 1]} ${rep.year}\n${parts}`;
}

const REPORT_TOOL = {
  name: "generate_annual_report",
  description: "Erstellt den strukturierten Performance-Dialog-Jahresbericht.",
  input_schema: {
    type: "object",
    properties: {
      employees: {
        type: "array",
        description: "Ein Eintrag je Mitarbeiter mit abgegebenen Protokollen im gewählten Jahr.",
        items: {
          type: "object",
          properties: {
            employee: { type: "string" },
            months: {
              type: "array",
              description: "Ein Eintrag je Monat, für den ein Protokoll vorliegt.",
              items: {
                type: "object",
                properties: {
                  month: { type: "integer", description: "1-12" },
                  summary: { type: "string", description: "Kurze, konkrete Analyse dieses Monats (2-4 Sätze): Kennzahlen-Stand, was aus den Antworten hervorsticht." },
                },
                required: ["month", "summary"],
              },
            },
            yearSummary: { type: "string", description: "Zusammenfassung des GESAMTEN Jahres für diesen Mitarbeiter (1-2 Absätze): Entwicklung über die Monate hinweg, wiederkehrende Themen/Muster, Zielerreichung im Trend." },
          },
          required: ["employee", "months", "yearSummary"],
        },
      },
      companySummary: {
        type: "string",
        description: "Unternehmensweite Zusammenfassung über alle Mitarbeiter und das gesamte Jahr (2-4 Absätze): gemeinsame Muster, Unterstützungsbedarf, auffällige Unterschiede zwischen Mitarbeitern.",
      },
    },
    required: ["employees", "companySummary"],
  },
};

// Monatsbericht-Variante (01.09.2026): flacher als REPORT_TOOL - genau ein
// Monat, daher kein months[]-Array je Mitarbeiter und kein Jahres-Trend
// (yearSummary). companySummary bezieht sich hier nur auf diesen einen Monat.
const MONTHLY_REPORT_TOOL = {
  name: "generate_monthly_report",
  description: "Erstellt den strukturierten Performance-Dialog-Monatsbericht für genau einen Monat.",
  input_schema: {
    type: "object",
    properties: {
      employees: {
        type: "array",
        description: "Ein Eintrag je Mitarbeiter mit abgegebenem Protokoll in diesem Monat.",
        items: {
          type: "object",
          properties: {
            employee: { type: "string" },
            summary: { type: "string", description: "Konkrete Analyse dieses Mitarbeiters für diesen Monat (2-4 Sätze): Kennzahlen-Stand, was aus den Antworten hervorsticht, ggf. Unterstützungsbedarf." },
          },
          required: ["employee", "summary"],
        },
      },
      companySummary: {
        type: "string",
        description: "Unternehmensweite Zusammenfassung über alle Mitarbeiter für DIESEN EINEN Monat (1-3 Absätze): gemeinsame Muster, Unterstützungsbedarf, auffällige Unterschiede zwischen Mitarbeitern.",
      },
    },
    required: ["employees", "companySummary"],
  },
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "Fehlender Authorization-Header" }, 401);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: { user }, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !user) return json({ error: "Ungültige Session" }, 401);

  const { data: profile } = await admin.from("profiles").select("role").eq("id", user.id).maybeSingle();
  if (profile?.role !== "admin") return json({ error: "Nur für Admins" }, 403);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Ungültiger Body" }, 400); }
  const year = Number(body.year);
  if (!year || year < 2000 || year > 3000) return json({ error: "Ungültiges Jahr" }, 400);
  // month ist optional (01.09.2026) - vorhanden -> Monatsbericht-Modus,
  // sonst unverändertes Jahresbericht-Verhalten.
  const monthRaw = body.month;
  const month = monthRaw == null || monthRaw === "" ? null : Number(monthRaw);
  if (month != null && (!Number.isInteger(month) || month < 1 || month > 12)) {
    return json({ error: "Ungültiger Monat" }, 400);
  }

  let reportsQuery = admin
    .from("performance_dialog_reports").select("*").eq("year", year).eq("is_draft", false);
  if (month != null) reportsQuery = reportsQuery.eq("month", month);
  const { data: reports, error: repErr } = await reportsQuery.order("employee").order("month");
  if (repErr) return json({ error: repErr.message }, 500);
  const zeitraumLbl = month != null ? `${MONATE[month - 1]} ${year}` : `${year}`;
  if (!reports || !reports.length) {
    return json({ error: `Für ${zeitraumLbl} liegen noch keine Performance-Dialog-Protokolle vor.` }, 400);
  }

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "ANTHROPIC_API_KEY ist nicht als Supabase-Secret hinterlegt." }, 500);

  const employeeList = [...new Set(reports.map((r) => r.employee as string))];
  const promptBody = reports.map(formatReportForPrompt).join("\n\n---\n\n");

  const systemPrompt = month != null
    ? `Du erstellst einen internen Monatsbericht für das Wertgarantie Performance Dashboard auf Basis der ` +
      `"Performance Dialog"-Protokolle von Vertriebsmitarbeitern für GENAU EINEN Monat. Jedes Protokoll enthält ` +
      `System-Kennzahlen zu den persönlichen Zielen des Monats sowie vier Freitext-Antworten des Mitarbeiters. ` +
      `Analysiere die Daten sachlich und konkret - Kennzahlen-Stand, was aus den Antworten hervorsticht, ggf. ` +
      `Unterstützungsbedarf. Da nur ein Monat vorliegt, gibt es KEINEN Trend über mehrere Monate - erfinde keinen. ` +
      `Schreibe auf Deutsch, professionell, prägnant, ohne Floskeln. Gehe NUR auf Mitarbeiter ein, für die ` +
      `tatsächlich ein Protokoll vorliegt. Antworte ausschließlich über das Tool "generate_monthly_report".`
    : `Du erstellst einen internen Jahresbericht für das Wertgarantie Performance Dashboard auf Basis der ` +
      `monatlichen "Performance Dialog"-Protokolle von Vertriebsmitarbeitern. Jedes Protokoll enthält System-` +
      `Kennzahlen zu den persönlichen Zielen des Monats sowie vier Freitext-Antworten des Mitarbeiters. ` +
      `Analysiere die Daten sachlich und konkret, erkenne Muster/Trends über die Monate hinweg (z.B. wiederkehrende ` +
      `Themen, Verbesserung/Verschlechterung der Zielerreichung, wiederholt genannter Unterstützungsbedarf). ` +
      `Schreibe auf Deutsch, professionell, prägnant, ohne Floskeln. Gehe NUR auf Monate/Mitarbeiter ein, für die ` +
      `tatsächlich Protokolle vorliegen - erfinde nichts für fehlende Monate. Antworte ausschließlich über das ` +
      `Tool "generate_annual_report".`;

  const userPrompt = month != null
    ? `Monat: ${zeitraumLbl}\nMitarbeiter mit Protokollen: ${employeeList.join(", ")}\n\n` +
      `Rohdaten aller Protokolle dieses Monats:\n\n${promptBody}`
    : `Jahr: ${year}\nMitarbeiter mit Protokollen: ${employeeList.join(", ")}\n\n` +
      `Rohdaten aller Protokolle dieses Jahres:\n\n${promptBody}`;

  const tool = month != null ? MONTHLY_REPORT_TOOL : REPORT_TOOL;

  let aiRes: Response;
  try {
    aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 8000,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
        tools: [tool],
        tool_choice: { type: "tool", name: tool.name },
      }),
    });
  } catch (e) {
    return json({ error: "Anthropic-API nicht erreichbar: " + String(e) }, 502);
  }

  if (!aiRes.ok) {
    const errText = await aiRes.text();
    return json({ error: `Anthropic-API-Fehler (${aiRes.status}): ${errText}` }, 502);
  }

  const aiJson = await aiRes.json();
  const toolUse = (aiJson.content || []).find((c: { type: string }) => c.type === "tool_use");
  if (!toolUse) return json({ error: "KI-Antwort enthielt keinen strukturierten Bericht." }, 502);

  return json({ ok: true, year, month, report: toolUse.input });
});
