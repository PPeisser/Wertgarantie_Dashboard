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

-- PO-Quote und 3-fuer-2-Quote gab es bisher nur als EIN aktueller LJ-Snapshot
-- (state.latest.akp[].poQuote/.q3fuer2 aus dem Tagesimport), keine Historie wie
-- bei prod_monthly. Seit Migration akp_contacts_quota_monthly_snapshots wird
-- pro Kalendermonat der zuletzt bekannte Stand mitgeschrieben.
--
-- WICHTIG - andere Semantik als prod_monthly: prod_monthly[YYYY-MM] ist eine
-- additive, bereits kumulierte Monats-STUECKZAHL (jeder Import ueberschreibt
-- den Schluessel, am Monatsende steht der Endwert). poquote_monthly[YYYY-MM] /
-- q3fuer2_monthly[YYYY-MM] sind dagegen Verhaeltniszahlen (Jahres-kumulativer
-- Anteil, als Bruch z.B. 0.483 = 48,3%) - "Summe eines Monats" ist dafuer
-- bedeutungslos. Hier gilt: der ZULETZT BEKANNTE WERT innerhalb dieses
-- Kalendermonats (jeder Import ueberschreibt den Schluessel des laufenden
-- Monats; am Monatsende bleibt der Stand per Monatsultimo stehen). Ein
-- "Monatswert" ist also ein Stand zum Monatsende, KEIN Monatsanteil -
-- rueckwirkend nicht verfuegbar, waechst erst ab jetzt.
alter table public.akp_contacts add column if not exists poquote_monthly jsonb not null default '{}'::jsonb;
alter table public.akp_contacts add column if not exists q3fuer2_monthly jsonb not null default '{}'::jsonb;

-- Stornoquoten je AKP (02.09.2026, "Vermittlerübersicht mit Stornoquoten",
-- siehe parseAkpStornoquoten in index.html) - EIN aktueller Snapshot, keine
-- Historie (wie poquote_monthly), da die Quelldatei selbst bereits ein
-- kumuliertes "laufendes Jahr bis Vormonat"-Stand ist. Werte als Bruch
-- (nicht ×100). NICHT vertraulich - im Gegensatz zu fh_deckungsgrad für
-- alle authentifizierten Nutzer über die bestehenden akp_contacts-Policies
-- lesbar (siehe unten), da diese Quoten laut Nutzervorgabe für alle
-- Mitarbeiter sichtbar sein sollen. Nur 3 der 4 Quoten aus der Quelldatei
-- werden gespeichert (1) Widerruf, 2) Nichtzahlung Erstprämie, 4) Wegfall
-- versichertes Interesse) - Quote 3) "Kulanz/Wegfall (erste 6 Monate)" wird
-- im Dashboard nicht angezeigt.
alter table public.akp_contacts add column if not exists storno_widerruf_quote numeric;
alter table public.akp_contacts add column if not exists storno_erstpraemie_quote numeric;
alter table public.akp_contacts add column if not exists storno_wegfall_quote numeric;
alter table public.akp_contacts add column if not exists storno_quoten_updated_at timestamptz;

-- Service-Training (02.09.2026): eigenes Feld getrennt von profi_training,
-- da ein AKP theoretisch BEIDE Programme abgeschlossen haben kann (Profi-
-- Training UND Service-Training sind unterschiedliche Trainingsreihen laut
-- Nutzervorgabe) - ein gemeinsames Feld würde eines der beiden verdecken.
-- Nur 2 Stufen (kein "erledigt"/"500" wie bei profi_training).
alter table public.akp_contacts add column if not exists service_training text
  check (service_training is null or service_training in ('1','2'));

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
  poval numeric; f2val numeric; pojson jsonb; f2json jsonb;
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
    -- po/f2: zuletzt bekannter Stand des Kalendermonats, siehe Spaltenkommentar
    -- oben - kein Additions-/Ist-0-Filter wie bei mval, da 0 ein gueltiger
    -- Quotenwert ist (nur explizites null im Import ueberspringen).
    poval := nullif(r->>'po','')::numeric;
    f2val := nullif(r->>'f2','')::numeric;
    pojson := case when mkey is not null and poval is not null then jsonb_build_object(mkey, poval) else '{}'::jsonb end;
    f2json := case when mkey is not null and f2val is not null then jsonb_build_object(mkey, f2val) else '{}'::jsonb end;

    insert into public.akp_contacts (nr, fh_nr, vorname, nachname, firma, ort, prod_monthly, poquote_monthly, q3fuer2_monthly)
    values (r->>'nr', coalesce(r->>'fh',''), vn, nn, r->>'fi', r->>'or', monthjson, pojson, f2json)
    on conflict (nr) do update set
      fh_nr = excluded.fh_nr,
      firma = coalesce(excluded.firma, akp_contacts.firma),
      ort = coalesce(excluded.ort, akp_contacts.ort),
      prod_monthly = coalesce(akp_contacts.prod_monthly,'{}'::jsonb) || excluded.prod_monthly,
      poquote_monthly = coalesce(akp_contacts.poquote_monthly,'{}'::jsonb) || excluded.poquote_monthly,
      q3fuer2_monthly = coalesce(akp_contacts.q3fuer2_monthly,'{}'::jsonb) || excluded.q3fuer2_monthly,
      updated_at = now();
  end loop;
