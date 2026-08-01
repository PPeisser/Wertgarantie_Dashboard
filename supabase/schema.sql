-- Wertgarantie Performance Dashboard – Supabase Schema
-- Im Supabase SQL-Editor (https://supabase.com/dashboard/project/_/sql) einmalig ausführen.

create table if not exists public.dashboard_kv (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

alter table public.dashboard_kv enable row level security;

-- Nur eingeloggte Nutzer dürfen den gemeinsamen Datenstand (Ziele, Excel-Auswertung) lesen/schreiben.
create policy "Authenticated read dashboard_kv"
  on public.dashboard_kv for select
  to authenticated
  using (true);

create policy "Authenticated insert dashboard_kv"
  on public.dashboard_kv for insert
  to authenticated
  with check (true);

create policy "Authenticated update dashboard_kv"
  on public.dashboard_kv for update
  to authenticated
  using (true)
  with check (true);

-- ---------- Rollen (Admin / Außendienst) ----------

create table if not exists public.profiles (
  id                   uuid primary key references auth.users(id) on delete cascade,
  email                text,
  name                 text,
  role                 text not null default 'aussendienst' check (role in ('admin','aussendienst')),
  must_change_password boolean not null default false,
  created_at           timestamptz not null default now()
);

alter table public.profiles add column if not exists name text;
alter table public.profiles add column if not exists must_change_password boolean not null default false;

alter table public.profiles enable row level security;

-- Jeder eingeloggte Nutzer darf alle Rollen sehen (kleines Team, für UI-Zwecke).
create policy "Authenticated read profiles"
  on public.profiles for select
  to authenticated
  using (true);

-- Hilfsfunktion (security definer, umgeht RLS gezielt) um rekursive Policy-Auswertung zu vermeiden.
create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

-- Nur Admins dürfen Rollen ändern.
create policy "Admins can update roles"
  on public.profiles for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Setzt must_change_password auf false für den eigenen Account, nachdem der
-- Nutzer im Client sein Passwort geändert hat (client darf profiles sonst
-- nicht selbst updaten, siehe Policy oben – nur Admins dürfen das direkt).
create or replace function public.mark_password_changed()
returns void
language sql
security definer
set search_path = public
as $$
  update public.profiles set must_change_password = false where id = auth.uid();
$$;

-- Legt bei jeder Neuregistrierung automatisch ein Profil mit Standardrolle "aussendienst" an.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, name, role)
  values (new.id, new.email, new.raw_user_meta_data->>'name', 'aussendienst');
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Postgres vergibt EXECUTE standardmäßig an PUBLIC – das würde beide Funktionen
-- als öffentliche RPC-Endpunkte exponieren (/rest/v1/rpc/...). Einschränken:
-- handle_new_user() braucht niemand direkt aufrufbar (nur der Trigger nutzt sie).
-- is_admin() muss für authenticated ausführbar bleiben (RLS-Policy oben ruft sie auf).
revoke execute on function public.handle_new_user() from public;
revoke execute on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;
revoke execute on function public.mark_password_changed() from public;
grant execute on function public.mark_password_changed() to authenticated;

-- Bestehenden Nutzer peter@peisser.com als Admin anlegen/markieren (einmalig, idempotent).
insert into public.profiles (id, email, name, role)
select id, email, 'Peter Peißer', 'admin' from auth.users where email = 'peter@peisser.com'
on conflict (id) do update set role = 'admin', name = coalesce(public.profiles.name, excluded.name);

-- ---------- AKP-Kontakte (Ansprechpartner beim Fachhändler) ----------

create table if not exists public.akp_contacts (
  nr               text primary key,
  fh_nr            text not null default '',
  vorname          text,
  nachname         text,
  firma            text,
  strasse          text,
  plz              text,
  ort              text,
  telefon          text,
  email            text,
  geburtsdatum     date,
  aktionsteilnahme boolean,
  profi_training   smallint check (profi_training is null or profi_training between 1 and 3),
  -- Monatsproduktion als offene Kalender-Map "YYYY-MM" -> Verträge, damit
  -- künftige Monate bei jeder täglichen Einspielung einfach ergänzt werden
  -- können, ohne das Schema zu ändern.
  prod_monthly     jsonb not null default '{}'::jsonb,
  -- Produktion in Monaten, in denen die Person bei einem ANDEREN (frueheren)
  -- Fachhaendler produziert hat, nicht beim aktuell hinterlegten (fh_nr).
  -- Wird separat/farblich im Popup angezeigt, zaehlt aber in der Gesamtsumme mit.
  prod_monthly_other jsonb not null default '{}'::jsonb,
  updated_at       timestamptz not null default now(),
  updated_by       uuid references auth.users(id)
);

alter table public.akp_contacts add column if not exists prod_monthly_other jsonb not null default '{}'::jsonb;

alter table public.akp_contacts enable row level security;

-- Kontaktdaten sind Team-Arbeitswerkzeug: jeder eingeloggte Nutzer (jede Rolle)
-- darf lesen und pflegen, analog zu dashboard_kv.
create policy "Authenticated read akp_contacts"
  on public.akp_contacts for select
  to authenticated
  using (true);

create policy "Authenticated insert akp_contacts"
  on public.akp_contacts for insert
  to authenticated
  with check (true);

create policy "Authenticated update akp_contacts"
  on public.akp_contacts for update
  to authenticated
  using (true)
  with check (true);

create index if not exists akp_contacts_nr_idx on public.akp_contacts (nr);

-- Wird bei jeder täglichen Excel-Einspielung aufgerufen (siehe syncAkpContacts
-- in index.html): legt neue AKP an (Name best-effort aus der Einspielliste
-- gesplittet) und hält bei bereits bekannten AKP zumindest Fachhändler/Firma/
-- Ort sowie die Monatsproduktion aktuell (Kontaktdaten/Vorname/Nachname aus
-- der Stammliste bzw. manuellen Bearbeitung bleiben dabei unangetastet).
create or replace function public.akp_sync_daily(rows jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  r jsonb; nm text; vn text; nn text; sp int; mval int; mkey text; monthjson jsonb;
begin
  for r in select * from jsonb_array_elements(rows) loop
    if coalesce(r->>'nr','') = '' then continue; end if;
    nm := nullif(trim(r->>'nm'), '');
    vn := null; nn := null;
    if nm is not null then
      sp := position(' ' in nm);
      if sp > 0 then vn := left(nm, sp-1); nn := substring(nm from sp+1);
      else vn := nm; end if;
    end if;
    mkey := r->>'mk';
    mval := coalesce((r->>'mv')::int, 0);
    monthjson := case when mkey is not null and mval <> 0 then jsonb_build_object(mkey, mval) else '{}'::jsonb end;

    insert into public.akp_contacts (nr, fh_nr, vorname, nachname, firma, ort, prod_monthly)
    values (r->>'nr', coalesce(r->>'fh',''), vn, nn, r->>'fi', r->>'or', monthjson)
    on conflict (nr) do update set
      fh_nr = excluded.fh_nr,
      firma = coalesce(excluded.firma, akp_contacts.firma),
      ort = coalesce(excluded.ort, akp_contacts.ort),
      prod_monthly = coalesce(akp_contacts.prod_monthly,'{}'::jsonb) || excluded.prod_monthly,
      updated_at = now();
  end loop;
end;
$$;

revoke execute on function public.akp_sync_daily(jsonb) from public;
grant execute on function public.akp_sync_daily(jsonb) to authenticated;
