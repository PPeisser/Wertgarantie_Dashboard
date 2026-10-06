// Trainerbetreuung: periodischer Fortschrittsbericht (Nutzervorgabe
// 10.09.2026, Frequenz-Einstellung ergänzt 11.09.2026). Läuft stündlich per
// pg_cron (siehe schema.sql, Job "trainerbetreuung-weekly-mail-hourly") -
// prüft aber nur bei Montag 08:00 Wiener Ortszeit weiter (analog
// performance-dialog-reminder, vermeidet die DST-Ungenauigkeit einer fixen
// UTC-Cron-Zeit).
//
// Nutzervorgabe 22.09.2026: der Bericht ging bisher als HTML-Text direkt in
// der Mail raus - das führte u.a. dazu, dass der FH-Name fehlte (fh_contacts.
// name ist praktisch immer leer, der echte Name kommt aus akq_name/
// miete_name - derselbe Bug wie im Client, siehe fhResolveNameOrt()-Fix vom
// 19.09.2026) und die Zeile zweimal die bloße FH-Nummer zeigte. Jetzt:
// - Bericht wird als schön formatiertes PDF gebaut (pdf-lib - läuft rein
//   serverseitig ohne Browser/DOM, anders als das client-seitige jsPDF+
//   html2canvas, das dieser Cron-Job mangels Browser nicht nutzen kann) und
//   als Anhang verschickt (die Mail selbst ist nur noch ein kurzer Hinweis).
// - Name-Auflösung repariert: akq_name > miete_name > name > FH-Nr (wie
//   client-seitig buildFhContactsIndices()).
// - Zusätzliche Felder je Einsatz: PLZ (neben Ort), zugeteilter
//   Gebietsleiter (fh_contacts.akq_gl), die vom Trainer eingetragenen
//   Tätigkeiten (Freitext) und die Namen der teilgenommenen AKP.
// - Jedes versendete PDF wird zusätzlich im Storage-Bucket "trainerberichte"
//   abgelegt und in trainerbetreuung_weekly_reports protokolliert (Datum,
//   Trainer, Pfad) - damit im Admin-Tool eine nach Datum sortierte Liste
//   ALLER je versendeten Berichte zum Download bereitsteht, nicht nur eine
//   Neuberechnung aus dem aktuellen (sich laufend ändernden) Live-Stand.
//
// Pro Mitarbeiter MIT mindestens einem Trainerbesuch (aktiv ODER
// abgeschlossen - "immer mit den fertigen zusätzlich zu den aktiven
// ergänzt") UND fälliger Frequenz wird EIN PDF gebaut und ZWEIMAL
// verschickt: einmal an die Mail-Adresse des Mitarbeiters (aus
// profiles.email), einmal an den Admin k.scheiermann@wertgarantie.com -
// beide Male derselbe Anhang für GENAU diesen einen Mitarbeiter, keine
// Sammel-Mail über mehrere Mitarbeiter (Nutzervorgabe: "getrennt pro
// Trainer und auch getrennt pro Trainer an den Admin"). Opt-out ("never")
// gilt auch für die Admin-Kopie dieses einen Mitarbeiters - andere
// Mitarbeiter sind davon unberührt.
//
// Baseline/Nachher-Berechnung ist bewusst IDENTISCH zu
// fhAvgDailyProdInRange() in index.html gehalten (beide rechnen nur mit
// fh_contacts.prod_monthly, nicht mit Tages-Deltas) - bei Änderungen an
// einer Seite immer auch die andere prüfen.
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET (bereits
// vorhanden, siehe dashboard-mailer).
//
// Test-/Korrektur-Aufruf (x-cron-secret erforderlich, wie der reguläre
// Cron-Aufruf): POST-Body { "force": true, "trainerName": "...",
// "periodReference": "YYYY-MM-DD", "skipRealSend": true|false } - umgeht das
// Montag-08:00-Gate und die Frequenz-Prüfung, rechnet mit periodReference
// als Bezugsdatum (statt "heute") und kann so exakt reproduzieren, was an
// einem bestimmten Tag (z.B. dem 21.09.2026) verschickt worden wäre.
// skipRealSend:true baut PDF + Storage + Log-Zeile, verschickt aber KEINE
// echte Mail (nur zum Prüfen des PDF-Inhalts vor einem echten Versand).

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

const ADMIN_EMAIL = "k.scheiermann@wertgarantie.com";

function viennaNow(): { year: number; month: number; day: number; weekday: number; hour: number } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Vienna", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", hourCycle: "h23",
  });
  const parts = fmt.formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: +get("year"), month: +get("month"), day: +get("day"),
    weekday: weekdayMap[get("weekday")] ?? -1, hour: +get("hour"),
  };
}

