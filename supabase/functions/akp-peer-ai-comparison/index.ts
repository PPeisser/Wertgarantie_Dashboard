// AKP-Peer-Vergleich – KI-Unterstuetzt: fasst die Leistung EINES Aktivpartners
// (AKP, Verkaeufer beim Fachhaendler) zusammen und vergleicht ihn anonymisiert
// (nur Aggregatwerte, keine Einzeldaten anderer AKP) mit einer Vergleichsgruppe
// anderer Aktivpartner. Struktur/Muster bewusst identisch zu
// chefgespraech-ai-comparison (gleiches CORS-/Auth-/Mistral-Geruest,
// gleiche median/percentile/rankPercentile-Helfer), nur die Peer-Aufloesung
// ist ein Zwei-Hop-Konstrukt statt einem direkten fh_contacts-Filter:
// AKP -> fh_nr -> fh_contacts.<mode> = Wert -> alle FH mit diesem Wert ->
// deren AKP (akp_contacts.fh_nr in [...]).
//
// Vergleichsmodi ("mode"-Feld im Request, Default "fh"):
// - "fh": andere Aktivpartner desselben Fachhaendlers.
// - "filialbetriebe" / "hauptzweig" / "weitere_zuordnung" / "kooperation":
//   Aktivpartner aller Fachhaendler mit demselben Wert in der jeweiligen
//   fh_contacts-Spalte (der eigene Fachhaendler bleibt in der Gruppe - andere
//   AKP DESSELBEN Haendlers zaehlen bewusst auch in diesen Modi als Peers,
//   ausgeschlossen wird nur die Zielperson selbst ueber akp_contacts.nr -
//   siehe akpPeerRows/akpPeerCompute im Client, gleiche Logik hier gespiegelt,
//   damit Bildschirm-Zahlen und KI-Zahlen nie auseinanderlaufen).
//
// PO-Quote/3-fuer-2-Quote: nur auf Jahresebene bewertbar (siehe Migration
// akp_contacts_quota_monthly_snapshots) - keine Monats-/Quartalshistorie.
// Der System-Prompt weist das Modell ausdruecklich darauf hin, damit es zu
// diesen beiden Kennzahlen keine Zeitverlaeufe/Trends erfindet.
//
// Auth: normale Nutzer-Session (Authorization-Header) - KEIN Admin-Gate,
// analog chefgespraech-ai-comparison (akp_contacts ist ohnehin fuer alle
// authentifizierten Nutzer lesbar).
//
// Secret: MISTRAL_API_KEY (als Supabase-Secret hinterlegt).

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
type AkpRow = Record<string, any>;
// deno-lint-ignore no-explicit-any
type FhRow = Record<string, any>;
type SnapAkp = { nr: string; monat: number; lj: number; vj: number; poQuote: number | null; q3fuer2: number | null };

function mergedMonthly(row: AkpRow): Record<string, number> {
  const pm: Record<string, number> = { ...(row.prod_monthly || {}) };
  for (const [k, v] of Object.entries(row.prod_monthly_other || {})) pm[k] = (pm[k] || 0) + (Number(v) || 0);
  return pm;
}

function keysBack(y: number, m: number, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(y + "-" + String(m).padStart(2, "0"));
    m--;
    if (m < 1) { m = 12; y--; }
  }
  return out;
}

// Juengster Monatsstand eines *_monthly-Quoten-Objekts innerhalb eines Jahres
// (Stand per Monatsultimo) - Client-Pendant: akpLatestYearQuota in index.html.
function latestYearQuota(monthlyObj: Record<string, number> | null | undefined, jahr: number): number | null {
  if (!monthlyObj) return null;
  const keys = Object.keys(monthlyObj).filter((k) => k.startsWith(jahr + "-")).sort();
  if (!keys.length) return null;
  return monthlyObj[keys[keys.length - 1]];
}

function pctOf(cur: number, prev: number): number | null {
  return prev > 0 ? (cur - prev) / prev * 100 : (cur > 0 ? null : 0);
}

interface AkpMetrics {
  prod: { monat: number; quartal: number; jahr: number };
  yoy: { monat: number | null; quartal: number | null; jahr: number | null };
  po: number | null;
  q3f2: number | null;
}

