// Performance Dialog: KI-gestuetzter Jahres-/Monatsbericht (Admin-Only,
// on-demand). Fasst die im gewaehlten Zeitraum abgegebenen Performance-
// Dialog-Protokolle zusammen und gleicht Monate/Mitarbeiter ab -
// ZUSAeTZLICH zu den bestehenden Einzel-/Monatsprotokollen, ersetzt diese
// nicht (siehe Nutzervorgabe 22.08.2026). Nutzt die Mistral Chat-Completions-
// API (EU-Anbieter, DSGVO-konform, DPA vorhanden - Nutzervorgabe 04.09.2026)
// mit erzwungenem Tool-Call, damit die Antwort garantiert dem erwarteten
// JSON-Schema entspricht (keine Freitext-Parsing-Fehler).
//
// Zeitraum (Nutzervorgabe 01.09.2026): optionaler "month"-Parameter im
// Request-Body schaltet von "ganzes Jahr, Trend ueber alle Monate" auf
// "genau ein Monat" um - dafuer werden Query/Tool-Schema/Prompt/Response-
// Form unten jeweils zwischen den beiden Modi verzweigt. Kein Monat
// angegeben -> unveraendertes Jahresbericht-Verhalten (Abwaertskompatibilitaet).
//
// Auth: normale Nutzer-Session (Authorization-Header), serverseitig auf
// role="admin" geprueft - anders als dashboard-mailer/performance-dialog-
// reminder NICHT ueber x-cron-secret, da dies eine gezielte Admin-Aktion
// per Klick ist, kein Cron-Job.
//
// Secret: MISTRAL_API_KEY (Supabase Dashboard -> Project Settings ->
// Edge Functions -> Secrets, vom Nutzer am 04.09.2026 hinterlegt - ersetzt
// das vorherige ANTHROPIC_API_KEY-Secret).
//
// Pseudonymisierung (Nutzervorgabe 01.09.2026, DSGVO): echte Mitarbeiternamen
// werden NIE an Mistral uebermittelt. Jeder Mitarbeiter mit Protokollen in
// diesem Jahr bekommt einen Platzhalter-Token (z.B. "MITARBEITER_1"); dieser
// Token ersetzt den Namen sowohl in den "### Name - Monat"-Ueberschriften als
// auch in den Freitext-Antworten (falls dort ein Kollege namentlich erwaehnt
// wird). Die KI wird angewiesen, ausschliesslich diese Platzhalter zu
// verwenden. Erst NACH Erhalt der KI-Antwort (server-seitig, bevor sie ans
// Dashboard zurueckgeht) werden alle Platzhalter wieder durch die echten
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

// Ruft Mistral mit erzwungenem Tool-Call auf. temperature:0.2 (statt Default)
// fuer sachliche, konsistente Kennzahlen-Berichte statt kreativer Streuung.
// Ein automatischer zweiter Versuch (Netzwerkfehler, HTTP-Fehler, fehlender
// Tool-Call ODER ungueltiges JSON in den Tool-Argumenten) macht die Antwort
// robust gegen die seltenen, aber moeglichen Ausreisser eines einzelnen
// API-Aufrufs (Nutzervorgabe 04.09.2026: "es soll einwandfrei sein") - erst
// wenn auch der zweite Versuch scheitert, wird der Fehler an den Client
// zurueckgegeben.
async function callMistralTool(
  apiKey: string,
  systemPrompt: string,
  userPrompt: string,
  tool: Record<string, unknown>,
  maxTokens: number,
): Promise<{ report?: unknown; error?: string }> {
  let lastError = "Unbekannter Fehler.";
  for (let attempt = 1; attempt <= 2; attempt++) {
    let aiRes: Response;
    try {
      aiRes = await fetch("https://api.mistral.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + apiKey,
        },
        body: JSON.stringify({
          // Bug-Report 04.09.2026: "mistral-large-latest" liefert fuer den
          // hinterlegten API-Key HTTP 403 "This model is not available in
          // your subscription tier" - im aktuellen Mistral-Tarif nicht
          // freigeschaltet. "mistral-small-latest" ist fuer diesen Key
          // verfuegbar und unterstuetzt Chat-Completions + function_calling
          // (per /v1/models verifiziert).
          model: "mistral-small-latest",
          max_tokens: maxTokens,
          temperature: 0.2,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          tools: [{ type: "function", function: tool }],
          tool_choice: "any",
          parallel_tool_calls: false,
        }),
      });
    } catch (e) {
      lastError = "Mistral-API nicht erreichbar: " + String(e);
      continue;
    }
    if (!aiRes.ok) {
      const errText = await aiRes.text();
      lastError = `Mistral-API-Fehler (${aiRes.status}): ${errText}`;
      continue;
    }
    const aiJson = await aiRes.json();
    const toolCall = aiJson.choices?.[0]?.message?.tool_calls?.[0];
    if (!toolCall) {
      lastError = "KI-Antwort enthielt keine strukturierte Auswertung.";
      continue;
    }
    try {
      return { report: JSON.parse(toolCall.function.arguments) };
    } catch (e) {
      lastError = "KI-Antwort enthielt kein gueltiges JSON: " + String(e);
    }
  }
  return { error: lastError };
}

