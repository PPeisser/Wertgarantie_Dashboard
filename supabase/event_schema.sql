-- Wertgarantie Event-Landingpage – Supabase Schema
-- Ergänzt schema.sql um Events, Termine, Formularfelder, Anmeldungen und
-- E-Mail-Empfänger. Nutzt public.is_admin() aus schema.sql für Admin-Policies.
-- Im Supabase SQL-Editor ausführen (nach schema.sql), falls das Projekt neu
-- aufgesetzt wird. Auf dem bestehenden Projekt (gfyjftwlombhmwirbyse) wurde
-- dies bereits per Migration angewendet.

-- ---------- Events (fachlich: es gibt jeweils genau EIN aktives Event) ----------

create table if not exists public.events (
  id            uuid primary key default gen_random_uuid(),
  title         text not null default 'Wertgarantie Veranstaltung',
  description   text not null default '',
  privacy_text  text not null default '',
  is_active     boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table public.events enable row level security;

create policy "Public read active events"
  on public.events for select
  to anon, authenticated
  using (true);

create policy "Admins manage events"
  on public.events for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Nur ein aktives Event gleichzeitig (vereinfacht die Landingpage-Logik).
create unique index if not exists events_single_active_idx
  on public.events ((true)) where is_active;

-- ---------- Termine (Ort/Datum/Uhrzeit je Event) ----------

create table if not exists public.event_dates (
  id          uuid primary key default gen_random_uuid(),
  event_id    uuid not null references public.events(id) on delete cascade,
  event_date  date not null,
  start_time  time not null,
  end_time    time,
  location    text not null default '',
  sort_order  int not null default 0,
  created_at  timestamptz not null default now()
);

alter table public.event_dates enable row level security;

create policy "Public read event_dates"
  on public.event_dates for select
  to anon, authenticated
  using (true);

create policy "Admins manage event_dates"
  on public.event_dates for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create index if not exists event_dates_event_idx on public.event_dates (event_id, sort_order);

-- ---------- Formularfelder-Konfiguration je Event ----------
-- field_key ist ein fester Katalog, Label/Reihenfolge/Pflicht sind je Event
-- konfigurierbar (siehe FIELD_META in event-landingpage.html / event-admin.html).

create table if not exists public.event_form_fields (
  id          uuid primary key default gen_random_uuid(),
  event_id    uuid not null references public.events(id) on delete cascade,
  field_key   text not null check (field_key in (
                'vorname','nachname','plz','ort','geburtsdatum',
                'akp_nummer','fh_nummer','fachhaendler','telefon','email',
                'anreise_auto','bemerkungen'
              )),
  enabled     boolean not null default true,
  required    boolean not null default false,
  sort_order  int not null default 0,
  label       text,
  unique (event_id, field_key)
);

alter table public.event_form_fields enable row level security;

create policy "Public read event_form_fields"
  on public.event_form_fields for select
  to anon, authenticated
  using (true);

create policy "Admins manage event_form_fields"
  on public.event_form_fields for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ---------- Anmeldungen ----------

create table if not exists public.registrations (
  id                    uuid primary key default gen_random_uuid(),
  event_id              uuid not null references public.events(id) on delete cascade,
  event_date_id         uuid not null references public.event_dates(id) on delete cascade,
  data                  jsonb not null default '{}'::jsonb,
  email                 text,
  consent_at            timestamptz not null default now(),
  confirmation_sent_at  timestamptz,
  created_at            timestamptz not null default now()
);

alter table public.registrations enable row level security;

-- Anmeldeformular ist öffentlich (kein Login) -> anon darf nur INSERT, kein SELECT.
create policy "Public insert registrations"
  on public.registrations for insert
  to anon, authenticated
  with check (true);

create policy "Admins read registrations"
  on public.registrations for select
  to authenticated
  using (public.is_admin());

create policy "Admins delete registrations"
  on public.registrations for delete
  to authenticated
  using (public.is_admin());

create index if not exists registrations_event_idx on public.registrations (event_id, event_date_id);

-- ---------- E-Mail-Empfänger für Status-Reports (täglich/wöchentlich) ----------

create table if not exists public.email_recipients (
  id         uuid primary key default gen_random_uuid(),
  email      text not null,
  frequency  text not null check (frequency in ('daily','weekly')),
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  unique (email, frequency)
);

alter table public.email_recipients enable row level security;

create policy "Admins manage email_recipients"
  on public.email_recipients for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Seed: ein leeres Default-Event anlegen, falls noch keines existiert.
insert into public.events (title, description, is_active)
select 'Wertgarantie Roadshow', 'Beschreibung im Admin-Panel bearbeiten.', true
where not exists (select 1 from public.events);

-- Sinnvolle Default-Feldkonfiguration für Events ohne eigene Konfiguration.
insert into public.event_form_fields (event_id, field_key, enabled, required, sort_order, label)
select e.id, f.field_key, f.enabled, f.required, f.sort_order, f.label
from public.events e
cross join (values
  ('vorname',      true,  true,  1, 'Vorname'),
  ('nachname',     true,  true,  2, 'Name'),
  ('plz',          true,  false, 3, 'PLZ'),
  ('ort',          true,  false, 4, 'Ort'),
  ('geburtsdatum', false, false, 5, 'Geburtsdatum'),
  ('akp_nummer',   false, false, 6, 'AKP-Nummer'),
  ('fh_nummer',    false, false, 7, 'FH-Nummer'),
  ('fachhaendler', false, false, 8, 'Fachhändler'),
  ('telefon',      true,  false, 9, 'Telefonnummer'),
  ('email',        true,  true, 10, 'E-Mail-Adresse'),
  ('anreise_auto', false, false, 11, 'Anreise mit Auto'),
  ('bemerkungen',  false, false, 12, 'Sonstige Bemerkungen')
) as f(field_key, enabled, required, sort_order, label)
where not exists (
  select 1 from public.event_form_fields x where x.event_id = e.id
);

-- ---------- Automatischer täglicher/wöchentlicher Report (pg_cron + pg_net) ----------
-- Ruft die Edge Function event-mailer auf, die den aktuellen Gesamt-Anmeldestand
-- an alle aktiven email_recipients der jeweiligen Häufigkeit verschickt.
-- CRON_SECRET muss identisch als Edge-Function-Secret hinterlegt sein (siehe README).

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'event-daily-report',
  '0 6 * * *',
  $$
  select net.http_post(
    url := 'https://gfyjftwlombhmwirbyse.supabase.co/functions/v1/event-mailer',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<CRON_SECRET>'),
    body := jsonb_build_object('type','report','frequency','daily')
  );
  $$
);

select cron.schedule(
  'event-weekly-report',
  '0 6 * * 1',
  $$
  select net.http_post(
    url := 'https://gfyjftwlombhmwirbyse.supabase.co/functions/v1/event-mailer',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<CRON_SECRET>'),
    body := jsonb_build_object('type','report','frequency','weekly')
  );
  $$
);
