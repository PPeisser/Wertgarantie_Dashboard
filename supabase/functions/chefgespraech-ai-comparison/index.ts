// Chefgespräch – KI-Unterstützt: fasst die Kennzahlen EINES Fachhändlers
// zusammen und vergleicht ihn anonymisiert (nur Aggregatwerte, keine
// Einzelhändler-Daten) mit einer Vergleichsgruppe anderer Händler. Nutzt die
// Anthropic Messages API mit erzwungenem Tool-Call für eine strukturierte
// JSON-Antwort (Zusammenfassung + Vergleichswerte je Kennzahl + Empfehlungen).
//
// Vergleichsmodi (Nutzervorgabe 22./23.08.2026, "mode"-Feld im Request):
// - "region" (Default): gleiche erste PLZ-Ziffer.
// - "kooperation": gleicher Wert in fh_contacts.kooperation.
// - "hauptzweig": gleicher Wert in fh_contacts.hauptzweig.
// - "weitere_zuordnung": gleicher Wert in fh_contacts.weitere_zuordnung.
// Die Vergleichsgruppen-Auswahl ist als eigener, austauschbarer Schritt
// (selectPeerGroup) gebaut - weitere Modi (bestimmte Händler, Umkreis in km)
// können später ergänzt werden, ohne den restlichen Ablauf anzufassen.
//
// Auth: normale Nutzer-Session (Authorization-Header) - KEIN Admin-Gate,
// da jeder Außendienst-Mitarbeiter den Chefgespräch-Button nutzen darf
// (fh_contacts ist ohnehin für alle authentifizierten Nutzer lesbar).
//
// Secret: ANTHROPIC_API_KEY (bereits als Supabase-Secret hinterlegt, siehe
// performance-dialog-annual-summary).

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

interface Metrics {
  curYear: string | null;
  curProd: number;
  yoy: number | null;
  q3f2: number | null;
  akqPunkte: number | null;
  clubWeiss: boolean;
}

function metricsForFh(row: FhRow): Metrics {
  const byYear = yearlyProd(row);
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

// Vier Modi: "region" (Default, erste PLZ-Ziffer), "kooperation",
// "hauptzweig", "weitere_zuordnung" (jeweils: gleicher Wert wie der
// Ziel-Händler in der gleichnamigen fh_contacts-Spalte). Gibt die
// Kandidaten-Zeilen zurück (roher fh_contacts-Query, noch ohne
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
  // Default: "region" (erste PLZ-Ziffer, grobe Bundesland-Näherung).
  const plzPrefix = (target.plz || "").trim().charAt(0);
  if (!plzPrefix) return { rows: [], label: "Region unbekannt (keine PLZ hinterlegt)" };
  const { data } = await admin.from("fh_contacts").select(PEER_SELECT_COLS + ",plz")
    .like("plz", plzPrefix + "%").neq("fh_nr", target.fh_nr);
  return { rows: data || [], label: "Region " + plzPrefix + "xxx (gleiche erste PLZ-Ziffer)" };
}

const COMPARISON_TOOL = {
  name: "generate_chefgespraech_comparison",
  description: "Erstellt die strukturierte Zusammenfassung samt anonymem Vergleich für das Chefgespräch.",
  input_schema: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description: "Zusammenfassung der wichtigsten Kennzahlen dieses Händlers für das Chefgespräch (2-4 Sätze, sachlich, konkret).",
      },
      comparisons: {
        type: "array",
        description: "Ein Eintrag je Kennzahl, mit Einordnung ggü. der (anonymen) Vergleichsgruppe.",
        items: {
          type: "object",
          properties: {
            metric: { type: "string", description: "Name der Kennzahl, z.B. 'Jahresproduktion', 'Wachstum ggü. Vorjahr', '3-für-2-Quote', 'Akquisepunkte'." },
            assessment: { type: "string", description: "1 Satz Einordnung: steht der Händler besser/schlechter da als die Vergleichsgruppe, und was heißt das." },
          },
          required: ["metric", "assessment"],
        },
      },
      recommendations: {
        type: "array",
        items: { type: "string" },
        description: "2-4 konkrete, umsetzbare Empfehlungen/Gesprächsansätze für das Chefgespräch, abgeleitet aus dem Vergleich.",
      },
    },
    required: ["summary", "comparisons", "recommendations"],
  },
};