const MONATE = [
  "Januar", "Februar", "Maerz", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
];

const PERF_GOAL_TITLES: Record<number, string> = {
  1: "Persoenliches Produktionsziel",
  2: "Persoenliches Akquise-Ziel",
  3: "Mieten statt Kaufen",
  4: "Steigerung der Premium-Option bei Telekommunikation",
  5: "Steigerung der Gebrauchtgeraete-Quote",
};

const PERF_QUESTIONS: [string, string][] = [
  ["massnahmen", "Welche Massnahmen haben im letzten Monat auf das Ziel eingezahlt?"],
  ["gut", "Was hat gut funktioniert?"],
  ["nicht_mehr", "Was werde ich nicht mehr machen?"],
  ["unterstuetzung", "Wo brauche ich Unterstuetzung und von wem?"],
];

function pct(v: number | null | undefined): string {
  return v == null ? "-" : (v * 100).toFixed(1).replace(".", ",") + " %";
}

// Textform der "Auswertung aus dem System" je Ziel - dieselben Feldnamen
// wie perfGoalSnapshot()/perfGoalSystemHtml() im Client (index.html), aber
// als Klartext statt HTML, da hier keine Anzeige, sondern ein KI-Prompt
// gefuettert wird. Bewusste Duplizierung (kein gemeinsames Modul zwischen
// Client und Edge Function), wie bei den anderen Funktionen dieses Projekts.
// deno-lint-ignore no-explicit-any
function formatSnapshot(goalId: number, snap: any): string {
  if (!snap) return "(keine Kennzahlen)";
  if (goalId === 1) {
    const jp = snap.jahr_ziel > 0 ? (snap.jahr_ist / snap.jahr_ziel * 100).toFixed(1) : null;
    const mp = snap.monat_ziel > 0 ? (snap.monat_ist / snap.monat_ziel * 100).toFixed(1) : null;
    return `Jahr ${snap.year}: ${snap.jahr_ist} / ${snap.jahr_ziel || "-"} Stk.${jp ? ` (${jp} %)` : ""}; ` +
      `Monat ${MONATE[snap.month - 1]}: ${snap.monat_ist} / ${snap.monat_ziel || "-"} Stk.${mp ? ` (${mp} %)` : ""}`;
  }
  if (goalId === 2) {
    const sp = snap.staffeln_ziel > 0 ? (snap.staffeln_ist / snap.staffeln_ziel * 100).toFixed(1) : null;
    return `Akquisestufen ${snap.year}: ${snap.staffeln_ist} / ${snap.staffeln_ziel || "-"}${sp ? ` (${sp} %)` : ""}; ` +
      `Aktivierungsquote: ${pct(snap.aktivierung_quote)} (${snap.aktivierung_aktiv} von ${snap.aktivierung_angelegt} FH mit mind. 1 Vertrag ${snap.year})`;
  }
  if (goalId === 3) {
    return `Neu gewonnene Miet-FH ${snap.year}: ${snap.neu_fh_jahr}; Vormonat: ${snap.neu_fh_vormonat}; ` +
      `Mietvertraege Jahr: ${snap.jahr_ist} / ${snap.jahr_ziel}; Mietvertraege Vormonat: ${snap.monat_ist} / ${snap.monat_ziel}`;
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
  parameters: {
    type: "object",
    properties: {
      employees: {
        type: "array",
        description: "Ein Eintrag je Mitarbeiter mit abgegebenen Protokollen im gewaehlten Jahr.",
        items: {
          type: "object",
          properties: {
            employee: { type: "string" },
            months: {
              type: "array",
              description: "Ein Eintrag je Monat, fuer den ein Protokoll vorliegt.",
              items: {
                type: "object",
                properties: {
                  month: { type: "integer", description: "1-12" },
                  summary: { type: "string", description: "Kurze, konkrete Analyse dieses Monats (2-4 Saetze): Kennzahlen-Stand, was aus den Antworten hervorsticht." },
                },
                required: ["month", "summary"],
              },
            },
            yearSummary: { type: "string", description: "Zusammenfassung des GESAMTEN Jahres fuer diesen Mitarbeiter (1-2 Absaetze): Entwicklung ueber die Monate hinweg, wiederkehrende Themen/Muster, Zielerreichung im Trend." },
          },
          required: ["employee", "months", "yearSummary"],
        },
      },
      companySummary: {
        type: "string",
        description: "Unternehmensweite Zusammenfassung ueber alle Mitarbeiter und das gesamte Jahr (2-4 Absaetze): gemeinsame Muster, Unterstuetzungsbedarf, auffaellige Unterschiede zwischen Mitarbeitern.",
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
  description: "Erstellt den strukturierten Performance-Dialog-Monatsbericht fuer genau einen Monat.",
  parameters: {
    type: "object",
    properties: {
      employees: {
        type: "array",
        description: "Ein Eintrag je Mitarbeiter mit abgegebenem Protokoll in diesem Monat.",
        items: {
          type: "object",
          properties: {
            employee: { type: "string" },
            summary: { type: "string", description: "Konkrete Analyse dieses Mitarbeiters fuer diesen Monat (2-4 Saetze): Kennzahlen-Stand, was aus den Antworten hervorsticht, ggf. Unterstuetzungsbedarf." },
          },
          required: ["employee", "summary"],
        },
      },
      companySummary: {
        type: "string",
        description: "Unternehmensweite Zusammenfassung ueber alle Mitarbeiter fuer DIESEN EINEN Monat (1-3 Absaetze): gemeinsame Muster, Unterstuetzungsbedarf, auffaellige Unterschiede zwischen Mitarbeitern.",
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
  if (userErr || !user) return json({ error: "Ungueltige Session" }, 401);

  const { data: profile } = await admin.from("profiles").select("role").eq("id", user.id).maybeSingle();
  if (profile?.role !== "admin") return json({ error: "Nur fuer Admins" }, 403);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Ungueltiger Body" }, 400); }
  const year = Number(body.year);
  if (!year || year < 2000 || year > 3000) return json({ error: "Ungueltiges Jahr" }, 400);
  // month ist optional (01.09.2026) - vorhanden -> Monatsbericht-Modus,
  // sonst unveraendertes Jahresbericht-Verhalten.
  const monthRaw = body.month;
  const month = monthRaw == null || monthRaw === "" ? null : Number(monthRaw);
  if (month != null && (!Number.isInteger(month) || month < 1 || month > 12)) {
    return json({ error: "Ungueltiger Monat" }, 400);
  }

  let reportsQuery = admin
    .from("performance_dialog_reports").select("*").eq("year", year).eq("is_draft", false);
  if (month != null) reportsQuery = reportsQuery.eq("month", month);
  const { data: reports, error: repErr } = await reportsQuery.order("employee").order("month");
  if (repErr) return json({ error: repErr.message }, 500);
  const zeitraumLbl = month != null ? `${MONATE[month - 1]} ${year}` : `${year}`;
  if (!reports || !reports.length) {
    return json({ error: `Fuer ${zeitraumLbl} liegen noch keine Performance-Dialog-Protokolle vor.` }, 400);
  }

  const apiKey = Deno.env.get("MISTRAL_API_KEY");
  if (!apiKey) return json({ error: "MISTRAL_API_KEY ist nicht als Supabase-Secret hinterlegt." }, 500);

  const employeeList = [...new Set(reports.map((r) => r.employee as string))];
  const tokenOf = new Map<string, string>();
  employeeList.forEach((n, i) => tokenOf.set(n, `MITARBEITER_${i + 1}`));
  const tokenList = employeeList.map((n) => tokenOf.get(n));
  const promptBody = reports.map((r) => formatReportForPrompt(r, tokenOf)).join("\n\n---\n\n");

  const systemPrompt = month != null
    ? `Du erstellst einen internen Monatsbericht fuer das Wertgarantie Performance Dashboard auf Basis der ` +
      `"Performance Dialog"-Protokolle von Vertriebsmitarbeitern fuer GENAU EINEN Monat. Jedes Protokoll enthaelt ` +
      `System-Kennzahlen zu den persoenlichen Zielen des Monats sowie vier Freitext-Antworten des Mitarbeiters. ` +
      `Analysiere die Daten sachlich und konkret - Kennzahlen-Stand, was aus den Antworten hervorsticht, ggf. ` +
      `Unterstuetzungsbedarf. Da nur ein Monat vorliegt, gibt es KEINEN Trend ueber mehrere Monate - erfinde keinen. ` +
      `Schreibe auf Deutsch, professionell, praegnant, ohne Floskeln. Gehe NUR auf Mitarbeiter ein, fuer die ` +
      `tatsaechlich ein Protokoll vorliegt. Die echten Mitarbeiternamen werden dir aus Datenschutzgruenden NICHT ` +
      `mitgeteilt - jeder Mitarbeiter ist ausschliesslich ueber einen Platzhalter wie "MITARBEITER_1" referenziert. ` +
      `Verwende in deiner GESAMTEN Antwort (inkl. "employee"-Feldern) ausschliesslich diese Platzhalter und erfinde ` +
      `oder rekonstruiere KEINE echten Namen. Antworte ausschliesslich ueber das Tool "generate_monthly_report".`
    : `Du erstellst einen internen Jahresbericht fuer das Wertgarantie Performance Dashboard auf Basis der ` +
      `monatlichen "Performance Dialog"-Protokolle von Vertriebsmitarbeitern. Jedes Protokoll enthaelt System-` +
      `Kennzahlen zu den persoenlichen Zielen des Monats sowie vier Freitext-Antworten des Mitarbeiters. ` +
      `Analysiere die Daten sachlich und konkret, erkenne Muster/Trends ueber die Monate hinweg (z.B. wiederkehrende ` +
      `Themen, Verbesserung/Verschlechterung der Zielerreichung, wiederholt genannter Unterstuetzungsbedarf). ` +
      `Schreibe auf Deutsch, professionell, praegnant, ohne Floskeln. Gehe NUR auf Monate/Mitarbeiter ein, fuer die ` +
      `tatsaechlich Protokolle vorliegen - erfinde nichts fuer fehlende Monate. Die echten Mitarbeiternamen werden ` +
      `dir aus Datenschutzgruenden NICHT mitgeteilt - jeder Mitarbeiter ist ausschliesslich ueber einen Platzhalter ` +
      `wie "MITARBEITER_1" referenziert. Verwende in deiner GESAMTEN Antwort (inkl. "employee"-Feldern) ` +
      `ausschliesslich diese Platzhalter und erfinde oder rekonstruiere KEINE echten Namen. Antworte ausschliesslich ` +
      `ueber das Tool "generate_annual_report".`;

  const userPrompt = month != null
    ? `Monat: ${zeitraumLbl}\nMitarbeiter mit Protokollen: ${tokenList.join(", ")}\n\n` +
      `Rohdaten aller Protokolle dieses Monats:\n\n${promptBody}`
    : `Jahr: ${year}\nMitarbeiter mit Protokollen: ${tokenList.join(", ")}\n\n` +
      `Rohdaten aller Protokolle dieses Jahres:\n\n${promptBody}`;

  const tool = month != null ? MONTHLY_REPORT_TOOL : REPORT_TOOL;

  const aiResult = await callMistralTool(apiKey, systemPrompt, userPrompt, tool, 12000);
  if (aiResult.error) return json({ error: aiResult.error }, 502);

  // Platzhalter erst jetzt, server-seitig vor der Antwort ans Dashboard,
  // wieder durch die echten Namen ersetzen (siehe Pseudonymisierungs-Hinweis
  // oben). Laengere Tokens zuerst (MITARBEITER_10 vor MITARBEITER_1), damit
  // keine Teilersetzung einen laengeren Token zerstoert. Gilt fuer beide
  // Modi (Jahres- und Monatsbericht).
  const reverseTokens = [...tokenOf.entries()].sort((a, b) => b[1].length - a[1].length);
  const report = deepReplace(aiResult.report, (s: string) => {
    let out = s;
    for (const [name, tok] of reverseTokens) out = out.split(tok).join(name);
    return out;
  });

  return json({ ok: true, year, month, report });
});
