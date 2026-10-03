// Akquisetool - Google-Maps-Platform-Proxy fuer akquise.html.
//
// Der Google-Server-Schluessel (Places API (New) + Geocoding API) liegt nur
// hier als Secret GOOGLE_MAPS_SERVER_KEY und verlaesst den Server nie - der
// Browser bekommt ausschliesslich die aufbereiteten Ergebnisse.
//
// Aktionen ("action" im Request-Body):
// - "status":        { configured } - ist der Server-Schluessel hinterlegt?
// - "search":        Akquise-Suche je Sparte im Umkreis (Text Search (New)).
// - "details":       Telefon/Website/Oeffnungszeiten EINES Treffers (Place
//                    Details (New)) - bewusst nur auf Klick, damit die Suche
//                    selbst im guenstigeren "Pro"-Tarif bleibt.
// - "reverse":       Bezirk/Bundesland/Ort zum Standort (fuer die WKO-Links).
// - "geocode_address": freie Adresse -> Koordinaten (manuelle Standortwahl).
// - "geocode":       Fachhaendler-Adressen aus fh_contacts -> akquise_geo.
//
// Google-Nutzungsbedingungen: Places-Inhalte (Name, Adresse ...) werden
// NICHT gespeichert, nur an den Client durchgereicht. Gespeichert werden
// ausschliesslich Koordinaten unserer EIGENEN Haendleradressen (max. 30 Tage,
// danach Auffrischung - GEOCODE_MAX_AGE_DAYS) und place_ids (unbegrenzt
// erlaubt, Tabelle akquise_place_status, schreibt der Client).
//
// Auth: normale Nutzer-Session. Zusaetzlich muss das Akquisetool im
// Admin-Panel aktiviert sein (dashboard_kv "akquisetool_enabled" = "1") -
// Admins duerfen auch bei ausgeschaltetem Schalter (zum Testen).

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

const GEOCODE_MAX_AGE_DAYS = 30;
const MAX_RADIUS_M = 50000;

// Suchbegriffe je Sparte. Bewusst serverseitig fest hinterlegt (statt vom
// Client frei waehlbar), damit der Schluessel nicht fuer beliebige Suchen
// missbraucht werden kann und die Kosten je Suche planbar bleiben.
const SPARTEN: Record<string, string[]> = {
  elektrohandel: ["Elektrofachhandel", "Elektrohändler Haushaltsgeräte"],
  elektroservice: ["Elektrogeräte Reparatur", "Elektro Kundendienst"],
  mobilfunk: ["Handyshop", "Mobilfunk Shop"],
  hoerakustik: ["Hörakustiker"],
  optiker: ["Optiker"],
  kuechen: ["Küchenstudio"],
  uhren: ["Uhren Juwelier"],
};

const SEARCH_FIELD_MASK = [
  "places.id", "places.displayName", "places.formattedAddress", "places.location",
  "places.types", "places.primaryType", "places.primaryTypeDisplayName",
  "places.businessStatus", "places.googleMapsUri", "places.addressComponents",
  "nextPageToken",
].join(",");

const DETAILS_FIELD_MASK = [
  "id", "displayName", "formattedAddress", "nationalPhoneNumber", "websiteUri",
  "regularOpeningHours.weekdayDescriptions", "rating", "userRatingCount",
  "googleMapsUri", "businessStatus",
].join(",");

function distM(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371000, toRad = (d: number) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Rechteck um den Suchkreis - Text Search (New) unterstuetzt als harte
// Einschraenkung (locationRestriction) nur Rechtecke, die Ecken werden
// anschliessend per distM() auf den echten Kreis gefiltert.
function boundsFor(lat: number, lng: number, radiusM: number) {
  const dLat = radiusM / 111320;
  const dLng = radiusM / (111320 * Math.cos(lat * Math.PI / 180));
  return {
    low: { latitude: lat - dLat, longitude: lng - dLng },
    high: { latitude: lat + dLat, longitude: lng + dLng },
  };
}

type GPlace = {
  id: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude: number; longitude: number };
  types?: string[];
  primaryType?: string;
  primaryTypeDisplayName?: { text?: string };
  businessStatus?: string;
  googleMapsUri?: string;
  addressComponents?: { longText?: string; shortText?: string; types?: string[] }[];
};