// Client-Pendant: akpPeerMetricsFor in index.html - gleiche Basis (heutiger
// Snapshot fuer Monat/Jahr, akpQuarterSum-aequivalent fuer Quartal), damit
// Bildschirm und KI-Zusammenfassung nie auseinanderlaufen.
function metricsForAkp(row: AkpRow, snap: SnapAkp | undefined, jahr: number, monat: number): AkpMetrics {
  const pm = mergedMonthly(row);
  const mk = jahr + "-" + String(monat).padStart(2, "0");
  const pk = (jahr - 1) + "-" + String(monat).padStart(2, "0");

  const prodMonat = snap?.monat ?? (pm[mk] || 0);
  const yoyMonat = pctOf(pm[mk] || 0, pm[pk] || 0);

  const curQ = keysBack(jahr, monat, 3).reduce((t, k) => t + (pm[k] || 0), 0);
  const prevQ = keysBack(jahr - 1, monat, 3).reduce((t, k) => t + (pm[k] || 0), 0);
  const yoyQuartal = pctOf(curQ, prevQ);

  let lj = 0, vj = 0;
  if (snap) { lj = snap.lj; vj = snap.vj; } else {
    for (const [k, v] of Object.entries(pm)) {
      const [y, m] = k.split("-").map(Number);
      if (y === jahr && m <= monat) lj += v;
      else if (y === jahr - 1 && m <= monat) vj += v;
    }
  }
  const yoyJahr = pctOf(lj, vj);

  const po = snap?.poQuote ?? latestYearQuota(row.poquote_monthly, jahr);
  const q3f2 = snap?.q3fuer2 ?? latestYearQuota(row.q3fuer2_monthly, jahr);

  return { prod: { monat: prodMonat, quartal: curQ, jahr: lj }, yoy: { monat: yoyMonat, quartal: yoyQuartal, jahr: yoyJahr }, po, q3f2 };
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

const AKP_PEER_MODES = ["fh", "filialbetriebe", "hauptzweig", "weitere_zuordnung", "kooperation"];
const MODE_DESCRIPTION: Record<string, string> = {
  fh: "anderen Aktivpartnern desselben Fachhaendlers",
  filialbetriebe: "Aktivpartnern desselben Filialbetriebs",
  hauptzweig: "Aktivpartnern desselben Hauptzweigs (Branche)",
  weitere_zuordnung: "Aktivpartnern mit derselben weiteren Zuordnung",
  kooperation: "Aktivpartnern derselben Einkaufskooperation",
};

// Zwei-Hop-Peer-Aufloesung, Client-Pendant: akpPeerFhNrs + akpPeerRows in
// index.html. .in()-Chunking à 200 FH-Nummern, da eine grosse Dimension
// (z.B. hauptzweig="Vollsortiment") tausende FH treffen kann und ein
// einzelnes .in() mit zu vielen Werten die PostgREST-URL-Laenge sprengt.
async function selectAkpPeerGroup(
  // deno-lint-ignore no-explicit-any
  admin: any,
  target: AkpRow,
  fhRow: FhRow | null,
  mode: string,
): Promise<{ rows: AkpRow[]; label: string }> {
  let peerFhNrs: string[] = [];
  let label = "";
  if (mode === "fh") {
    if (!target.fh_nr) return { rows: [], label: "Kein Fachhaendler hinterlegt" };
    peerFhNrs = [target.fh_nr];
    label = "Ansprechpartner desselben Haendlers";
  } else {
    const value = ((fhRow || {})[mode] || "").trim();
    if (!value) return { rows: [], label: `${mode} beim Haendler nicht hinterlegt` };
    let from = 0, guard = 0;
    for (;;) {
      guard++;
      const { data, error } = await admin.from("fh_contacts").select("fh_nr").eq(mode, value).range(from, from + 999);
      if (error) { console.error("selectAkpPeerGroup:", error.message || error); break; }
      if (!data || !data.length) break;
      for (const r of data) if (r.fh_nr) peerFhNrs.push(r.fh_nr);
      from += data.length;
      if (guard > 50) break;
    }
    label = `${mode} "${value}"`;
  }
  if (!peerFhNrs.length) return { rows: [], label };

  const rows: AkpRow[] = [];
  const CHUNK = 200;
  for (let i = 0; i < peerFhNrs.length; i += CHUNK) {
    const chunk = peerFhNrs.slice(i, i + CHUNK);
    const { data, error } = await admin.from("akp_contacts")
      .select("nr,fh_nr,vorname,nachname,firma,ort,prod_monthly,prod_monthly_other,poquote_monthly,q3fuer2_monthly")
      .in("fh_nr", chunk);
    if (error) { console.error("selectAkpPeerGroup akp_contacts:", error.message || error); continue; }
    if (data) rows.push(...data);
  }
  return { rows, label };
}

const COMPARISON_TOOL = {
  name: "generate_akp_peer_comparison",
  description: "Erstellt die strukturierte Staerken-/Schwaechen-Einordnung eines Aktivpartners im Vergleich zu einer anonymen Vergleichsgruppe.",
  parameters: {
    type: "object",
    properties: {
      summary: { type: "string", description: "Zusammenfassung der Leistung dieses Aktivpartners (2-4 Saetze, sachlich, konkret)." },
      strengths: { type: "array", items: { type: "string" }, description: "Kennzahlen/Zeitraeume, in denen der Aktivpartner klar ueber der Vergleichsgruppe liegt." },
      weaknesses: { type: "array", items: { type: "string" }, description: "Kennzahlen/Zeitraeume, in denen der Aktivpartner klar unter der Vergleichsgruppe liegt." },
      comparisons: {
        type: "array",
        items: {
          type: "object",
          properties: {
            metric: { type: "string", description: "Name der Kennzahl, z.B. 'Produktion', 'Steigerung/Verlust ggu. Vorjahr', 'PO-Quote', '3-fuer-2-Quote'." },
            period: { type: "string", enum: ["Monat", "Quartal", "Jahr"] },
            assessment: { type: "string", description: "1 Satz Einordnung vs. Vergleichsgruppe." },
          },
          required: ["metric", "period", "assessment"],
        },
      },
      recommendations: { type: "array", items: { type: "string" }, description: "2-4 konkrete, umsetzbare Ansaetze fuer das Gespraech mit diesem Aktivpartner." },
      trend_warning: { type: ["string", "null"], description: "Nur setzen, wenn die 3-Monats-Entwicklung (Quartalswert) auf einen Einbruch hindeutet, sonst null." },
    },
    required: ["summary", "strengths", "weaknesses", "comparisons", "recommendations"],
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
  const akpNr = String(body.akp_nr || "").trim();
  if (!akpNr) return json({ error: "akp_nr fehlt" }, 400);
  const modeRaw = typeof body.mode === "string" ? body.mode : "fh";
  const mode = AKP_PEER_MODES.includes(modeRaw) ? modeRaw : "fh";

  const { data: target, error: targetErr } = await admin
    .from("akp_contacts").select("*").eq("nr", akpNr).maybeSingle();
  if (targetErr) return json({ error: targetErr.message }, 500);
  if (!target) return json({ error: `AKP ${akpNr} hat noch keine Stammdaten.` }, 400);

  let fhRow: FhRow | null = null;
  if (target.fh_nr) {
    const { data } = await admin.from("fh_contacts")
      .select("fh_nr,kooperation,hauptzweig,weitere_zuordnung,filialbetriebe").eq("fh_nr", target.fh_nr).maybeSingle();
    fhRow = data || null;
  }

  let jahr = new Date().getUTCFullYear();
  let monat = new Date().getUTCMonth() + 1;
  let snapMap: Record<string, SnapAkp> = {};
  try {
    const { data: kvRow } = await admin.from("dashboard_kv").select("value").eq("key", "wg-state").maybeSingle();
    if (kvRow?.value) {
      const parsed = JSON.parse(kvRow.value);
      const latest = parsed?.latest;
      if (latest?.jahr) jahr = latest.jahr;
      if (latest?.monat) monat = latest.monat;
      for (const a of (latest?.akp || [])) {
        if (a?.nr) snapMap[a.nr] = { nr: a.nr, monat: a.monat || 0, lj: a.lj || 0, vj: a.vj || 0, poQuote: a.poQuote ?? null, q3fuer2: a.q3fuer2 ?? null };
      }
    }
  } catch (e) {
    console.error("Tagesstand konnte nicht geladen werden, Vergleich laeuft nur mit gespeicherter Monatshistorie weiter:", e);
  }

  const { rows: peerRows, label: groupLabel } = await selectAkpPeerGroup(admin, target, fhRow, mode);
  const others = peerRows.filter((r) => r.nr !== akpNr);
  const peerFhSet = new Set(others.map((r) => r.fh_nr).filter(Boolean));

  const targetMetrics = metricsForAkp(target, snapMap[akpNr], jahr, monat);
  const peerMetrics = others.map((r) => metricsForAkp(r, snapMap[r.nr], jahr, monat));

  type Stat = { median: number | null; p75: number | null; rank: number | null };
  const statFor = (peerVals: (number | null)[], ownVal: number | null): Stat => {
    const vals = peerVals.filter((v): v is number => v != null);
    return { median: median(vals), p75: percentile(vals, 75), rank: (ownVal != null) ? rankPercentile(vals, ownVal) : null };
  };
  const peerStats = {
    prod: {
      monat: statFor(peerMetrics.map((m) => m.prod.monat), targetMetrics.prod.monat),
      quartal: statFor(peerMetrics.map((m) => m.prod.quartal), targetMetrics.prod.quartal),
      jahr: statFor(peerMetrics.map((m) => m.prod.jahr), targetMetrics.prod.jahr),
    },
    yoy: {
      monat: statFor(peerMetrics.map((m) => m.yoy.monat), targetMetrics.yoy.monat),
      quartal: statFor(peerMetrics.map((m) => m.yoy.quartal), targetMetrics.yoy.quartal),
      jahr: statFor(peerMetrics.map((m) => m.yoy.jahr), targetMetrics.yoy.jahr),
    },
    po: statFor(peerMetrics.map((m) => m.po), targetMetrics.po),
    q3f2: statFor(peerMetrics.map((m) => m.q3f2), targetMetrics.q3f2),
  };

  const apiKey = Deno.env.get("MISTRAL_API_KEY");
  if (!apiKey) return json({ error: "MISTRAL_API_KEY ist nicht als Supabase-Secret hinterlegt." }, 500);

  const fmtPct = (v: number | null) => v == null ? "-" : v.toFixed(1).replace(".", ",") + " %";
  const fmtQ = (v: number | null) => v == null ? "-" : v.toFixed(1).replace(".", ",") + " %";
  const rankTxt = (r: number | null) => r != null ? Math.round(r * 100) + ". Perzentil" : "-";
  const name = [target.vorname, target.nachname].filter(Boolean).join(" ") || akpNr;

  const userPrompt =
    `Aktivpartner ${akpNr} (${name}), Fachhaendler ${target.fh_nr || "-"}, Vergleichsgruppe: ${groupLabel} ` +
    `(${others.length} Aktivpartner bei ${peerFhSet.size} Haendlern, anonym).\n\n` +
    `Kennzahlen dieses Aktivpartners:\n` +
    `- Produktion Monat: ${targetMetrics.prod.monat} Vertraege, Steigerung/Verlust ggue. Vorjahresmonat: ${fmtPct(targetMetrics.yoy.monat)}\n` +
    `- Produktion Quartal (rollierend, letzte 3 Monate): ${targetMetrics.prod.quartal} Vertraege, ggue. Vorjahresquartal: ${fmtPct(targetMetrics.yoy.quartal)}\n` +
    `- Produktion Jahr: ${targetMetrics.prod.jahr} Vertraege, ggue. Vorjahr: ${fmtPct(targetMetrics.yoy.jahr)}\n` +
    `- PO-Quote (nur Jahr verfuegbar): ${fmtQ(targetMetrics.po)}\n` +
    `- 3-fuer-2-Quote (nur Jahr verfuegbar): ${fmtQ(targetMetrics.q3f2)}\n\n` +
    `Vergleichsgruppe (${groupLabel}), jeweils Median / oberes Quartil (75%) / Perzentil-Rang dieses Aktivpartners:\n` +
    `- Produktion Monat: Median ${peerStats.prod.monat.median ?? "-"} / oberes Quartil ${peerStats.prod.monat.p75 ?? "-"} / ${rankTxt(peerStats.prod.monat.rank)}\n` +
    `- Produktion Quartal: Median ${peerStats.prod.quartal.median ?? "-"} / oberes Quartil ${peerStats.prod.quartal.p75 ?? "-"} / ${rankTxt(peerStats.prod.quartal.rank)}\n` +
    `- Produktion Jahr: Median ${peerStats.prod.jahr.median ?? "-"} / oberes Quartil ${peerStats.prod.jahr.p75 ?? "-"} / ${rankTxt(peerStats.prod.jahr.rank)}\n` +
    `- Steigerung/Verlust Monat: Median ${fmtPct(peerStats.yoy.monat.median)} / oberes Quartil ${fmtPct(peerStats.yoy.monat.p75)} / ${rankTxt(peerStats.yoy.monat.rank)}\n` +
    `- Steigerung/Verlust Quartal: Median ${fmtPct(peerStats.yoy.quartal.median)} / oberes Quartil ${fmtPct(peerStats.yoy.quartal.p75)} / ${rankTxt(peerStats.yoy.quartal.rank)}\n` +
    `- Steigerung/Verlust Jahr: Median ${fmtPct(peerStats.yoy.jahr.median)} / oberes Quartil ${fmtPct(peerStats.yoy.jahr.p75)} / ${rankTxt(peerStats.yoy.jahr.rank)}\n` +
    `- PO-Quote (Jahr): Median ${fmtQ(peerStats.po.median)} / oberes Quartil ${fmtQ(peerStats.po.p75)} / ${rankTxt(peerStats.po.rank)}\n` +
    `- 3-fuer-2-Quote (Jahr): Median ${fmtQ(peerStats.q3f2.median)} / oberes Quartil ${fmtQ(peerStats.q3f2.p75)} / ${rankTxt(peerStats.q3f2.rank)}\n`;

  const systemPrompt =
    `Du ordnest die Leistung EINES Aktivpartners (AKP, ein Verkaeufer beim Fachhaendler) fuer einen ` +
    `Wertgarantie-Vertriebsmitarbeiter ein, im Vergleich zu ${MODE_DESCRIPTION[mode]}. Du bekommst NUR anonyme ` +
    `Aggregatwerte der Vergleichsgruppe (Median, oberes Quartil, Perzentil-Rang) - NIE Einzeldaten anderer ` +
    `Aktivpartner. Zeige sachlich, wo der Aktivpartner staerker bzw. schwaecher als die Vergleichsgruppe ist, ` +
    `und leite daraus konkrete, umsetzbare Gespraechsansaetze ab.\n\n` +
    `WICHTIGE DATENLIMITATION: Produktion und Steigerung/Verlust liegen fuer Monat, Quartal und Jahr vor. ` +
    `PO-Quote und 3-fuer-2-Quote liegen dagegen AUSSCHLIESSLICH als aktueller Jahres-Snapshot vor - es gibt ` +
    `dafuer KEINE Monats- oder Quartalshistorie. Aeussere dich zu diesen beiden Quoten daher NIEMALS ueber ` +
    `Zeitverlaeufe, Trends oder Vormonatsvergleiche, sondern ausschliesslich ueber den aktuellen Stand im ` +
    `Vergleich zur Gruppe.\n\n` +
    `Ist die Vergleichsgruppe kleiner als 5 Aktivpartner, weise ausdruecklich darauf hin, dass die Einordnung ` +
    `statistisch wenig belastbar ist, und formuliere entsprechend vorsichtig. Erfinde keine Zahlen - nutze nur ` +
    `die uebergebenen Werte, benenne fehlende Werte als fehlend. Setze trend_warning nur, wenn der Quartalswert ` +
    `(rollierende letzte 3 Monate) einen deutlichen Einbruch zeigt, sonst null. Schreibe auf Deutsch, ` +
    `professionell, praegnant, ohne Floskeln. Antworte ausschliesslich ueber das Tool ` +
    `"generate_akp_peer_comparison".`;

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
    akp_nr: akpNr,
    mode,
    groupLabel,
    peerCount: others.length,
    peerFhCount: peerFhSet.size,
    year: jahr,
    monat,
    metrics: { target: targetMetrics, peers: peerStats },
    report,
  });
});
