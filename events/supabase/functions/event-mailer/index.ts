// Event-Landingpage: Mailversand.
// - action "confirmation": Bestätigungsmail an eine einzelne Anmeldung
//   (wird vom öffentlichen Anmeldeformular direkt nach dem Insert aufgerufen).
//   Enthält einen unauffälligen Abmelde-Link (siehe cancelLinkHtml), der auf
//   die separate Edge Function cancel-registration verweist.
// - action "report": Status-Mail mit dem aktuellen Gesamt-Anmeldestand an alle
//   konfigurierten Empfänger einer Häufigkeit (täglich/wöchentlich/monatlich).
//   Wird von einem pg_cron-Job aufgerufen und ist über CRON_SECRET geschützt.
// - action "reminders": zwei Reminder an jede Anmeldung mit E-Mail - einer
//   72h vor dem Termin, einer am Tag der Veranstaltung um 12:00 (Wien).
//   Wird stündlich per pg_cron aufgerufen, ebenfalls über CRON_SECRET.
//
// Läuft serverseitig in Supabase, nutzt den service_role Key (nur hier, nie im
// Browser-Code) sowie SMTP-Zugangsdaten, die als Edge-Function-Secrets
// hinterlegt werden müssen (Supabase Dashboard -> Edge Functions -> Secrets):
//   SMTP_HOST, SMTP_PORT, SMTP_USERNAME, SMTP_PASSWORD,
//   SMTP_FROM_EMAIL, SMTP_FROM_NAME, CRON_SECRET

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const FIELD_LABELS: Record<string, string> = {
  vorname: "Vorname", nachname: "Name", plz: "PLZ", ort: "Ort",
  geburtsdatum: "Geburtsdatum", akp_nummer: "AKP-Nummer", fh_nummer: "FH-Nummer",
  fachhaendler: "Fachhändler", telefon: "Telefonnummer", email: "E-Mail-Adresse",
  anreise_auto: "Anreise mit Auto", bemerkungen: "Sonstige Bemerkungen",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function fmtDate(d: string) {
  return new Date(d + "T00:00:00").toLocaleDateString("de-AT", {
    weekday: "long", day: "2-digit", month: "2-digit", year: "numeric",
  });
}
function fmtDateShort(d: string) {
  return new Date(d + "T00:00:00").toLocaleDateString("de-AT", {
    day: "2-digit", month: "2-digit", year: "numeric",
  });
}
function fmtTime(t: string | null) {
  return t ? t.slice(0, 5) : "";
}
function escapeHtml(s: unknown) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string
  ));
}
function fullAddress(d: { street?: string | null; zip?: string | null; city?: string | null }) {
  const parts = [d.street, [d.zip, d.city].filter(Boolean).join(" ")].filter(Boolean);
  return parts.join(", ");
}
function mapsUrl(d: { location?: string | null; street?: string | null; zip?: string | null; city?: string | null }) {
  const query = [d.location, d.street, [d.zip, d.city].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(query);
}

// event_date/start_time werden ohne Zeitzone gespeichert (Wandzeit Österreich).
// Für Fristen-Berechnungen (48h-Abmeldefrist, Reminder-Versand) muss das in
// einen echten UTC-Zeitpunkt umgerechnet werden, DST-sicher (CET/CEST).
function viennaLocalToUtc(dateStr: string, timeStr: string): Date {
  const naiveUtc = new Date(`${dateStr}T${timeStr}Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Vienna", timeZoneName: "shortOffset",
  }).formatToParts(naiveUtc);
  const tzName = parts.find((p) => p.type === "timeZoneName")?.value || "GMT+1";
  const offsetHours = parseInt(tzName.replace("GMT", "") || "1", 10);
  return new Date(naiveUtc.getTime() - offsetHours * 3600000);
}

// Unauffälliger Abmelde-Link am Ende von Bestätigungs-/Reminder-Mails -
// führt zur statischen Seite events/abmelden.html (NICHT direkt zur
// cancel-registration Edge Function: Supabase liefert bei GET-Requests
// kein HTML aus, sondern schreibt den Content-Type zwangsweise auf
// text/plain um, wodurch nur der rohe HTML-Quelltext angezeigt würde).
// abmelden.html ruft die Edge Function per fetch() als JSON-API auf und
// prüft dort serverseitig nochmal die 48h-Frist.
function cancelLinkHtml(registrationId: string) {
  const url = `https://events.wgaustria.at/abmelden.html?id=${registrationId}`;
  return `<p style="color:#9BB0BE;font-size:11.5px;margin-top:22px">Kannst du doch nicht kommen? <a href="${url}" style="color:#9BB0BE;text-decoration:underline">Hier von der Veranstaltung abmelden</a>.</p>`;
}

// Wandzeit Wien "jetzt": Datum (YYYY-MM-DD) und Stunde (0-23), für den
// Tages-Reminder (fixe Uhrzeit statt fixer Stundenabstand zum Termin).
function viennaNow(): { dateStr: string; hour: number } {
  const now = new Date();
  const dateStr = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Vienna" }).format(now);
  const hour = parseInt(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Vienna", hour: "2-digit", hourCycle: "h23" }).format(now),
    10,
  );
  return { dateStr, hour };
}

function getSmtpClient() {
  const hostname = Deno.env.get("SMTP_HOST")!;
  const port = parseInt(Deno.env.get("SMTP_PORT") || "587", 10);
  const username = Deno.env.get("SMTP_USERNAME")!;
  const password = Deno.env.get("SMTP_PASSWORD")!;
  return new SMTPClient({
    connection: { hostname, port, tls: port === 465, auth: { username, password } },
  });
}

// denomailer 1.6.0 kodiert Nicht-ASCII-Zeichen (Umlaute, Gedankenstrich, ...)
// in Subject/From-Headern fehlerhaft (RFC-2047-widriges "encoded word" mit
// rohen Leerzeichen darin) - Mail-Clients wie Apple Mail geben dadurch den
// kompletten Header auf: Betreff erscheint als kryptischer Rohtext, Absender
// als "Kein Absender". Fix: Subject/From-Anzeigename vor dem Versand auf
// reines ASCII transliterieren, damit denomailer sie gar nicht erst als
// "encoded word" kodieren muss.
function asciiHeader(s: string): string {
  return s
    .replace(/ß/g, "ss")
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue")
    .replace(/Ä/g, "Ae").replace(/Ö/g, "Oe").replace(/Ü/g, "Ue")
    .replace(/[–—]/g, "-")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^\x20-\x7E]/g, "");
}