end;
$$;

revoke execute on function public.akp_sync_daily(jsonb) from public;
grant execute on function public.akp_sync_daily(jsonb) to authenticated;

-- Bulk-Import der "Profi Training"-Teilnehmerliste (Blatt "Liste zum
-- Abgleich", siehe parseProfiTraining in index.html): ergänzt profi_training/
-- service_training NUR bei bereits vorhandenen AKP (kein Insert für
-- unbekannte AKP-Nr, Nutzervorgabe 02.09.2026 - "nur bei den Vorhandenen
-- ergänzen") - "not found" nach dem select bricht die Zeile einfach ab.
--
-- Downgrade-Schutz (Nutzervorgabe 02.09.2026): ein bereits gesetzter, laut
-- rank_of HÖHERER Stand wird nie durch einen niedrigeren aus der Liste
-- ersetzt (z.B. Stufe 3 bleibt Stufe 3, auch wenn die aktuelle Liste nur
-- eine erfolgreiche Stufe 1 zeigt). Der Sonderwert "500" (500-Verträge-
-- Meilenstein, fachlich unabhängig vom Training) wird NIE überschrieben.
create or replace function public.akp_profi_training_upsert(rows jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  r jsonb;
  new_pt text; new_st text;
  cur_pt text; cur_st text;
  rank_of jsonb := '{"1":1,"2":2,"3":3,"erledigt":4,"500":5}'::jsonb;
begin
  for r in select * from jsonb_array_elements(rows) loop
    if coalesce(r->>'nr','') = '' then continue; end if;
    new_pt := nullif(r->>'profi_training','');
    new_st := nullif(r->>'service_training','');

    select profi_training, service_training into cur_pt, cur_st
      from public.akp_contacts where nr = r->>'nr';
    if not found then continue; end if;

    update public.akp_contacts set
      profi_training = case
        when new_pt is null then profi_training
        when cur_pt = '500' then profi_training
        when cur_pt is null then new_pt
        when coalesce((rank_of->>new_pt)::int,0) > coalesce((rank_of->>cur_pt)::int,0) then new_pt
        else profi_training
      end,
      service_training = case
        when new_st is null then service_training
        when cur_st is null then new_st
        when new_st::int > cur_st::int then new_st
        else service_training
      end,
      updated_at = now()
    where nr = r->>'nr';
  end loop;
end;
$$;

revoke execute on function public.akp_profi_training_upsert(jsonb) from public;
grant execute on function public.akp_profi_training_upsert(jsonb) to authenticated;

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
  -- Feste Segmentierung A+/A/B/C+/C/D (Händlerpotenzial). segmentierung_prev
  -- ist der zuletzt bekannte VORMONATSwert, segmentierung_month der
  -- Kalendermonat ("YYYY-MM"), für den "segmentierung" aktuell gilt - beide
  -- werden ausschließlich von der RPC fh_segmentierung_upsert gepflegt
  -- (siehe unten), Basis für den Trendpfeil im FH-PopUp (fhSegmentTrend).
  segmentierung    text check (segmentierung is null or segmentierung in ('A+','A','B','C+','C','D')),
  segmentierung_prev text check (segmentierung_prev is null or segmentierung_prev in ('A+','A','B','C+','C','D')),
  segmentierung_month text,
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

-- Vormonats-Trendpfeil für die Händlersegmentierung im FH-PopUp (Nutzervorgabe
-- 04.09.2026): zusätzlich zum aktuellen Wert (segmentierung) wird der zuletzt
-- bekannte Vormonatswert (segmentierung_prev) sowie der Monat, für den der
-- aktuelle Wert gilt (segmentierung_month, "YYYY-MM"), mitgeführt.
alter table public.fh_contacts add column if not exists segmentierung_prev text;
alter table public.fh_contacts add column if not exists segmentierung_month text;

alter table public.fh_contacts drop constraint if exists fh_contacts_segmentierung_prev_check;
alter table public.fh_contacts add constraint fh_contacts_segmentierung_prev_check
  check (segmentierung_prev is null or segmentierung_prev in ('A+','A','B','C+','C','D'));

-- Schreibt die monatliche Händlersegmentierungs-Datei (Admin-Upload oder
-- automatischer Mail-Import, siehe parseFhSegmentierung/upsertFhSegmentierung)
-- je Fachhändler fest. Beim ERSTEN Import eines neuen Kalendermonats
-- (erkannt an segmentierung_month vs. dem aktuellen Monat, server-seitig via
-- now() statt Client-Uhrzeit) wird der bisherige Wert nach segmentierung_prev
-- verschoben - das ist die Basis für den Trendpfeil (fhSegmentTrend im
-- Client). Ein erneuter Import INNERHALB desselben Monats (z.B. eine
-- Korrektur) überschreibt segmentierung_prev NICHT nochmal, sonst würde der
-- "Vormonat" bei mehreren Importen im selben Monat verlorengehen.
create or replace function public.fh_segmentierung_upsert(rows jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  r jsonb; fhnr text; newseg text; curmonth text;
  oldseg text; oldmonth text; oldprev text; newprev text;
begin
  curmonth := to_char(now(), 'YYYY-MM');
  for r in select * from jsonb_array_elements(rows) loop
    fhnr := r->>'fh_nr';
    if coalesce(fhnr,'') = '' then continue; end if;
    newseg := nullif(r->>'segmentierung','');

    select segmentierung, segmentierung_month, segmentierung_prev
      into oldseg, oldmonth, oldprev
      from public.fh_contacts where fh_nr = fhnr;

    if oldmonth is distinct from curmonth then
      newprev := oldseg;
    else
      newprev := oldprev;
    end if;

    insert into public.fh_contacts (fh_nr, segmentierung, segmentierung_prev, segmentierung_month)
    values (fhnr, newseg, newprev, curmonth)
    on conflict (fh_nr) do update set
      segmentierung = excluded.segmentierung,
      segmentierung_prev = excluded.segmentierung_prev,
      segmentierung_month = excluded.segmentierung_month,
      updated_at = now();
  end loop;
end;
$$;

revoke execute on function public.fh_segmentierung_upsert(jsonb) from public;
grant execute on function public.fh_segmentierung_upsert(jsonb) to authenticated;

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

-- ==========================================================================
-- Mitarbeiterstammdaten (Punkt 10, 01.09.2026): ersetzt die frueher
-- hartcodierten Konstanten EMPLOYEES/PERS_JAHRESZIELE/PERS_MIETEZIELE/
-- AKQ_STAFFEL_ZIEL/PERF_GOALS_BY_EMPLOYEE im Client. Neue Mitarbeiter
-- (inkl. Zielwerten) werden ab jetzt ueber das Admin-Panel angelegt statt
-- per Code-Deployment. Wird einmalig pro Session via loadEmployees() im
-- Client geladen, vor dem ersten Rendern.
create table if not exists public.employees (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  pers_jahresziel numeric not null default 0,
  miete_jahresziel numeric,
  akq_staffel_ziel numeric not null default 0,
  perf_goal_ids jsonb not null default '[1,2,3]'::jsonb,
  match_aliases text[] not null default '{}',
  admin_only boolean not null default false,
  active boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on column public.employees.name is
  'Kanonischer Anzeigename. Wird auch als Matching-Ziel in EMP_NORM registriert (siehe matchEmployee() im Client) - der Tagesreport-Rohtext muss exakt oder ueber match_aliases hierauf normalisieren.';
comment on column public.employees.match_aliases is
  'Alternative/rohe Schreibweisen aus dem Tagesreport fuer matchEmployee()-Matching. Wird u.a. genutzt, um die admin-only Analyse-Eintraege ("Technischer GL", "ohne Zuordnung") auf ihre rohen GL-Label-Texte im Tagesreport zu matchen, sodass Region_nach_GL/FH_Liste/Sparten/AKQ-Parsing diese automatisch unter dem virtuellen Mitarbeiternamen ablegen - keine Sonderbehandlung an anderer Stelle im Code noetig.';
comment on column public.employees.admin_only is
  'true = nur im Admin-Dropdown waehlbar (virtuelle Analyse-Mitarbeiter wie "Technischer GL"/"ohne Zuordnung"), nicht Teil der normalen EMPLOYEES-Liste/Benachrichtigungen/Ranking.';
comment on column public.employees.active is
  'Soft-Delete-Flag. Historische Daten (snap.gl/snap.fh/state.dailyGL) haengen am Namen - deshalb bewusst kein Hard-Delete im Standardfall.';
comment on column public.employees.perf_goal_ids is
  'Welche der 5 Performance-Dialog-Ziele gelten (siehe PERF_GOALS_BY_EMPLOYEE/PERF_GOAL_TITLES im Client). Ziele 4/5 (PO-Quote Telekom, Gebrauchtgeraete-Quote) sind aktuell Dominik-Szendi-spezifische Sondervertriebs-Snapshot-Berechnungen - ein neuer Mitarbeiter mit diesen Zielen braucht weiterhin Code-Anpassung.';

alter table public.employees enable row level security;

-- Jeder eingeloggte Nutzer braucht die Liste (Dropdown, Ranking, Ziel-
-- Kacheln, Matching) - analog profiles. Schreiben nur Admin, bewusst NICHT
-- wie fh_contacts/akp_contacts (dort duerfen alle pflegen): Mitarbeiter-
-- Zielwerte sind sensibler und laut Nutzervorgabe exklusiv ueber das
-- Admin-UI zu verwalten.
create policy "Authenticated read employees" on public.employees
  for select to authenticated using (true);
create policy "Admins can insert employees" on public.employees
  for insert to authenticated with check (public.is_admin());
create policy "Admins can update employees" on public.employees
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "Admins can delete employees" on public.employees
  for delete to authenticated using (public.is_admin());

create index if not exists employees_active_idx on public.employees (active, sort_order);

-- Seed: bestehende 6 Mitarbeiter 1:1 aus den bisherigen Code-Konstanten.
insert into public.employees (name, pers_jahresziel, miete_jahresziel, akq_staffel_ziel, perf_goal_ids, sort_order) values
  ('Klaus Witting',20000,750,30,'[1,2,3]','1'),
  ('Florian Hasibeder',15000,750,30,'[1,2,3]','2'),
  ('Dominik Szendi',55000,null,0,'[1,4,5]','3'),
  ('Helmut Otto',7000,750,30,'[1,2,3]','4'),
  ('Peter Peißer',7000,750,30,'[1,2,3]','5'),
  ('Thomas Eitzinger',15000,null,0,'[1]','6')
on conflict (name) do nothing;

-- Punkt 9: virtuelle, admin-only Analyse-Eintraege. match_aliases = exakter
-- GL-Rohtext aus dem Tagesreport, damit matchEmployee() sie automatisch auf
-- diesen Mitarbeiternamen matcht.
insert into public.employees (name, admin_only, match_aliases, sort_order) values
  ('Technischer GL', true, '{"Technischer GL CE DE"}', 100),
  ('ohne Zuordnung', true, '{}', 101)
on conflict (name) do nothing;

-- ==========================================================================
-- Deckungsgrad-Auswertung (01.09.2026): absolut vertrauliche Finanzdaten je
-- Fachhaendler aus einer separaten Excel-Datei ("DG2_Bericht_AT.xlsx",
-- Spalten u.a. FH Nr/Bestand/Provision/Schaeden/DB1/DG1/DB2/DG2 je LJ/VJ).
-- Bestand/Provision/Schaeden duerfen als Zahl angezeigt werden, DG1/DG2/DB1/
-- DB2 NIEMALS im Klartext - auch nicht an Admins (Nutzervorgabe). Deshalb
-- bewusst KEINE select-Policy auf der Rohdatentabelle - der einzige
-- Lesezugriff laeuft ueber die security-definer-Funktion
-- fh_deckungsgrad_for() weiter unten, die ausschliesslich abgeleitete
-- Ampel-/Tendenz-Werte und die unkritischen Felder zurueckgibt. Kein KI-/
-- Anthropic-Bezug irgendwo in dieser Kette (Nutzervorgabe: diese Daten
-- duerfen nie ueber "das Internet/KI" verteilt werden). Trend (besser/
-- schlechter/gleich zum Vorjahr) kommt direkt aus den VJ-Spalten derselben
-- Einspielung - keine eigene Zeithistorie noetig, die Quelldatei liefert LJ
-- und VJ bereits nebeneinander.
create table if not exists public.fh_deckungsgrad (
  fh_nr text primary key,
  bestand numeric,
  provision_lj numeric,
  schaeden_lj integer,
  schadenbetrag_lj numeric,
  db1_lj numeric,
  dg1_lj numeric,
  db2_lj numeric,
  dg2_lj numeric,
  db1_vj numeric,
  dg1_vj numeric,
  db2_vj numeric,
  dg2_vj numeric,
  imported_at timestamptz not null default now(),
  imported_by uuid references auth.users(id)
);

alter table public.fh_deckungsgrad enable row level security;

-- Schreiben (Import) nur durch Admin. Bewusst KEINE select-Policy fuer
-- irgendeine Rolle -> RLS verweigert jeden direkten Lesezugriff, auch fuer
-- Admin. Der einzige Weg an die Daten ist die untenstehende Funktion.
create policy "Admins can insert fh_deckungsgrad" on public.fh_deckungsgrad
  for insert to authenticated with check (public.is_admin());
create policy "Admins can update fh_deckungsgrad" on public.fh_deckungsgrad
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- DG-Ampel: rot bis 10 %, gelb bis 30 %, gruen ab 30 % (identische Schwellen
-- fuer DG1 und DG2, Nutzervorgabe). DB-Ampel (absolute Euro-Betraege,
-- Haendlergroessen extrem unterschiedlich): Perzentil-Rang unter allen
-- Haendlern dieser Einspielung - rot = unteres Drittel, gelb = mittleres
-- Drittel, gruen = oberes Drittel. Tendenz DG: Differenz LJ-VJ in
-- Prozentpunkten, +/-0,5pp Totzone als "gleich". Tendenz DB: relative
-- Veraenderung LJ-VJ, +/-5% Totzone.
create or replace function public.fh_deckungsgrad_for(p_fh_nr text)
returns table (
  fh_nr text,
  bestand numeric,
  provision_lj numeric,
  schaeden_lj integer,
  schadenbetrag_lj numeric,
  dg1_ampel text,
  dg1_trend text,
  dg2_ampel text,
  dg2_trend text,
  db1_ampel text,
  db1_trend text,
  db2_ampel text,
  db2_trend text,
  imported_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  with ranked as (
    select
      d.*,
      percent_rank() over (order by d.db1_lj) as db1_rank,
      percent_rank() over (order by d.db2_lj) as db2_rank
    from public.fh_deckungsgrad d
  )
  select
    r.fh_nr,
    r.bestand,
    r.provision_lj,
    r.schaeden_lj,
    r.schadenbetrag_lj,
    case when r.dg1_lj is null then null when r.dg1_lj < 0.10 then 'rot' when r.dg1_lj < 0.30 then 'gelb' else 'gruen' end as dg1_ampel,
    case when r.dg1_lj is null or r.dg1_vj is null then null
         when r.dg1_lj - r.dg1_vj > 0.005 then 'besser'
         when r.dg1_vj - r.dg1_lj > 0.005 then 'schlechter'
         else 'gleich' end as dg1_trend,
    case when r.dg2_lj is null then null when r.dg2_lj < 0.10 then 'rot' when r.dg2_lj < 0.30 then 'gelb' else 'gruen' end as dg2_ampel,
    case when r.dg2_lj is null or r.dg2_vj is null then null
         when r.dg2_lj - r.dg2_vj > 0.005 then 'besser'
         when r.dg2_vj - r.dg2_lj > 0.005 then 'schlechter'
         else 'gleich' end as dg2_trend,
    case when r.db1_lj is null then null when r.db1_rank < 0.333 then 'rot' when r.db1_rank < 0.667 then 'gelb' else 'gruen' end as db1_ampel,
    case when r.db1_lj is null or r.db1_vj is null or r.db1_vj = 0 then null
         when (r.db1_lj - r.db1_vj) / abs(r.db1_vj) > 0.05 then 'besser'
         when (r.db1_vj - r.db1_lj) / abs(r.db1_vj) > 0.05 then 'schlechter'
         else 'gleich' end as db1_trend,
    case when r.db2_lj is null then null when r.db2_rank < 0.333 then 'rot' when r.db2_rank < 0.667 then 'gelb' else 'gruen' end as db2_ampel,
    case when r.db2_lj is null or r.db2_vj is null or r.db2_vj = 0 then null
         when (r.db2_lj - r.db2_vj) / abs(r.db2_vj) > 0.05 then 'besser'
         when (r.db2_vj - r.db2_lj) / abs(r.db2_vj) > 0.05 then 'schlechter'
         else 'gleich' end as db2_trend,
    r.imported_at
  from ranked r
  where r.fh_nr = p_fh_nr;
$$;

revoke execute on function public.fh_deckungsgrad_for(text) from public;
grant execute on function public.fh_deckungsgrad_for(text) to authenticated;

-- Root Cause (02.09.2026, real-world reproduziert): fh_deckungsgrad hat
-- bewusst KEINE select-Policy fuer irgendeine Rolle (siehe Tabellenkommentar
-- oben - selbst Admins duerfen die Rohwerte nie im Klartext sehen). Ein
-- direkter Client-seitiger .upsert() ueber PostgREST verlangt aber implizit
-- eine RETURNING-Klausel (representation), was OHNE Select-Policy IMMER mit
-- "new row violates row-level security policy" fehlschlaegt - bestaetigt per
-- SQL-Test: dieselbe INSERT-Anweisung MIT "returning" schlaegt fehl, OHNE
-- "returning" gelingt sie, mit exakt derselben Fehlermeldung wie in den
-- echten Supabase-Logs (POST 403) - unabhaengig davon, ob der aufrufende
-- Account tatsaechlich Admin ist (is_admin() wurde separat verifiziert: true).
--
-- Fix nach demselben Muster wie fh_sync_daily/fh_sync_miete/akp_sync_daily:
-- security-definer RPC-Funktion, die serverseitig upsert't und dabei NIE
-- Daten zurueckgibt (returns void) - dadurch wird die RETURNING-Klausel nie
-- ausgeloest und die fehlende Select-Policy bleibt unangetastet (weiterhin
-- niemand kann die Rohwerte lesen). Da dieser Import (anders als die anderen
-- sync-Funktionen) admin-only sein soll, wird is_admin() explizit im
-- Funktionskoerper geprueft (grant execute geht an alle authenticated, da
-- Postgres EXECUTE nicht rollenspezifisch feiner granular ist).
create or replace function public.fh_deckungsgrad_upsert(rows jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  r jsonb;
begin
  if not public.is_admin() then
    raise exception 'Nur für Admins';
  end if;
  for r in select * from jsonb_array_elements(rows) loop
    if coalesce(r->>'fh_nr','') = '' then continue; end if;
    insert into public.fh_deckungsgrad (
      fh_nr, bestand, provision_lj, schaeden_lj, schadenbetrag_lj,
      db1_lj, dg1_lj, db2_lj, dg2_lj, db1_vj, dg1_vj, db2_vj, dg2_vj,
      imported_by, imported_at
    ) values (
      r->>'fh_nr',
      (r->>'bestand')::numeric,
      (r->>'provision_lj')::numeric,
      (r->>'schaeden_lj')::integer,
      (r->>'schadenbetrag_lj')::numeric,
      (r->>'db1_lj')::numeric, (r->>'dg1_lj')::numeric,
      (r->>'db2_lj')::numeric, (r->>'dg2_lj')::numeric,
      (r->>'db1_vj')::numeric, (r->>'dg1_vj')::numeric,
      (r->>'db2_vj')::numeric, (r->>'dg2_vj')::numeric,
      auth.uid(), now()
    )
    on conflict (fh_nr) do update set
      bestand = excluded.bestand,
      provision_lj = excluded.provision_lj,
      schaeden_lj = excluded.schaeden_lj,
      schadenbetrag_lj = excluded.schadenbetrag_lj,
      db1_lj = excluded.db1_lj, dg1_lj = excluded.dg1_lj,
      db2_lj = excluded.db2_lj, dg2_lj = excluded.dg2_lj,
      db1_vj = excluded.db1_vj, dg1_vj = excluded.dg1_vj,
      db2_vj = excluded.db2_vj, dg2_vj = excluded.dg2_vj,
      imported_by = excluded.imported_by, imported_at = excluded.imported_at;
  end loop;
end;
$$;

revoke execute on function public.fh_deckungsgrad_upsert(jsonb) from public;
grant execute on function public.fh_deckungsgrad_upsert(jsonb) to authenticated;
