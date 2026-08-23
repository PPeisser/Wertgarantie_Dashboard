// Kooperationsgespräch – KI-Unterstützt: fasst die aggregierten Kennzahlen
// EINER Einkaufskooperation (alle ihre Mitglieds-Fachhändler zusammen)
// zusammen und vergleicht sie anonymisiert (nur Aggregatwerte je Kooperation,
// keine Einzelhändler-Daten) mit allen ANDEREN Einkaufskooperationen. Nutzt
// die Anthropic Messages API mit erzwungenem Tool-Call für eine strukturierte
// JSON-Antwort (Zusammenfassung + Vergleichswerte je Kennzahl + Empfehlungen).
// Analog zu chefgespraech-ai-comparison, aber auf Kooperations- statt
// Einzelhändler-Ebene - "ohne Kooperation" ist keine echte Kooperation und
// wird sowohl als Ziel als auch aus der Vergleichsgruppe ausgeschlossen.
//
// Auth: normale Nutzer-Session (Authorization-Header) - KEIN Admin-Gate,
// da jeder Außendienst-Mitarbeiter den Kooperationsgespräch-Button nutzen
// darf (fh_contacts ist ohnehin für alle authentifizierten Nutzer lesbar).
//
// Secret: ANTHROPIC_API_KEY (bereits als Supabase-Secret hinterlegt, siehe
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

// deno-lint-ignore no-explicit-any
type FhRow = Record<string, any>;

