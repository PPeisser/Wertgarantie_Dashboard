// Performance Dialog: KI-gestützter Jahresbericht (Admin-Only, on-demand).
// Fasst alle im gewählten Jahr abgegebenen Performance-Dialog-Protokolle
// zusammen und gleicht Monate/Mitarbeiter ab - ZUSÄTZLICH zu den
// bestehenden Einzel-/Monatsprotokollen, ersetzt diese nicht (siehe
// Nutzervorgabe 22.08.2026). Nutzt die Anthropic Messages API mit
// erzwungenem Tool-Call, damit die Antwort garantiert dem erwarteten
// JSON-Schema entspricht (keine Freitext-Parsing-Fehler).
//
// Auth: normale Nutzer-Session (Authorization-Header), serverseitig auf
// role="admin" geprüft - anders als dashboard-mailer/performance-dialog-
// reminder NICHT über x-cron-secret, da dies eine gezielte Admin-Aktion
// per Klick ist, kein Cron-Job.
//
// Secret: ANTHROPIC_API_KEY (Supabase Dashboard -> Project Settings ->
// Edge Functions -> Secrets, vom Nutzer am 22.08.2026 hinterlegt).
//
// Pseudonymisierung (Nutzervorgabe 01.09.2026, DSGVO): echte Mitarbeiternamen
// werden NIE an Anthropic uebermittelt. Jeder Mitarbeiter mit Protokollen in
// diesem Jahr bekommt einen Platzhalter-Token (z.B. "MITARBEITER_1"); dieser
// Token ersetzt den Namen sowohl in den "### Name - Monat"-Ueberschriften als
// auch in den Freitext-Antworten (falls dort ein Kollege namentlich erwaehnt
// wird). Die KI wird angewiesen, ausschliesslich diese Platzhalter zu
// verwenden. Erst NACH Erhalt der KI-Antwort (server-seitig, bevor sie ans
// Dashboard zurückgeht) werden alle Platzhalter wieder durch die echten
// Namen ersetzt (deepReplace ueber die komplette Antwortstruktur).

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

// Ersetzt jedes bekannte Mitarbeiter-Namen-Vorkommen in einem Text durch den
// zugehoerigen Platzhalter-Token (siehe Pseudonymisierungs-Hinweis oben).
// Laengere Namen zuerst ersetzen, damit z.B. "Anna Maria" nicht schon durch
// eine Teilersetzung von "Anna" zerstoert wird.
function pseudonymizeText(s: string, tokenOf: Map<string, string>): string {
  let out = s;
  const names = [...tokenOf.keys()].sort((a, b) => b.length - a.length);
  for (const n of names) { if (n) out = out.split(n).join(tokenOf.get(n)!); }
  return out;
}

// deno-lint-ignore no-explicit-any
function formatReportForPrompt(rep: any, tokenOf: Map<string, string>): string {
  const token = tokenOf.get(rep.employee) || rep.employee;
  const goals = rep.goals || [];
  const parts = goals.map((g: any) => {
    const title = PERF_GOAL_TITLES[g.goal_id] || `Ziel ${g.goal_id}`;
    const kennzahlen = formatSnapshot(g.goal_id, g.snapshot);
    const antworten = PERF_QUESTIONS.map(([key, label]) => `  - ${label}\n    ${pseudonymizeText((g.answers && g.answers[key]) || "(keine Antwort)", tokenOf)}`).join("\n");
    return `  [${title}]\n  Kennzahlen: ${kennzahlen}\n${antworten}`;
  }).join("\n\n");
  return `### ${token} - ${MONATE[rep.month - 1]} ${rep.year}\n${parts}`;
}

// Ersetzt rekursiv jeden String-Wert einer (verschachtelten) Struktur ueber
// den uebergebenen replacer - genutzt, um die Namens-Platzhalter nach der
// KI-Antwort wieder durch die echten Namen zu ersetzen, unabhaengig davon,
// in welchem Feld/welcher Verschachtelungstiefe die KI sie verwendet hat.
// deno-lint-ignore no-explicit-any
function deepReplace(value: any, replacer: (s: string) => string): any {
  if (typeof value === "string") return replacer(value);
  if (Array.isArray(value)) return value.map((v) => deepReplace(v, replacer));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = deepReplace(v, replacer);
    return out;
  }
  return value;
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

  const { data: reports, error: repErr } = await admin
    .from("performance_dialog_reports").select("*").eq("year", year).eq("is_draft", false).order("employee").order("month");
  if (repErr) return json({ error: repErr.message }, 500);
  if (!reports || !reports.length) {
    return json({ error: `Für ${year} liegen noch keine Performance-Dialog-Protokolle vor.` }, 400);
  }

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "ANTHROPIC_API_KEY ist nicht als Supabase-Secret hinterlegt." }, 500);

  const employeeList = [...new Set(reports.map((r) => r.employee as string))];
  const tokenOf = new Map<string, string>();
  employeeList.forEach((n, i) => tokenOf.set(n, `MITARBEITER_${i + 1}`));
  const tokenList = employeeList.map((n) => tokenOf.get(n));
  const promptBody = reports.map((r) => formatReportForPrompt(r, tokenOf)).join("\n\n---\n\n");

  const systemPrompt =
    `Du erstellst einen internen Jahresbericht für das Wertgarantie Performance Dashboard auf Basis der ` +
    `monatlichen "Performance Dialog"-Protokolle von Vertriebsmitarbeitern. Jedes Protokoll enthält System-` +
    `Kennzahlen zu den persönlichen Zielen des Monats sowie vier Freitext-Antworten des Mitarbeiters. ` +
    `Analysiere die Daten sachlich und konkret, erkenne Muster/Trends über die Monate hinweg (z.B. wiederkehrende ` +
    `Themen, Verbesserung/Verschlechterung der Zielerreichung, wiederholt genannter Unterstützungsbedarf). ` +
    `Schreibe auf Deutsch, professionell, prägnant, ohne Floskeln. Gehe NUR auf Monate/Mitarbeiter ein, für die ` +
    `tatsächlich Protokolle vorliegen - erfinde nichts für fehlende Monate. Die echten Mitarbeiternamen werden ` +
    `dir aus Datenschutzgründen NICHT mitgeteilt - jeder Mitarbeiter ist ausschließlich über einen Platzhalter ` +
    `wie "MITARBEITER_1" referenziert. Verwende in deiner GESAMTEN Antwort (inkl. "employee"-Feldern) ` +
    `ausschließlich diese Platzhalter und erfinde oder rekonstruiere KEINE echten Namen. Antworte ausschließlich ` +
    `über das Tool "generate_annual_report".`;

  const userPrompt =
    `Jahr: ${year}\nMitarbeiter mit Protokollen: ${tokenList.join(", ")}\n\n` +
    `Rohdaten aller Protokolle dieses Jahres:\n\n${promptBody}`;

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
        tools: [REPORT_TOOL],
        tool_choice: { type: "tool", name: "generate_annual_report" },
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

  // Platzhalter erst jetzt, server-seitig vor der Antwort ans Dashboard,
  // wieder durch die echten Namen ersetzen (siehe Pseudonymisierungs-Hinweis
  // oben). Laengere Tokens zuerst (MITARBEITER_10 vor MITARBEITER_1), damit
  // keine Teilersetzung einen laengeren Token zerstoert.
  const reverseTokens = [...tokenOf.entries()].sort((a, b) => b[1].length - a[1].length);
  const report = deepReplace(toolUse.input, (s: string) => {
    let out = s;
    for (const [name, tok] of reverseTokens) out = out.split(tok).join(name);
    return out;
  });

  return json({ ok: true, year, report });
});
