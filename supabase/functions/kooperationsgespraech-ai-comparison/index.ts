// Kooperationsgespraech - KI-Unterstuetzt: fasst die aggregierten Kennzahlen
// EINER Einkaufskooperation (alle ihre Mitglieds-Fachhaendler zusammen)
// zusammen und vergleicht sie anonymisiert (nur Aggregatwerte je Kooperation,
// keine Einzelhaendler-Daten) mit allen ANDEREN Einkaufskooperationen. Nutzt
// die Mistral Chat-Completions-API (EU-Anbieter, DSGVO-konform, DPA vorhanden
// - Nutzervorgabe 04.09.2026) mit erzwungenem Tool-Call fuer eine strukturierte
// JSON-Antwort (Zusammenfassung + Vergleichswerte je Kennzahl + Empfehlungen).
// Analog zu chefgespraech-ai-comparison, aber auf Kooperations- statt
// Einzelhaendler-Ebene - "ohne Kooperation" ist keine echte Kooperation und
// wird sowohl als Ziel als auch aus der Vergleichsgruppe ausgeschlossen.
//
// Auth: normale Nutzer-Session (Authorization-Header) - KEIN Admin-Gate,
// da jeder Aussendienst-Mitarbeiter den Kooperationsgespraech-Button nutzen
// darf (fh_contacts ist ohnehin fuer alle authentifizierten Nutzer lesbar).
//
// Secret: MISTRAL_API_KEY (als Supabase-Secret hinterlegt, siehe
// chefgespraech-ai-comparison).

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

// deno-lint-ignore no-explicit-any
type FhRow = Record<string, any>;
// deno-lint-ignore no-explicit-any
type DailyFhMap = Record<string, Record<string, number>>;

// Tagesproduktion (dashboard_kv "wg-state" -> dailyFH) + Bulk-Import
// (fh_contacts.prod_monthly) zusammenfuehren - exakt wie fhMonthlyMerged() im
// Client / mergedMonthly() in chefgespraech-ai-comparison. Ohne dies sah
// diese Funktion NUR den (oft lueckenhaften) Bulk-Import und ignorierte die
// taegliche Produktionshistorie komplett (Nutzer-Feedback 24.08.2026: "Daten
// ... koennen nicht stimmen"). Bulk-Werte gewinnen bei Ueberschneidung.
function mergedMonthly(fhNr: string, prodMonthly: Record<string, number> | null | undefined, dailyFH: DailyFhMap): Record<string, number> {
  const daily = dailyFH[fhNr] || {};
  const fromDaily: Record<string, number> = {};
  for (const [d, v] of Object.entries(daily)) {
    const ym = d.slice(0, 7);
    fromDaily[ym] = (fromDaily[ym] || 0) + (Number(v) || 0);
  }
  return { ...fromDaily, ...(prodMonthly || {}) };
}

function yearlyProd(monthly: Record<string, number>): Record<string, number> {
  const byYear: Record<string, number> = {};
  for (const [k, v] of Object.entries(monthly)) {
    const y = k.slice(0, 4);
    byYear[y] = (byYear[y] || 0) + (Number(v) || 0);
  }
  return byYear;
}

interface KoopMetrics {
  curYear: string | null;
  curProd: number;
  yoy: number | null;
  q3f2: number | null;
  akqPunkte: number | null;
  fhCount: number;
  clubWeissRate: number | null;
}

// Aggregiert eine Gruppe von Fachhaendler-Zeilen (eine Kooperation) zu den
// Kennzahlen dieser Kooperation, bezogen auf ein fest vorgegebenes Jahr
// (curYear) - damit sind Kooperationen untereinander vergleichbar, auch wenn
// einzelne Mitglieds-Haendler unterschiedliche Datenstaende haben.
function aggregateGroup(rows: FhRow[], curYear: string, prevYear: string, dailyFH: DailyFhMap): KoopMetrics {
  let curProd = 0, prevProd = 0, bf = 0, akqSum = 0, akqCount = 0, clubWeissCount = 0;
  for (const r of rows) {
    const byYear = yearlyProd(mergedMonthly(r.fh_nr, r.prod_monthly, dailyFH));
    curProd += byYear[curYear] || 0;
    prevProd += byYear[prevYear] || 0;
    bf += Number((r.beitragsfrei_yearly || {})[curYear]) || 0;
    if (r.akq_punkte != null) { akqSum += Number(r.akq_punkte) || 0; akqCount++; }
    if (r.club_weiss_mitglied) clubWeissCount++;
  }
  const yoy = prevProd > 0 ? (curProd - prevProd) / prevProd : null;
  const q3f2 = curProd > 0 ? bf / curProd : null;
  const akqPunkte = akqCount > 0 ? akqSum / akqCount : null;
  const clubWeissRate = rows.length ? clubWeissCount / rows.length : null;
  return { curYear, curProd, yoy, q3f2, akqPunkte, fhCount: rows.length, clubWeissRate };
}

