// Automatische wiederkehrende "Auswertungen" (Nutzervorgabe 24.09.2026):
// jede einzelne Auswertung (Kooperation/Weitere Zuordnung/Filialbetriebe/
// Fachhändler/AKP) kann beim Einrichten (index.html, auswertungAutoSection)
// als wiederkehrender Mailversand an eine Kunden-Adresse abonniert werden.
// Läuft täglich per pg_cron (schema.sql, Job "auswertung-scheduled-mail-daily")
// - alle 5 Intervalle sind anhand von Wochentag/Monatstag (Wiener Ortszeit)
// tagesgenau prüfbar, kein stündliches Zeitfenster nötig.
//
// Pro fälligem Abo wird EIN PDF gebaut (pdf-lib - läuft ohne Browser/DOM,
// analog dem bereits etablierten Trainerbetreuung-Wochenbericht-Muster)
// und ZWEIMAL verschickt: einmal an recipient_email (Kunde, "Lieber
// Kunde..."-Text), einmal an created_by_email (Mitarbeiter-Kopie, nur bei
// automatischen Sendungen - Klärung 24.09.2026). Danach wird das PDF im
// Storage-Bucket "auswertung-berichte" abgelegt und in
// auswertung_subscription_sends protokolliert (Idempotenz + spätere
// Admin-Downloadliste).
//
// Perioden sind immer ABGESCHLOSSENE Kalenderabschnitte (gestern/Vorwoche/
// Vormonat/Vorquartal/Vorjahr) - nie der laufende, noch unvollständige
// Zeitraum. Ein Abo ohne jeden bisherigen Sende-Log gilt unabhängig vom
// Tages-Gate als sofort fällig (erster Versand spätestens beim nächsten
// Cron-Tick, siehe Design-Entscheidung im Plan).
//
// Bei fixed_range_enabled hat der Endstand-Zweig (heute > range_end, noch
// nicht versendet) Vorrang vor der normalen Intervallprüfung - danach wird
// das Abo automatisch deaktiviert (active=false).
//
// Test-/Korrektur-Aufruf (x-cron-secret erforderlich): POST-Body
// { "force": true, "subscriptionId": "...", "skipRealSend": true|false } -
// umgeht Tages-Gate und Idempotenz-Vorprüfung (die harte DB-Unique-Sperre
// bleibt als Fallback bestehen), optional auf ein einzelnes Abo beschränkt.
// skipRealSend:true baut PDF + Storage + Log-Zeile, verschickt aber keine
// echte Mail.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { PDFDocument, StandardFonts, rgb, PDFFont, PDFPage } from "npm:pdf-lib@1.17.1";

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

// ---------- Wiener Ortszeit / Datumshilfen ----------

