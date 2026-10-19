// HTML-Mailvorlagen (Angebot mit Link, Abschlussbestätigung) und das
// Bestätigungs-PDF. Tabellen-Layout + Inline-Styles, damit Outlook & Co.
// sauber rendern. Seit 19.10.2026 personalisiert mit den Händlerdaten
// (as_dealers: Name, Adresse, E-Mail Geschäft, Telefon, Homepage, Logo).

import { PDFDocument, StandardFonts, rgb } from "https://esm.sh/pdf-lib@1.17.1";
import { appUrl, escapeHtml, fmtDate, fmtDateTime, reference } from "./common.ts";
import { calcPrice, eur, maskIban, PAYMENT_LABELS, paymentPeriod, PREMIUM_SURCHARGE, PRICE_PERIOD } from "./pricing.ts";

const BLUE = "#009FE3", NAVY = "#10202C", MUTED = "#5D7284", LINE = "#E1EAF1", PAPER = "#EEF3F7";

// deno-lint-ignore no-explicit-any
export type Rec = Record<string, any>;
export type Dealer = {
  fh_nr?: string; name?: string | null; strasse?: string | null; plz?: string | null; ort?: string | null;
  email?: string | null; telefon?: string | null; homepage?: string | null; logo_url?: string | null;
};

function homepageUrl(h: string) {
  return /^https?:\/\//i.test(h) ? h : "https://" + h;
}

