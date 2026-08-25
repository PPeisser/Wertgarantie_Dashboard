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
  role                 text not null default 'aussendienst' check (role in ('admin','aussendienst','trainer')),
  must_change_password boolean not null default false,
  created_at           timestamptz not null default now()
);

alter table public.profiles add column if not exists name text;
alter table public.profiles add column if not exists must_change_password boolean not null default false;
-- Rolle "Trainer" (wie Außendienst, aber ohne Zugriff auf den Performance
-- Dialog - steuert der Client, siehe index.html).
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (role in ('admin','aussendienst','trainer'));

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
  -- '1'/'2'/'3' = Trainingsstufe, 'erledigt' = abgeschlossen, '500' = 500-Verträge-Meilenstein.
  profi_training   text check (profi_training is null or profi_training in ('1','2','3','erledigt','500')),
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

-- ---------- Fachhändler-Zusatzdaten (Adresse, Kontakt, Ansprechpartner, Segmentierung, Besuch, Notizen) ----------

create table if not exists public.fh_contacts (
  fh_nr            text primary key,
  strasse          text,
  plz              text,
  ort              text,
  telefon          text,
  email            text, -- "E-Mail Geschäft"
  ansprechpartner  text,
  ansprechpartner_email text, -- getrennt von der geschäftlichen E-Mail-Adresse
  homepage         text,
  -- Feste Segmentierung A+/A/B/C+/C/D (Händlerpotenzial).
  segmentierung    text check (segmentierung is null or segmentierung in ('A+','A','B','C+','C','D')),
  letzter_besuch   date,
  sonstige_infos   text,
  -- Monatsproduktion je Fachhändler (analog zu akp_contacts.prod_monthly),
  -- "YYYY-MM" -> Verträge. Wird über einen Bulk-Import befüllt; bis dahin
  -- ergänzt der Client die Ansicht clientseitig aus der Tages-Historie.
  prod_monthly     jsonb not null default '{}'::jsonb,
  -- Manuell oder automatisch (alte Händler ohne aktuellen Akquise-Beginn,
  -- bzw. 5+ Termine oder 20+ Verträge im laufenden Jahr) gesetzter Status:
  -- Händler ist mit dem 9-Wochen-Plan durch. Einmal gesetzt, "rastet" der
  -- Status dauerhaft ein (kein automatisches Zurücksetzen).
  neunwochen_erledigt boolean not null default false,
  -- Jährliche "davon beitragsfrei"-Summe (aus dem Bulk-Import, nicht in der
  -- täglichen Auswertung enthalten) - "YYYY" -> Anzahl. Jeder beitragsfreie
  -- Vertrag entspricht einer 3-für-2-Aktion; die Quote wird clientseitig aus
  -- prod_monthly (Jahressumme) und diesem Wert berechnet.
  beitragsfrei_yearly jsonb not null default '{}'::jsonb,
  updated_at       timestamptz not null default now(),
  updated_by       uuid references auth.users(id)
);

