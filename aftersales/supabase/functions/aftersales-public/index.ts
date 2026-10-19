// After-Sales: öffentliche Endpunkte für Kunden (ohne Login, verify_jwt=false).
// Der Kunde kennt nur seinen Einmal-Token aus dem Link - alle DB-Zugriffe
// laufen hier mit service_role, es gibt KEINE anon-Policies auf as_records.
//
// - GET  ?a=px&t=<token>          Öffnungs-Pixel (1x1 GIF) → opened_at
// - POST {action:"get", token}     Landingpage lädt vorausgefüllte Daten → clicked_at
// - POST {action:"submit", token, data}
//        Abschluss: Preis wird HIER verbindlich neu berechnet, Datensatz wird
//        einmalig auf "abgeschlossen" gesetzt, Bestätigung (HTML + PDF) geht
//        an den Kunden und an die Login-Adresse(n) des Fachhändlers.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CORS_HEADERS, bytesToBase64, json, loadDealer, reference } from "../_shared/common.ts";
import { calcPrice, isMobileDevice, isValidIban, isValidImei, normalizeIban, paymentAmount, PRODUCT_NAME, PRICE_PERIOD } from "../_shared/pricing.ts";
import { confirmationMail, confirmationPdf } from "../_shared/templates.ts";
import { SmtpSession } from "../_shared/smtp.ts";

