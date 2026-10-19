-- After-Sales-Tool: Schema im Event-Projekt (jtgoytbcqkqopdpjlozq), live
-- angewendet am 19.10.2026 (Migration "aftersales_init" + Nachträge).
-- Lose Referenz wie supabase/schema.sql - maßgeblich ist die Live-DB.

alter table public.profiles add column if not exists fh_nr text;
alter table public.profiles add column if not exists aftersales_access boolean not null default true;
alter table public.profiles add column if not exists as_managed boolean not null default false;

-- Rolle/FH-Nr aus app_metadata (nur service_role setzbar), Default 'admin' (Dashboard-Sync).
create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  insert into public.profiles (id, email, name, role, fh_nr)
  values (new.id, new.email, new.raw_user_meta_data->>'name',
          coalesce(new.raw_app_meta_data->>'role', 'admin'), new.raw_app_meta_data->>'fh_nr');
  return new;
end; $$;

create or replace function public.my_fh_nr() returns text language sql stable security definer set search_path to 'public' as $$
  select fh_nr from public.profiles where id = auth.uid(); $$;
create or replace function public.is_aftersales_user() returns boolean language sql stable security definer set search_path to 'public' as $$
  select exists (select 1 from public.profiles where id = auth.uid() and aftersales_access and role in ('admin','fachhaendler')); $$;
revoke execute on function public.my_fh_nr() from anon, public;
revoke execute on function public.is_aftersales_user() from anon, public;

-- profiles: nur eigene Zeile bzw. Admin alles (vorher: alle Authentifizierten alles)
alter policy "Authenticated read profiles" on public.profiles using (id = auth.uid() or public.is_admin());

create table public.as_imports (
  id uuid primary key default gen_random_uuid(), created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null, created_by_email text,
  fh_nr text not null, file_name text, row_count int not null default 0);

create table public.as_records (
  id uuid primary key default gen_random_uuid(),
  import_id uuid references public.as_imports(id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  fh_nr text not null,
  token text not null unique default encode(extensions.gen_random_bytes(24), 'hex'),
  expires_at timestamptz not null default (now() + interval '30 days'),
  status text not null default 'importiert' check (status in ('importiert','versendet','geoeffnet','aufgerufen','abgeschlossen','fehler','bounce','storniert')),
  anrede text, vorname text, nachname text, email text, telefon text, strasse text, plz text, ort text,
  geraet text, typ text, kaufdatum date, kaufpreis numeric(10,2), imei text,
  produkt text not null default 'Komplettschutz27', premium boolean, praemie numeric(10,2), raw jsonb,
  sent_at timestamptz, send_count int not null default 0, send_error text,
  opened_at timestamptz, open_count int not null default 0,
  clicked_at timestamptz, click_count int not null default 0,
  completed_at timestamptz, completed_data jsonb, bounced_at timestamptz, bounce_info text,
  updated_at timestamptz not null default now());

create table public.as_events (
  id bigserial primary key, record_id uuid references public.as_records(id) on delete cascade,
  created_at timestamptz not null default now(), type text not null, meta jsonb);

alter table public.as_imports enable row level security;
alter table public.as_records enable row level security;
alter table public.as_events enable row level security;
create policy "AS admin or own fh imports" on public.as_imports for all to authenticated
  using (public.is_aftersales_user() and (public.is_admin() or fh_nr = public.my_fh_nr()))
  with check (public.is_aftersales_user() and (public.is_admin() or fh_nr = public.my_fh_nr()));
create policy "AS admin or own fh records" on public.as_records for all to authenticated
  using (public.is_aftersales_user() and (public.is_admin() or fh_nr = public.my_fh_nr()))
  with check (public.is_aftersales_user() and (public.is_admin() or fh_nr = public.my_fh_nr()));
create policy "AS read events of visible records" on public.as_events for select to authenticated
  using (exists (select 1 from public.as_records r where r.id = record_id));

-- Trigger as_records_guard: authentifizierte Nutzer dürfen Tracking-/Abschluss-
-- Spalten nicht selbst setzen (nur service_role in den Edge Functions);
-- Status nur auf 'importiert'/'storniert', abgeschlossene Datensätze gesperrt.
-- (Volltext siehe Live-DB: public.as_records_guard())

-- Nachtrag 19.10.2026: Händlerdaten/Logo + Zahlung
create table public.as_dealers (
  fh_nr text primary key, name text, strasse text, plz text, ort text,
  email text, telefon text, homepage text, logo_url text,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null);
alter table public.as_dealers enable row level security;
create policy "AS admin or own fh dealer" on public.as_dealers for all to authenticated
  using (public.is_aftersales_user() and (public.is_admin() or fh_nr = public.my_fh_nr()))
  with check (public.is_aftersales_user() and (public.is_admin() or fh_nr = public.my_fh_nr()));
-- Storage-Bucket as-logos (public, PNG/JPG, max 1 MB); Schreibrechte nur im
-- Ordner der eigenen FH-Nr bzw. für Admins.
alter table public.as_records
  add column zahlungsart text check (zahlungsart in ('sepa_monatlich','ueberweisung_jaehrlich')),
  add column iban text, add column kontoinhaber text, add column zahlbetrag numeric(10,2);
-- as_records_guard setzt zusätzlich zahlungsart/iban/kontoinhaber/zahlbetrag
-- für authentifizierte Nutzer zurück (nur service_role schreibt diese).
