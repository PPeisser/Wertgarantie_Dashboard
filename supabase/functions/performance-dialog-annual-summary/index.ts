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
          // Bug-Report 04.09.2026: "mistral-large-latest" lieferte fuer den
          // hinterlegten API-Key HTTP 403 "This model is not available in
          // your subscription tier" (Free-Tier), Zwischenfix auf
          // "mistral-small-latest". Nach Aktivierung von Pay-as-you-go
          // (05.09.2026, vom Nutzer bestaetigt und per /v1/models +
          // Testaufruf verifiziert) ist "mistral-large-latest" wieder
          // verfuegbar und liefert saubere Tool-Call-Antworten - zurueck auf
          // das groessere Modell fuer bessere Berichtsqualitaet.
          model: "mistral-large-latest",
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

// Saisonale Jahres-Hochrechnung - 1:1-Portierung von seasonShare() (und
// dessen Abhaengigkeiten easter()/holidaysAT()/workdaysBetween()) aus dem
// Client (index.html), damit die "Hochrechnung Jahresende" hier exakt
// denselben Wert liefert wie im Dashboard/PDF (siehe perfGoalSystemHtml()
// im Client) - Nutzervorgabe 07.09.2026: "auch bei der KI-Zusammenfassung
// integrieren". Bewusste Duplizierung statt gemeinsames Modul, wie bei den
// anderen Funktionen dieser Edge Function.
const Q4_ANTEIL = 0.29; // 71 % bis 30.9., 29 % der Jahresproduktion in Q4
function easterUTC(y: number): Date {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25),
    g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4,
    l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451),
    mo = Math.floor((h + l - 7 * m + 114) / 31), da = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(y, mo - 1, da));
}
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
const holidayCache: Record<number, Set<string>> = {};
function holidaysAT(y: number): Set<string> {
  if (holidayCache[y]) return holidayCache[y];
  const s = new Set<string>();
  const add = (d: Date) => s.add(isoDate(d));
  ([[0, 1], [0, 6], [4, 1], [7, 15], [9, 26], [10, 1], [11, 8], [11, 25], [11, 26]] as [number, number][])
    .forEach(([m, d]) => add(new Date(Date.UTC(y, m, d))));
  const e = easterUTC(y);
  [1, 39, 50, 60].forEach((off) => { const d = new Date(e); d.setUTCDate(d.getUTCDate() + off); add(d); });
  holidayCache[y] = s;
  return s;
}
function isWorkday(d: Date): boolean {
  const wd = d.getUTCDay();
  if (wd === 0) return false;
  return !holidaysAT(d.getUTCFullYear()).has(isoDate(d));
}
function addDaysUTC(d: Date, n: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}
function workdaysBetween(a: Date, b: Date): number {
  let n = 0, x = new Date(a);
  while (x <= b) { if (isWorkday(x)) n++; x = addDaysUTC(x, 1); }
  return n;
}
function seasonShare(dISO: string, jahr: number): number {
  const d = new Date(dISO + "T00:00:00Z");
  const jan1 = new Date(Date.UTC(jahr, 0, 1)), sep30 = new Date(Date.UTC(jahr, 8, 30)),
    okt1 = new Date(Date.UTC(jahr, 9, 1)), dez31 = new Date(Date.UTC(jahr, 11, 31));
  const wd19 = workdaysBetween(jan1, sep30), wdQ4 = workdaysBetween(okt1, dez31);
  if (d <= sep30) return (1 - Q4_ANTEIL) * workdaysBetween(jan1, d) / wd19;
  return (1 - Q4_ANTEIL) + Q4_ANTEIL * workdaysBetween(okt1, d) / wdQ4;
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
    // Hochrechnung Jahresende (Nutzervorgabe 07.09.2026): dieselbe saisonale
    // Gewichtung wie im Dashboard, damit die KI dieselbe Zahl kennt, die auch
    // im PDF unter "SYSTEM-KENNZAHLEN" (perfKiSystemDataHtml() im Client)
    // neben ihrem Text steht - nur bei "Jahr", nicht bei "Monat" (der
    // Berichtsmonat ist bereits abgeschlossen, siehe Client-Kommentar).
    let hrPart = "";
    if (snap.year && snap.month) {
      const monthEndIso = `${snap.year}-${String(snap.month).padStart(2, "0")}-` +
        `${String(new Date(Date.UTC(snap.year, snap.month, 0)).getUTCDate()).padStart(2, "0")}`;
      const share = seasonShare(monthEndIso, snap.year);
      const hrJahr = share > 0 ? snap.jahr_ist / share : snap.jahr_ist;
      const hp = snap.jahr_ziel > 0 ? (hrJahr / snap.jahr_ziel * 100).toFixed(1) : null;
      hrPart = `; Hochrechnung Jahresende (saisonal gewichtet): ${Math.round(hrJahr)} Stk.${hp ? ` (${hp} %)` : ""}`;
    }
    return `Jahr ${snap.year}: ${snap.jahr_ist} / ${snap.jahr_ziel || "-"} Stk.${jp ? ` (${jp} %)` : ""}${hrPart}; ` +
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

  // Bug-Report 05.09.2026 (Peter Peißer): die KI schrieb im Fliesstext
  // "Akquisequote (63,3 %)" - tatsaechlich die Akquisestufen-Erreichung
  // (staffeln_ist/staffeln_ziel), nicht die separat und korrekt beschriftet
  // uebergebene Aktivierungsquote (83,7 %, siehe formatSnapshot() Ziel 2
  // oben: "Akquisestufen ...; Aktivierungsquote: ..."). Explizite
  // Anti-Verwechslungs-Anweisung als zusaetzliche Abschwaechung - ersetzt
  // NICHT den eigentlichen Fix (perfKiSystemDataHtml() im Client zeigt die
  // System-Kennzahlen zum Abgleich direkt neben diesem KI-Text an), da
  // Prompting allein Halluzinationen nicht zuverlaessig auf 0 senkt.
  const antiVerwechslungHinweis =
    `WICHTIG gegen Zahlenverwechslung: uebernimm jede Kennzahl EXAKT mit dem Wert und der Bezeichnung, die dir im ` +
    `Rohdatenblock gegeben wird (z.B. "Akquisestufen" und "Aktivierungsquote" sind zwei VERSCHIEDENE Kennzahlen mit ` +
    `unterschiedlichen Werten - verwechsle, vertausche oder vermische sie nie, auch nicht unter einer neuen, eigenen ` +
    `Bezeichnung wie "Akquisequote"). Erfinde niemals einen Wert und runde nicht anders, als er dir vorliegt.`;
  const systemPrompt = month != null
    ? `Du erstellst einen internen Monatsbericht fuer das Wertgarantie Performance Dashboard auf Basis der ` +
      `"Performance Dialog"-Protokolle von Vertriebsmitarbeitern fuer GENAU EINEN Monat. Jedes Protokoll enthaelt ` +
      `System-Kennzahlen zu den persoenlichen Zielen des Monats sowie vier Freitext-Antworten des Mitarbeiters. ` +
      `Analysiere die Daten sachlich und konkret - Kennzahlen-Stand, was aus den Antworten hervorsticht, ggf. ` +
      `Unterstuetzungsbedarf. Da nur ein Monat vorliegt, gibt es KEINEN Trend ueber mehrere Monate - erfinde keinen. ` +
      `${antiVerwechslungHinweis} ` +
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
      `${antiVerwechslungHinweis} ` +
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
