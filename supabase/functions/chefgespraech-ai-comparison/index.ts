// Chefgespraech - KI-Unterstuetzt: fasst die Kennzahlen EINES Fachhaendlers
// zusammen und vergleicht ihn anonymisiert (nur Aggregatwerte, keine
// Einzelhaendler-Daten) mit einer Vergleichsgruppe anderer Haendler. Nutzt die
// Mistral Chat-Completions-API (EU-Anbieter, DSGVO-konform, DPA vorhanden -
// Nutzervorgabe 04.09.2026) mit erzwungenem Tool-Call fuer eine strukturierte
// JSON-Antwort (Zusammenfassung + Vergleichswerte je Kennzahl + Empfehlungen).
//
// Vergleichsmodi (Nutzervorgabe 22./23./25.08.2026, "mode"-Feld im Request):
// - "region" (Default): gleiche erste PLZ-Ziffer.
// - "kooperation": gleicher Wert in fh_contacts.kooperation.
// - "hauptzweig": gleicher Wert in fh_contacts.hauptzweig.
// - "weitere_zuordnung": gleicher Wert in fh_contacts.weitere_zuordnung.
// - "filialbetriebe": gleicher Wert in fh_contacts.filialbetriebe.
// Die Vergleichsgruppen-Auswahl ist als eigener, austauschbarer Schritt
// (selectPeerGroup) gebaut - weitere Modi (bestimmte Haendler, Umkreis in km)
// koennen spaeter ergaenzt werden, ohne den restlichen Ablauf anzufassen.
//
// Auth: normale Nutzer-Session (Authorization-Header) - KEIN Admin-Gate,
// da jeder Aussendienst-Mitarbeiter den Chefgespraech-Button nutzen darf
// (fh_contacts ist ohnehin fuer alle authentifizierten Nutzer lesbar).
//
// Secret: MISTRAL_API_KEY (als Supabase-Secret hinterlegt, siehe
// performance-dialog-annual-summary).
//
// Hinweis 25.08.2026: Kommentare/Prompt-Texte in dieser Datei sind bewusst
// ASCII-transliteriert (ae/oe/ue/ss statt ä/ö/ü/ß) - reine Deploy-Mechanik
// (Umlaute im MCP-Deploy-Tool-Aufruf wiederholt korrumpiert), kein Nutzer
// sieht diesen Text direkt (Code-Kommentare + KI-Tool-Schema/Prompt-Text).

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

// deno-lint-ignore no-explicit-any
type FhRow = Record<string, any>;
// deno-lint-ignore no-explicit-any
type DailyFhMap = Record<string, Record<string, number>>;

// Tagesproduktion (dashboard_kv "wg-state" -> dailyFH) + Bulk-Import
// (fh_contacts.prod_monthly) zusammenfuehren - exakt wie fhMonthlyMerged() im
// Client. Ohne dies sah diese Funktion NUR den (oft lueckenhaften) Bulk-Import
// und ignorierte die taegliche Produktionshistorie komplett, wodurch sowohl
// die Zahlen des Zielhaendlers als auch die Vergleichsgruppe unvollstaendig/
// falsch waren (Nutzer-Feedback 24.08.2026: "Daten ... koennen nicht
// stimmen"). Bulk-Werte gewinnen bei Ueberschneidung (echte Monatssumme statt
// aus Tageswerten hochgerechnet).
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

interface Metrics {
  curYear: string | null;
  curProd: number;
  yoy: number | null;
  q3f2: number | null;
  akqPunkte: number | null;
  clubWeiss: boolean;
}