function viennaNow(): { year: number; month: number; day: number; weekday: number } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Vienna", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  });
  const parts = fmt.formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
  const weekdayMap: Record<string, number> = { Sun: 7, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: +get("year"), month: +get("month"), day: +get("day"),
    weekday: weekdayMap[get("weekday")] ?? -1,
  };
}
function pad2(n: number): string { return String(n).padStart(2, "0"); }
function ymd(y: number, m: number, d: number): string { return `${y}-${pad2(m)}-${pad2(d)}`; }
function addDaysISO(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function addYearsIso(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return ymd(y + n, m, d);
}
function fmtDateAT(iso: string | null | undefined): string {
  if (!iso) return "–";
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}
function fmtInt(n: number | null | undefined): string {
  return n == null ? "–" : Math.round(n).toLocaleString("de-AT");
}

// Fälligkeits-Gate: an welchem Wiener Kalendertag darf ein Intervall (außer
// beim allerersten, IMMER fälligen Versand) feuern.
function isDueToday(interval: string, v: { day: number; month: number; weekday: number }): boolean {
  if (interval === "daily") return true;
  if (interval === "weekly") return v.weekday === 1;
  if (interval === "monthly") return v.day === 1;
  if (interval === "quarterly") return v.day === 1 && [1, 4, 7, 10].includes(v.month);
  if (interval === "yearly") return v.day === 1 && v.month === 1;
  return false;
}

// Letzter ABGESCHLOSSENER Kalenderabschnitt vor "heute" (Wien) für das
// jeweilige Intervall - unabhängig davon, ob heute zufällig der Gate-Tag
// ist (wird für den allerersten, sofort fälligen Versand eines neuen Abos
// gebraucht, das noch nie einen Sende-Log-Eintrag hat).
function periodForInterval(interval: string, v: { year: number; month: number; day: number; weekday: number }): { start: string; end: string } {
  const todayISO = ymd(v.year, v.month, v.day);
  if (interval === "daily") {
    const end = addDaysISO(todayISO, -1);
    return { start: end, end };
  }
  if (interval === "weekly") {
    const thisMonday = addDaysISO(todayISO, -(v.weekday - 1));
    const prevMonday = addDaysISO(thisMonday, -7);
    const prevSunday = addDaysISO(thisMonday, -1);
    return { start: prevMonday, end: prevSunday };
  }
  if (interval === "monthly") {
    const firstOfThisMonth = ymd(v.year, v.month, 1);
    const lastOfPrevMonth = addDaysISO(firstOfThisMonth, -1);
    const prevMonthStart = lastOfPrevMonth.slice(0, 8) + "01";
    return { start: prevMonthStart, end: lastOfPrevMonth };
  }
  if (interval === "quarterly") {
    const q = Math.floor((v.month - 1) / 3);
    const qStartMonth = q * 3 + 1;
    const firstOfThisQuarter = ymd(v.year, qStartMonth, 1);
    const lastOfPrevQuarter = addDaysISO(firstOfThisQuarter, -1);
    const prevQ = q === 0 ? { y: v.year - 1, q: 3 } : { y: v.year, q: q - 1 };
    const prevQuarterStart = ymd(prevQ.y, prevQ.q * 3 + 1, 1);
    return { start: prevQuarterStart, end: lastOfPrevQuarter };
  }
  // yearly
  return { start: ymd(v.year - 1, 1, 1), end: ymd(v.year - 1, 12, 31) };
}

// Proportionale Monats-Overlap-Summe (wie fhAvgDailyProdInRange in
// index.html, hier aber SUMME statt Tagesschnitt) - robust für beliebige,
// nicht zwingend kalenderausgerichtete Bereiche (z.B. ein vom Nutzer frei
// gewählter Endstand-Zeitraum). [fromISO, toISO] inklusive.
function sumProdMonthlyInRange(monthly: Record<string, number> | null | undefined, fromISO: string, toISO: string): number {
  if (!monthly || fromISO > toISO) return 0;
  let sum = 0;
  let cur = new Date(fromISO + "T00:00:00Z");
  const endExclusive = new Date(toISO + "T00:00:00Z");
  endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
  while (cur < endExclusive) {
    const y = cur.getUTCFullYear(), m = cur.getUTCMonth();
    const monthStart = new Date(Date.UTC(y, m, 1));
    const monthEnd = new Date(Date.UTC(y, m + 1, 1));
    const daysInMonth = Math.round((monthEnd.getTime() - monthStart.getTime()) / 86400000);
    const overlapStart = cur > monthStart ? cur : monthStart;
    const overlapEnd = endExclusive < monthEnd ? endExclusive : monthEnd;
    const overlapDays = Math.max(0, Math.round((overlapEnd.getTime() - overlapStart.getTime()) / 86400000));
    if (overlapDays > 0) {
      const key = `${y}-${pad2(m + 1)}`;
      const val = monthly[key];
      if (val != null) sum += Number(val) * overlapDays / daysInMonth;
    }
    cur = monthEnd;
  }
  return sum;
}
function sumDailyInRange(daily: Record<string, number> | undefined, fromISO: string, toISO: string): number {
  if (!daily) return 0;
  let sum = 0;
  for (const [d, v] of Object.entries(daily)) if (d >= fromISO && d <= toISO) sum += Number(v) || 0;
  return sum;
}

// ---------- Datenmodell ----------

interface Unit {
  key: string; // FH-Nr oder AKP-Nr
  monthlyWg: Record<string, number>;
}
const TYP_LABEL: Record<string, string> = {
  kooperation: "Kooperation", weitere_zuordnung: "Weitere Zuordnung", filialbetriebe: "Filialbetriebe",
  fachhaendler: "Fachhändler", akp: "AKP (Aktivpartner)",
};

// Namens-/Ort-Auflösung wie fhResolveNameOrt() im Client (Bug-Report
// 19./23.09.2026 hier serverseitig identisch nachgebaut): akq_name >
// miete_name > name > erster AKP-Kontakt dieses FH mit firma > FH-Nr.
function resolveFhName(fh: { name: string | null; akq_name: string | null; miete_name: string | null } | undefined, akpFirma: string | null | undefined, fhNr: string): string {
  return fh?.akq_name || fh?.miete_name || fh?.name || akpFirma || fhNr;
}

async function loadUnitsForSubscription(
  admin: ReturnType<typeof createClient>,
  typ: string,
  entityKey: string,
): Promise<{ units: Unit[]; label: string }> {
  if (typ === "akp") {
    const { data: a } = await admin.from("akp_contacts").select("nr,vorname,nachname,firma,prod_monthly,prod_monthly_other").eq("nr", entityKey).maybeSingle();
    const monthlyWg: Record<string, number> = {};
    for (const [k, v] of Object.entries((a?.prod_monthly as Record<string, number>) || {})) monthlyWg[k] = (monthlyWg[k] || 0) + (Number(v) || 0);
    for (const [k, v] of Object.entries((a?.prod_monthly_other as Record<string, number>) || {})) monthlyWg[k] = (monthlyWg[k] || 0) + (Number(v) || 0);
    const label = a ? ([a.vorname, a.nachname].filter(Boolean).join(" ") || a.firma || entityKey) : entityKey;
    return { units: [{ key: entityKey, monthlyWg }], label };
  }
  if (typ === "fachhaendler") {
    const { data: fh } = await admin.from("fh_contacts").select("fh_nr,name,akq_name,miete_name,prod_monthly").eq("fh_nr", entityKey).maybeSingle();
    let akpFirma: string | null = null;
    if (!fh?.akq_name && !fh?.miete_name && !fh?.name) {
      const { data: akpRow } = await admin.from("akp_contacts").select("firma").eq("fh_nr", entityKey).not("firma", "is", null).limit(1).maybeSingle();
      akpFirma = akpRow?.firma || null;
    }
    const label = resolveFhName(fh || undefined, akpFirma, entityKey);
    return { units: [{ key: entityKey, monthlyWg: (fh?.prod_monthly as Record<string, number>) || {} }], label };
  }
  // Aggregat-Typen: alle FH mit diesem Kooperations-/Zuordnungs-/
  // Filialketten-Wert, Entity-Key selbst ist der Anzeige-Label.
  const col = typ === "kooperation" ? "kooperation" : typ === "weitere_zuordnung" ? "weitere_zuordnung" : "filialbetriebe";
  const { data: rows } = await admin.from("fh_contacts").select("fh_nr,prod_monthly").eq(col, entityKey);
  const units: Unit[] = (rows || []).map((r) => ({ key: r.fh_nr as string, monthlyWg: (r.prod_monthly as Record<string, number>) || {} }));
  return { units, label: entityKey };
}

// state.dailyFH/dailyAKP (Tageshistorie) liegen NUR im dashboard_kv-Blob
// "wg-state" (derselbe Trick wie bereits im Trainerbetreuung-Wochenbericht
// genutzt) - nötig für daily/weekly-Intervalle, da prod_monthly nur
// Monatsaggregate hält. Wird nur bei Bedarf geladen (teurer ~730KB-Blob).
async function loadDailyHistory(admin: ReturnType<typeof createClient>): Promise<{ dailyFH: Record<string, Record<string, number>>; dailyAKP: Record<string, Record<string, number>> }> {
  try {
    const { data } = await admin.from("dashboard_kv").select("value").eq("key", "wg-state").maybeSingle();
    if (data?.value) {
      const parsed = JSON.parse(data.value as string);
      return { dailyFH: parsed?.dailyFH || {}, dailyAKP: parsed?.dailyAKP || {} };
    }
  } catch (e) { console.error("[auswertung-scheduled-mail] wg-state Parse fehlgeschlagen:", String(e)); }
  return { dailyFH: {}, dailyAKP: {} };
}

function unitsTotal(units: Unit[], typ: string, fromISO: string, toISO: string, useDailyHistory: boolean, dailyFH: Record<string, Record<string, number>>, dailyAKP: Record<string, Record<string, number>>): number {
  if (useDailyHistory) {
    const dailyMap = typ === "akp" ? dailyAKP : dailyFH;
    return units.reduce((s, u) => s + sumDailyInRange(dailyMap[u.key], fromISO, toISO), 0);
  }
  return units.reduce((s, u) => s + sumProdMonthlyInRange(u.monthlyWg, fromISO, toISO), 0);
}

// ---------- PDF-Aufbau (pdf-lib, kein DOM) ----------

const PAGE_W = 595.28, PAGE_H = 841.89, MARGIN = 42;
const COL_NAVY = rgb(6 / 255, 42 / 255, 63 / 255);
const COL_BLUE = rgb(0 / 255, 159 / 255, 227 / 255);
const COL_MUTED = rgb(93 / 255, 114 / 255, 132 / 255);
const COL_INK = rgb(16 / 255, 32 / 255, 44 / 255);
const COL_LINE = rgb(228 / 255, 237 / 255, 243 / 255);
const COL_POS = rgb(27 / 255, 122 / 255, 67 / 255);
const COL_NEG = rgb(179 / 255, 50 / 255, 74 / 255);

class PdfBuilder {
  doc!: PDFDocument;
  fontReg!: PDFFont;
  fontBold!: PDFFont;
  page!: PDFPage;
  y = 0;

  static async create(): Promise<PdfBuilder> {
    const b = new PdfBuilder();
    b.doc = await PDFDocument.create();
    b.fontReg = await b.doc.embedFont(StandardFonts.Helvetica);
    b.fontBold = await b.doc.embedFont(StandardFonts.HelveticaBold);
    b.addPage();
    return b;
  }
  addPage() { this.page = this.doc.addPage([PAGE_W, PAGE_H]); this.y = PAGE_H - MARGIN; }
  ensureSpace(h: number) { if (this.y - h < MARGIN) this.addPage(); }
  text(str: string, x: number, size: number, opts: { bold?: boolean; color?: ReturnType<typeof rgb> } = {}) {
    this.page.drawText(str, { x, y: this.y, size, font: opts.bold ? this.fontBold : this.fontReg, color: opts.color || COL_INK });
  }
  lineBreak(h: number) { this.y -= h; }
  hr(color = COL_LINE) { this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: PAGE_W - MARGIN, y: this.y }, thickness: 1, color }); }
}