function shell(inner: string, preheader: string, dealer: Dealer | null) {
  const wg = `<img src="${appUrl()}/logo.png" alt="Wertgarantie – Einfach. Gut. Geschützt." width="${dealer?.logo_url ? 130 : 200}" style="display:block;height:auto;border:0">`;
  const head = dealer?.logo_url
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td align="left" valign="middle"><img src="${escapeHtml(dealer.logo_url)}" alt="${escapeHtml(dealer.name || "")}" style="display:block;max-height:60px;max-width:240px;height:auto;border:0"></td>
        <td align="right" valign="middle">${wg}</td></tr></table>`
    : wg;
  return `<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${PAPER};font-family:'Segoe UI',Arial,sans-serif;color:${NAVY}">
<span style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAPER};padding:24px 0"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:16px;overflow:hidden">
<tr><td style="padding:22px 32px;border-bottom:4px solid ${BLUE}">${head}</td></tr>
<tr><td style="padding:28px 32px 8px;font-size:15px;line-height:1.6">${inner}</td></tr>
${dealer?.name ? `<tr><td style="padding:8px 32px 6px">${dealerBlock(dealer)}</td></tr>` : ""}
<tr><td style="padding:16px 32px 26px;font-size:11.5px;color:${MUTED}">Komplettschutz von WERTGARANTIE · Einfach. Gut. Geschützt.</td></tr>
</table></td></tr></table></body></html>`;
}

// Kontaktblock des Händlers (Mail-Fuß, auch in der Bestätigung).
export function dealerBlock(d: Dealer) {
  const lines: string[] = [];
  if (d.strasse) lines.push(escapeHtml(d.strasse));
  if (d.plz || d.ort) lines.push(escapeHtml([d.plz, d.ort].filter(Boolean).join(" ")));
  const contact: string[] = [];
  if (d.telefon) contact.push(`Tel. <a href="tel:${escapeHtml(String(d.telefon).replace(/[^\d+]/g, ""))}" style="color:${NAVY};text-decoration:none">${escapeHtml(d.telefon)}</a>`);
  if (d.email) contact.push(`<a href="mailto:${escapeHtml(d.email)}" style="color:${BLUE};text-decoration:none">${escapeHtml(d.email)}</a>`);
  if (d.homepage) contact.push(`<a href="${escapeHtml(homepageUrl(d.homepage))}" style="color:${BLUE};text-decoration:none">${escapeHtml(String(d.homepage).replace(/^https?:\/\//i, "").replace(/\/$/, ""))}</a>`);
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAPER};border-radius:12px"><tr><td style="padding:14px 18px;font-size:13px;line-height:1.6;color:${NAVY}">
<div style="font-size:11px;color:${MUTED};text-transform:uppercase;letter-spacing:.04em;font-weight:700;margin-bottom:2px">Ihr Fachhändler</div>
<b style="font-size:14.5px">${escapeHtml(d.name || "")}</b><br>${lines.join("<br>")}${contact.length ? "<br>" + contact.join(" &nbsp;·&nbsp; ") : ""}
</td></tr></table>`;
}

export function salutation(r: Rec) {
  const an = String(r.anrede || "").trim().toLowerCase();
  const nn = escapeHtml(r.nachname || "");
  if (an.startsWith("frau") && nn) return `Liebe Frau ${nn},`;
  if (an.startsWith("herr") && nn) return `Lieber Herr ${nn},`;
  const full = escapeHtml([r.vorname, r.nachname].filter(Boolean).join(" "));
  return full ? `Guten Tag ${full},` : "Liebe Kundin, lieber Kunde,";
}

function contactSentence(d: Dealer | null) {
  if (!d) return "Bei Fragen stehen wir Ihnen natürlich gerne zur Verfügung.";
  const tel = d.telefon ? `telefonisch unter <b>${escapeHtml(d.telefon)}</b>` : "";
  const mail = d.email ? `per E-Mail an <a href="mailto:${escapeHtml(d.email)}" style="color:${BLUE}">${escapeHtml(d.email)}</a>` : "";
  const via = [tel, mail].filter(Boolean).join(" oder ");
  return `Bei Fragen stehen wir Ihnen natürlich gerne${via ? " " + via : ""} zur Verfügung.`;
}

// ---------- Angebot / Einladung ----------
export function inviteMail(r: Rec, dealer: Dealer | null) {
  const link = `${appUrl()}/k/${r.token}`;
  const pixel = `${Deno.env.get("SUPABASE_URL")}/functions/v1/aftersales-public?a=px&t=${r.token}`;
  const dn = dealer?.name ? escapeHtml(dealer.name) : "";
  const geraetTxt = [r.geraet, r.typ].filter(Boolean).join(" – ");
  const price = r.kaufpreis != null ? calcPrice(+r.kaufpreis, r.geraet, false) : null;
  const priceRow = price && price.ok
    ? `<tr><td style="padding:4px 0;color:${MUTED}">Ihr Preis</td><td style="padding:4px 0;font-weight:800;color:#0077AC;font-size:17px">${eur(price.total)} <span style="font-size:13px;font-weight:600;color:${MUTED}">${PRICE_PERIOD}</span></td></tr>
       <tr><td></td><td style="padding:0 0 4px;font-size:12px;color:${MUTED}">${price.premiumIncluded ? "inkl. Premium-Option" : `Premium-Option optional + ${eur(PREMIUM_SURCHARGE)}`}</td></tr>`
    : "";
  const inner = `
<p style="margin:0 0 14px">${salutation(r)}</p>
<p style="margin:0 0 14px">vielen Dank für Ihren Einkauf${dn ? ` bei <b>${dn}</b>` : ""}! Gerne übermitteln wir Ihnen ein Angebot für den <b>Wertgarantie Komplettschutz</b> Ihres Gerätes – damit Sie lange und sorgenfrei Freude daran haben.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAPER};border-radius:12px;margin:6px 0 18px"><tr><td style="padding:14px 18px;font-size:14px">
<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px">
<tr><td style="padding:4px 18px 4px 0;color:${MUTED}">Gerät</td><td style="padding:4px 0;font-weight:700">${escapeHtml(geraetTxt || "Ihr neues Gerät")}</td></tr>
${r.kaufdatum ? `<tr><td style="padding:4px 18px 4px 0;color:${MUTED}">Kaufdatum</td><td style="padding:4px 0">${fmtDate(r.kaufdatum)}</td></tr>` : ""}
<tr><td style="padding:4px 18px 4px 0;color:${MUTED}">Produkt</td><td style="padding:4px 0">${escapeHtml(r.produkt || "Komplettschutz27")}</td></tr>
${priceRow}
</table></td></tr></table>
<p style="margin:0 0 20px">Ihre Daten haben wir bereits für Sie vorausgefüllt – Sie müssen sie nur noch prüfen, ergänzen und können den Komplettschutz dann mit einem Klick abschließen.</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 22px"><tr><td style="background:${BLUE};border-radius:999px">
<a href="${link}" style="display:inline-block;padding:14px 30px;color:#fff;text-decoration:none;font-weight:700;font-size:15px">Angebot ansehen &amp; abschließen</a>
</td></tr></table>
<p style="margin:0 0 14px">${contactSentence(dealer)}</p>
<p style="margin:0 0 6px;font-size:12px;color:${MUTED}">Falls der Button nicht funktioniert, kopieren Sie diesen Link in Ihren Browser:<br><a href="${link}" style="color:${BLUE};word-break:break-all">${link}</a></p>
<p style="margin:16px 0 14px">Freundliche Grüße<br>${dn ? `<b>${dn}</b><br>` : ""}gemeinsam mit Ihrem WERTGARANTIE Team</p>
<img src="${pixel}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0">`;
  return {
    subject: `Angebot für Ihren persönlichen Geräte-Komplettschutz${r.typ ? " – " + String(r.typ) : ""}`,
    html: shell(inner, "Ihr persönliches Angebot – Daten bereits vorausgefüllt, Abschluss mit einem Klick.", dealer),
  };
}

// ---------- Bestätigung ----------
export function confirmationRows(r: Rec): [string, string][] {
  const c = r.completed_data || {};
  return [
    ["Referenz", reference(r.id)],
    ["Abgeschlossen am", fmtDateTime(r.completed_at || new Date())],
    ["Anrede", r.anrede || "–"],
    ["Vorname", r.vorname], ["Name", r.nachname],
    ["Adresse", r.strasse], ["PLZ", r.plz], ["Ort", r.ort],
    ["E-Mail", r.email], ["Telefon", r.telefon || "–"],
    ["Gerät", r.geraet], ["Typ", r.typ],
    ["Kaufdatum", fmtDate(r.kaufdatum)], ["Kaufpreis", eur(r.kaufpreis)],
    ...(r.imei ? [["IMEI", r.imei] as [string, string]] : []),
    ["Produkt", r.produkt],
    ["Premium-Option", c.premium_included ? "inklusive" : (r.premium ? `ja (+ ${eur(c.surcharge)})` : "nein")],
    ["Prämie Komplettschutz", `${eur(r.praemie)} ${PRICE_PERIOD}`],
    ...(r.zahlungsart ? [
      ["Zahlungsart", PAYMENT_LABELS[r.zahlungsart] || r.zahlungsart],
      ["Zahlbetrag", `${eur(r.zahlbetrag)} ${paymentPeriod(r.zahlungsart)}`],
    ] as [string, string][] : []),
    // IBAN in Mail/PDF nur maskiert (vollständig nur in der Datenbank/im Tool).
    ...(r.zahlungsart === "sepa_monatlich" ? [
      ["Kontoinhaber", r.kontoinhaber || "–"],
      ["IBAN", maskIban(r.iban)],
    ] as [string, string][] : []),
    ["Fachhändler-Nr.", r.fh_nr],
  ].map(([k, v]) => [k, String(v ?? "–")]);
}

export function confirmationMail(r: Rec, forDealer: boolean, dealer: Dealer | null) {
  const rows = confirmationRows(r).map(([k, v]) =>
    `<tr><td style="padding:7px 0;color:${MUTED};font-size:13.5px;width:44%;border-bottom:1px solid ${LINE}">${escapeHtml(k)}</td><td style="padding:7px 0;font-size:13.5px;font-weight:600;border-bottom:1px solid ${LINE}">${escapeHtml(v)}</td></tr>`
  ).join("");
  const dn = dealer?.name ? escapeHtml(dealer.name) : "";
  const intro = forDealer
    ? `<p style="margin:0 0 14px">Ihr Kunde <b>${escapeHtml([r.vorname, r.nachname].filter(Boolean).join(" "))}</b> hat den Komplettschutz soeben online abgeschlossen. Alle Daten finden Sie unten sowie im angehängten PDF. Die Originalpolizze erhält der Kunde gesondert per E-Mail.</p>`
    : `<p style="margin:0 0 14px">${salutation(r)}</p><p style="margin:0 0 14px">herzlichen Dank für Ihr Vertrauen! Hiermit bestätigen wir Ihnen den Abschluss Ihres <b>Wertgarantie ${escapeHtml(r.produkt)}</b>. Alle Angaben finden Sie unten sowie im angehängten PDF.</p><p style="margin:0 0 14px"><b>Ihre Originalpolizze folgt in Kürze gesondert per E-Mail.</b></p>`;
  const inner = `${intro}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#E8F7EE;border-radius:12px;margin:0 0 16px"><tr><td style="padding:12px 16px;font-size:14px;color:#0B6B34"><b>✓ Abschluss bestätigt</b> am ${escapeHtml(fmtDateTime(r.completed_at || new Date()))}</td></tr></table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>
${forDealer ? "" : `<p style="margin:18px 0 0">${contactSentence(dealer)}</p>`}
<p style="margin:18px 0 14px">Freundliche Grüße<br>${!forDealer && dn ? `<b>${dn}</b><br>gemeinsam mit Ihrem ` : "Ihr "}WERTGARANTIE Team</p>`;
  const who = [r.vorname, r.nachname].filter(Boolean).join(" ");
  return {
    subject: forDealer
      ? `Abschluss ${r.produkt}: ${who} (${reference(r.id)})`
      : `Bestätigung Ihres Geräte-Komplettschutzes (${reference(r.id)})`,
    html: shell(inner, "Ihr Abschluss wurde bestätigt.", forDealer ? null : dealer),
  };
}

// ---------- PDF ----------
// deno-lint-ignore no-explicit-any
async function embedImage(pdf: any, url: string) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
    const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8;
    return isPng ? await pdf.embedPng(bytes) : isJpg ? await pdf.embedJpg(bytes) : null;
  } catch {
    return null;
  }
}

export async function confirmationPdf(r: Rec, dealer: Dealer | null): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const H = 841.89;
  const page = pdf.addPage([595.28, H]); // A4
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const navy = rgb(0x10 / 255, 0x20 / 255, 0x2c / 255);
  const muted = rgb(0x5d / 255, 0x72 / 255, 0x84 / 255);
  const blue = rgb(0, 0x9f / 255, 0xe3 / 255);
  const line = rgb(0xe1 / 255, 0xea / 255, 0xf1 / 255);

  // Kopf: Händlerlogo links (falls vorhanden), Wertgarantie-Logo rechts bzw.
  // allein links. Scheitert ein Bild, entsteht das PDF eben ohne.
  const top = H - 45, headH = 52;
  const wg = await embedImage(pdf, `${appUrl()}/logo.png`);
  const dl = dealer?.logo_url ? await embedImage(pdf, dealer.logo_url) : null;
  if (dl) {
    const s = Math.min(200 / dl.width, headH / dl.height);
    page.drawImage(dl, { x: 50, y: top - dl.height * s, width: dl.width * s, height: dl.height * s });
  }
  if (wg) {
    const w = dl ? 130 : 170, h = w * wg.height / wg.width;
    page.drawImage(wg, { x: dl ? 545 - w : 50, y: top - h, width: w, height: h });
  }
  page.drawRectangle({ x: 50, y: top - headH - 10, width: 495, height: 3, color: blue });

  let y = top - headH - 42;
  page.drawText(safe("Bestätigung Komplettschutz", bold, 20, 495), { x: 50, y, size: 20, font: bold, color: navy });
  y -= 22;
  page.drawText(safe(`${r.produkt} · Referenz ${reference(r.id)}`, font, 11, 495), { x: 50, y, size: 11, font, color: muted });
  y -= 26;
  page.drawRectangle({ x: 50, y: y - 8, width: 495, height: 26, color: rgb(0.91, 0.97, 0.93) });
  page.drawText(safe(`Abschluss bestätigt am ${fmtDateTime(r.completed_at || new Date())}`, bold, 11, 470), {
    x: 60, y, size: 11, font: bold, color: rgb(0.04, 0.42, 0.2),
  });
  y -= 32;

  for (const [k, v] of confirmationRows(r)) {
    page.drawText(k, { x: 50, y, size: 10, font, color: muted });
    page.drawText(safe(v, bold, 10, 300), { x: 245, y, size: 10, font: bold, color: navy });
    y -= 6;
    page.drawLine({ start: { x: 50, y }, end: { x: 545, y }, thickness: 0.6, color: line });
    y -= 11.5;
  }

  if (dealer?.name) {
    y -= 8;
    const dLines = [
      [dealer.strasse, [dealer.plz, dealer.ort].filter(Boolean).join(" ")].filter(Boolean).join(", "),
      [dealer.telefon ? "Tel. " + dealer.telefon : "", dealer.email || ""].filter(Boolean).join("  ·  "),
      dealer.homepage || "",
    ].filter(Boolean);
    const boxH = 30 + dLines.length * 13;
    page.drawRectangle({ x: 50, y: y - boxH + 12, width: 495, height: boxH, color: rgb(0.933, 0.953, 0.969) });
    page.drawText("IHR FACHHÄNDLER", { x: 62, y: y - 2, size: 8, font: bold, color: muted });
    page.drawText(safe(dealer.name, bold, 11.5, 470), { x: 62, y: y - 16, size: 11.5, font: bold, color: navy });
    let yy = y - 30;
    for (const l of dLines) { page.drawText(safe(l, font, 9.5, 470), { x: 62, y: yy, size: 9.5, font, color: navy }); yy -= 13; }
    y -= boxH + 6;
  }

  const c = r.completed_data || {};
  const note = `Der Abschluss wurde online über den persönlichen Link bestätigt` + (c.ip ? ` (IP ${c.ip})` : "") + ".";
  page.drawText(safe(note, font, 8.5, 495), { x: 50, y: Math.max(y - 4, 70), size: 8.5, font, color: muted });
  page.drawText("Die Originalpolizze folgt gesondert per E-Mail.", { x: 50, y: Math.max(y - 16, 58), size: 9, font: bold, color: navy });
  page.drawText("Komplettschutz von WERTGARANTIE · Einfach. Gut. Geschützt.", { x: 50, y: 36, size: 8.5, font, color: muted });
  return await pdf.save();
}

// WinAnsi-Font: unbekannte Zeichen ersetzen, zu lange Werte kürzen.
// deno-lint-ignore no-explicit-any
function safe(s: string, font: any, size: number, maxW: number) {
  let t = String(s).replace(/[  ]/g, " ").replace(/[^\x20-\x7e\xa0-\xff€–·]/g, "?");
  while (t.length > 3 && font.widthOfTextAtSize(t, size) > maxW) t = t.slice(0, -2);
  return t;
}