function addrPart(p: GPlace, type: string) {
  const c = (p.addressComponents || []).find((x) => (x.types || []).includes(type));
  return c ? (c.longText || c.shortText || "") : "";
}

async function textSearch(key: string, query: string, lat: number, lng: number, radiusM: number) {
  const out: GPlace[] = [];
  let pageToken: string | undefined;
  let calls = 0;
  for (let page = 0; page < 3; page++) {
    const body: Record<string, unknown> = {
      textQuery: query,
      languageCode: "de",
      regionCode: "AT",
      pageSize: 20,
      rankPreference: "DISTANCE",
      locationRestriction: { rectangle: boundsFor(lat, lng, radiusM) },
    };
    if (pageToken) body.pageToken = pageToken;
    const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": SEARCH_FIELD_MASK,
      },
      body: JSON.stringify(body),
    });
    calls++;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data?.error?.message || ("HTTP " + res.status);
      throw new Error("Google Places: " + msg);
    }
    const places: GPlace[] = data.places || [];
    out.push(...places);
    pageToken = data.nextPageToken;
    // Weitere Seite nur, wenn die Seite voll war UND der entfernteste
    // Treffer noch im Kreis liegt (Ergebnisse sind nach Distanz sortiert).
    const last = places[places.length - 1];
    if (!pageToken || places.length < 20 || !last?.location) break;
    if (distM(lat, lng, last.location.latitude, last.location.longitude) > radiusM) break;
  }
  return { places: out, calls };
}

async function geocodeRaw(key: string, params: Record<string, string>) {
  const qs = new URLSearchParams({ ...params, language: "de", region: "at", key });
  const res = await fetch("https://maps.googleapis.com/maps/api/geocode/json?" + qs.toString());
  const data = await res.json().catch(() => ({}));
  if (data.status === "OVER_QUERY_LIMIT" || data.status === "REQUEST_DENIED") {
    throw new Error("Google Geocoding: " + data.status + (data.error_message ? " - " + data.error_message : ""));
  }
  return data;
}

