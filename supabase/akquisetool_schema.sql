-- Wertgarantie Performance Akquisetool – Supabase Schema
-- Ergänzung zu schema.sql, nur vom Akquisetool (akquise.html) genutzt.
-- Das Dashboard (index.html) liest/schreibt keine dieser Tabellen.

-- ---------- Koordinaten + Sparte je Fachhändler ----------
-- Wird ausschließlich von der Edge Function akquise-google (Aktion
-- "geocode") befüllt. address_key ist die normalisierte Adresse, aus der die
-- Koordinaten stammen - ändert sich die Adresse in fh_contacts, wird neu
-- geocodiert. Google-Nutzungsbedingungen: Koordinaten aus der Geocoding API
-- dürfen max. 30 Tage zwischengespeichert werden, daher geocoded_at +
-- Auffrischung nach 30 Tagen (siehe GEOCODE_MAX_AGE_DAYS in der Function).
-- sparte: manuell im Akquisetool gesetzte Sparte (null = automatisch aus
-- Name/Hauptzweig abgeleitet, siehe guessSparte() in akquise.html).
create table if not exists public.akquise_geo (
  fh_nr        text primary key,
  lat          double precision,
  lng          double precision,
  -- 'adresse' (Straße + Hausnummer gefunden), 'ort' (nur PLZ/Ort genau),
  -- 'fehler' (Adresse nicht auffindbar - kein erneuter Versuch bis zur
  -- nächsten Adressänderung bzw. nach 30 Tagen)
  genauigkeit  text check (genauigkeit is null or genauigkeit in ('adresse','ort','fehler')),
  address_key  text,
  geocoded_at  timestamptz,
  sparte       text check (sparte is null or sparte in ('elektrohandel','elektroservice','mobilfunk','hoerakustik','optiker','kuechen','uhren')),
  updated_at   timestamptz not null default now(),
  updated_by   uuid  -- auth.users.id (ohne FK: Fremdschlüssel auf auth.users blockierte beim Anlegen)
);

alter table public.akquise_geo enable row level security;

drop policy if exists "Authenticated read akquise_geo" on public.akquise_geo;
create policy "Authenticated read akquise_geo"
  on public.akquise_geo for select
  to authenticated
  using (true);

-- Clients dürfen nur die Sparte pflegen (Insert für noch nicht geocodierte
-- Händler, Update der Sparte) - Koordinaten schreibt die Edge Function mit
-- Service-Role-Key, die Column-Grants unten verhindern clientseitige
-- Änderungen an lat/lng/geocoded_at.
drop policy if exists "Authenticated insert akquise_geo" on public.akquise_geo;
create policy "Authenticated insert akquise_geo"
  on public.akquise_geo for insert
  to authenticated
  with check (true);

drop policy if exists "Authenticated update akquise_geo" on public.akquise_geo;
create policy "Authenticated update akquise_geo"
  on public.akquise_geo for update
  to authenticated
  using (true)
  with check (true);

revoke insert, update on public.akquise_geo from authenticated;
revoke all on public.akquise_geo from anon;
grant insert (fh_nr, sparte, updated_at, updated_by) on public.akquise_geo to authenticated;
grant update (sparte, updated_at, updated_by) on public.akquise_geo to authenticated;

-- ---------- Status je Akquise-Treffer (Google-Ort) ----------
-- Gespeichert wird nur die Google place_id (laut Google-Nutzungsbedingungen
-- unbegrenzt speicherbar) plus unser eigener Status/Notiz - KEINE
-- Google-Inhalte wie Name oder Adresse.
create table if not exists public.akquise_place_status (
  place_id    text primary key,
  status      text not null check (status in ('offen','kontaktiert','termin','kein_interesse','angelegt')),
  notiz       text,
  sparte      text,
  updated_at  timestamptz not null default now(),
  updated_by  uuid  -- auth.users.id (ohne FK, siehe akquise_geo)
);

alter table public.akquise_place_status enable row level security;

drop policy if exists "Authenticated all akquise_place_status" on public.akquise_place_status;
create policy "Authenticated all akquise_place_status"
  on public.akquise_place_status for all
  to authenticated
  using (true)
  with check (true);

revoke all on public.akquise_place_status from anon;

-- ---------- Ein/Aus-Schalter ----------
-- dashboard_kv-Key "akquisetool_enabled" ("1"/"0"), per Schalter im
-- Admin-Panel des Dashboards. Admins können das Tool auch bei
-- ausgeschaltetem Schalter öffnen (zum Testen).
--
-- dashboard_kv-Key "google_maps_browser_key": der auf die Vercel-Domains
-- beschränkte Browser-Schlüssel für die Maps JavaScript API, im Akquisetool
-- unter "Einstellungen" (nur Admin) hinterlegt. Der Server-Schlüssel liegt
-- NICHT hier, sondern als Edge-Function-Secret GOOGLE_MAPS_SERVER_KEY.