function metricsForFh(row: FhRow, dailyFH: DailyFhMap): Metrics {
  const byYear = yearlyProd(mergedMonthly(row.fh_nr, row.prod_monthly, dailyFH));
  const years = Object.keys(byYear).sort();
  const curYear = years.length ? years[years.length - 1] : null;
  const prevYear = years.length > 1 ? years[years.length - 2] : null;
  const curProd = curYear ? byYear[curYear] : 0;
  const prevProd = prevYear ? byYear[prevYear] : null;
  const yoy = (prevProd != null && prevProd > 0) ? (curProd - prevProd) / prevProd : null;
  const bf = curYear ? (row.beitragsfrei_yearly || {})[curYear] : null;
  const q3f2 = (bf != null && curProd > 0) ? bf / curProd : null;
  const akqPunkte = row.akq_punkte != null ? Number(row.akq_punkte) : null;
  const clubWeiss = !!row.club_weiss_mitglied;
  return { curYear, curProd, yoy, q3f2, akqPunkte, clubWeiss };
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

const PEER_SELECT_COLS = "fh_nr,prod_monthly,beitragsfrei_yearly,akq_punkte,club_weiss_mitglied";

// Fuenf Modi: "region" (Default, erste PLZ-Ziffer), "kooperation",
// "hauptzweig", "weitere_zuordnung", "filialbetriebe" (jeweils: gleicher
// Wert wie der Ziel-Haendler in der gleichnamigen fh_contacts-Spalte). Gibt
// die Kandidaten-Zeilen zurueck (roher fh_contacts-Query, noch ohne
// Metrik-Berechnung).
async function selectPeerGroup(
  // deno-lint-ignore no-explicit-any
  admin: any,
  target: FhRow,
  mode: string,
): Promise<{ rows: FhRow[]; label: string }> {
  if (mode === "kooperation") {
    const koop = (target.kooperation || "").trim();
    if (!koop) return { rows: [], label: "Kooperation unbekannt (kein Wert hinterlegt)" };
    const { data } = await admin.from("fh_contacts").select(PEER_SELECT_COLS)
      .eq("kooperation", koop).neq("fh_nr", target.fh_nr);
    return { rows: data || [], label: `Kooperation "${koop}"` };
  }
  if (mode === "hauptzweig") {
    const hz = (target.hauptzweig || "").trim();
    if (!hz) return { rows: [], label: "Hauptzweig unbekannt (kein Wert hinterlegt)" };
    const { data } = await admin.from("fh_contacts").select(PEER_SELECT_COLS)
      .eq("hauptzweig", hz).neq("fh_nr", target.fh_nr);
    return { rows: data || [], label: `Hauptzweig "${hz}"` };
  }
  if (mode === "weitere_zuordnung") {
    const wz = (target.weitere_zuordnung || "").trim();
    if (!wz) return { rows: [], label: "Weitere Zuordnung unbekannt (kein Wert hinterlegt)" };
    const { data } = await admin.from("fh_contacts").select(PEER_SELECT_COLS)
      .eq("weitere_zuordnung", wz).neq("fh_nr", target.fh_nr);
    return { rows: data || [], label: `Weitere Zuordnung "${wz}"` };
  }
  if (mode === "filialbetriebe") {
    const fb = (target.filialbetriebe || "").trim();
    if (!fb) return { rows: [], label: "Filialbetriebe unbekannt (kein Wert hinterlegt)" };
    const { data } = await admin.from("fh_contacts").select(PEER_SELECT_COLS)
      .eq("filialbetriebe", fb).neq("fh_nr", target.fh_nr);
    return { rows: data || [], label: `Filialbetriebe "${fb}"` };
  }
  // Default: "region" (erste PLZ-Ziffer, grobe Bundesland-Naeherung).
  const plzPrefix = (target.plz || "").trim().charAt(0);
  if (!plzPrefix) return { rows: [], label: "Region unbekannt (keine PLZ hinterlegt)" };
  const { data } = await admin.from("fh_contacts").select(PEER_SELECT_COLS + ",plz")
    .like("plz", plzPrefix + "%").neq("fh_nr", target.fh_nr);
  return { rows: data || [], label: "Region " + plzPrefix + "xxx (gleiche erste PLZ-Ziffer)" };
}

const COMPARISON_TOOL = {
  name: "generate_chefgespraech_comparison",
  description: "Erstellt die strukturierte Zusammenfassung samt anonymem Vergleich fuer das Chefgespraech.",
  parameters: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description: "Zusammenfassung der wichtigsten Kennzahlen dieses Haendlers fuer das Chefgespraech (2-4 Saetze, sachlich, konkret).",
      },
      comparisons: {
        type: "array",
        description: "Ein Eintrag je Kennzahl, mit Einordnung vs. der (anonymen) Vergleichsgruppe.",
        items: {
          type: "object",
          properties: {
            metric: { type: "string", description: "Name der Kennzahl, z.B. 'Jahresproduktion', 'Wachstum vs. Vorjahr', '3fuer2-Quote', 'Akquisepunkte'." },
            assessment: { type: "string", description: "1 Satz Einordnung: steht der Haendler besser/schlechter da als die Vergleichsgruppe, und was das heisst." },
          },
          required: ["metric", "assessment"],
        },
      },
      recommendations: {
        type: "array",
        items: { type: "string" },
        description: "2-4 konkrete, umsetzbare Empfehlungen/Gespraechsansaetze fuer das Chefgespraech, abgeleitet aus dem Vergleich.",
      },
    },
    required: ["summary", "comparisons", "recommendations"],
  },
};

