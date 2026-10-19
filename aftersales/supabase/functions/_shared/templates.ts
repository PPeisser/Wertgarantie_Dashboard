// HTML-Mailvorlagen (Einladung mit Link, Abschlussbestätigung) und das
// Bestätigungs-PDF. Tabellen-Layout + Inline-Styles, damit Outlook & Co.
// sauber rendern.

import { PDFDocument, StandardFonts, rgb } from "https://esm.sh/pdf-lib@1.17.1";
import { appUrl, escapeHtml, fmtDate, fmtDateTime, reference } from "./common.ts";
import { eur, PRICE_PERIOD } from "./pricing.ts";

const BLUE = "#009FE3", NAVY = "#10202C", MUTED = "#5D7284", LINE = "#E1EAF1", PAPER = "#EEF3F7";

// deno-lint-ignore no-explicit-any
export type Rec = Record<string, any>;

function shell(inner: string, preheader = "") {
  return `<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${PAPER};font-family:'Segoe UI',Arial,sans-serif;color:${NAVY}">
<span style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAPER};padding:24px 0"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:16px;overflow:hidden">
<tr><td style="padding:24px 32px;border-bottom:4px solid ${BLUE}"><img src="${appUrl()}/logo.png" alt="Wertgarantie – Einfach. Gut. Geschützt." width="200" style="display:block;width:200px;height:auto;border:0"></td></tr>
<tr><td style="padding:28px 32px 8px;font-size:15px;line-height:1.6">${inner}</td></tr>
<tr><td style="padding:20px 32px 28px;font-size:11.5px;color:${MUTED};border-top:1px solid ${LINE}">WERTGARANTIE Austria · Einfach. Gut. Geschützt.</td></tr>
</table></td></tr></table></body></html>`;
}

function salutation(r: Rec) {
  const an = String(r.anrede || "").trim().toLowerCase();
  const nn = escapeHtml(r.nachname || "");
  if (an.startsWith("frau") && nn) return `Sehr geehrte Frau ${nn},`;
  if (an.startsWith("herr") && nn) return `Sehr geehrter Herr ${nn},`;
  const full = escapeHtml([r.vorname, r.nachname].filter(Boolean).join(" "));
  return full ? `Hallo ${full},` : "Sehr geehrte Kundin, sehr geehrter Kunde,";
}

// ---------- Einladung ----------
export function inviteMail(r: Rec, fhName: string) {
  const link = `${appUrl()}/k/${r.token}`;
  const pixel = `${Deno.env.get("SUPABASE_URL")}/functions/v1/aftersales-public?a=px&t=${r.token}`;
  const geraet = escapeHtml([r.geraet, r.typ].filter(Boolean).join(" – ") || "Ihr neues Gerät");
  const inner = `
<p style="margin:0 0 14px">${salutation(r)}</p>
<p style="margin:0 0 14px">vielen Dank für Ihren Einkauf${fhName ? ` bei <b>${escapeHtml(fhName)}</b>` : ""}! Damit Sie an Ihrem neuen Gerät lange Freude haben, können Sie es jetzt ganz einfach mit dem <b>Wertgarantie Komplettschutz</b> absichern.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAPER};border-radius:12px;margin:6px 0 18px"><tr><td style="padding:14px 18px;font-size:14px">
<b>${geraet}</b>${r.kaufdatum ? `<br><span style="color:${MUTED}">gekauft am ${fmtDate(r.kaufdatum)}</span>` : ""}
</td></tr></table>
<p style="margin:0 0 20px">Ihre Daten sind bereits vorausgefüllt – Sie müssen nur noch prüfen, ergänzen und mit einem Klick abschließen.</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 22px"><tr><td style="background:${BLUE};border-radius:999px">
<a href="${link}" style="display:inline-block;padding:14px 30px;color:#fff;text-decoration:none;font-weight:700;font-size:15px">Jetzt Komplettschutz sichern</a>
</td></tr></table>
<p style="margin:0 0 6px;font-size:12.5px;color:${MUTED}">Falls der Button nicht funktioniert, kopieren Sie diesen Link in Ihren Browser:<br><a href="${link}" style="color:${BLUE};word-break:break-all">${link}</a></p>
<p style="margin:16px 0 0">Freundliche Grüße<br>${fhName ? escapeHtml(fhName) + " &amp; " : ""}Ihr WERTGARANTIE Team</p>
<img src="${pixel}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0">`;
  return {
    subject: `Ihr ${r.geraet ? String(r.geraet) : "Gerät"}: jetzt mit Komplettschutz absichern`,
    html: shell(inner, "Ihr Gerät mit einem Klick absichern – Daten bereits vorausgefüllt."),
  };
}

// ---------- Bestätigung ----------
export function confirmationRows(r: Rec): [string, string][] {
  const c = r.completed_data || {};
  return [
    ["Referenz", reference(r.id)],
    ["Abgeschlossen am", fmtDateTime(r.completed_at || new Date())],
    ["Vorname", r.vorname], ["Name", r.nachname],
    ["Adresse", r.strasse], ["PLZ", r.plz], ["Ort", r.ort],
    ["E-Mail", r.email], ["Telefon", r.telefon || "–"],
    ["Gerät", r.geraet], ["Typ", r.typ],
    ["Kaufdatum", fmtDate(r.kaufdatum)], ["Kaufpreis", eur(r.kaufpreis)],
    ...(r.imei ? [["IMEI", r.imei] as [string, string]] : []),
    ["Produkt", r.produkt],
    ["Premium-Option", c.premium_included ? "inklusive" : (r.premium ? `ja (+ ${eur(c.surcharge)})` : "nein")],
    ["Preis Komplettschutz", `${eur(r.praemie)} ${PRICE_PERIOD}`],
    ["Fachhändler-Nr.", r.fh_nr],
  ].map(([k, v]) => [k, String(v ?? "–")]);
}