async function buildAuswertungPdf(opts: {
  typLabel: string; entityLabel: string; fromISO: string; toISO: string; isEndstand: boolean;
  total: number; totalVj: number | null; totalVvj: number | null;
}): Promise<Uint8Array> {
  const b = await PdfBuilder.create();
  b.text(opts.isEndstand ? "Auswertung – Abschlussbericht" : "Auswertung", MARGIN, 19, { bold: true, color: COL_NAVY });
  b.lineBreak(22);
  b.text(`${opts.typLabel} · ${opts.entityLabel}`, MARGIN, 13, { bold: true, color: COL_NAVY });
  b.lineBreak(18);
  b.text(`Zeitraum: ${fmtDateAT(opts.fromISO)} – ${fmtDateAT(opts.toISO)}`, MARGIN, 11, { color: COL_MUTED });
  b.lineBreak(10);
  b.hr(COL_BLUE);
  b.lineBreak(24);

  b.text("WG-Produktion im Zeitraum:", MARGIN, 12, { bold: true, color: COL_INK });
  b.text(fmtInt(opts.total) + " Stk.", MARGIN + 260, 12, { bold: true, color: COL_NAVY });
  b.lineBreak(20);

  if (opts.totalVj != null) {
    const diff = opts.totalVj > 0 ? ((opts.total - opts.totalVj) / opts.totalVj * 100) : null;
    b.text("Vorjahreszeitraum:", MARGIN, 11, { color: COL_MUTED });
    b.text(fmtInt(opts.totalVj) + " Stk." + (diff != null ? `  (${diff >= 0 ? "+" : ""}${diff.toFixed(1).replace(".", ",")} %)` : ""), MARGIN + 260, 11, { color: diff == null ? COL_INK : (diff >= 0 ? COL_POS : COL_NEG) });
    b.lineBreak(16);
  }
  if (opts.totalVvj != null) {
    const diff = opts.totalVvj > 0 ? ((opts.total - opts.totalVvj) / opts.totalVvj * 100) : null;
    b.text("Vorvorjahreszeitraum:", MARGIN, 11, { color: COL_MUTED });
    b.text(fmtInt(opts.totalVvj) + " Stk." + (diff != null ? `  (${diff >= 0 ? "+" : ""}${diff.toFixed(1).replace(".", ",")} %)` : ""), MARGIN + 260, 11, { color: diff == null ? COL_INK : (diff >= 0 ? COL_POS : COL_NEG) });
    b.lineBreak(16);
  }

  if (opts.isEndstand) {
    b.lineBreak(10);
    b.text("Dies ist der abschließende Bericht für den gesamten definierten Zeitraum.", MARGIN, 10, { color: COL_MUTED });
  }
  return await b.doc.save();
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  return btoa(binary);
}
function slugify(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "auswertung";
}