function yearlyProd(row: FhRow): Record<string, number> {
  const pm = row.prod_monthly || {};
  const byYear: Record<string, number> = {};
  for (const [k, v] of Object.entries(pm)) {
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

// Aggregiert eine Gruppe von Fachhändler-Zeilen (eine Kooperation) zu den
// Kennzahlen dieser Kooperation, bezogen auf ein fest vorgegebenes Jahr
// (curYear) - damit sind Kooperationen untereinander vergleichbar, auch wenn
// einzelne Mitglieds-Händler unterschiedliche Datenstände haben.
function aggregateGroup(rows: FhRow[], curYear: string, prevYear: string): KoopMetrics {
  let curProd = 0, prevProd = 0, bf = 0, akqSum = 0, akqCount = 0, clubWeissCount = 0;
  for (const r of rows) {
    const byYear = yearlyProd(r);
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
  description: "Erstellt die strukturierte Zusammenfassung samt anonymem Vergleich für das Kooperationsgespräch.",
  input_schema: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description: "Zusammenfassung der wichtigsten Kennzahlen dieser Einkaufskooperation für das Kooperationsgespräch (2-4 Sätze, sachlich, konkret).",
      },
      comparisons: {
        type: "array",
        description: "Ein Eintrag je Kennzahl, mit Einordnung ggü. den anderen (anonymen) Einkaufskooperationen.",
        items: {
          type: "object",
          properties: {
            metric: { type: "string", description: "Name der Kennzahl, z.B. 'Jahresproduktion', 'Wachstum ggü. Vorjahr', '3-für-2-Quote', 'Ø Akquisepunkte je Fachhändler'." },
            assessment: { type: "string", description: "1 Satz Einordnung: steht die Kooperation besser/schlechter da als die anderen Kooperationen, und was heißt das." },
          },
          required: ["metric", "assessment"],
        },
      },
      recommendations: {
        type: "array",
        items: { type: "string" },
        description: "2-4 konkrete, umsetzbare Empfehlungen/Gesprächsansätze für das Kooperationsgespräch, abgeleitet aus dem Vergleich.",
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
  if (userErr || !user) return json({ error: "Ungültige Session" }, 401);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Ungültiger Body" }, 400); }
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

  let maxYear = "";
  for (const r of rows) {
    for (const k of Object.keys(r.prod_monthly || {})) {
      const y = k.slice(0, 4);
      if (y > maxYear) maxYear = y;
    }
  }
  if (!maxYear) return json({ error: "Für Einkaufskooperationen liegt noch keine Jahresproduktion vor." }, 400);
  const prevYear = String(Number(maxYear) - 1);

  const byKoop = new Map<string, FhRow[]>();
  for (const r of rows) {
    const k = (r.kooperation || "").trim();
    if (!k) continue;
    if (!byKoop.has(k)) byKoop.set(k, []);
    byKoop.get(k)!.push(r);
  }

  const targetRows = byKoop.get(kooperation) || [];
  if (!targetRows.length) return json({ error: `Keine Fachhändler mit Kooperation "${kooperation}" gefunden.` }, 400);
  const targetMetrics = aggregateGroup(targetRows, maxYear, prevYear);

  const peerGroups: KoopMetrics[] = [];
  for (const [k, grp] of byKoop) {
    if (k === kooperation) continue;
    peerGroups.push(aggregateGroup(grp, maxYear, prevYear));
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

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "ANTHROPIC_API_KEY ist nicht als Supabase-Secret hinterlegt." }, 500);

  const fmtPct = (v: number | null) => v == null ? "–" : (v * 100).toFixed(1).replace(".", ",") + " %";
  const userPrompt =
    `Einkaufskooperation "${kooperation}" mit ${targetMetrics.fhCount} Mitglieds-Fachhändlern, ` +
    `Vergleichsgruppe: ${peerGroups.length} andere Einkaufskooperationen (anonym).\n\n` +
    `Kennzahlen dieser Kooperation (Jahr ${maxYear}, aufsummiert über alle Mitglieds-Fachhändler):\n` +
    `- Jahresproduktion: ${targetMetrics.curProd} Verträge\n` +
    `- Wachstum ggü. Vorjahr: ${fmtPct(targetMetrics.yoy)}\n` +
    `- 3-für-2-Quote: ${fmtPct(targetMetrics.q3f2)}\n` +
    `- Ø Akquisepunkte je Fachhändler: ${targetMetrics.akqPunkte != null ? Math.round(targetMetrics.akqPunkte) : "–"}\n` +
    `- Club Weiss Mitgliedschaftsquote (Anteil Club-Weiss-Mitglieder unter den Mitglieds-Fachhändlern): ${fmtPct(targetMetrics.clubWeissRate)}\n\n` +
    `Andere Einkaufskooperationen, jeweils Median / oberes Quartil (75%) / Perzentil-Rang dieser Kooperation:\n` +
    `- Jahresproduktion: Median ${peerStats.curProd.median != null ? Math.round(peerStats.curProd.median) : "–"} / oberes Quartil ${peerStats.curProd.p75 != null ? Math.round(peerStats.curProd.p75) : "–"} / diese Kooperation liegt im ${peerStats.curProd.rank != null ? Math.round(peerStats.curProd.rank * 100) : "–"}. Perzentil\n` +
    `- Wachstum ggü. Vorjahr: Median ${fmtPct(peerStats.yoy.median)} / oberes Quartil ${fmtPct(peerStats.yoy.p75)} / Perzentil ${peerStats.yoy.rank != null ? Math.round(peerStats.yoy.rank * 100) : "–"}\n` +
    `- 3-für-2-Quote: Median ${fmtPct(peerStats.q3f2.median)} / oberes Quartil ${fmtPct(peerStats.q3f2.p75)} / Perzentil ${peerStats.q3f2.rank != null ? Math.round(peerStats.q3f2.rank * 100) : "–"}\n` +
    `- Ø Akquisepunkte je Fachhändler: Median ${peerStats.akqPunkte.median != null ? Math.round(peerStats.akqPunkte.median) : "–"} / oberes Quartil ${peerStats.akqPunkte.p75 != null ? Math.round(peerStats.akqPunkte.p75) : "–"} / Perzentil ${peerStats.akqPunkte.rank != null ? Math.round(peerStats.akqPunkte.rank * 100) : "–"}\n` +
    `- Club Weiss Mitgliedschaftsquote: Median ${fmtPct(peerStats.clubWeissRate.median)} / oberes Quartil ${fmtPct(peerStats.clubWeissRate.p75)} / Perzentil ${peerStats.clubWeissRate.rank != null ? Math.round(peerStats.clubWeissRate.rank * 100) : "–"}\n`;

  const systemPrompt =
    `Du bereitest ein "Kooperationsgespräch" vor - ein internes Beratungsgespräch eines Wertgarantie-Vertriebsmitarbeiters ` +
    `mit einer Einkaufskooperation (Vertriebsverbund mehrerer Fachhändler). Du bekommst die aufsummierten/gemittelten ` +
    `Kennzahlen dieser einen Kooperation sowie ANONYME Aggregatwerte (Median, oberes Quartil, Perzentil-Rang) einer ` +
    `Vergleichsgruppe aller anderen Einkaufskooperationen (nie Einzeldaten anderer Kooperationen oder einzelner ` +
    `Fachhändler). Ordne die Zahlen sachlich ein, zeige wo die Kooperation im Vergleich gut dasteht und wo Potenzial ` +
    `liegt, und leite daraus konkrete, umsetzbare Gesprächsansätze/Empfehlungen ab. Berücksichtige dabei auch die ` +
    `Club-Weiss-Mitgliedschaftsquote: liegt sie unter dem Vergleichswert, ist das ein konkreter Gesprächsansatz ` +
    `(mehr Mitglieds-Fachhändler für Club Weiss gewinnen); liegt sie darüber, ist das eine Stärke. Schreibe auf ` +
    `Deutsch, professionell, prägnant, ohne Floskeln. Antworte ausschließlich über das Tool ` +
    `"generate_kooperationsgespraech_comparison".`;

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
        max_tokens: 4000,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
        tools: [COMPARISON_TOOL],
        tool_choice: { type: "tool", name: "generate_kooperationsgespraech_comparison" },
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
  if (!toolUse) return json({ error: "KI-Antwort enthielt keine strukturierte Auswertung." }, 502);

  return json({
    ok: true,
    kooperation,
    peerCount: peerGroups.length,
    year: maxYear,
    metrics: { target: targetMetrics, peers: peerStats },
    report: toolUse.input,
  });
});