alter table public.fh_contacts add column if not exists prod_monthly jsonb not null default '{}'::jsonb;
alter table public.fh_contacts add column if not exists neunwochen_erledigt boolean not null default false;
alter table public.fh_contacts add column if not exists beitragsfrei_yearly jsonb not null default '{}'::jsonb;
-- Akquisestaffeln: lebenslang-kumulative Punkte (nicht jährlich zurückgesetzt)
-- und je der 7 fixen Stufen (20/50/100/150/200/250/300) das Erreichungsdatum
-- als "MM/JJ"-String (null = noch nicht erreicht). Wird per Admin-Import aus
-- der monatlichen Akquisestaffeln-Datei komplett überschrieben (Snapshot).
alter table public.fh_contacts add column if not exists akq_punkte numeric;
alter table public.fh_contacts add column if not exists akq_staffeln jsonb not null default '[]'::jsonb;
-- Mitarbeiter-Zuordnung laut Akquisestaffel-Datei selbst (Spalte "GL
-- aktuell", in der Praxis Spalte H) - Quelle der Wahrheit für "AKQ ohne
-- Zuordnung" (siehe renderObs in index.html), unabhängig von der
-- GL-Zuordnung aus der täglichen FH_Liste-Auswertung.
alter table public.fh_contacts add column if not exists akq_gl text;
-- Firmenname laut Akquisestaffel-Datei (Spalte "FH Bez (ohne Nr)") - Fallback
-- für "AKQ ohne Zuordnung" (siehe renderObs in index.html), falls der
-- Händler in der aktuellen täglichen FH_Liste-Auswertung keine Zeile hat
-- (z.B. keine Tagesproduktion) und dort daher kein Name verfügbar ist.
alter table public.fh_contacts add column if not exists akq_name text;
-- Manueller Namens-Fallback (FH-PopUp, Nutzervorgabe 25.08.2026): fuer
-- Haendler, die WEDER in der taeglichen FH_Liste-Einspielung, NOCH als
-- AKP-Kontakt mit Firma, NOCH in der Akquisestaffeln-Datei (akq_name) einen
-- Namen haben, zeigten Miete-PopUp/FH-PopUp bis dahin nur die rohe FH-Nr.
-- an, da nirgends in der DB ein Firmenname hinterlegt war. Rein manuelles
-- Feld (ueberschreibt NICHT die automatischen Quellen, greift nur, wenn alle
-- anderen fehlen) - siehe fhFallbackFromAkp() in index.html.
alter table public.fh_contacts add column if not exists name text;
-- Miete-Report (Club Weiß, MSK_Report-Datei, Admin-Import): club_weiss_mitglied
-- wird beim Import IMMER auf true gesetzt (jeder FH in der Datei ist Mitglied),
-- aber nie automatisch wieder zurückgesetzt (siehe fh_sync_miete) - manuelles
-- Zurücksetzen bleibt im FH-PopUp weiterhin möglich. miete_monthly ("YYYY-MM"
-- -> Vertragsanzahl) und miete_sortiment (Sortiment-Name -> Anzahl) werden per
-- JSONB-Merge aktualisiert, ältere Monate/Sortimente bleiben bei einem neuen
-- Import erhalten, auch wenn die neue Datei sie nicht mehr enthält.
alter table public.fh_contacts add column if not exists club_weiss_mitglied boolean not null default false;
alter table public.fh_contacts add column if not exists club_weiss_mitgliedsnummer text;
alter table public.fh_contacts add column if not exists miete_monthly jsonb not null default '{}'::jsonb;
alter table public.fh_contacts add column if not exists miete_sortiment jsonb not null default '{}'::jsonb;
-- Firmenname direkt aus dem Miete-Report (Freitagsreport, Spalte "FH Bez
-- (ohne Nr)", Nutzer-Bestaetigung 25.08.2026) - deckt Haendler ab, die in
-- keiner anderen Quelle (taegliche FH_Liste, AKP, Akquisestaffeln) einen
-- Namen haben, automatisch bei jedem Miete-Import statt manueller Eingabe.
-- Eigene Spalte (nicht die manuelle fh_contacts.name), damit ein Import den
-- manuell im FH-PopUp eingetragenen Namen nie stillschweigend ueberschreibt.
alter table public.fh_contacts add column if not exists miete_name text;

-- Kooperation (Einkaufsverbindung) und Hauptzweig je Fachhändler (Nutzer-
-- vorgabe 23.08.2026). Kooperation ist bewusst freier Text (kein CHECK),
-- da künftige Kooperationslisten ohne Migration ergänzt werden können - die
-- feste Auswahl im Dropdown lebt im Client (index.html, KOOPERATION_OPTIONS).
-- Hauptzweig ist dagegen eine bewusst feste, kleine Liste.
alter table public.fh_contacts add column if not exists kooperation text;
alter table public.fh_contacts add column if not exists hauptzweig text;
-- "Weitere Zuordnung" (Nutzervorgabe 23.08.2026) - optionales, per Haken
-- aktivierbares Zusatzfeld. Bewusst freier Text ohne CHECK: der Client baut
-- das Dropdown aus den bereits verwendeten DISTINCT-Werten dieser Spalte
-- (+ dem fixen Basiswert "A1 Shop") - ein neuer Freitext-Wert wird dadurch
-- automatisch zur Dropdown-Option für alle anderen Händler.
alter table public.fh_contacts add column if not exists weitere_zuordnung text;
-- "Filialbetriebe" (Nutzervorgabe 25.08.2026, umbenannt aus dem
-- ursprünglichen zweiten "Weitere Zuordnung"-Slot, live per "alter table ...
-- rename column" migriert): fasst FH zusammen, die zur selben
-- Filialkette/demselben Betrieb gehören. Eigener, unabhängiger Options-Pool
-- (NICHT der Weitere-Zuordnung-Pool), da der Wert hier direkt
-- Gruppenzugehörigkeit für den Filial-Umschalter + das Filialgruppen-PopUp
-- im FH-PopUp steuert (siehe loadFilialbetriebeOptions()/
-- renderFhFilialbetriebeSwitcher()/openFilialGruppeModal() im Client).
alter table public.fh_contacts add column if not exists filialbetriebe text;

-- Jahres-Ziel/Plan je Fachhändler in Stk. (Nutzervorgabe 24.08.2026) - kommt
-- primär aus der täglichen FH_Liste (Spalte "Plan"), ist aber auch manuell in
-- den Stammdaten editierbar. Abweichungen zwischen Einspielung und
-- gespeichertem Wert werden NICHT automatisch übernommen, sondern wie bei
-- PLZ/Ort über den Stammdaten-Diff-Workflow bestätigt (siehe fhStammdatenDiff
-- im Client). Nur sichtbar, wenn im Admin-Panel freigeschaltet
-- (dashboard_kv-Key "fh_ziel_enabled") UND für den jeweiligen FH gesetzt.
alter table public.fh_contacts add column if not exists ziel numeric;

alter table public.fh_contacts drop constraint if exists fh_contacts_segmentierung_check;
alter table public.fh_contacts add constraint fh_contacts_segmentierung_check
  check (segmentierung is null or segmentierung in ('A+','A','B','C+','C','D'));

alter table public.fh_contacts drop constraint if exists fh_contacts_hauptzweig_check;
alter table public.fh_contacts add constraint fh_contacts_hauptzweig_check
  check (hauptzweig is null or hauptzweig in (
    'Vollsortiment','Mobilfunk','IT','Kundendienst','Industrie','Akustik',
    'Optik','Küchenhandel','Uhrenhandel','Grüne Ware','Makler','Projekt','Sonstiges'
  ));

alter table public.fh_contacts enable row level security;

-- Team-Arbeitswerkzeug wie akp_contacts: jede Rolle darf lesen und pflegen.
create policy "Authenticated read fh_contacts"
  on public.fh_contacts for select
  to authenticated
  using (true);

create policy "Authenticated insert fh_contacts"
  on public.fh_contacts for insert
  to authenticated
  with check (true);

create policy "Authenticated update fh_contacts"
  on public.fh_contacts for update
  to authenticated
  using (true)
  with check (true);

-- Für FH, die aus einer Kooperationsliste bekannt sind, aber noch keine
-- fh_contacts-Zeile haben (siehe Kooperations-Bulk-Import 23.08.2026) -
-- sobald der Händler über die tägliche Einspielung (fh_sync_daily) zum
-- ersten Mal angelegt wird, bekommt er die hinterlegte Kooperation
-- automatisch mit. Einmalig "konsumiert" (Zeile wird danach gelöscht).
create table if not exists public.fh_kooperation_pending (
  fh_nr        text primary key,
  kooperation  text not null,
  created_at   timestamptz not null default now()
);

alter table public.fh_kooperation_pending enable row level security;

create policy "Authenticated read fh_kooperation_pending"
  on public.fh_kooperation_pending for select
  to authenticated
  using (true);

create policy "Authenticated insert fh_kooperation_pending"
  on public.fh_kooperation_pending for insert
  to authenticated
  with check (true);

create policy "Authenticated delete fh_kooperation_pending"
  on public.fh_kooperation_pending for delete
  to authenticated
  using (true);

-- Hält fh_contacts.prod_monthly bei jeder täglichen Einspielung aktuell
-- (analog zu akp_sync_daily) - schreibt den laufenden Monat mit dem
-- kumulierten Monatswert aus der FH-Liste fest. Erkennt außerdem, ob eine
-- Zeile NEU angelegt wird (statt eines Updates auf einen bereits bekannten
-- Händler) und übernimmt in dem Fall eine vorgemerkte Kooperation aus
-- fh_kooperation_pending, falls vorhanden.
create or replace function public.fh_sync_daily(rows jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  r jsonb; mval int; mkey text; monthjson jsonb; fhnr text;
  is_new boolean; pending_koop text;
begin
  for r in select * from jsonb_array_elements(rows) loop
    fhnr := r->>'nr';
    if coalesce(fhnr,'') = '' then continue; end if;
    mkey := r->>'mk';
    mval := coalesce((r->>'mv')::int, 0);
    monthjson := case when mkey is not null and mval <> 0 then jsonb_build_object(mkey, mval) else '{}'::jsonb end;

    is_new := not exists (select 1 from public.fh_contacts where fh_nr = fhnr);

    insert into public.fh_contacts (fh_nr, prod_monthly)
    values (fhnr, monthjson)
    on conflict (fh_nr) do update set
      prod_monthly = coalesce(fh_contacts.prod_monthly,'{}'::jsonb) || excluded.prod_monthly,
      updated_at = now();

    if is_new then
      select kooperation into pending_koop from public.fh_kooperation_pending where fh_nr = fhnr;
      if pending_koop is not null then
        update public.fh_contacts set kooperation = pending_koop where fh_nr = fhnr;
        delete from public.fh_kooperation_pending where fh_nr = fhnr;
      end if;
    end if;
  end loop;
end;
$$;

revoke execute on function public.fh_sync_daily(jsonb) from public;
grant execute on function public.fh_sync_daily(jsonb) to authenticated;

-- Schreibt Miete-Report-Daten (Club Weiß) je Fachhändler: monatliche
-- Vertragsanzahl und Sortiments-Aufstellung werden per JSONB-Merge auf den
-- bestehenden Stand aufgesetzt (analog fh_sync_daily) - ein erneuter Import
-- überschreibt nur die im neuen Report enthaltenen Monate/Sortimente, ältere
-- bleiben erhalten. club_weiss_mitglied wird beim Import IMMER auf true
-- gesetzt (jeder FH in der Datei ist Mitglied), aber nie automatisch wieder
-- auf false zurückgesetzt - ein manuelles Zurücksetzen bleibt im FH-PopUp
-- weiterhin möglich (Stammdaten-Bearbeiten-Formular).
create or replace function public.fh_sync_miete(rows jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  r jsonb; monthlyj jsonb; sortimentj jsonb; clubnr text; mietename text;
begin
  for r in select * from jsonb_array_elements(rows) loop
    if coalesce(r->>'fh_nr','') = '' then continue; end if;
    monthlyj := coalesce(r->'monthly','{}'::jsonb);
    sortimentj := coalesce(r->'sortiment','{}'::jsonb);
    clubnr := r->>'club_nr';
    mietename := nullif(r->>'name','');

    insert into public.fh_contacts (fh_nr, miete_monthly, miete_sortiment, club_weiss_mitglied, club_weiss_mitgliedsnummer, miete_name)
    values (r->>'fh_nr', monthlyj, sortimentj, true, clubnr, mietename)
    on conflict (fh_nr) do update set
      miete_monthly = coalesce(fh_contacts.miete_monthly,'{}'::jsonb) || excluded.miete_monthly,
      miete_sortiment = coalesce(fh_contacts.miete_sortiment,'{}'::jsonb) || excluded.miete_sortiment,
      club_weiss_mitglied = true,
      club_weiss_mitgliedsnummer = coalesce(excluded.club_weiss_mitgliedsnummer, fh_contacts.club_weiss_mitgliedsnummer),
      miete_name = coalesce(excluded.miete_name, fh_contacts.miete_name),
      updated_at = now();
  end loop;
end;
$$;

revoke execute on function public.fh_sync_miete(jsonb) from public;
grant execute on function public.fh_sync_miete(jsonb) to authenticated;

-- Pro-Nutzer-Einstellungen (Passwort-Bereich separat über auth.updateUser,
-- hier nur Benachrichtigungs-Präferenzen). Anders als alle bisherigen
-- Tabellen NICHT team-weit lesbar - jeder Nutzer sieht/ändert nur seine
-- eigene Zeile (auth.uid() = user_id).
create table if not exists public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  notif_akp_enabled boolean not null default false,
  notif_akp_days integer not null default 30,
  notif_fh_enabled boolean not null default false,
  notif_fh_days integer not null default 30,
  notif_scope text not null default 'own',
  updated_at timestamptz not null default now()
);

-- "own" (eigener, zuordenbarer Mitarbeiterbereich), "all" (Österreich
-- gesamt) oder - v.a. für Admins ohne eigenen Vertriebsbereich - ein
-- konkreter Mitarbeitername (frei wählbar im Einstellungen-PopUp).
alter table public.user_settings drop constraint if exists user_settings_scope_check;
alter table public.user_settings add constraint user_settings_scope_check
  check (notif_scope in ('own','all','Klaus Witting','Florian Hasibeder','Dominik Szendi','Helmut Otto','Peter Peißer','Thomas Eitzinger'));

alter table public.user_settings drop constraint if exists user_settings_akp_days_check;
alter table public.user_settings add constraint user_settings_akp_days_check
  check (notif_akp_days in (30,60,90));

alter table public.user_settings drop constraint if exists user_settings_fh_days_check;
alter table public.user_settings add constraint user_settings_fh_days_check
  check (notif_fh_days in (30,60,90));

alter table public.user_settings enable row level security;

drop policy if exists "Users read own settings" on public.user_settings;
create policy "Users read own settings"
  on public.user_settings for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users insert own settings" on public.user_settings;
create policy "Users insert own settings"
  on public.user_settings for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "Users update own settings" on public.user_settings;
create policy "Users update own settings"
  on public.user_settings for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Automatischer Excel-Mail-Import (input@wgaustria.at, siehe README) - die
-- Edge Function dashboard-mail-poller legt hier pro gefundenem Excel-Anhang
-- eine Zeile an; das Parsen selbst passiert weiterhin clientseitig
-- (processPendingImports in index.html, wiederverwendet parseAuswertung).
create table if not exists public.pending_imports (
  id uuid primary key default gen_random_uuid(),
  filename text not null,
  storage_path text not null,
  status text not null default 'pending',
  source_subject text,
  source_from text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  error text
);

-- "processing" ist der kurze Zwischenstatus, den processPendingImports()
-- beim optimistischen "Claimen" einer Zeile setzt (verhindert doppelte
-- Verarbeitung durch zwei gleichzeitig offene Tabs) - fehlte ursprünglich in
-- der Constraint, wodurch jeder Import-Versuch mit HTTP 400 fehlschlug.
alter table public.pending_imports drop constraint if exists pending_imports_status_check;
alter table public.pending_imports add constraint pending_imports_status_check
  check (status in ('pending','processing','processed','failed'));

alter table public.pending_imports enable row level security;

drop policy if exists "Authenticated read pending_imports" on public.pending_imports;
create policy "Authenticated read pending_imports"
  on public.pending_imports for select
  to authenticated
  using (true);

drop policy if exists "Authenticated update pending_imports" on public.pending_imports;
create policy "Authenticated update pending_imports"
  on public.pending_imports for update
  to authenticated
  using (true)
  with check (true);

insert into storage.buckets (id, name, public)
values ('mail-imports', 'mail-imports', false)
on conflict (id) do nothing;

drop policy if exists "Authenticated read mail-imports" on storage.objects;
create policy "Authenticated read mail-imports"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'mail-imports');

-- pg_cron-Job: ruft die Edge Function dashboard-mail-poller alle 15 Minuten
-- auf. <CRON_SECRET> durch denselben Wert ersetzen, der auch als
-- Edge-Function-Secret CRON_SECRET hinterlegt ist (siehe README).
-- timeout_milliseconds bewusst hoch (der pg_net-Default von 5s reicht nicht -
-- IMAP-Abruf + Literal-Transfer eines echten Anhangs dauert real eher
-- 10-20s, siehe Testlauf 14.08.2026).
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'dashboard-mail-poll',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := '<SUPABASE_PROJECT_URL>/functions/v1/dashboard-mail-poller',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<CRON_SECRET>'),
    body := jsonb_build_object('trigger','cron'),
    timeout_milliseconds := 55000
  );
  $$
);

-- ---------- Performance Dialog (monatlicher Zielgespräch-Bericht je Mitarbeiter) ----------

-- Monatlicher Performance-Dialog je Mitarbeiter: ein Bericht pro
-- Mitarbeiter/Jahr/Monat (Monat = der berichtete Vormonat, nicht der
-- Einreichungsmonat). "goals" speichert je zutreffendem Ziel sowohl den
-- Auswertungs-Snapshot (Zahlen zum Zeitpunkt der Abgabe - bewusst
-- eingefroren, damit der Bericht ein fixer historischer Datensatz bleibt
-- und sich nicht rückwirkend ändert, wenn sich die Statistik später
-- weiterentwickelt) als auch die vier Freitextantworten.
-- is_draft=true + submitted_at=null: Zwischenstand, den der Mitarbeiter noch
-- nicht abgeschickt hat (Autosave nach jedem Wizard-Schritt) - wird NICHT
-- als PDF versendet und zaehlt in Admin-Uebersicht/Erinnerungsmails/
-- Jahresbericht nicht als abgegeben. Erst der finale "Abschliessen und
-- absenden"-Klick setzt is_draft=false + submitted_at.
create table if not exists public.performance_dialog_reports (
  id           uuid primary key default gen_random_uuid(),
  employee     text not null,
  year         int not null,
  month        int not null check (month between 1 and 12),
  goals        jsonb not null default '[]'::jsonb,
  is_draft     boolean not null default false,
  submitted_at timestamptz,
  submitted_by uuid references auth.users(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (employee, year, month)
);

alter table public.performance_dialog_reports enable row level security;

-- Persönliche Reflexionsantworten (u.a. "Wo brauche ich Unterstützung") sind
-- sensibler als reine Produktionszahlen - anders als bei den team-weit
-- lesbaren Tabellen (fh_contacts, akp_contacts) darf hier jeder Mitarbeiter
-- nur seinen eigenen Bericht sehen/schreiben, Admin sieht/schreibt alle
-- (für die Admin-Übersicht + Sammel-PDF). Trainer hat KEINEN Sonderzugriff
-- (steuert der Client über das Fehlen des Performance-Dialog-Buttons, aber
-- RLS blockt zusätzlich serverseitig).
create policy "Own or admin read performance_dialog_reports"
  on public.performance_dialog_reports for select
  to authenticated
  using (
    public.is_admin()
    or employee = (select name from public.profiles where id = auth.uid())
  );

create policy "Own or admin insert performance_dialog_reports"
  on public.performance_dialog_reports for insert
  to authenticated
  with check (
    public.is_admin()
    or employee = (select name from public.profiles where id = auth.uid())
  );

create policy "Own or admin update performance_dialog_reports"
  on public.performance_dialog_reports for update
  to authenticated
  using (
    public.is_admin()
    or employee = (select name from public.profiles where id = auth.uid())
  )
  with check (
    public.is_admin()
    or employee = (select name from public.profiles where id = auth.uid())
  );

-- Nur Admin darf Berichte löschen (Performance Dialog – ADMIN PopUp,
-- "Zurücksetzen"-Button je Mitarbeiter) - ein Mitarbeiter darf seinen
-- eigenen abgegebenen Bericht nicht selbst wieder entfernen.
create policy "Admin delete performance_dialog_reports"
  on public.performance_dialog_reports for delete
  to authenticated
  using (public.is_admin());

create index if not exists performance_dialog_reports_employee_idx
  on public.performance_dialog_reports (employee, year, month);

-- pg_cron-Job: ruft die Edge Function performance-dialog-reminder täglich um
-- 07:00 Uhr auf (UTC - Deno.env-getriebene Datumslogik in der Function
-- selbst entscheidet Freitag/15. anhand der Europe/Vienna-Zeitzone).
-- <CRON_SECRET> durch denselben Wert wie oben ersetzen.
select cron.schedule(
  'performance-dialog-reminder-daily',
  '0 6 * * *',
  $$
  select net.http_post(
    url := '<SUPABASE_PROJECT_URL>/functions/v1/performance-dialog-reminder',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<CRON_SECRET>'),
    body := jsonb_build_object('trigger','cron'),
    timeout_milliseconds := 55000
  );
  $$
);