function addDaysISO(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function daysBetween(aISO: string, bISO: string): number {
  return Math.round((new Date(bISO + "T00:00:00Z").getTime() - new Date(aISO + "T00:00:00Z").getTime()) / 86400000);
}

// Identische Logik zu fhAvgDailyProdInRange() in index.html.
function avgDailyProdInRange(prodMonthly: Record<string, number> | null | undefined, fromISO: string, toISO: string): number | null {
  const from = new Date(fromISO + "T00:00:00Z"), to = new Date(toISO + "T00:00:00Z");
  const totalDays = Math.round((to.getTime() - from.getTime()) / 86400000);
  if (totalDays <= 0) return null;
  let sum = 0, any = false;
  let cur = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  while (cur < to) {
    const monthStart = cur;
    const monthEnd = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1));
    const overlapStart = monthStart > from ? monthStart : from;
    const overlapEnd = monthEnd < to ? monthEnd : to;
    const overlapDays = Math.max(0, Math.round((overlapEnd.getTime() - overlapStart.getTime()) / 86400000));
    if (overlapDays > 0) {
      const daysInMonth = Math.round((monthEnd.getTime() - monthStart.getTime()) / 86400000);
      const key = monthStart.getUTCFullYear() + "-" + String(monthStart.getUTCMonth() + 1).padStart(2, "0");
      const val = prodMonthly?.[key];
      if (val != null) { sum += val * overlapDays / daysInMonth; any = true; }
    }
    cur = monthEnd;
  }
  if (!any) return null;
  return sum / totalDays;
}
function isAbgeschlossen(besuchDatumISO: string, todayISO: string): boolean {
  return daysBetween(besuchDatumISO, todayISO) >= 28;
}
function fmtDateAT(iso: string | null | undefined): string {
  if (!iso) return "–";
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}
function fmtAvg1(n: number | null | undefined): string {
  return n == null ? "–" : n.toFixed(1).replace(".", ",");
}
function fmtInt(n: number | null | undefined): string {
  return n == null ? "–" : String(Math.round(n));
}
// Namens-/Ort-Auflösung wie buildFhContactsIndices()/fhFallbackFromAkp() im
// Client (Bug-Report 19.09.2026, hier serverseitig identisch nachgebaut) -
// UND ergänzt um den AKP-Fallback (Bug-Report 23.09.2026: "bei 2 FH wieder
// nur die Nummer"): fh_contacts.akq_name/miete_name/name blieben bei
// brandneu akquirierten Händlern anfangs leer, OBWOHL der zugehörige
// AKP-Kontakt (akp_contacts.firma/ort) bereits einen Namen/Ort hat - der
// Client fällt in genau diesem Fall über fhFallbackFromAkp() auf den ersten
// passenden AKP-Kontakt zurück, das fehlte hier bisher komplett. Priorität:
// akq_name > miete_name > name > erster AKP-Kontakt dieses FH mit firma/ort
// > FH-Nr als allerletzter Fallback.
function resolveFhNameOrt(fh: FhRow | undefined, akpForFh: { firma: string | null; ort: string | null }[] | undefined, fhNr: string): { name: string; ort: string } {
  const directName = fh?.akq_name || fh?.miete_name || fh?.name || null;
  const akpMatch = (akpForFh || []).find((a) => a.firma);
  const name = directName || akpMatch?.firma || fhNr;
  const akpOrt = (akpForFh || []).find((a) => a.ort)?.ort || null;
  const ort = fh?.ort || akpOrt || "";
  return { name, ort };
}

// deno-lint-ignore no-explicit-any
type Besuch = any;
interface FhRow {
  fh_nr: string; name: string | null; akq_name: string | null; miete_name: string | null;
  ort: string | null; plz: string | null; akq_gl: string | null; prod_monthly: Record<string, number> | null;
}

// ---------- PDF-Aufbau (pdf-lib, läuft ohne Browser/DOM) ----------

const PAGE_W = 595.28, PAGE_H = 841.89, MARGIN = 42;
const COL_NAVY = rgb(6 / 255, 42 / 255, 63 / 255);
const COL_BLUE = rgb(0 / 255, 159 / 255, 227 / 255);
const COL_MUTED = rgb(93 / 255, 114 / 255, 132 / 255);
const COL_INK = rgb(16 / 255, 32 / 255, 44 / 255);
const COL_LINE = rgb(228 / 255, 237 / 255, 243 / 255);
const COL_POS = rgb(27 / 255, 122 / 255, 67 / 255);
const COL_NEG = rgb(179 / 255, 50 / 255, 74 / 255);