const MODE_DESCRIPTION: Record<string, string> = {
  region: "Fachhaendlern derselben Region (grobe PLZ-Naeherung)",
  kooperation: "Fachhaendlern derselben Einkaufskooperation",
  hauptzweig: "Fachhaendlern desselben Hauptzweigs (Branche)",
  weitere_zuordnung: "Fachhaendlern mit derselben weiteren Zuordnung",
  filialbetriebe: "Fachhaendlern desselben Filialbetriebs (anderen Filialen derselben Kette)",
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
  const fhNr = String(body.fh_nr || "").trim();
  if (!fhNr) return json({ error: "fh_nr fehlt" }, 400);
  const modeRaw = typeof body.mode === "string" ? body.mode : "region";
  const mode = ["region", "kooperation", "hauptzweig", "weitere_zuordnung", "filialbetriebe"].includes(modeRaw) ? modeRaw : "region";

  const { data: target, error: targetErr } = await admin
    .from("fh_contacts").select("*").eq("fh_nr", fhNr).maybeSingle();
  if (targetErr) return json({ error: targetErr.message }, 500);
  if (!target) return json({ error: `Fachhaendler ${fhNr} hat noch keine Stammdaten.` }, 400);

  // Taegliche Produktionshistorie (dashboard_kv "wg-state" -> dailyFH) laden -
  // ein einzelner geteilter Datensatz fuer das gesamte Dashboard (~300 KB),
  // siehe mergedMonthly() oben. "value" ist eine Text-Spalte (JSON.stringify
  // clientseitig), daher hier explizit JSON.parse statt automatischer jsonb-
  // Dekodierung.
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

  const targetMetrics = metricsForFh(target, dailyFH);
  if (!targetMetrics.curYear) {
    return json({ error: "Fuer diesen Haendler liegt noch keine Jahresproduktion vor - Vergleich nicht moeglich." }, 400);
  }

  const { rows: peerRows, label: groupLabel } = await selectPeerGroup(admin, target, mode);
  const allPeerMetrics = peerRows.map((r) => metricsForFh(r, dailyFH));
  const peerMetrics = allPeerMetrics.filter((m) => m.curYear === targetMetrics.curYear);

  // Kooperation: zusaetzlich zur (statistisch aussagekraeftigeren) Vergleichsgruppe
  // der aktuell produzierenden Mitglieder auch den Gesamtkontext der ganzen
  // Kooperation liefern - Nutzervorgabe 24.08.2026: "einmal mit dem
  // produzierenden Teil ... und einmal mit der gesamten Koop vergleichen".
  // Bewusst KEIN zweiter voller KI-Vergleich (Kosten/Dauer verdoppelt sich
  // sonst) - stattdessen als Kontext-Kennzahlen in Prompt + Antwort.
  let cooperationContext: Record<string, unknown> | null = null;
  if (mode === "kooperation") {
    const totalMembers = peerRows.length + 1;
    const producingMembers = peerMetrics.length + 1; // Zielhaendler hat curYear (s.o. Guard)
    const totalProduction = peerMetrics.reduce((s, m) => s + m.curProd, 0) + targetMetrics.curProd;
    cooperationContext = {
      totalMembers,
      producingMembers,
      participationRate: totalMembers > 0 ? producingMembers / totalMembers : null,
      totalProduction,
    };
  }

  const peerStats = {
    curProd: {
      median: median(peerMetrics.map((m) => m.curProd)),
      p75: percentile(peerMetrics.map((m) => m.curProd), 75),
      rank: rankPercentile(peerMetrics.map((m) => m.curProd), targetMetrics.curProd),
    },
    yoy: {
      median: median(peerMetrics.map((m) => m.yoy).filter((v): v is number => v != null)),
      p75: percentile(peerMetrics.map((m) => m.yoy).filter((v): v is number => v != null), 75),
      rank: targetMetrics.yoy != null ? rankPercentile(peerMetrics.map((m) => m.yoy).filter((v): v is number => v != null), targetMetrics.yoy) : null,
    },
    q3f2: {
      median: median(peerMetrics.map((m) => m.q3f2).filter((v): v is number => v != null)),
      p75: percentile(peerMetrics.map((m) => m.q3f2).filter((v): v is number => v != null), 75),
      rank: targetMetrics.q3f2 != null ? rankPercentile(peerMetrics.map((m) => m.q3f2).filter((v): v is number => v != null), targetMetrics.q3f2) : null,
    },
    akqPunkte: {
      median: median(peerMetrics.map((m) => m.akqPunkte).filter((v): v is number => v != null)),
      p75: percentile(peerMetrics.map((m) => m.akqPunkte).filter((v): v is number => v != null), 75),
      rank: targetMetrics.akqPunkte != null ? rankPercentile(peerMetrics.map((m) => m.akqPunkte).filter((v): v is number => v != null), targetMetrics.akqPunkte) : null,
    },
    clubWeissRate: peerMetrics.length ? peerMetrics.filter((m) => m.clubWeiss).length / peerMetrics.length : null,
  };

  const apiKey = Deno.env.get("MISTRAL_API_KEY");
  if (!apiKey) return json({ error: "MISTRAL_API_KEY ist nicht als Supabase-Secret hinterlegt." }, 500);

  const fmtPct = (v: number | null) => v == null ? "-" : (v * 100).toFixed(1).replace(".", ",") + " %";
  const userPrompt =
    `Fachhaendler ${fhNr}, Vergleichsgruppe: ${groupLabel} (${peerMetrics.length} Vergleichshaendler, anonym).\n\n` +
    `Kennzahlen dieses Haendlers (Jahr ${targetMetrics.curYear}):\n` +
    `- Jahresproduktion: ${targetMetrics.curProd} Vertraege\n` +
    `- Wachstum vs. Vorjahr: ${fmtPct(targetMetrics.yoy)}\n` +
    `- 3fuer2-Quote: ${fmtPct(targetMetrics.q3f2)}\n` +
    `- Akquisepunkte (lebenslang-kumulativ): ${targetMetrics.akqPunkte ?? "-"}\n` +
    `- Club Weiss Mitglied: ${targetMetrics.clubWeiss ? "Ja" : "Nein"}\n\n` +
    `Vergleichsgruppe (${groupLabel}), jeweils Median / oberes Quartil (75%) / Perzentil-Rang dieses Haendlers:\n` +
    `- Jahresproduktion: Median ${peerStats.curProd.median ?? "-"} / oberes Quartil ${peerStats.curProd.p75 ?? "-"} / dieser Haendler liegt im ${peerStats.curProd.rank != null ? Math.round(peerStats.curProd.rank * 100) : "-"}. Perzentil\n` +
    `- Wachstum vs. Vorjahr: Median ${fmtPct(peerStats.yoy.median)} / oberes Quartil ${fmtPct(peerStats.yoy.p75)} / Perzentil ${peerStats.yoy.rank != null ? Math.round(peerStats.yoy.rank * 100) : "-"}\n` +
    `- 3fuer2-Quote: Median ${fmtPct(peerStats.q3f2.median)} / oberes Quartil ${fmtPct(peerStats.q3f2.p75)} / Perzentil ${peerStats.q3f2.rank != null ? Math.round(peerStats.q3f2.rank * 100) : "-"}\n` +
    `- Akquisepunkte: Median ${peerStats.akqPunkte.median ?? "-"} / oberes Quartil ${peerStats.akqPunkte.p75 ?? "-"} / Perzentil ${peerStats.akqPunkte.rank != null ? Math.round(peerStats.akqPunkte.rank * 100) : "-"}\n` +
    `- Club Weiss Mitgliedschaftsquote in der Vergleichsgruppe: ${fmtPct(peerStats.clubWeissRate)}\n` +
    (cooperationContext
      ? `\nGesamtkontext der ganzen Kooperation "${(target.kooperation || "").trim()}" (alle Mitglieds-Fachhaendler, nicht nur die aktuell produzierenden):\n` +
        `- Mitglieds-Fachhaendler gesamt: ${cooperationContext.totalMembers}\n` +
        `- davon aktuell produzierend (Jahr ${targetMetrics.curYear}): ${cooperationContext.producingMembers} (${fmtPct(cooperationContext.participationRate as number | null)})\n` +
        `- Gesamtproduktion der Kooperation (nur produzierende Mitglieder): ${cooperationContext.totalProduction} Vertraege\n`
      : "");

  const systemPrompt =
    `Du bereitest ein "Chefgespraech" vor - ein internes Beratungsgespraech eines Wertgarantie-Vertriebsmitarbeiters ` +
    `mit der Geschaeftsfuehrung eines Fachhaendlers. Du bekommst die Kennzahlen dieses einen Haendlers sowie ` +
    `ANONYME Aggregatwerte (Median, oberes Quartil, Perzentil-Rang) einer Vergleichsgruppe von ` +
    `${MODE_DESCRIPTION[mode]} (nie Einzeldaten anderer Haendler). Ordne die Zahlen sachlich ein, zeige wo der ` +
    `Haendler im Vergleich gut dasteht und wo Potenzial liegt, und leite daraus konkrete, umsetzbare ` +
    `Gespraechsansaetze/Empfehlungen ab. Beruecksichtige dabei auch die Club-Weiss-Mitgliedschaft: ist der Haendler ` +
    `noch KEIN Mitglied, obwohl die Vergleichsgruppe eine hohe Mitgliedschaftsquote hat, ist das ein konkreter ` +
    `Gespraechsansatz (Empfehlung zum Beitritt); ist er Mitglied, kann das als Staerke hervorgehoben werden. ` +
    (mode === "kooperation"
      ? `Zusaetzlich bekommst du den Gesamtkontext der ganzen Kooperation (alle Mitglieds-Fachhaendler, nicht nur ` +
        `die produzierenden, auf denen der statistische Vergleich oben beruht) - erwaehne kurz und sachlich, wie ` +
        `viele Mitglieder aktuell produzieren, aber ueberbewerte eine niedrige Teilnahmequote nicht als Vorwurf an ` +
        `diesen einzelnen Haendler. `
      : "") +
    `Schreibe auf Deutsch, professionell, praegnant, ohne Floskeln. Antworte ` +
    `ausschliesslich ueber das Tool "generate_chefgespraech_comparison".`;

  let aiRes: Response;
  try {
    aiRes = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + apiKey,
      },
      body: JSON.stringify({
        model: "mistral-large-latest",
        max_tokens: 4000,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        tools: [{ type: "function", function: COMPARISON_TOOL }],
        tool_choice: "any",
        parallel_tool_calls: false,
      }),
    });
  } catch (e) {
    return json({ error: "Mistral-API nicht erreichbar: " + String(e) }, 502);
  }

  if (!aiRes.ok) {
    const errText = await aiRes.text();
    return json({ error: `Mistral-API-Fehler (${aiRes.status}): ${errText}` }, 502);
  }

  const aiJson = await aiRes.json();
  const toolCall = aiJson.choices?.[0]?.message?.tool_calls?.[0];
  if (!toolCall) return json({ error: "KI-Antwort enthielt keine strukturierte Auswertung." }, 502);
  let report: unknown;
  try {
    report = JSON.parse(toolCall.function.arguments);
  } catch (e) {
    return json({ error: "KI-Antwort enthielt kein gueltiges JSON: " + String(e) }, 502);
  }

  return json({
    ok: true,
    fh_nr: fhNr,
    mode,
    groupLabel,
    peerCount: peerMetrics.length,
    year: targetMetrics.curYear,
    metrics: { target: targetMetrics, peers: peerStats },
    cooperationContext,
    report,
  });
});