function median(arr: number[]): number | null {
  const s = [...arr].sort((a, b) => a - b);
  const n = s.length;
  if (!n) return null;
  const mid = Math.floor(n / 2);
  return n % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function percentile(arr: number[], p: number): number | null {
  const s = [...arr].sort((a, b) => a - b);
  if (!s.length) return null;
  const idx = (p / 100) * (s.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

function rankPercentile(arr: number[], value: number): number | null {
  const s = arr.filter((v) => v != null);
  if (!s.length) return null;
  let below = 0;
  for (const v of s) if (v < value) below++;
  return below / s.length;
}

const COMPARISON_TOOL = {
  name: "generate_kooperationsgespraech_comparison",
  description: "Erstellt die strukturierte Zusammenfassung samt anonymem Vergleich fuer das Kooperationsgespraech.",
  parameters: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description: "Zusammenfassung der wichtigsten Kennzahlen dieser Einkaufskooperation fuer das Kooperationsgespraech (2-4 Saetze, sachlich, konkret).",
      },
      comparisons: {
        type: "array",
        description: "Ein Eintrag je Kennzahl, mit Einordnung ggue. den anderen (anonymen) Einkaufskooperationen.",
        items: {
          type: "object",
          properties: {
            metric: { type: "string", description: "Name der Kennzahl, z.B. 'Jahresproduktion', 'Wachstum ggue. Vorjahr', '3-fuer-2-Quote', 'Durchschnittliche Akquisepunkte je Fachhaendler'." },
            assessment: { type: "string", description: "1 Satz Einordnung: steht die Kooperation besser/schlechter da als die anderen Kooperationen, und was heisst das." },
          },
          required: ["metric", "assessment"],
        },
      },
      recommendations: {
        type: "array",
        items: { type: "string" },
        description: "2-4 konkrete, umsetzbare Empfehlungen/Gespraechsansaetze fuer das Kooperationsgespraech, abgeleitet aus dem Vergleich.",
      },
    },
    required: ["summary", "comparisons", "recommendations"],
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

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Ungueltiger Body" }, 400); }
  const kooperation = String(body.kooperation || "").trim();
  if (!kooperation) return json({ error: "kooperation fehlt" }, 400);
  if (kooperation === "ohne Kooperation") {
    return json({ error: "\"ohne Kooperation\" ist keine Einkaufskooperation und kann nicht verglichen werden." }, 400);
  }

  const { data: allRows, error: allErr } = await admin
    .from("fh_contacts").select("fh_nr,kooperation,prod_monthly,beitragsfrei_yearly,akq_punkte,club_weiss_mitglied")
    .not("kooperation", "is", null)
    .neq("kooperation", "ohne Kooperation");
  if (allErr) return json({ error: allErr.message }, 500);
  const rows = allRows || [];

  // Taegliche Produktionshistorie laden (siehe mergedMonthly() oben) - ohne
  // dies sah diese Funktion nur den lueckenhaften Bulk-Import je Fachhaendler.
  let dailyFH: DailyFhMap = {};
  try {
    const { data: kvRow } = await admin.from("dashboard_kv").select("value").eq("key", "wg-state").maybeSingle();
    if (kvRow?.value) {
      const parsed = JSON.parse(kvRow.value);
      dailyFH = parsed?.dailyFH || {};
    }
  } catch (e) {
    console.error("dailyFH konnte nicht geladen werden, Vergleich laeuft nur mit Bulk-Import-Daten weiter:", e);
  }

  let maxYear = "";
  for (const r of rows) {
    for (const k of Object.keys(mergedMonthly(r.fh_nr, r.prod_monthly, dailyFH))) {
      const y = k.slice(0, 4);
      if (y > maxYear) maxYear = y;
    }
  }
  if (!maxYear) return json({ error: "Fuer Einkaufskooperationen liegt noch keine Jahresproduktion vor." }, 400);
  const prevYear = String(Number(maxYear) - 1);

  const byKoop = new Map<string, FhRow[]>();
  for (const r of rows) {
    const k = (r.kooperation || "").trim();
    if (!k) continue;
    if (!byKoop.has(k)) byKoop.set(k, []);
    byKoop.get(k)!.push(r);
  }

  const targetRows = byKoop.get(kooperation) || [];
  if (!targetRows.length) return json({ error: `Keine Fachhaendler mit Kooperation "${kooperation}" gefunden.` }, 400);
  const targetMetrics = aggregateGroup(targetRows, maxYear, prevYear, dailyFH);

  const peerGroups: KoopMetrics[] = [];
  for (const [k, grp] of byKoop) {
    if (k === kooperation) continue;
    peerGroups.push(aggregateGroup(grp, maxYear, prevYear, dailyFH));
  }

  const peerStats = {
    curProd: {
      median: median(peerGroups.map((m) => m.curProd)),
      p75: percentile(peerGroups.map((m) => m.curProd), 75),
      rank: rankPercentile(peerGroups.map((m) => m.curProd), targetMetrics.curProd),
    },
    yoy: {
      median: median(peerGroups.map((m) => m.yoy).filter((v): v is number => v != null)),
      p75: percentile(peerGroups.map((m) => m.yoy).filter((v): v is number => v != null), 75),
      rank: targetMetrics.yoy != null ? rankPercentile(peerGroups.map((m) => m.yoy).filter((v): v is number => v != null), targetMetrics.yoy) : null,
    },
    q3f2: {
      median: median(peerGroups.map((m) => m.q3f2).filter((v): v is number => v != null)),
      p75: percentile(peerGroups.map((m) => m.q3f2).filter((v): v is number => v != null), 75),
      rank: targetMetrics.q3f2 != null ? rankPercentile(peerGroups.map((m) => m.q3f2).filter((v): v is number => v != null), targetMetrics.q3f2) : null,
    },
    akqPunkte: {
      median: median(peerGroups.map((m) => m.akqPunkte).filter((v): v is number => v != null)),
      p75: percentile(peerGroups.map((m) => m.akqPunkte).filter((v): v is number => v != null), 75),
      rank: targetMetrics.akqPunkte != null ? rankPercentile(peerGroups.map((m) => m.akqPunkte).filter((v): v is number => v != null), targetMetrics.akqPunkte) : null,
    },
    clubWeissRate: {
      median: median(peerGroups.map((m) => m.clubWeissRate).filter((v): v is number => v != null)),
      p75: percentile(peerGroups.map((m) => m.clubWeissRate).filter((v): v is number => v != null), 75),
      rank: targetMetrics.clubWeissRate != null ? rankPercentile(peerGroups.map((m) => m.clubWeissRate).filter((v): v is number => v != null), targetMetrics.clubWeissRate) : null,
    },
  };

  const apiKey = Deno.env.get("MISTRAL_API_KEY");
  if (!apiKey) return json({ error: "MISTRAL_API_KEY ist nicht als Supabase-Secret hinterlegt." }, 500);

  const fmtPct = (v: number | null) => v == null ? "-" : (v * 100).toFixed(1).replace(".", ",") + " %";
  const userPrompt =
    `Einkaufskooperation "${kooperation}" mit ${targetMetrics.fhCount} Mitglieds-Fachhaendlern, ` +
    `Vergleichsgruppe: ${peerGroups.length} andere Einkaufskooperationen (anonym).\n\n` +
    `Kennzahlen dieser Kooperation (Jahr ${maxYear}, aufsummiert ueber alle Mitglieds-Fachhaendler):\n` +
    `- Jahresproduktion: ${targetMetrics.curProd} Vertraege\n` +
    `- Wachstum ggue. Vorjahr: ${fmtPct(targetMetrics.yoy)}\n` +
    `- 3-fuer-2-Quote: ${fmtPct(targetMetrics.q3f2)}\n` +
    `- Durchschnittliche Akquisepunkte je Fachhaendler: ${targetMetrics.akqPunkte != null ? Math.round(targetMetrics.akqPunkte) : "-"}\n` +
    `- Club Weiss Mitgliedschaftsquote (Anteil Club-Weiss-Mitglieder unter den Mitglieds-Fachhaendlern): ${fmtPct(targetMetrics.clubWeissRate)}\n\n` +
    `Andere Einkaufskooperationen, jeweils Median / oberes Quartil (75%) / Perzentil-Rang dieser Kooperation:\n` +
    `- Jahresproduktion: Median ${peerStats.curProd.median != null ? Math.round(peerStats.curProd.median) : "-"} / oberes Quartil ${peerStats.curProd.p75 != null ? Math.round(peerStats.curProd.p75) : "-"} / diese Kooperation liegt im ${peerStats.curProd.rank != null ? Math.round(peerStats.curProd.rank * 100) : "-"}. Perzentil\n` +
    `- Wachstum ggue. Vorjahr: Median ${fmtPct(peerStats.yoy.median)} / oberes Quartil ${fmtPct(peerStats.yoy.p75)} / Perzentil ${peerStats.yoy.rank != null ? Math.round(peerStats.yoy.rank * 100) : "-"}\n` +
    `- 3-fuer-2-Quote: Median ${fmtPct(peerStats.q3f2.median)} / oberes Quartil ${fmtPct(peerStats.q3f2.p75)} / Perzentil ${peerStats.q3f2.rank != null ? Math.round(peerStats.q3f2.rank * 100) : "-"}\n` +
    `- Durchschnittliche Akquisepunkte je Fachhaendler: Median ${peerStats.akqPunkte.median != null ? Math.round(peerStats.akqPunkte.median) : "-"} / oberes Quartil ${peerStats.akqPunkte.p75 != null ? Math.round(peerStats.akqPunkte.p75) : "-"} / Perzentil ${peerStats.akqPunkte.rank != null ? Math.round(peerStats.akqPunkte.rank * 100) : "-"}\n` +
    `- Club Weiss Mitgliedschaftsquote: Median ${fmtPct(peerStats.clubWeissRate.median)} / oberes Quartil ${fmtPct(peerStats.clubWeissRate.p75)} / Perzentil ${peerStats.clubWeissRate.rank != null ? Math.round(peerStats.clubWeissRate.rank * 100) : "-"}\n`;

  const systemPrompt =
    `Du bereitest ein "Kooperationsgespraech" vor - ein internes Beratungsgespraech eines Wertgarantie-Vertriebsmitarbeiters ` +
    `mit einer Einkaufskooperation (Vertriebsverbund mehrerer Fachhaendler). Du bekommst die aufsummierten/gemittelten ` +
    `Kennzahlen dieser einen Kooperation sowie ANONYME Aggregatwerte (Median, oberes Quartil, Perzentil-Rang) einer ` +
    `Vergleichsgruppe aller anderen Einkaufskooperationen (nie Einzeldaten anderer Kooperationen oder einzelner ` +
    `Fachhaendler). Ordne die Zahlen sachlich ein, zeige wo die Kooperation im Vergleich gut dasteht und wo Potenzial ` +
    `liegt, und leite daraus konkrete, umsetzbare Gespraechsansaetze/Empfehlungen ab. Beruecksichtige dabei auch die ` +
    `Club-Weiss-Mitgliedschaftsquote: liegt sie unter dem Vergleichswert, ist das ein konkreter Gespraechsansatz ` +
    `(mehr Mitglieds-Fachhaendler fuer Club Weiss gewinnen); liegt sie darueber, ist das eine Staerke. Schreibe auf ` +
    `Deutsch, professionell, praegnant, ohne Floskeln. Antworte ausschliesslich ueber das Tool ` +
    `"generate_kooperationsgespraech_comparison".`;

  const aiResult = await callMistralTool(apiKey, systemPrompt, userPrompt, COMPARISON_TOOL, 6000);
  if (aiResult.error) return json({ error: aiResult.error }, 502);
  const report = aiResult.report;

  return json({
    ok: true,
    kooperation,
    peerCount: peerGroups.length,
    year: maxYear,
    metrics: { target: targetMetrics, peers: peerStats },
    report,
  });
});