// denomailer 1.6.0 kodiert auch den HTML-Body fehlerhaft: quotedPrintableEncode()
// (config/mail/encoding.ts) zerschneidet den GESAMTEN Body ohne Rücksicht auf
// Wortgrenzen oder bereits vorhandene Zeilenumbrüche stur alle 74 Zeichen und
// fügt dort einen "weichen" Zeilenumbruch ein - dadurch kann (und wird real
// beobachtet) ein einzelnes Zeichen mitten in einem Wort/einer URL verloren
// gehen (bestätigter Fall: "events.wgaustria.at" im Abmelde-Link kam beim
// Empfänger als "eventswgaustria.at" an, der Punkt fiel exakt einer
// Umbruchstelle zum Opfer). Betrifft nur den HTML-Body über das "html"-Feld,
// das intern quotedPrintableEncode() aufruft - nicht Subject/From (siehe
// asciiHeader oben, separater Bug) und nicht den kurzen Text-Fallback unten
// (der bleibt unter 74 Zeichen, wird also nie umgebrochen).
//
// Fix: HTML-Body nicht über das "html"-Feld schicken (das landet automatisch
// bei quotedPrintableEncode), sondern selbst Base64-kodieren und als
// "mimeContent" mit transferEncoding "base64" übergeben. denomailer schreibt
// mimeContent[].content unverändert auf die Leitung (client/basic/client.ts) -
// Base64 ist unempfindlich gegenüber der Umbruchstelle, weil dort nie
// einzelne Zeichen/Escape-Sequenzen zerschnitten werden können.
function toBase64Utf8(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
function wrapBase64(b64: string): string {
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
  return lines.join("\r\n");
}

async function sendMail(subject: string, to: string, html: string) {
  const fromEmail = Deno.env.get("SMTP_FROM_EMAIL")!;
  const fromName = asciiHeader(Deno.env.get("SMTP_FROM_NAME") || "Wertgarantie Events Austria");
  const client = getSmtpClient();
  try {
    await client.send({
      from: `${fromName} <${fromEmail}>`,
      to,
      subject: asciiHeader(subject),
      content: "Bitte verwenden Sie einen E-Mail-Client mit HTML-Unterstützung.",
      mimeContent: [{
        mimeType: 'text/html; charset="utf-8"',
        content: wrapBase64(toBase64Utf8(html)),
        transferEncoding: "base64",
      }],
    });
  } finally {
    await client.close();
  }
}

async function handleConfirmation(admin: ReturnType<typeof createClient>, registrationId: string) {
  const { data: reg, error: regErr } = await admin
    .from("registrations").select("*").eq("id", registrationId).maybeSingle();
  if (regErr || !reg) return json({ error: "Anmeldung nicht gefunden" }, 404);
  if (reg.confirmation_sent_at) return json({ ok: true, skipped: "already_sent" });
  if (!reg.email) return json({ ok: true, skipped: "no_email" });

  const [{ data: event }, { data: eventDate }] = await Promise.all([
    admin.from("events").select("*").eq("id", reg.event_id).maybeSingle(),
    admin.from("event_dates").select("*").eq("id", reg.event_date_id).maybeSingle(),
  ]);
  if (!event || !eventDate) return json({ error: "Veranstaltung/Termin nicht gefunden" }, 404);

  const vorname = reg.data?.vorname ? String(reg.data.vorname) : "";
  const greeting = vorname ? `Hallo ${escapeHtml(vorname)},` : "Hallo,";

  const detailRows = Object.entries(FIELD_LABELS)
    .filter(([key]) => reg.data && reg.data[key] !== undefined && reg.data[key] !== "")
    .map(([key, label]) => `<tr><td style="padding:4px 12px 4px 0;color:#5D7284">${escapeHtml(label)}</td><td style="padding:4px 0;font-weight:600">${escapeHtml(reg.data[key])}</td></tr>`)
    .join("");

  const html = `
  <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:560px;margin:0 auto;color:#10202C">
    <div style="background:#10202C;padding:22px 26px;border-radius:14px 14px 0 0">
      <span style="color:#fff;font-weight:800;font-size:16px">Wertgarantie</span>
    </div>
    <div style="border:1px solid #DCE7EE;border-top:none;border-radius:0 0 14px 14px;padding:26px">
      <p>${greeting}</p>
      <p>wir freuen uns, dass du bei <strong>${escapeHtml(event.title)}</strong> dabei bist! Hier noch einmal alle Details zu deiner Anmeldung:</p>
      <div style="background:#F0FAFF;border:1px solid #009FE3;border-radius:12px;padding:16px 18px;margin:18px 0">
        <div style="font-weight:800;color:#062A3F;margin-bottom:4px">Dein Termin</div>
        <div>${escapeHtml(fmtDate(eventDate.event_date))}</div>
        <div>${escapeHtml(fmtTime(eventDate.start_time))}${eventDate.end_time ? "–" + escapeHtml(fmtTime(eventDate.end_time)) : ""} Uhr</div>
        <div>${escapeHtml(eventDate.location)}</div>
        ${fullAddress(eventDate) ? `<div>${escapeHtml(fullAddress(eventDate))}</div>` : ""}
        <div style="margin-top:8px"><a href="${mapsUrl(eventDate)}" style="color:#009FE3;font-weight:700;text-decoration:none">📍 Route planen ›</a></div>
      </div>
      ${detailRows ? `<div style="margin:18px 0"><div style="font-weight:800;color:#062A3F;margin-bottom:6px">Deine Angaben</div><table>${detailRows}</table></div>` : ""}
      <p>Wir freuen uns auf dich!</p>
      <p style="margin-bottom:0">Dein Wertgarantie Österreich Team</p>
      <p style="color:#5D7284;font-size:13px;margin-top:24px">Diese E-Mail wurde automatisch versendet. Bei Fragen wende dich bitte an die Kontaktperson deiner Veranstaltung.</p>
      ${cancelLinkHtml(reg.id)}
    </div>
  </div>`;

  await sendMail(`Anmeldebestätigung – ${event.title}`, reg.email, html);
  await admin.from("registrations").update({ confirmation_sent_at: new Date().toISOString() }).eq("id", reg.id);
  return json({ ok: true });
}

const FREQ_LABEL: Record<string, string> = { daily: "Täglicher", weekly: "Wöchentlicher", monthly: "Monatlicher" };

// Für die Teilnehmerliste je Termin: kompakte, immer gleiche Spalten,
// unabhängig davon welche Formularfelder für das Event aktiv sind.
const REPORT_PERSON_FIELDS: [string, string][] = [
  ["vorname", "Vorname"], ["nachname", "Name"], ["telefon", "Telefon"],
  ["email", "E-Mail"], ["plz", "PLZ"], ["ort", "Ort"],
];

// Betreff-Format: "<Veranstaltung> // Anmeldezahlen // <Termin-Info>", z.B.
// "Wertgarantie KickOff // Anmeldezahlen // 30.09.2026 // Wolfsberg". Bei
// mehreren Terminen einer Veranstaltung lässt sich kein einzelnes
// Datum/Ort sinnvoll in den Betreff packen, daher dort "X Termine".
function reportSubject(event: { title: string }, dates: { event_date: string; location: string }[]) {
  let terminPart: string;
  if (dates.length === 1) {
    terminPart = `${fmtDateShort(dates[0].event_date)} // ${dates[0].location}`;
  } else if (dates.length > 1) {
    terminPart = `${dates.length} Termine`;
  } else {
    terminPart = "keine Termine";
  }
  return `${event.title} // Anmeldezahlen // ${terminPart}`;
}

// Ein Report je aktiver Veranstaltung (mehrere können gleichzeitig laufen),
// nur an die für GENAU diese Veranstaltung hinterlegten Empfänger.
async function handleReport(admin: ReturnType<typeof createClient>, frequency: "daily" | "weekly" | "monthly") {
  const { data: events } = await admin.from("events").select("*").eq("is_active", true).order("created_at");
  if (!events || !events.length) return json({ ok: true, skipped: "no_active_events" });

  const freqLabel = FREQ_LABEL[frequency] || "Aktueller";
  const personHeaderCells = REPORT_PERSON_FIELDS
    .map(([, label]) => `<th style="padding:4px 12px 4px 0">${escapeHtml(label)}</th>`).join("");

  const results: { event: string; sent: number }[] = [];

  for (const event of events) {
    const { data: recipients } = await admin
      .from("email_recipients").select("*").eq("event_id", event.id).eq("frequency", frequency).eq("active", true);
    if (!recipients || !recipients.length) continue;

    const { data: dates } = await admin
      .from("event_dates").select("*").eq("event_id", event.id).order("sort_order").order("event_date");
    const { data: regs } = await admin
      .from("registrations").select("event_date_id, data, created_at").eq("event_id", event.id)
      .order("created_at");

    const byDate: Record<string, typeof regs> = {};
    (regs || []).forEach((r) => {
      (byDate[r.event_date_id] ||= []).push(r);
    });
    const total = (regs || []).length;

    const summaryRows = (dates || []).map((d) => `
      <tr>
        <td style="padding:6px 14px 6px 0">${escapeHtml(fmtDate(d.event_date))}</td>
        <td style="padding:6px 14px 6px 0">${escapeHtml(fmtTime(d.start_time))}${d.end_time ? "–" + escapeHtml(fmtTime(d.end_time)) : ""} Uhr</td>
        <td style="padding:6px 14px 6px 0">${escapeHtml(d.location)}</td>
        <td style="padding:6px 0;font-weight:800;text-align:right">${(byDate[d.id] || []).length}</td>
      </tr>`).join("");

    const dateSections = (dates || []).map((d) => {
      const people = byDate[d.id] || [];
      const personRows = people.map((r) => {
        const cells = REPORT_PERSON_FIELDS
          .map(([key]) => `<td style="padding:4px 12px 4px 0">${escapeHtml(r.data?.[key] ?? "")}</td>`).join("");
        return `<tr>${cells}</tr>`;
      }).join("");
      return `
        <div style="margin:22px 0 8px;font-weight:800;color:#062A3F">
          ${escapeHtml(fmtDate(d.event_date))} · ${escapeHtml(fmtTime(d.start_time))} Uhr · ${escapeHtml(d.location)}${fullAddress(d) ? " · " + escapeHtml(fullAddress(d)) : ""}
          <span style="font-weight:600;color:#5D7284">(${people.length})</span>
          <a href="${mapsUrl(d)}" style="color:#009FE3;font-weight:700;text-decoration:none;margin-left:6px">📍</a>
        </div>
        ${people.length
          ? `<table style="width:100%;border-collapse:collapse;font-size:13px">
              <thead><tr style="color:#5D7284;font-size:11px;text-transform:uppercase;text-align:left">${personHeaderCells}</tr></thead>
              <tbody>${personRows}</tbody>
            </table>`
          : `<div style="color:#5D7284;font-size:13px">Noch keine Anmeldungen.</div>`}
      `;
    }).join("");

    const html = `
    <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:680px;margin:0 auto;color:#10202C">
      <div style="background:#10202C;padding:22px 26px;border-radius:14px 14px 0 0">
        <span style="color:#fff;font-weight:800;font-size:16px">Wertgarantie</span>
      </div>
      <div style="border:1px solid #DCE7EE;border-top:none;border-radius:0 0 14px 14px;padding:26px">
        <p style="margin-top:0">${freqLabel} Anmeldestand für <strong>${escapeHtml(event.title)}</strong>, Stand ${new Date().toLocaleString("de-AT")}.</p>
        <div style="background:#ECF2F6;border-radius:12px;padding:14px 18px;margin:18px 0;font-weight:800;font-size:20px;color:#062A3F">
          ${total} Anmeldung${total === 1 ? "" : "en"} gesamt
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          <thead><tr style="color:#5D7284;font-size:11.5px;text-transform:uppercase;text-align:left">
            <th style="padding-bottom:6px">Datum</th><th style="padding-bottom:6px">Uhrzeit</th><th style="padding-bottom:6px">Ort</th><th style="padding-bottom:6px;text-align:right">Anmeldungen</th>
          </tr></thead>
          <tbody>${summaryRows}</tbody>
        </table>

        <div style="margin-top:26px;padding-top:18px;border-top:1px solid #DCE7EE">
          <div style="font-weight:800;color:#062A3F;margin-bottom:4px">Angemeldete Personen je Termin</div>
          ${dateSections}
        </div>

        <p style="color:#5D7284;font-size:13px;margin-top:24px">Diese E-Mail wurde automatisch versendet.</p>
      </div>
    </div>`;

    const subject = reportSubject(event, dates || []);
    for (const r of recipients) {
      await sendMail(subject, r.email, html);
    }
    results.push({ event: event.title, sent: recipients.length });
  }

  if (!results.length) return json({ ok: true, skipped: "no_recipients" });
  return json({ ok: true, results });
}

// Verschickt eine Reminder-Mail an jede Anmeldung mit E-Mail zu den
// übergebenen Terminen, die für die übergebene Spalte noch keinen Eintrag
// hat (reminder_72h_sent_at / reminder_day_sent_at), und markiert sie
// danach dort - verhindert Doppelversand über mehrere Cron-Läufe hinweg.
async function sendReminderBatch(
  admin: ReturnType<typeof createClient>,
  eventDates: Record<string, unknown>[],
  sentColumn: "reminder_72h_sent_at" | "reminder_day_sent_at",
): Promise<number> {
  if (!eventDates.length) return 0;
  const dateIds = eventDates.map((d) => d.id as string);
  const { data: regs } = await admin
    .from("registrations").select("*")
    .in("event_date_id", dateIds)
    .is(sentColumn, null)
    .not("email", "is", null);
  if (!regs || !regs.length) return 0;

  const eventIds = [...new Set(eventDates.map((d) => d.event_id as string))];
  const { data: events } = await admin.from("events").select("*").in("id", eventIds);
  const eventById = Object.fromEntries((events || []).map((e) => [e.id, e]));
  const dateById = Object.fromEntries(eventDates.map((d) => [d.id as string, d]));

  let sent = 0;
  for (const reg of regs) {
    const eventDate = dateById[reg.event_date_id] as Record<string, unknown> | undefined;
    const event = eventDate ? eventById[eventDate.event_id as string] : null;
    if (!eventDate || !event) continue;

    const vorname = reg.data?.vorname ? String(reg.data.vorname) : "";
    const greeting = vorname ? `Hallo ${escapeHtml(vorname)},` : "Hallo,";

    const html = `
    <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:560px;margin:0 auto;color:#10202C">
      <div style="background:#10202C;padding:22px 26px;border-radius:14px 14px 0 0">
        <span style="color:#fff;font-weight:800;font-size:16px">Wertgarantie</span>
      </div>
      <div style="border:1px solid #DCE7EE;border-top:none;border-radius:0 0 14px 14px;padding:26px">
        <p>${greeting}</p>
        <p>nur noch kurz hin bis <strong>${escapeHtml(event.title as string)}</strong> – wir wollten dich an deinen Termin erinnern:</p>
        <div style="background:#F0FAFF;border:1px solid #009FE3;border-radius:12px;padding:16px 18px;margin:18px 0">
          <div style="font-weight:800;color:#062A3F;margin-bottom:4px">Dein Termin</div>
          <div>${escapeHtml(fmtDate(eventDate.event_date as string))}</div>
          <div>${escapeHtml(fmtTime(eventDate.start_time as string))}${eventDate.end_time ? "–" + escapeHtml(fmtTime(eventDate.end_time as string)) : ""} Uhr</div>
          <div>${escapeHtml(eventDate.location as string)}</div>
          ${fullAddress(eventDate as { street?: string; zip?: string; city?: string }) ? `<div>${escapeHtml(fullAddress(eventDate as { street?: string; zip?: string; city?: string }))}</div>` : ""}
          <div style="margin-top:8px"><a href="${mapsUrl(eventDate as { location?: string; street?: string; zip?: string; city?: string })}" style="color:#009FE3;font-weight:700;text-decoration:none">📍 Route planen ›</a></div>
        </div>
        <p>Wir freuen uns auf dich!</p>
        <p style="margin-bottom:0">Dein Wertgarantie Österreich Team</p>
        <p style="color:#5D7284;font-size:13px;margin-top:24px">Diese E-Mail wurde automatisch versendet. Bei Fragen wende dich bitte an die Kontaktperson deiner Veranstaltung.</p>
        ${cancelLinkHtml(reg.id)}
      </div>
    </div>`;

    try {
      await sendMail(`Reminder: Anmeldebestätigung – ${event.title as string}`, reg.email, html);
      await admin.from("registrations").update({ [sentColumn]: new Date().toISOString() }).eq("id", reg.id);
      sent++;
    } catch (_e) {
      // best-effort: einzelner Fehler soll die restlichen Reminder nicht blockieren
    }
  }
  return sent;
}

// Zwei Reminder je Anmeldung: 72h vor dem Termin, und am Tag der
// Veranstaltung ab 12:00 Wiener Ortszeit (unabhängig von der Startzeit -
// bei einer Abendveranstaltung z.B. 7h vorher). Wird stündlich per pg_cron
// aufgerufen (siehe schema.sql).
async function handleReminders(admin: ReturnType<typeof createClient>) {
  const { data: dates } = await admin.from("event_dates").select("*");
  const now = Date.now();
  const { dateStr: todayVienna, hour: viennaHour } = viennaNow();

  const upcoming72h = (dates || []).filter((d) => {
    const dt = viennaLocalToUtc(d.event_date, d.start_time).getTime();
    return dt > now && dt <= now + 72 * 3600000;
  });
  const dayOf = (dates || []).filter((d) => {
    const dt = viennaLocalToUtc(d.event_date, d.start_time).getTime();
    return d.event_date === todayVienna && dt > now && viennaHour >= 12;
  });

  const sent72h = await sendReminderBatch(admin, upcoming72h, "reminder_72h_sent_at");
  const sentDayOf = await sendReminderBatch(admin, dayOf, "reminder_day_sent_at");

  if (!upcoming72h.length && !dayOf.length) return json({ ok: true, skipped: "no_upcoming_dates" });
  return json({ ok: true, sent_72h: sent72h, sent_day_of: sentDayOf });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Ungültiger Body" }, 400); }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  if (body.type === "confirmation") {
    const registrationId = String(body.registration_id || "");
    if (!registrationId) return json({ error: "registration_id erforderlich" }, 400);
    try {
      return await handleConfirmation(admin, registrationId);
    } catch (e) {
      return json({ error: "Mailversand fehlgeschlagen: " + String(e) }, 500);
    }
  }

  if (body.type === "report") {
    const secret = req.headers.get("x-cron-secret") || "";
    if (!secret || secret !== Deno.env.get("CRON_SECRET")) {
      return json({ error: "Nicht autorisiert" }, 401);
    }
    const frequency = body.frequency === "weekly" ? "weekly" : body.frequency === "monthly" ? "monthly" : "daily";
    try {
      return await handleReport(admin, frequency);
    } catch (e) {
      return json({ error: "Mailversand fehlgeschlagen: " + String(e) }, 500);
    }
  }

  if (body.type === "reminders") {
    const secret = req.headers.get("x-cron-secret") || "";
    if (!secret || secret !== Deno.env.get("CRON_SECRET")) {
      return json({ error: "Nicht autorisiert" }, 401);
    }
    try {
      return await handleReminders(admin);
    } catch (e) {
      return json({ error: "Mailversand fehlgeschlagen: " + String(e) }, 500);
    }
  }

  // Manueller SMTP-Verbindungstest, geschützt wie "report".
  if (body.type === "test") {
    const secret = req.headers.get("x-cron-secret") || "";
    if (!secret || secret !== Deno.env.get("CRON_SECRET")) {
      return json({ error: "Nicht autorisiert" }, 401);
    }
    const to = String(body.to || "");
    if (!to) return json({ error: "to erforderlich" }, 400);
    try {
      await sendMail(
        "Wertgarantie Events – SMTP-Test",
        to,
        `<div style="font-family:'Segoe UI',Arial,sans-serif;color:#10202C"><p>Diese Testmail bestätigt, dass die SMTP-Verbindung des Events-Projekts funktioniert.</p><p>Gesendet: ${new Date().toLocaleString("de-AT")}</p></div>`,
      );
      return json({ ok: true });
    } catch (e) {
      return json({ error: "SMTP-Test fehlgeschlagen: " + String(e) }, 500);
    }
  }

  return json({ error: "Unbekannter type" }, 400);
});
