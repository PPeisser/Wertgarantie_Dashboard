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