const GIF = Uint8Array.from(atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"), (c) => c.charCodeAt(0));

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

function clientIp(req: Request) {
  return (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || null;
}

async function logEvent(recordId: string, type: string, meta?: unknown) {
  await admin.from("as_events").insert({ record_id: recordId, type, meta: meta ?? null });
}

async function byToken(token: string) {
  if (!/^[a-f0-9]{32,64}$/.test(token)) return null;
  const { data } = await admin.from("as_records").select("*").eq("token", token).maybeSingle();
  return data;
}

async function dealerEmails(rec: Record<string, unknown>): Promise<string[]> {
  const { data } = await admin.from("profiles").select("email")
    .eq("fh_nr", rec.fh_nr as string).eq("aftersales_access", true);
  const out = (data || []).map((p) => p.email).filter(Boolean) as string[];
  if (rec.created_by) {
    const { data: creator } = await admin.from("profiles").select("email").eq("id", rec.created_by as string).maybeSingle();
    if (creator?.email) out.push(creator.email);
  }
  return [...new Set(out.map((e) => e.toLowerCase()))];
}

// Nur die für Kunden bestimmten Händlerfelder herausgeben.
async function publicDealer(fhNr: string) {
  const d = await loadDealer(admin, fhNr);
  if (!d) return null;
  const { name, strasse, plz, ort, email, telefon, homepage, logo_url } = d;
  return { name, strasse, plz, ort, email, telefon, homepage, logo_url };
}

const str = (v: unknown, max = 200) => String(v ?? "").trim().slice(0, max);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  const url = new URL(req.url);

  // ---------- Öffnungs-Pixel ----------
  if (req.method === "GET" && url.searchParams.get("a") === "px") {
    const rec = await byToken(url.searchParams.get("t") || "");
    if (rec) {
      const upd: Record<string, unknown> = { open_count: (rec.open_count || 0) + 1 };
      if (!rec.opened_at) upd.opened_at = new Date().toISOString();
      if (rec.status === "versendet") upd.status = "geoeffnet";
      await admin.from("as_records").update(upd).eq("id", rec.id);
      if (!rec.opened_at) await logEvent(rec.id, "opened", { ua: req.headers.get("user-agent") });
    }
    return new Response(GIF, {
      headers: { "Content-Type": "image/gif", "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0" },
    });
  }

  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Ungültiger Body" }, 400); }
  const rec = await byToken(String(body.token || ""));
  if (!rec || rec.status === "storniert") return json({ error: "Dieser Link ist ungültig." }, 404);

  const expired = new Date(rec.expires_at).getTime() < Date.now();

  // ---------- Landingpage laden ----------
  if (body.action === "get") {
    if (rec.status !== "abgeschlossen" && !expired) {
      const upd: Record<string, unknown> = { click_count: (rec.click_count || 0) + 1 };
      if (!rec.clicked_at) upd.clicked_at = new Date().toISOString();
      if (["versendet", "geoeffnet", "importiert"].includes(rec.status)) upd.status = "aufgerufen";
      await admin.from("as_records").update(upd).eq("id", rec.id);
      if (!rec.clicked_at) await logEvent(rec.id, "clicked", { ip: clientIp(req), ua: req.headers.get("user-agent") });
    }
    return json({
      ok: true,
      state: rec.status === "abgeschlossen" ? "completed" : (expired ? "expired" : "open"),
      reference: reference(rec.id),
      dealer: await publicDealer(rec.fh_nr),
      completed_at: rec.completed_at,
      record: {
        anrede: rec.anrede, vorname: rec.vorname, nachname: rec.nachname, email: rec.email, telefon: rec.telefon,
        strasse: rec.strasse, plz: rec.plz, ort: rec.ort,
        geraet: rec.geraet, typ: rec.typ, kaufdatum: rec.kaufdatum, kaufpreis: rec.kaufpreis,
        imei: rec.imei, produkt: rec.produkt || PRODUCT_NAME, premium: rec.premium, praemie: rec.praemie,
      },
      period: PRICE_PERIOD,
    });
  }

  // ---------- Abschluss ----------
  if (body.action === "submit") {
    if (rec.status === "abgeschlossen") return json({ error: "Dieser Komplettschutz wurde bereits abgeschlossen." }, 409);
    if (expired) return json({ error: "Dieser Link ist abgelaufen. Bitte wenden Sie sich an Ihren Fachhändler." }, 410);
    const d = (body.data || {}) as Record<string, unknown>;

    // Gerätedaten aus dem Import sind verbindlich (Kunde kann sie auf der
    // Landingpage nicht ändern); nur wo im Import nichts stand, zählt die Eingabe.
    const geraet = rec.geraet || str(d.geraet, 120);
    const typ = rec.typ || str(d.typ, 160);
    const kaufdatum = rec.kaufdatum || str(d.kaufdatum, 10);
    const kaufpreis = rec.kaufpreis != null ? +rec.kaufpreis : +String(d.kaufpreis ?? "").replace(",", ".");
    const anrede = ["Frau", "Herr", "Divers"].includes(str(d.anrede, 10)) ? str(d.anrede, 10) : (rec.anrede || null);
    const fields = {
      anrede,
      vorname: str(d.vorname, 80), nachname: str(d.nachname, 80),
      strasse: str(d.strasse, 160), plz: str(d.plz, 10), ort: str(d.ort, 80),
      email: str(d.email, 160).toLowerCase(), telefon: str(d.telefon, 40),
    };
    const errors: string[] = [];
    for (const [k, label] of [["vorname", "Vorname"], ["nachname", "Name"], ["strasse", "Adresse"], ["plz", "PLZ"], ["ort", "Ort"], ["email", "E-Mail"]]) {
      if (!fields[k as keyof typeof fields]) errors.push(label);
    }
    if (fields.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email)) errors.push("E-Mail (ungültig)");
    if (!geraet) errors.push("Gerät");
    if (!typ) errors.push("Typ");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(kaufdatum)) || new Date(kaufdatum + "T00:00:00").getTime() > Date.now()) errors.push("Kaufdatum");
    if (!(kaufpreis > 0)) errors.push("Kaufpreis");
    const mobile = isMobileDevice(geraet);
    const imei = mobile ? str(d.imei || rec.imei, 20).replace(/\s|-/g, "") : null;
    if (mobile && !isValidImei(imei)) errors.push("IMEI (15-stellig, gültig)");
    // Zahlung: SEPA-Lastschrift monatlich (IBAN + Kontoinhaber + Mandat) oder
    // Überweisung jährlich.
    const zahlungsart = str(d.zahlungsart, 30);
    const sepa = zahlungsart === "sepa_monatlich";
    const iban = sepa ? normalizeIban(str(d.iban, 50)) : null;
    // Kontoinhaber = Kunde (Vorname + Name), nicht frei änderbar.
    const kontoinhaber = sepa ? [fields.vorname, fields.nachname].filter(Boolean).join(" ") : null;
    if (!["sepa_monatlich", "ueberweisung_jaehrlich"].includes(zahlungsart)) errors.push("Zahlungsart");
    else if (sepa) {
      if (!isValidIban(iban)) errors.push("IBAN (ungültig)");
      if (!kontoinhaber) errors.push("Kontoinhaber");
      if (d.accept_sepa !== true) errors.push("SEPA-Lastschriftmandat");
    }
    if (d.accept_terms !== true) errors.push("Zustimmung zu den Bedingungen");
    if (errors.length) return json({ error: "Bitte prüfen: " + errors.join(", ") }, 400);

    const price = calcPrice(kaufpreis, geraet, d.premium === true);
    if (!price.ok) return json({ error: price.reason }, 400);

    const completedAt = new Date().toISOString();
    const completedData = {
      ip: clientIp(req), ua: req.headers.get("user-agent"),
      base: price.base, surcharge: price.surcharge, premium_included: price.premiumIncluded,
      accept_terms: true, accept_sepa: sepa ? true : undefined, accepted_at: completedAt,
    };
    // Atomar nur einmal abschließen (status != abgeschlossen im Filter).
    const { data: updated, error } = await admin.from("as_records").update({
      ...fields, geraet, typ, kaufdatum, kaufpreis, imei,
      produkt: PRODUCT_NAME, premium: price.premium, praemie: price.total,
      zahlungsart, iban, kontoinhaber, zahlbetrag: paymentAmount(price.total, zahlungsart),
      status: "abgeschlossen", completed_at: completedAt, completed_data: completedData,
    }).eq("id", rec.id).neq("status", "abgeschlossen").select("*").maybeSingle();
    if (error) return json({ error: "Speichern fehlgeschlagen: " + error.message }, 500);
    if (!updated) return json({ error: "Dieser Komplettschutz wurde bereits abgeschlossen." }, 409);
    await logEvent(rec.id, "completed", { ip: completedData.ip, total: price.total });

    // Bestätigungen - Fehler hier machen den Abschluss NICHT rückgängig,
    // werden aber protokolliert und im Tool sichtbar.
    let mailStatus = "ok";
    try {
      const dealer = await loadDealer(admin, updated.fh_nr);
      const fromName = dealer?.name ? `${dealer.name} | Wertgarantie` : undefined;
      const pdfB64 = bytesToBase64(await confirmationPdf(updated, dealer));
      const att = [{ filename: `Bestaetigung_${reference(updated.id)}.pdf`, content: pdfB64, contentType: "application/pdf" }];
      const s = new SmtpSession();
      await s.open();
      try {
        const cust = confirmationMail(updated, false, dealer);
        await s.send({ to: [updated.email], subject: cust.subject, html: cust.html, attachments: att, fromName, replyTo: dealer?.email || undefined });
        const dealers = await dealerEmails(updated);
        if (dealers.length) {
          const fh = confirmationMail(updated, true, dealer);
          await s.send({ to: dealers, subject: fh.subject, html: fh.html, attachments: att, replyTo: updated.email });
        }
      } finally { await s.close(); }
      await logEvent(rec.id, "confirmation_sent");
    } catch (e) {
      mailStatus = "failed";
      await logEvent(rec.id, "confirmation_failed", { error: String(e) });
      await admin.from("as_records").update({ send_error: "Bestätigungsmail: " + String(e).slice(0, 300) }).eq("id", rec.id);
    }
    return json({ ok: true, reference: reference(updated.id), total: price.total, zahlbetrag: updated.zahlbetrag, zahlungsart, mail: mailStatus });
  }

  return json({ error: "Unbekannte Aktion" }, 400);
});