const MODE_DESCRIPTION: Record<string, string> = {
  region: "Fachhändlern derselben Region (grobe PLZ-Näherung)",
  kooperation: "Fachhändlern derselben Einkaufskooperation",
  hauptzweig: "Fachhändlern desselben Hauptzweigs (Branche)",
  weitere_zuordnung: "Fachhändlern mit derselben weiteren Zuordnung",
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
  const fhNr = String(body.fh_nr || "").trim();
  if (!fhNr) return json({ error: "fh_nr fehlt" }, 400);
  const modeRaw = typeof body.mode === "string" ? body.mode : "region";
  const mode = ["region", "kooperation", "hauptzweig", "weitere_zuordnung"].includes(modeRaw) ? modeRaw : "region";

  const { data: target, error: targetErr } = await admin
    .from("fh_contacts").select("*").eq("fh_nr", fhNr).maybeSingle();
  if (targetErr) return json({ error: targetErr.message }, 500);
  if (!target) return json({ error: `Fachhändler ${fhNr} hat noch keine Stammdaten.` }, 400);

  const targetMetrics = metricsForFh(target);
  if (!targetMetrics.curYear) {
    return json({ error: "Für diesen Händler liegt noch keine Jahresproduktion vor - Vergleich nicht möglich." }, 400);
  }

  const { rows: peerRows, label: groupLabel } = await selectPeerGroup(admin, target, mode);
  const peerMetrics = peerRows.map(metricsForFh).filter((m) => m.curYear === targetMetrics.curYear);

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

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "ANTHROPIC_API_KEY ist nicht als Supabase-Secret hinterlegt." }, 500);

  const fmtPct = (v: number | null) => v == null ? "–" : (v * 100).toFixed(1).replace(".", ",") + " %";
  const userPrompt =
    `Fachhändler ${fhNr}, Vergleichsgruppe: ${groupLabel} (${peerMetrics.length} Vergleichshändler, anonym).\n\n` +
    `Kennzahlen dieses Händlers (Jahr ${targetMetrics.curYear}):\n` +
    `- Jahresproduktion: ${targetMetrics.curProd} Verträge\n` +
    `- Wachstum ggü. Vorjahr: ${fmtPct(targetMetrics.yoy)}\n` +
    `- 3-für-2-Quote: ${fmtPct(targetMetrics.q3f2)}\n` +
    `- Akquisepunkte (lebenslang-kumulativ): ${targetMetrics.akqPunkte ?? "–"}\n` +
    `- Club Weiss Mitglied: ${targetMetrics.clubWeiss ? "Ja" : "Nein"}\n\n` +
    `Vergleichsgruppe (${groupLabel}), jeweils Median / oberes Quartil (75%) / Perzentil-Rang dieses Händlers:\n` +
    `- Jahresproduktion: Median ${peerStats.curProd.median ?? "–"} / oberes Quartil ${peerStats.curProd.p75 ?? "–"} / dieser Händler liegt im ${peerStats.curProd.rank != null ? Math.round(peerStats.curProd.rank * 100) : "–"}. Perzentil\n` +
    `- Wachstum ggü. Vorjahr: Median ${fmtPct(peerStats.yoy.median)} / oberes Quartil ${fmtPct(peerStats.yoy.p75)} / Perzentil ${peerStats.yoy.rank != null ? Math.round(peerStats.yoy.rank * 100) : "–"}\n` +
    `- 3-für-2-Quote: Median ${fmtPct(peerStats.q3f2.median)} / oberes Quartil ${fmtPct(peerStats.q3f2.p75)} / Perzentil ${peerStats.q3f2.rank != null ? Math.round(peerStats.q3f2.rank * 100) : "–"}\n` +
    `- Akquisepunkte: Median ${peerStats.akqPunkte.median ?? "–"} / oberes Quartil ${peerStats.akqPunkte.p75 ?? "–"} / Perzentil ${peerStats.akqPunkte.rank != null ? Math.round(peerStats.akqPunkte.rank * 100) : "–"}\n` +
    `- Club Weiss Mitgliedschaftsquote in der Vergleichsgruppe: ${fmtPct(peerStats.clubWeissRate)}\n`;

  const systemPrompt =
    `Du bereitest ein "Chefgespräch" vor - ein internes Beratungsgespräch eines Wertgarantie-Vertriebsmitarbeiters ` +
    `mit der Geschäftsführung eines Fachhändlers. Du bekommst die Kennzahlen dieses einen Händlers sowie ` +
    `ANONYME Aggregatwerte (Median, oberes Quartil, Perzentil-Rang) einer Vergleichsgruppe von ` +
    `${MODE_DESCRIPTION[mode]} (nie Einzeldaten anderer Händler). Ordne die Zahlen sachlich ein, zeige wo der ` +
    `Händler im Vergleich gut dasteht und wo Potenzial liegt, und leite daraus konkrete, umsetzbare ` +
    `Gesprächsansätze/Empfehlungen ab. Berücksichtige dabei auch die Club-Weiss-Mitgliedschaft: ist der Händler ` +
    `noch KEIN Mitglied, obwohl die Vergleichsgruppe eine hohe Mitgliedschaftsquote hat, ist das ein konkreter ` +
    `Gesprächsansatz (Empfehlung zum Beitritt); ist er Mitglied, kann das als Stärke hervorgehoben werden. ` +
    `Schreibe auf Deutsch, professionell, prägnant, ohne Floskeln. Antworte ` +
    `ausschließlich über das Tool "generate_chefgespraech_comparison".`;

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
        tool_choice: { type: "tool", name: "generate_chefgespraech_comparison" },
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
    fh_nr: fhNr,
    mode,
    groupLabel,
    peerCount: peerMetrics.length,
    year: targetMetrics.curYear,
    metrics: { target: targetMetrics, peers: peerStats },
    report: toolUse.input,
  });
});
