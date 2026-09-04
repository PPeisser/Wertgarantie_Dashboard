-- Wertgarantie Events – eigenständiges Supabase-Schema (Projekt "wgaustria-events",
-- getrennt vom Performance-Dashboard). Im Supabase SQL-Editor ausführen, falls
-- das Projekt neu aufgesetzt wird. Auf dem bestehenden Projekt wurde dies
-- bereits per Migration angewendet.

-- ---------- Rollen ----------
-- Dieses Projekt hat nur einen Nutzerkreis: Event-Admins. Jeder neu
-- registrierte Nutzer wird automatisch Admin (siehe handle_new_user unten).

create table if not exists public.profiles (
  id                    uuid primary key references auth.users(id) on delete cascade,
  email                 text,
  name                  text,
  role                  text not null default 'admin' check (role in ('admin')),
  must_change_password  boolean not null default false,
  created_at            timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "Authenticated read profiles"
  on public.profiles for select
  to authenticated
  using (true);

create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

revoke execute on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, name, role)
  values (new.id, new.email, new.raw_user_meta_data->>'name', 'admin');
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- Setzt must_change_password auf false für den eigenen Account, nachdem der
-- Nutzer im Client sein Passwort geändert hat.
create or replace function public.mark_password_changed()
returns void
language sql
security definer
set search_path = public
as $$
  update public.profiles set must_change_password = false where id = auth.uid();
$$;

revoke execute on function public.mark_password_changed() from public, anon;
grant execute on function public.mark_password_changed() to authenticated;

-- ---------- Nutzer-Synchronisation vom Performance-Dashboard-Projekt ----------
-- Nutzer werden NICHT hier angelegt, sondern über die Edge Function
-- supabase/functions/sync-user, die vom Dashboard-Projekt (admin-users
-- Edge Function, siehe dortiges Repo-Verzeichnis) aufgerufen wird, wenn im
-- Dashboard ein Nutzer angelegt/gelöscht wird. Sync-Nutzer bekommen das
-- Erstpasswort "WertGARANTIE" und must_change_password = true.

-- ---------- Events (mehrere Veranstaltungen gleichzeitig möglich) ----------
-- Jede Veranstaltung hat einen eindeutigen, sprechenden Kurzlink (slug),
-- über den register.html sie öffentlich lädt (?event=<slug>, von Vercel
-- aus /<slug> umgeschrieben, siehe events/vercel.json). Es gibt keine
-- öffentliche Übersicht -- nur wer den Link/QR-Code bekommt, kommt zur
-- Anmeldeseite. is_active steuert je Veranstaltung, ob sie offen für
-- Anmeldungen ist; mehrere Veranstaltungen dürfen gleichzeitig aktiv sein.

create table if not exists public.events (
  id            uuid primary key default gen_random_uuid(),
  title         text not null default 'Wertgarantie Veranstaltung',
  slug          text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  description   text not null default '',
  privacy_text  text not null default '',
  photo_url     text,
  is_active     boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table public.events enable row level security;

create unique index if not exists events_slug_idx on public.events (slug);

create policy "Public read active events"
  on public.events for select
  to anon, authenticated
  using (true);

create policy "Admins manage events"
  on public.events for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ---------- Termine (Ort/Datum/Uhrzeit je Event) ----------

create table if not exists public.event_dates (
  id          uuid primary key default gen_random_uuid(),
  event_id    uuid not null references public.events(id) on delete cascade,
  event_date  date not null,
  start_time  time not null,
  end_time    time,
  location    text not null default '',
  street      text not null default '',
  zip         text not null default '',
  city        text not null default '',
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
-- konfigurierbar (siehe FIELD_META in events/index.html / events/admin.html).

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
  -- Gesetzt, sobald der jeweilige automatische Reminder verschickt wurde
  -- (siehe event-mailer action "reminders"); verhindert Doppelversand über
  -- mehrere stündliche Cron-Läufe hinweg. Zwei getrennte Reminder: 72h vor
  -- dem Termin, und am Tag der Veranstaltung ab 12:00 Wiener Ortszeit.
  reminder_72h_sent_at  timestamptz,
  reminder_day_sent_at  timestamptz,
  -- Ergebnis des serverseitigen AKP/FH-Datenabgleichs mit dem
  -- Dashboard-Projekt (siehe supabase/functions/match-registration und
  -- lookup-akp im Dashboard-Projekt). Wird nicht im Anmeldeschritt
  -- angezeigt, nur im Admin-Panel/CSV-Export.
  matched_akp           jsonb,
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

-- ---------- E-Mail-Empfänger für Status-Reports (je Veranstaltung) ----------

create table if not exists public.email_recipients (
  id         uuid primary key default gen_random_uuid(),
  event_id   uuid not null references public.events(id) on delete cascade,
  email      text not null,
  frequency  text not null check (frequency in ('daily','weekly','monthly')),
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  unique (event_id, email, frequency)
);

create index if not exists email_recipients_event_idx on public.email_recipients (event_id);

alter table public.email_recipients enable row level security;

create policy "Admins manage email_recipients"
  on public.email_recipients for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ---------- Foto-Storage ----------

insert into storage.buckets (id, name, public)
values ('event-photos', 'event-photos', true)
on conflict (id) do nothing;

create policy "Public read event photos"
  on storage.objects for select
  to anon, authenticated
  using (bucket_id = 'event-photos');

create policy "Admins upload event photos"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'event-photos' and public.is_admin());

create policy "Admins update event photos"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'event-photos' and public.is_admin())
  with check (bucket_id = 'event-photos' and public.is_admin());

create policy "Admins delete event photos"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'event-photos' and public.is_admin());

-- ---------- Seed: Default-Event + Feldkonfiguration ----------

insert into public.events (title, slug, description, is_active)
select 'Wertgarantie Roadshow', 'wertgarantie-roadshow', 'Beschreibung im Admin-Panel bearbeiten.', true
where not exists (select 1 from public.events);

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
-- <CRON_SECRET> durch denselben Wert ersetzen, der auch als Edge-Function-Secret
-- CRON_SECRET hinterlegt ist (siehe README).

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'event-daily-report',
  '0 6 * * *',
  $$
  select net.http_post(
    url := '<SUPABASE_PROJECT_URL>/functions/v1/event-mailer',
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
    url := '<SUPABASE_PROJECT_URL>/functions/v1/event-mailer',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<CRON_SECRET>'),
    body := jsonb_build_object('type','report','frequency','weekly')
  );
  $$
);

select cron.schedule(
  'event-monthly-report',
  '0 6 1 * *',
  $$
  select net.http_post(
    url := '<SUPABASE_PROJECT_URL>/functions/v1/event-mailer',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<CRON_SECRET>'),
    body := jsonb_build_object('type','report','frequency','monthly')
  );
  $$
);

-- ---------- Automatische Reminder (pg_cron + pg_net) ----------
-- Stündlicher Check, verschickt zwei getrennte Erinnerungsmails (Betreff
-- "Reminder: ...") an jede Anmeldung mit E-Mail:
--  - 72h vor dem Termin (reminder_72h_sent_at)
--  - am Tag der Veranstaltung ab 12:00 Wiener Ortszeit (reminder_day_sent_at)
-- Die jeweilige *_sent_at-Spalte verhindert Doppelversand über mehrere
-- Cron-Läufe hinweg.

select cron.schedule(
  'event-reminder-check',
  '0 * * * *',
  $$
  select net.http_post(
    url := '<SUPABASE_PROJECT_URL>/functions/v1/event-mailer',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<CRON_SECRET>'),
    body := jsonb_build_object('type','reminders')
  );
  $$
);
