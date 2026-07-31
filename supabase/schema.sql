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
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text,
  role       text not null default 'aussendienst' check (role in ('admin','aussendienst')),
  created_at timestamptz not null default now()
);

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

-- Legt bei jeder Neuregistrierung automatisch ein Profil mit Standardrolle "aussendienst" an.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, role)
  values (new.id, new.email, 'aussendienst');
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Bestehenden Nutzer peter@peisser.com als Admin anlegen/markieren (einmalig, idempotent).
insert into public.profiles (id, email, role)
select id, email, 'admin' from auth.users where email = 'peter@peisser.com'
on conflict (id) do update set role = 'admin';