function wrapText(font: PDFFont, text: string, size: number, maxWidth: number): string[] {
  const out: string[] = [];
  for (const rawLine of String(text || "").split("\n")) {
    const words = rawLine.split(/\s+/).filter(Boolean);
    if (!words.length) { out.push(""); continue; }
    let line = "";
    for (const w of words) {
      const test = line ? line + " " + w : w;
      if (font.widthOfTextAtSize(test, size) > maxWidth && line) {
        out.push(line);
        line = w;
      } else {
        line = test;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

class PdfBuilder {
  doc: PDFDocument;
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
  addPage() {
    this.page = this.doc.addPage([PAGE_W, PAGE_H]);
    this.y = PAGE_H - MARGIN;
  }
  ensureSpace(h: number) {
    if (this.y - h < MARGIN) this.addPage();
  }
  text(str: string, x: number, size: number, opts: { bold?: boolean; color?: ReturnType<typeof rgb> } = {}) {
    this.page.drawText(str, {
      x, y: this.y, size,
      font: opts.bold ? this.fontBold : this.fontReg,
      color: opts.color || COL_INK,
    });
  }
  lineBreak(h: number) { this.y -= h; }
  hr(color = COL_LINE) {
    this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: PAGE_W - MARGIN, y: this.y }, thickness: 1, color });
  }
  wrapped(str: string, x: number, size: number, maxWidth: number, lineHeight: number, opts: { bold?: boolean; color?: ReturnType<typeof rgb> } = {}) {
    const font = opts.bold ? this.fontBold : this.fontReg;
    const lines = wrapText(font, str, size, maxWidth);
    for (const line of lines) {
      this.ensureSpace(lineHeight);
      this.text(line, x, size, opts);
      this.lineBreak(lineHeight);
    }
    return lines.length;
  }
}

function visitCard(b: PdfBuilder, r: Besuch, kind: "aktiv" | "fertig") {
  const contentW = PAGE_W - 2 * MARGIN - 20;
  // Grobe Höhenabschätzung, um die Karte nicht mitten in einer Seite
  // abzuschneiden - Tätigkeiten können mehrzeilig sein.
  const taetLines = wrapText(b.fontReg, r.taetigkeiten || "–", 9, contentW - 20);
  const estHeight = 109 + taetLines.length * 11.5;
  b.ensureSpace(Math.min(estHeight, PAGE_H - 2 * MARGIN));

  const cardTop = b.y;
  b.lineBreak(10);
  b.text(`${r.fhName}  ·  FH ${r.fh_nr}`, MARGIN + 10, 12, { bold: true, color: COL_NAVY });
  b.lineBreak(16);
  const ortPlz = [r.plz, r.fhOrt].filter(Boolean).join(" ") || "–";
  b.text(`${ortPlz}${r.gebietsleiter ? "  ·  Gebietsleiter: " + r.gebietsleiter : ""}`, MARGIN + 10, 9, { color: COL_MUTED });
  b.lineBreak(14);
  b.text(`Besuchsdatum: ${fmtDateAT(r.besuch_datum)}`, MARGIN + 10, 9, { color: COL_MUTED });
  b.lineBreak(14);

  b.text("Tätigkeiten:", MARGIN + 10, 9, { bold: true, color: COL_INK });
  b.lineBreak(12);
  b.wrapped(r.taetigkeiten || "–", MARGIN + 10, 9, contentW - 20, 11.5, { color: COL_INK });
  b.lineBreak(3);

  b.text("Teilnehmer:", MARGIN + 10, 9, { bold: true, color: COL_INK });
  b.lineBreak(12);
  b.wrapped(r.akpNames || "–", MARGIN + 10, 9, contentW - 20, 11.5, { color: COL_INK });
  b.lineBreak(3);

  b.text(`Produktion am Einsatztag (${fmtDateAT(r.besuch_datum)}): ${fmtInt(r.tagesproduktion)} Stk.`, MARGIN + 10, 9.5, { color: COL_INK });
  b.lineBreak(14);
  if (kind === "aktiv") {
    b.text(`Tagesschnitt vorher: ${fmtAvg1(r.baseline_avg)}  ·  bisher: ${fmtAvg1(r.aktuell)} Stk./Tag`, MARGIN + 10, 9.5, { color: COL_INK });
    b.lineBreak(14);
  } else {
    const diff = (r.aktuell != null && r.baseline_avg != null) ? r.aktuell - r.baseline_avg : null;
    b.text(`Tagesschnitt vorher: ${fmtAvg1(r.baseline_avg)}  →  nachher: ${fmtAvg1(r.aktuell)} Stk./Tag`, MARGIN + 10, 9.5, { color: diff == null ? COL_INK : (diff >= 0 ? COL_POS : COL_NEG) });
    b.lineBreak(14);
  }

  // Rahmen um die Karte (nachträglich, jetzt kennen wir die Höhe).
  const cardBottom = b.y + 6;
  b.page.drawRectangle({
    x: MARGIN, y: cardBottom, width: PAGE_W - 2 * MARGIN, height: cardTop - cardBottom,
    borderColor: COL_LINE, borderWidth: 1,
  });
  b.lineBreak(10);
}

async function buildReportPdf(trainerName: string, aktiv: Besuch[], fertig: Besuch[], periodReferenceISO: string): Promise<Uint8Array> {
  const b = await PdfBuilder.create();
  b.text("Trainerbetreuung – Fortschrittsbericht", MARGIN, 19, { bold: true, color: COL_NAVY });
  b.lineBreak(22);
  b.text(`Trainer: ${trainerName}  ·  Stand: ${fmtDateAT(periodReferenceISO)}`, MARGIN, 11, { color: COL_MUTED });
  b.lineBreak(10);
  b.hr(COL_BLUE);
  b.lineBreak(20);

  b.text("Aktive Trainereinsätze", MARGIN, 13, { bold: true, color: COL_NAVY });
  b.lineBreak(18);
  if (aktiv.length) { for (const r of aktiv) visitCard(b, r, "aktiv"); }
  else { b.text("Keine aktiven Trainereinsätze.", MARGIN, 10, { color: COL_MUTED }); b.lineBreak(18); }

  b.lineBreak(6);
  b.ensureSpace(30);
  b.text("Abgeschlossene Trainereinsätze", MARGIN, 13, { bold: true, color: COL_NAVY });
  b.lineBreak(18);
  if (fertig.length) { for (const r of fertig) visitCard(b, r, "fertig"); }
  else { b.text("Noch keine abgeschlossenen Trainereinsätze.", MARGIN, 10, { color: COL_MUTED }); b.lineBreak(18); }

  return await b.doc.save();
}

function buildMailHtml(trainerName: string, periodReferenceISO: string, aktivCount: number, fertigCount: number): string {
  return `<div style="font-family:'Segoe UI',Arial,sans-serif;color:#10202C">
    <p>Fortschrittsbericht Trainerbetreuung für <b>${trainerName}</b>, Stand ${fmtDateAT(periodReferenceISO)}.</p>
    <p>${aktivCount} aktive${fertigCount ? " · " + fertigCount + " abgeschlossene" : ""} Trainereinsätze im Detail siehe angehängtes PDF.</p>
    <p style="font-size:11px;color:#5D7284;margin-top:20px">Automatische Mail · Frequenz änderbar in den Dashboard-Einstellungen · Wertgarantie Performance Dashboard</p>
  </div>`;
}

async function sendMail(url: string, secret: string, to: string, subject: string, html: string, pdfBase64: string, filename: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-cron-secret": secret },
      body: JSON.stringify({
        type: "send", to, subject, html,
        attachmentBase64: pdfBase64, attachmentFilename: filename, attachmentContentType: "application/pdf",
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function slugify(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const secret = req.headers.get("x-cron-secret") || "";
  if (!secret || secret !== Deno.env.get("CRON_SECRET")) {
    return json({ error: "Nicht autorisiert" }, 401);
  }

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* leerer Body beim regulären Cron-Aufruf ist ok */ }
  const force = body.force === true;
  const forceTrainerName = typeof body.trainerName === "string" ? body.trainerName : null;
  const forcePeriodReference = typeof body.periodReference === "string" ? body.periodReference : null;
  const skipRealSend = body.skipRealSend === true;
  const extraRecipients: string[] = Array.isArray(body.extraRecipients) ? body.extraRecipients.filter((x): x is string => typeof x === "string") : [];

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: flagRow } = await admin
    .from("dashboard_kv").select("value").eq("key", "trainerbetreuung_enabled").maybeSingle();
  if (flagRow?.value !== "1") {
    return json({ ok: true, skipped: "Trainerbetreuung ist deaktiviert" });
  }

  const now = viennaNow();
  if (!force && !(now.weekday === 1 && now.hour === 8)) {
    return json({ ok: true, skipped: "nicht Montag 08:00 (Wien)" });
  }
  const isFirstMondayOfMonth = now.day <= 7;

  const todayISO = forcePeriodReference || `${now.year}-${String(now.month).padStart(2, "0")}-${String(now.day).padStart(2, "0")}`;

  const { data: rows, error } = await admin.from("trainerbesuche").select("*").order("besuch_datum", { ascending: false });
  if (error) return json({ error: error.message }, 500);
  if (!rows || !rows.length) return json({ ok: true, trainers: 0 });

  const fhNrs = [...new Set(rows.map((r) => r.fh_nr))];
  const { data: fhRows } = await admin.from("fh_contacts").select("fh_nr,name,akq_name,miete_name,ort,plz,akq_gl,prod_monthly").in("fh_nr", fhNrs);
  const fhIdx: Record<string, FhRow> = Object.fromEntries((fhRows || []).map((f) => [f.fh_nr, f as FhRow]));

  const akpNrs = [...new Set(rows.flatMap((r) => (r.akp_teilnehmer || []) as string[]))];
  let akpIdx: Record<string, { vorname: string | null; nachname: string | null }> = {};
  if (akpNrs.length) {
    const { data: akpRows } = await admin.from("akp_contacts").select("nr,vorname,nachname").in("nr", akpNrs);
    akpIdx = Object.fromEntries((akpRows || []).map((a) => [a.nr, a]));
  }
  function akpNamesFor(nrs: string[] | null | undefined): string {
    if (!nrs || !nrs.length) return "–";
    return nrs.map((nr) => {
      const a = akpIdx[nr];
      const name = a ? [a.vorname, a.nachname].filter(Boolean).join(" ") : "";
      return name || nr;
    }).join(", ");
  }
  // AKP-Fallback für Name/Ort (Bug-Report 23.09.2026) - ALLE AKP-Kontakte
  // dieser FH-Nummern, nicht nur die als Teilnehmer angehakten, damit auch
  // ein Händler ohne akq_name/miete_name über seinen AKP-Kontakt einen Namen
  // bekommt (siehe resolveFhNameOrt() oben, analog fhFallbackFromAkp()).
  const { data: akpByFhRows } = await admin.from("akp_contacts").select("fh_nr,firma,ort").in("fh_nr", fhNrs);
  const akpByFh: Record<string, { firma: string | null; ort: string | null }[]> = {};
  for (const a of akpByFhRows || []) { (akpByFh[a.fh_nr] ||= []).push({ firma: a.firma, ort: a.ort }); }

  // Produktion am Einsatztag (Nutzervorgabe 23.09.2026) - ein einzelner Tag
  // lässt sich nicht aus prod_monthly (Monatsaggregate) herauslesen, dafür
  // braucht es die Tages-Historie state.dailyFH, die nur im dashboard_kv-
  // Blob "wg-state" liegt (dieselbe Quelle, die auch der Client für exakt
  // diesen Zweck nutzt - siehe trainerbesuchTagesproduktion() in index.html).
  // Ein fehlender Eintrag bedeutet dort NICHT "unbekannt", sondern echt 0
  // (mergeSnapshot() schreibt nur bei Produktion > 0) - dieselbe Konvention
  // wird hier 1:1 übernommen.
  let dailyFH: Record<string, Record<string, number>> = {};
  try {
    const { data: stateRow } = await admin.from("dashboard_kv").select("value").eq("key", "wg-state").maybeSingle();
    if (stateRow?.value) {
      const parsed = JSON.parse(stateRow.value);
      dailyFH = parsed?.dailyFH || {};
    }
  } catch (e) { console.error("[trainerbetreuung-weekly-mail] wg-state Parse fehlgeschlagen:", String(e)); }
  function tagesproduktionFor(fhNr: string, besuchDatumISO: string): number {
    return dailyFH[fhNr]?.[besuchDatumISO] || 0;
  }

  let byTrainer: Record<string, Besuch[]> = {};
  for (const r of rows) { (byTrainer[r.trainer_name] ||= []).push(r); }
  if (forceTrainerName) byTrainer = { [forceTrainerName]: byTrainer[forceTrainerName] || [] };

  const mailerUrl = Deno.env.get("SUPABASE_URL")! + "/functions/v1/dashboard-mailer";
  const subject = `Trainerbetreuung – Fortschrittsbericht (${fmtDateAT(todayISO)})`;

  const results: Besuch[] = [];
  for (const [trainerName, list] of Object.entries(byTrainer)) {
    const { data: profRow } = await admin.from("profiles").select("id,email").eq("name", trainerName).maybeSingle();
    let freq = "weekly";
    if (profRow?.id) {
      const { data: settRow } = await admin.from("user_settings").select("notif_trainerbetreuung_frequency").eq("user_id", profRow.id).maybeSingle();
      if (settRow?.notif_trainerbetreuung_frequency) freq = settRow.notif_trainerbetreuung_frequency;
    }

    if (!force && freq === "never") {
      results.push({ trainer: trainerName, skipped: "Frequenz: nie" });
      continue;
    }
    if (!force && freq === "monthly" && !isFirstMondayOfMonth) {
      results.push({ trainer: trainerName, skipped: "Frequenz: monatlich, nicht der erste Montag im Monat" });
      continue;
    }

    const enriched = list.map((r) => {
      const fh = fhIdx[r.fh_nr];
      const prodMonthly = fh?.prod_monthly || {};
      const abgeschlossen = isAbgeschlossen(r.besuch_datum, todayISO);
      const nachherFrom = r.besuch_datum, nachherTo = addDaysISO(r.besuch_datum, 28);
      const aktuell = abgeschlossen
        ? (r.nachher_avg != null ? r.nachher_avg : avgDailyProdInRange(prodMonthly, nachherFrom, nachherTo))
        : avgDailyProdInRange(prodMonthly, r.besuch_datum, todayISO);
      const { name: fhName, ort: fhOrt } = resolveFhNameOrt(fh, akpByFh[r.fh_nr], r.fh_nr);
      return {
        ...r, abgeschlossen, aktuell,
        fhName, fhOrt, plz: fh?.plz || "", gebietsleiter: fh?.akq_gl || "",
        akpNames: akpNamesFor(r.akp_teilnehmer),
        tagesproduktion: tagesproduktionFor(r.fh_nr, r.besuch_datum),
      };
    });
    const aktiv = enriched.filter((r) => !r.abgeschlossen);
    const fertig = enriched.filter((r) => r.abgeschlossen);

    if (!aktiv.length && !fertig.length) {
      results.push({ trainer: trainerName, skipped: "keine Trainerbesuche" });
      continue;
    }

    const pdfBytes = await buildReportPdf(trainerName, aktiv, fertig, todayISO);
    const pdfBase64 = bytesToBase64(pdfBytes);
    const filename = `Trainerbetreuung_${slugify(trainerName)}_${todayISO}.pdf`;
    const storagePath = `weekly/${slugify(trainerName)}/${todayISO}-${Date.now()}.pdf`;

    const { error: upErr } = await admin.storage.from("trainerberichte").upload(storagePath, pdfBytes, {
      contentType: "application/pdf", upsert: false,
    });
    if (upErr) {
      results.push({ trainer: trainerName, error: "Storage-Upload fehlgeschlagen: " + upErr.message });
      continue;
    }

    const trainerEmail: string | null = profRow?.email || null;
    const html = buildMailHtml(trainerName, todayISO, aktiv.length, fertig.length);

    let sentTrainer = false, sentAdmin = false;
    const extraResults: Record<string, boolean> = {};
    if (!skipRealSend) {
      sentTrainer = trainerEmail ? await sendMail(mailerUrl, secret, trainerEmail, subject, html, pdfBase64, filename) : false;
      sentAdmin = await sendMail(mailerUrl, secret, ADMIN_EMAIL, subject, html, pdfBase64, filename);
      for (const addr of extraRecipients) {
        extraResults[addr] = await sendMail(mailerUrl, secret, addr, subject, html, pdfBase64, filename);
      }
    }

    const { error: logErr } = await admin.from("trainerbetreuung_weekly_reports").insert({
      trainer_name: trainerName, period_reference: todayISO, storage_path: storagePath, filename,
      visit_count: aktiv.length + fertig.length, trainer_email_sent: sentTrainer, admin_email_sent: sentAdmin,
    });

    results.push({
      trainer: trainerName, freq, aktiv: aktiv.length, fertig: fertig.length, trainerEmail,
      sentTrainer, sentAdmin, extraResults, storagePath, logErr: logErr?.message || null, skipRealSend,
    });
  }

  return json({ ok: true, trainers: results.length, results });
});