// ---------- Mailversand ----------

async function sendMail(url: string, secret: string, to: string, subject: string, html: string, pdfBase64: string, filename: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-cron-secret": secret },
      body: JSON.stringify({ type: "send", to, subject, html, attachmentBase64: pdfBase64, attachmentFilename: filename, attachmentContentType: "application/pdf" }),
    });
    return res.ok;
  } catch { return false; }
}

function buildCustomerMailHtml(entityLabel: string, fromISO: string, toISO: string, isEndstand: boolean): string {
  if (isEndstand) {
    return `<div style="font-family:'Segoe UI',Arial,sans-serif;color:#10202C">
      <p>Lieber Kunde,</p>
      <p>anbei erhalten Sie den Abschlussbericht Ihrer Wertgarantie-Auswertung für den gesamten Zeitraum ${fmtDateAT(fromISO)} – ${fmtDateAT(toISO)}. Dies ist die letzte automatische Auswertung in dieser Serie.</p>
      <p>Liebe Grüße<br>Ihr Wertgarantie-Team</p>
    </div>`;
  }
  return `<div style="font-family:'Segoe UI',Arial,sans-serif;color:#10202C">
    <p>Lieber Kunde,</p>
    <p>anbei erhalten Sie automatisch Ihre aktuelle Wertgarantie-Auswertung für den Zeitraum ${fmtDateAT(fromISO)} – ${fmtDateAT(toISO)}.</p>
    <p>Bei Fragen zu den Zahlen wenden Sie sich gerne an Ihren Wertgarantie-Ansprechpartner.</p>
    <p>Liebe Grüße<br>Ihr Wertgarantie-Team</p>
  </div>`;
}
function buildEmployeeMailHtml(createdByName: string, recipientEmail: string, entityLabel: string, fromISO: string, toISO: string, isEndstand: boolean): string {
  return `<div style="font-family:'Segoe UI',Arial,sans-serif;color:#10202C">
    <p>Hallo ${createdByName || ""},</p>
    <p>zur Info: die folgende automatische Auswertung wurde soeben an ${recipientEmail} (${entityLabel}) versendet.</p>
    <p>Zeitraum: ${fmtDateAT(fromISO)} – ${fmtDateAT(toISO)}${isEndstand ? " (Abschlussbericht)" : ""}</p>
    <p>Liebe Grüße<br>Wertgarantie Performance Dashboard</p>
  </div>`;
}
// Nutzervorgabe 24.09.2026 (Ergänzung 2/3): wenn kein externer Versand
// stattfindet (send_to_external=false), geht die eigentliche Auswertung
// (nicht nur eine "zur Info"-Kopie wie buildEmployeeMailHtml) direkt an den
// erstellenden Mitarbeiter selbst.
function buildInternalMailHtml(createdByName: string, entityLabel: string, fromISO: string, toISO: string, isEndstand: boolean): string {
  if (isEndstand) {
    return `<div style="font-family:'Segoe UI',Arial,sans-serif;color:#10202C">
      <p>Hallo ${createdByName || ""},</p>
      <p>anbei der Abschlussbericht deiner automatischen Auswertung "${entityLabel}" für den gesamten Zeitraum ${fmtDateAT(fromISO)} – ${fmtDateAT(toISO)}. Dies ist die letzte automatische Auswertung in dieser Serie.</p>
      <p>Liebe Grüße<br>Wertgarantie Performance Dashboard</p>
    </div>`;
  }
  return `<div style="font-family:'Segoe UI',Arial,sans-serif;color:#10202C">
    <p>Hallo ${createdByName || ""},</p>
    <p>anbei deine automatische Auswertung "${entityLabel}" für den Zeitraum ${fmtDateAT(fromISO)} – ${fmtDateAT(toISO)}.</p>
    <p>Liebe Grüße<br>Wertgarantie Performance Dashboard</p>
  </div>`;
}