export function confirmationMail(r: Rec, forDealer: boolean) {
  const rows = confirmationRows(r).map(([k, v]) =>
    `<tr><td style="padding:7px 0;color:${MUTED};font-size:13.5px;width:44%;border-bottom:1px solid ${LINE}">${escapeHtml(k)}</td><td style="padding:7px 0;font-size:13.5px;font-weight:600;border-bottom:1px solid ${LINE}">${escapeHtml(v)}</td></tr>`
  ).join("");
  const intro = forDealer
    ? `<p style="margin:0 0 14px">Ihr Kunde <b>${escapeHtml([r.vorname, r.nachname].filter(Boolean).join(" "))}</b> hat den Komplettschutz soeben online abgeschlossen. Alle Daten finden Sie unten sowie im angehängten PDF.</p>`
    : `<p style="margin:0 0 14px">${salutation(r)}</p><p style="margin:0 0 14px">vielen Dank! Hiermit bestätigen wir Ihnen den Abschluss Ihres <b>Wertgarantie ${escapeHtml(r.produkt)}</b>. Ihre Angaben finden Sie unten sowie im angehängten PDF.</p>`;
  const inner = `${intro}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#E8F7EE;border-radius:12px;margin:0 0 16px"><tr><td style="padding:12px 16px;font-size:14px;color:#0B6B34"><b>✓ Abschluss bestätigt</b> am ${escapeHtml(fmtDateTime(r.completed_at || new Date()))}</td></tr></table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>
<p style="margin:20px 0 0">Freundliche Grüße<br>Ihr WERTGARANTIE Team</p>`;
  const who = [r.vorname, r.nachname].filter(Boolean).join(" ");
  return {
    subject: forDealer
      ? `Abschluss ${r.produkt}: ${who} (${reference(r.id)})`
      : `Bestätigung Ihres Wertgarantie ${r.produkt} (${reference(r.id)})`,
    html: shell(inner, "Ihr Abschluss wurde bestätigt."),
  };
}

// ---------- PDF ----------
export async function confirmationPdf(r: Rec): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595.28, 841.89]); // A4
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const navy = rgb(0x10 / 255, 0x20 / 255, 0x2c / 255);
  const muted = rgb(0x5d / 255, 0x72 / 255, 0x84 / 255);
  const blue = rgb(0, 0x9f / 255, 0xe3 / 255);
  const line = rgb(0xe1 / 255, 0xea / 255, 0xf1 / 255);

  // Logo wird von der After-Sales-App geladen (aftersales/logo.png); falls das
  // scheitert, entsteht das PDF eben ohne Logo statt gar nicht.
  const lw = 170, lh = 51.3;
  try {
    const res = await fetch(`${appUrl()}/logo.png`);
    if (res.ok) {
      const logo = await pdf.embedPng(new Uint8Array(await res.arrayBuffer()));
      page.drawImage(logo, { x: 50, y: 841.89 - 50 - lh, width: lw, height: lw * logo.height / logo.width });
    }
  } catch { /* ohne Logo weiter */ }
  page.drawRectangle({ x: 50, y: 841.89 - 62 - lh, width: 495, height: 3, color: blue });

  let y = 841.89 - 100 - lh;
  page.drawText("Bestätigung Komplettschutz", { x: 50, y, size: 20, font: bold, color: navy });
  y -= 22;
  page.drawText(`${r.produkt} · Referenz ${reference(r.id)}`, { x: 50, y, size: 11, font, color: muted });
  y -= 26;
  page.drawRectangle({ x: 50, y: y - 8, width: 495, height: 26, color: rgb(0.91, 0.97, 0.93) });
  page.drawText(`Abschluss bestätigt am ${fmtDateTime(r.completed_at || new Date())}`, {
    x: 60, y: y, size: 11, font: bold, color: rgb(0.04, 0.42, 0.2),
  });
  y -= 34;

  for (const [k, v] of confirmationRows(r)) {
    page.drawText(k, { x: 50, y, size: 10.5, font, color: muted });
    page.drawText(safe(v, font, 10.5, 300), { x: 245, y, size: 10.5, font: bold, color: navy });
    y -= 8;
    page.drawLine({ start: { x: 50, y }, end: { x: 545, y }, thickness: 0.6, color: line });
    y -= 13;
  }
  y -= 10;
  const c = r.completed_data || {};
  const note = `Der Abschluss wurde online über den persönlichen Link bestätigt` +
    (c.ip ? ` (IP ${c.ip})` : "") + ".";
  page.drawText(note, { x: 50, y, size: 9, font, color: muted });
  page.drawText("WERTGARANTIE Austria · Einfach. Gut. Geschützt.", { x: 50, y: 40, size: 9, font, color: muted });
  return await pdf.save();
}

// WinAnsi-Font: unbekannte Zeichen ersetzen, zu lange Werte kürzen.
// deno-lint-ignore no-explicit-any
function safe(s: string, font: any, size: number, maxW: number) {
  let t = String(s).replace(/[^\x20-\x7e\xa0-\xff€–]/g, "?");
  while (t.length > 3 && font.widthOfTextAtSize(t, size) > maxW) t = t.slice(0, -2);
  return t;
}