// PostgREST liefert je Abfrage max. 1000 Zeilen (Supabase max_rows, gilt
// auch mit Service-Role-Key) - fh_contacts hat deutlich mehr, daher seitenweise.
// deno-lint-ignore no-explicit-any
async function fetchAllRows(client: any, table: string, cols: string) {
  const out: Record<string, unknown>[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await client.from(table).select(cols).order("fh_nr").range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

function normAddr(s: string) {
  return String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

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

  const [{ data: prof }, { data: kv }] = await Promise.all([
    admin.from("profiles").select("role").eq("id", user.id).maybeSingle(),
    admin.from("dashboard_kv").select("value").eq("key", "akquisetool_enabled").maybeSingle(),
  ]);
  const isAdmin = prof?.role === "admin";
  if (!isAdmin && kv?.value !== "1") return json({ error: "Akquisetool ist nicht aktiviert." }, 403);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Ungueltiger Body" }, 400); }
  const action = String(body.action || "");

  const key = Deno.env.get("GOOGLE_MAPS_SERVER_KEY") || "";
  if (action === "status") return json({ configured: !!key, isAdmin });
  if (!key) return json({ error: "Google-Server-Schlüssel (GOOGLE_MAPS_SERVER_KEY) ist noch nicht hinterlegt." }, 503);

  try {
    if (action === "search") {
      const lat = Number(body.lat), lng = Number(body.lng);
      const radius = Math.min(MAX_RADIUS_M, Math.max(500, Number(body.radius) || 10000));
      if (!isFinite(lat) || !isFinite(lng)) return json({ error: "lat/lng fehlen" }, 400);
      const sparten = (Array.isArray(body.sparten) ? body.sparten : Object.keys(SPARTEN))
        .map(String).filter((s) => SPARTEN[s]);
      if (!sparten.length) return json({ error: "Keine gültige Sparte gewählt" }, 400);

      const jobs: { sparte: string; query: string }[] = [];
      for (const s of sparten) for (const q of SPARTEN[s]) jobs.push({ sparte: s, query: q });

      const byId = new Map<string, Record<string, unknown>>();
      let calls = 0;
      const errors: string[] = [];
      await Promise.all(jobs.map(async (j) => {
        try {
          const r = await textSearch(key, j.query, lat, lng, radius);
          calls += r.calls;
          for (const p of r.places) {
            if (!p.location || p.businessStatus === "CLOSED_PERMANENTLY") continue;
            const d = distM(lat, lng, p.location.latitude, p.location.longitude);
            if (d > radius) continue;
            const ex = byId.get(p.id);
            if (ex) {
              const sp = ex.sparten as string[];
              if (!sp.includes(j.sparte)) sp.push(j.sparte);
              continue;
            }
            byId.set(p.id, {
              place_id: p.id,
              name: p.displayName?.text || "",
              adresse: p.formattedAddress || "",
              strasse: addrPart(p, "route"),
              hausnr: addrPart(p, "street_number"),
              plz: addrPart(p, "postal_code"),
              ort: addrPart(p, "locality") || addrPart(p, "postal_town"),
              lat: p.location.latitude,
              lng: p.location.longitude,
              dist: Math.round(d),
              typ: p.primaryTypeDisplayName?.text || "",
              types: p.types || [],
              status: p.businessStatus || "",
              maps_url: p.googleMapsUri || "",
              sparten: [j.sparte],
            });
          }
        } catch (e) {
          errors.push(String((e as Error).message || e));
        }
      }));
      if (!byId.size && errors.length) return json({ error: errors[0] }, 502);
      const results = [...byId.values()].sort((a, b) => (a.dist as number) - (b.dist as number));
      return json({ results, calls, errors });
    }

    if (action === "details") {
      const id = String(body.place_id || "");
      if (!/^[A-Za-z0-9_-]+$/.test(id)) return json({ error: "place_id ungültig" }, 400);
      const res = await fetch("https://places.googleapis.com/v1/places/" + id + "?languageCode=de&regionCode=AT", {
        headers: { "X-Goog-Api-Key": key, "X-Goog-FieldMask": DETAILS_FIELD_MASK },
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) return json({ error: "Google Places: " + (d?.error?.message || res.status) }, 502);
      return json({
        place_id: d.id,
        name: d.displayName?.text || "",
        adresse: d.formattedAddress || "",
        telefon: d.nationalPhoneNumber || "",
        website: d.websiteUri || "",
        oeffnungszeiten: d.regularOpeningHours?.weekdayDescriptions || [],
        rating: d.rating ?? null,
        ratings: d.userRatingCount ?? null,
        maps_url: d.googleMapsUri || "",
        status: d.businessStatus || "",
      });
    }

    if (action === "reverse") {
      const lat = Number(body.lat), lng = Number(body.lng);
      if (!isFinite(lat) || !isFinite(lng)) return json({ error: "lat/lng fehlen" }, 400);
      const data = await geocodeRaw(key, { latlng: lat + "," + lng });
      const pick = (t: string) => {
        for (const r of data.results || []) {
          const c = (r.address_components || []).find((x: { types: string[] }) => x.types.includes(t));
          if (c) return c.long_name as string;
        }
        return "";
      };
      return json({
        bundesland: pick("administrative_area_level_1"),
        bezirk: pick("administrative_area_level_2"),
        ort: pick("locality") || pick("postal_town"),
        plz: pick("postal_code"),
        adresse: data.results?.[0]?.formatted_address || "",
      });
    }

    if (action === "geocode_address") {
      const q = String(body.address || "").trim();
      if (!q) return json({ error: "Adresse fehlt" }, 400);
      const data = await geocodeRaw(key, { address: q, components: "country:AT" });
      const r = data.results?.[0];
      if (!r) return json({ error: "Adresse nicht gefunden" }, 404);
      return json({ lat: r.geometry.location.lat, lng: r.geometry.location.lng, adresse: r.formatted_address });
    }

    if (action === "geocode") {
      const limit = Math.min(300, Math.max(1, Number(body.limit) || 150));
      type ContactRow = { fh_nr: string; strasse: string | null; plz: string | null; ort: string | null };
      type GeoRow = { fh_nr: string; address_key: string | null; geocoded_at: string | null };
      const [contacts, geo, { data: stateRow }] = await Promise.all([
        fetchAllRows(admin, "fh_contacts", "fh_nr,strasse,plz,ort") as Promise<ContactRow[]>,
        fetchAllRows(admin, "akquise_geo", "fh_nr,address_key,geocoded_at") as Promise<GeoRow[]>,
        admin.from("dashboard_kv").select("value").eq("key", "wg-state").maybeSingle(),
      ]);

      // Aktive Haendler (FH-Liste) und Akquisekunden zuerst geocodieren.
      const prio = new Map<string, number>();
      try {
        const st = stateRow?.value ? JSON.parse(stateRow.value) : null;
        for (const nr of Object.keys(st?.latest?.fh || {})) prio.set(nr, 0);
        for (const a of st?.latest?.akq || []) if (a?.nr && !prio.has(String(a.nr))) prio.set(String(a.nr), 1);
      } catch { /* ohne Prioritaet weiter */ }

      const geoBy = new Map<string, GeoRow>(geo.map((g) => [g.fh_nr, g]));
      const maxAge = Date.now() - GEOCODE_MAX_AGE_DAYS * 86400000;
      const todo: { fh_nr: string; strasse: string; plz: string; ort: string; key: string }[] = [];
      let ohneAdresse = 0;
      for (const c of contacts) {
        const plz = String(c.plz || "").trim(), ort = String(c.ort || "").trim();
        const strasse = String(c.strasse || "").trim();
        if (!plz && !ort) { ohneAdresse++; continue; }
        const k = normAddr([strasse, plz, ort].join("|"));
        const g = geoBy.get(c.fh_nr);
        const fresh = g && g.address_key === k && g.geocoded_at && new Date(g.geocoded_at).getTime() > maxAge;
        if (!fresh) todo.push({ fh_nr: c.fh_nr, strasse, plz, ort, key: k });
      }
      todo.sort((a, b) => (prio.get(a.fh_nr) ?? 2) - (prio.get(b.fh_nr) ?? 2));
      const batch = todo.slice(0, limit);

      let ok = 0, fehler = 0;
      const now = new Date().toISOString();
      const rows: Record<string, unknown>[] = [];
      let fatal: string | null = null;
      const queue = [...batch];
      await Promise.all(Array.from({ length: 8 }, async () => {
        while (queue.length && !fatal) {
          const c = queue.shift()!;
          try {
            let lat: number | null = null, lng: number | null = null, gen = "fehler";
            if (c.strasse) {
              const d = await geocodeRaw(key, {
                address: `${c.strasse}, ${c.plz} ${c.ort}`,
                components: "country:AT" + (c.plz ? "|postal_code:" + c.plz : ""),
              });
              const r = d.results?.[0];
              if (r) {
                lat = r.geometry.location.lat; lng = r.geometry.location.lng;
                const lt = r.geometry.location_type;
                gen = (lt === "ROOFTOP" || lt === "RANGE_INTERPOLATED") ? "adresse" : "ort";
              }
            }
            if (lat == null) {
              const d = await geocodeRaw(key, {
                address: `${c.plz} ${c.ort}`.trim(),
                components: "country:AT",
              });
              const r = d.results?.[0];
              if (r) { lat = r.geometry.location.lat; lng = r.geometry.location.lng; gen = "ort"; }
            }
            if (lat == null) fehler++; else ok++;
            rows.push({ fh_nr: c.fh_nr, lat, lng, genauigkeit: gen, address_key: c.key, geocoded_at: now, updated_at: now });
          } catch (e) {
            fatal = String((e as Error).message || e);
          }
        }
      }));
      if (rows.length) {
        const { error: upErr } = await admin.from("akquise_geo").upsert(rows, { onConflict: "fh_nr" });
        if (upErr) return json({ error: upErr.message }, 500);
      }
      if (fatal && !rows.length) return json({ error: fatal }, 502);
      return json({
        verarbeitet: rows.length, ok, fehler,
        offen: Math.max(0, todo.length - rows.length),
        ohne_adresse: ohneAdresse,
        warnung: fatal,
      });
    }

    return json({ error: "Unbekannte Aktion" }, 400);
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