// ---------- Hauptlogik ----------

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const secret = req.headers.get("x-cron-secret") || "";
  if (!secret || secret !== Deno.env.get("CRON_SECRET")) return json({ error: "Nicht autorisiert" }, 401);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* leerer Body beim regulären Cron-Aufruf ist ok */ }
  const force = body.force === true;
  const skipRealSend = body.skipRealSend === true;
  const onlySubscriptionId = typeof body.subscriptionId === "string" ? body.subscriptionId : null;

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const { data: flagRow } = await admin.from("dashboard_kv").select("value").eq("key", "auswertung_enabled").maybeSingle();
  if (flagRow?.value !== "1") return json({ ok: true, skipped: "Auswertung erfassen ist deaktiviert" });

  let subQuery = admin.from("auswertung_subscriptions").select("*").eq("active", true);
  if (onlySubscriptionId) subQuery = subQuery.eq("id", onlySubscriptionId);
  const { data: subs, error: subErr } = await subQuery;
  if (subErr) return json({ error: subErr.message }, 500);
  if (!subs || !subs.length) return json({ ok: true, subscriptions: 0 });

  const vienna = viennaNow();
  const todayISO = ymd(vienna.year, vienna.month, vienna.day);
  const mailerUrl = Deno.env.get("SUPABASE_URL")! + "/functions/v1/dashboard-mailer";

  let dailyLoaded = false;
  let dailyFH: Record<string, Record<string, number>> = {};
  let dailyAKP: Record<string, Record<string, number>> = {};

  const results: Record<string, unknown>[] = [];

  for (const sub of subs) {
    try {
      // 1) Endstand hat Vorrang vor der normalen Intervallprüfung.
      const isEndstandDue = sub.fixed_range_enabled && sub.range_end && todayISO > sub.range_end && !sub.endstand_sent_at;

      let fromISO: string, toISO: string, isEndstand = false;
      if (isEndstandDue) {
        fromISO = sub.range_start; toISO = sub.range_end; isEndstand = true;
      } else {
        const { count: sentCount } = await admin.from("auswertung_subscription_sends").select("id", { count: "exact", head: true }).eq("subscription_id", sub.id);
        const hasEverSent = (sentCount || 0) > 0;
        const due = force || !hasEverSent || isDueToday(sub.interval, vienna);
        if (!due) { results.push({ subscription: sub.id, skipped: "nicht fällig" }); continue; }
        const period = periodForInterval(sub.interval, vienna);
        fromISO = period.start; toISO = period.end;
        // Fixzeitraum begrenzt die Periode auf den definierten Start -
        // vor Beginn des Abos liegende Perioden werden übersprungen.
        if (sub.fixed_range_enabled && sub.range_start && fromISO < sub.range_start) {
          if (toISO < sub.range_start) { results.push({ subscription: sub.id, skipped: "vor Abo-Start" }); continue; }
          fromISO = sub.range_start;
        }
        if (sub.fixed_range_enabled && sub.range_end && toISO > sub.range_end) toISO = sub.range_end;
      }

      // Idempotenz-Vorprüfung (harte DB-Unique-Sperre bleibt als Fallback).
      const { data: existing } = await admin.from("auswertung_subscription_sends")
        .select("id").eq("subscription_id", sub.id).eq("period_end", toISO).eq("is_endstand", isEndstand).maybeSingle();
      if (existing) { results.push({ subscription: sub.id, skipped: "bereits versendet (Periode)" }); continue; }

      const useDailyHistory = !isEndstand && (sub.interval === "daily" || sub.interval === "weekly");
      if (useDailyHistory && !dailyLoaded) { const h = await loadDailyHistory(admin); dailyFH = h.dailyFH; dailyAKP = h.dailyAKP; dailyLoaded = true; }

      const { units, label: entityLabel } = await loadUnitsForSubscription(admin, sub.auswertung_typ, sub.entity_key);
      const total = unitsTotal(units, sub.auswertung_typ, fromISO, toISO, useDailyHistory, dailyFH, dailyAKP);
      const totalVj = sub.include_vj ? unitsTotal(units, sub.auswertung_typ, addYearsIso(fromISO, -1), addYearsIso(toISO, -1), false, dailyFH, dailyAKP) : null;
      const totalVvj = sub.include_vvj ? unitsTotal(units, sub.auswertung_typ, addYearsIso(fromISO, -2), addYearsIso(toISO, -2), false, dailyFH, dailyAKP) : null;

      const typLabel = TYP_LABEL[sub.auswertung_typ] || sub.auswertung_typ;
      const pdfBytes = await buildAuswertungPdf({ typLabel, entityLabel, fromISO, toISO, isEndstand, total, totalVj, totalVvj });
      const pdfBase64 = bytesToBase64(pdfBytes);
      const filename = `Auswertung_${slugify(entityLabel)}_${toISO}${isEndstand ? "_Endstand" : ""}.pdf`;
      const storagePath = `${sub.id}/${toISO}${isEndstand ? "-endstand" : ""}.pdf`;

      // upsert:true (nicht false wie beim Trainerbetreuung-Muster): sollte
      // ein früherer Lauf für dieselbe Periode am Log-Insert oder Mailversand
      // gescheitert sein (retry beim nächsten Cron-Tick, da kein Sende-Log
      // existiert), würde ein reiner upload() sonst dauerhaft an "Objekt
      // existiert bereits" scheitern - storagePath ist ohnehin schon eindeutig
      // je Subscription+Periode.
      const { error: upErr } = await admin.storage.from("auswertung-berichte").upload(storagePath, pdfBytes, { contentType: "application/pdf", upsert: true });
      if (upErr) { results.push({ subscription: sub.id, error: "Storage-Upload fehlgeschlagen: " + upErr.message }); continue; }

      const subject = `Wertgarantie Auswertung${isEndstand ? " – Abschlussbericht" : ""} (${fmtDateAT(toISO)})`;
      // Nutzervorgabe 24.09.2026 (Ergänzung): mehrere Empfänger möglich
      // (recipient_emails, Array statt einzelner Adresse) - je eine eigene
      // Mail pro Empfänger, wie schon zwischen Kunde/Mitarbeiter-Kopie
      // üblich. customer_email_sent bleibt ein einzelnes Flag (true nur
      // wenn ALLE Empfänger erfolgreich zugestellt wurden).
      // Nutzervorgabe 24.09.2026 (Ergänzung 3): Versand an Mitarbeiter UND
      // Versand an Externe sind zwei UNABHÄNGIGE Schalter (send_to_employee/
      // send_to_external, im Admin-Tool auch nachträglich umschaltbar) -
      // beide, eines oder keines kann aktiv sein. Wenn Externe deaktiviert
      // ist, geht an den Mitarbeiter (falls dessen Versand aktiv ist) die
      // eigentliche Auswertung (buildInternalMailHtml), sonst weiterhin nur
      // die "zur Info"-Kopie (buildEmployeeMailHtml).
      const recipients: string[] = sub.send_to_external ? (Array.isArray(sub.recipient_emails) ? sub.recipient_emails : []) : [];
      let customerSent = false, employeeSent = false;
      if (!skipRealSend) {
        if (sub.send_to_external && recipients.length) {
          const results2 = await Promise.all(recipients.map((to) => sendMail(mailerUrl, secret, to, subject, buildCustomerMailHtml(entityLabel, fromISO, toISO, isEndstand), pdfBase64, filename)));
          customerSent = results2.every(Boolean);
        }
        if (sub.send_to_employee && sub.created_by_email) {
          employeeSent = sub.send_to_external
            ? await sendMail(mailerUrl, secret, sub.created_by_email, subject, buildEmployeeMailHtml(sub.created_by_name, recipients.join(", "), entityLabel, fromISO, toISO, isEndstand), pdfBase64, filename)
            : await sendMail(mailerUrl, secret, sub.created_by_email, subject, buildInternalMailHtml(sub.created_by_name, entityLabel, fromISO, toISO, isEndstand), pdfBase64, filename);
        }
      }

      const { error: logErr } = await admin.from("auswertung_subscription_sends").insert({
        subscription_id: sub.id, period_start: fromISO, period_end: toISO, is_endstand: isEndstand,
        storage_path: storagePath, filename, customer_email_sent: customerSent, employee_email_sent: employeeSent,
      });

      if (isEndstand) await admin.from("auswertung_subscriptions").update({ endstand_sent_at: new Date().toISOString(), active: false }).eq("id", sub.id);

      results.push({ subscription: sub.id, entityLabel, fromISO, toISO, isEndstand, customerSent, employeeSent, storagePath, logErr: logErr?.message || null, skipRealSend });
    } catch (e) {
      console.error("[auswertung-scheduled-mail] Fehler bei Subscription", sub.id, String(e));
      results.push({ subscription: sub.id, error: String(e) });
    }
  }

  return json({ ok: true, subscriptions: subs.length, results });
});
