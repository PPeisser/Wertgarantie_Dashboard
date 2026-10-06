-- ============================================================
-- Wertgarantie Performance Dashboard - vollständiger Schema-Dump
-- ============================================================
-- Supabase-Projekt: gfyjftwlombhmwirbyse (Region: siehe Supabase Dashboard
-- -> Project Settings -> General). Erzeugt am 06.10.2026 per manueller
-- pg_catalog/information_schema-Introspektion (kein pg_dump-Zugriff
-- verfügbar), zum Zweck einer vollständigen Grundgerüst-Sicherung, mit der
-- das Backend bei Bedarf auf einem anderen Host/Projekt neu aufgebaut
-- werden kann. Ersetzt die vorherige, veraltete schema.sql-Referenz.
--
-- Reihenfolge wichtig: Tabellen -> Constraints/Indizes -> RLS -> Funktionen/
-- Trigger -> Extensions -> Storage -> pg_cron. Enthält NICHT: Daten (siehe
-- docs/REHOSTING.md für den Hinweis auf separaten Daten-Export), Secrets
-- (NIE im Repo - siehe docs/REHOSTING.md für die Liste der benötigten
-- Secret-NAMEN), den auth.users-Trigger "on_auth_user_created" (liegt auf
-- schema "auth", siehe Kommentar bei den Triggern unten).
--
-- WICHTIG: Die pg_cron-Jobs ganz unten enthalten PLATZHALTER statt echter
-- Secret-Werte (<CRON_SECRET>, <CRON_SECRET_EVENT_MAILER>, <PROJECT_REF>) -
-- diese NIEMALS durch echte Werte ersetzt committen.

-- ============================================================
-- SECTION 1: TABLES (columns only, constraints/indexes folgen)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.akp_contacts (
  nr text NOT NULL,
  fh_nr text NOT NULL DEFAULT ''::text,
  vorname text,
  nachname text,
  firma text,
  strasse text,
  plz text,
  ort text,
  telefon text,
  email text,
  geburtsdatum date,
  aktionsteilnahme boolean,
  prod_monthly jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_by uuid,
  prod_monthly_other jsonb NOT NULL DEFAULT '{}'::jsonb,
  poquote_monthly jsonb NOT NULL DEFAULT '{}'::jsonb,
  q3fuer2_monthly jsonb NOT NULL DEFAULT '{}'::jsonb,
  gesperrt_am timestamp with time zone,
  storno_widerruf_quote numeric,
  storno_erstpraemie_quote numeric,
  storno_wegfall_quote numeric,
  storno_quoten_updated_at timestamp with time zone,
  training_status text,
  training_status_by_year jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS public.akquise_geo (
  fh_nr text NOT NULL,
  lat double precision,
  lng double precision,
  genauigkeit text,
  address_key text,
  geocoded_at timestamp with time zone,
  sparte text,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_by uuid
);

CREATE TABLE IF NOT EXISTS public.akquise_place_status (
  place_id text NOT NULL,
  status text NOT NULL,
  notiz text,
  sparte text,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_by uuid
);

CREATE TABLE IF NOT EXISTS public.auswertung_subscription_sends (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  is_endstand boolean NOT NULL DEFAULT false,
  sent_at timestamp with time zone NOT NULL DEFAULT now(),
  storage_path text NOT NULL,
  filename text NOT NULL,
  customer_email_sent boolean NOT NULL DEFAULT false,
  employee_email_sent boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.auswertung_subscriptions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  auswertung_typ text NOT NULL,
  entity_key text NOT NULL,
  "interval" text NOT NULL,
  fixed_range_enabled boolean NOT NULL DEFAULT false,
  range_start date,
  range_end date,
  include_vj boolean NOT NULL DEFAULT false,
  include_vvj boolean NOT NULL DEFAULT false,
  show_akp boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  endstand_sent_at timestamp with time zone,
  created_by uuid,
  created_by_name text,
  created_by_email text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  recipient_emails text[] NOT NULL DEFAULT '{}'::text[],
  send_to_employee boolean NOT NULL DEFAULT true,
  send_to_external boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS public.dashboard_kv (
  key text NOT NULL,
  value text NOT NULL,
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.email_recipients (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  email text NOT NULL,
  frequency text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.employees (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  pers_jahresziel numeric NOT NULL DEFAULT 0,
  miete_jahresziel numeric,
  akq_staffel_ziel numeric NOT NULL DEFAULT 0,
  perf_goal_ids jsonb NOT NULL DEFAULT '[1, 2, 3]'::jsonb,
  match_aliases text[] NOT NULL DEFAULT '{}'::text[],
  admin_only boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.event_dates (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL,
  event_date date NOT NULL,
  start_time time without time zone NOT NULL,
  end_time time without time zone,
  location text NOT NULL DEFAULT ''::text,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.event_form_fields (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL,
  field_key text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  required boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  label text
);

CREATE TABLE IF NOT EXISTS public.events (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  title text NOT NULL DEFAULT 'Wertgarantie Veranstaltung'::text,
  description text NOT NULL DEFAULT ''::text,
  is_active boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  privacy_text text NOT NULL DEFAULT ''::text,
  photo_url text
);

CREATE TABLE IF NOT EXISTS public.fh_contacts (
  fh_nr text NOT NULL,
  strasse text,
  plz text,
  ort text,
  telefon text,
  email text,
  ansprechpartner text,
  homepage text,
  segmentierung text,
  letzter_besuch date,
  sonstige_infos text,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_by uuid,
  prod_monthly jsonb NOT NULL DEFAULT '{}'::jsonb,
  neunwochen_erledigt boolean NOT NULL DEFAULT false,
  beitragsfrei_yearly jsonb NOT NULL DEFAULT '{}'::jsonb,
  akq_punkte numeric,
  akq_staffeln jsonb NOT NULL DEFAULT '[]'::jsonb,
  akq_gl text,
  akq_name text,
  ansprechpartner_email text,
  club_weiss_mitglied boolean NOT NULL DEFAULT false,
  club_weiss_mitgliedsnummer text,
  miete_monthly jsonb NOT NULL DEFAULT '{}'::jsonb,
  miete_sortiment jsonb NOT NULL DEFAULT '{}'::jsonb,
  kooperation text,
  hauptzweig text,
  weitere_zuordnung text,
  ziel numeric,
  filialbetriebe text,
  name text,
  miete_name text,
  gesperrt_am timestamp with time zone,
  segmentierung_prev text,
  segmentierung_month text
);

CREATE TABLE IF NOT EXISTS public.fh_deckungsgrad (
  fh_nr text NOT NULL,
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
  imported_at timestamp with time zone NOT NULL DEFAULT now(),
  imported_by uuid
);

CREATE TABLE IF NOT EXISTS public.fh_duplicate_merges (
  alias_fh_nr text NOT NULL,
  canonical_fh_nr text NOT NULL,
  note text,
  created_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.fh_kooperation_pending (
  fh_nr text NOT NULL,
  kooperation text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.filialgruppen_contacts (
  filialbetriebe text NOT NULL,
  zentral_telefon text,
  zentral_email text,
  updated_by uuid,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  strasse text,
  plz text,
  ort text,
  ansprechpartner_liste jsonb NOT NULL DEFAULT '[]'::jsonb
);

CREATE TABLE IF NOT EXISTS public.import_log (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  imported_at timestamp with time zone,
  type text NOT NULL,
  filename text,
  vortag date,
  source text NOT NULL DEFAULT 'upload'::text,
  imported_by text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.pending_imports (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  filename text NOT NULL,
  storage_path text NOT NULL,
  status text NOT NULL DEFAULT 'pending'::text,
  source_subject text,
  source_from text,
  received_at timestamp with time zone NOT NULL DEFAULT now(),
  processed_at timestamp with time zone,
  error text,
  claimed_at timestamp with time zone
);

CREATE TABLE IF NOT EXISTS public.performance_dialog_reports (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  employee text NOT NULL,
  year integer NOT NULL,
  month integer NOT NULL,
  goals jsonb NOT NULL DEFAULT '[]'::jsonb,
  submitted_at timestamp with time zone,
  submitted_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  is_draft boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS public.profiles (
  id uuid NOT NULL,
  email text,
  role text NOT NULL DEFAULT 'aussendienst'::text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  name text,
  must_change_password boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS public.registrations (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL,
  event_date_id uuid NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  email text,
  consent_at timestamp with time zone NOT NULL DEFAULT now(),
  confirmation_sent_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.trainerbesuche (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  fh_nr text NOT NULL,
  trainer_name text NOT NULL,
  besuch_datum date NOT NULL,
  taetigkeiten text,
  akp_teilnehmer jsonb NOT NULL DEFAULT '[]'::jsonb,
  baseline_avg numeric,
  nachher_avg numeric,
  endbericht_sent_at timestamp with time zone,
  created_by uuid,
  updated_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  trainingsart jsonb NOT NULL DEFAULT '[]'::jsonb
);

CREATE TABLE IF NOT EXISTS public.trainerbetreuung_weekly_reports (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  trainer_name text NOT NULL,
  sent_at timestamp with time zone NOT NULL DEFAULT now(),
  period_reference date NOT NULL,
  storage_path text NOT NULL,
  filename text NOT NULL,
  visit_count integer NOT NULL DEFAULT 0,
  trainer_email_sent boolean NOT NULL DEFAULT false,
  admin_email_sent boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.user_settings (
  user_id uuid NOT NULL,
  notif_akp_enabled boolean NOT NULL DEFAULT false,
  notif_akp_days integer NOT NULL DEFAULT 30,
  notif_fh_enabled boolean NOT NULL DEFAULT false,
  notif_fh_days integer NOT NULL DEFAULT 30,
  notif_scope text NOT NULL DEFAULT 'own'::text,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  notif_trainerbetreuung_frequency text NOT NULL DEFAULT 'weekly'::text
);

-- ============================================================
-- SECTION 2: CONSTRAINTS (PK/UNIQUE/CHECK/FK)
-- ============================================================

ALTER TABLE ONLY public.akp_contacts ADD CONSTRAINT akp_contacts_pkey PRIMARY KEY (nr);
ALTER TABLE ONLY public.akp_contacts ADD CONSTRAINT akp_contacts_training_status_check CHECK (((training_status IS NULL) OR (training_status = ANY (ARRAY['verkauf1'::text, 'verkauf2'::text, 'verkauf3'::text, 'service1'::text, 'service2'::text, 'abgeschlossen'::text, 'teilgenommen'::text, '500'::text]))));
ALTER TABLE ONLY public.akp_contacts ADD CONSTRAINT akp_contacts_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth.users(id);
ALTER TABLE ONLY public.akquise_geo ADD CONSTRAINT akquise_geo_genauigkeit_check CHECK (((genauigkeit IS NULL) OR (genauigkeit = ANY (ARRAY['adresse'::text, 'ort'::text, 'fehler'::text]))));
ALTER TABLE ONLY public.akquise_geo ADD CONSTRAINT akquise_geo_pkey PRIMARY KEY (fh_nr);
ALTER TABLE ONLY public.akquise_geo ADD CONSTRAINT akquise_geo_sparte_check CHECK (((sparte IS NULL) OR (sparte = ANY (ARRAY['elektrohandel'::text, 'elektroservice'::text, 'mobilfunk'::text, 'hoerakustik'::text, 'optiker'::text, 'kuechen'::text, 'uhren'::text]))));
ALTER TABLE ONLY public.akquise_place_status ADD CONSTRAINT akquise_place_status_pkey PRIMARY KEY (place_id);
ALTER TABLE ONLY public.akquise_place_status ADD CONSTRAINT akquise_place_status_status_check CHECK ((status = ANY (ARRAY['offen'::text, 'kontaktiert'::text, 'termin'::text, 'kein_interesse'::text, 'angelegt'::text])));
ALTER TABLE ONLY public.auswertung_subscription_sends ADD CONSTRAINT auswertung_subscription_sends_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.auswertung_subscription_sends ADD CONSTRAINT auswertung_subscription_sends_subscription_id_fkey FOREIGN KEY (subscription_id) REFERENCES auswertung_subscriptions(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.auswertung_subscriptions ADD CONSTRAINT auswertung_subscriptions_auswertung_typ_check CHECK ((auswertung_typ = ANY (ARRAY['kooperation'::text, 'weitere_zuordnung'::text, 'filialbetriebe'::text, 'fachhaendler'::text, 'akp'::text])));
ALTER TABLE ONLY public.auswertung_subscriptions ADD CONSTRAINT auswertung_subscriptions_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);
ALTER TABLE ONLY public.auswertung_subscriptions ADD CONSTRAINT auswertung_subscriptions_interval_check CHECK (("interval" = ANY (ARRAY['daily'::text, 'weekly'::text, 'monthly'::text, 'quarterly'::text, 'yearly'::text])));
ALTER TABLE ONLY public.auswertung_subscriptions ADD CONSTRAINT auswertung_subscriptions_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.auswertung_subscriptions ADD CONSTRAINT auswertung_subscriptions_range_chk CHECK (((NOT fixed_range_enabled) OR ((range_start IS NOT NULL) AND (range_end IS NOT NULL) AND (range_end >= range_start))));
ALTER TABLE ONLY public.auswertung_subscriptions ADD CONSTRAINT auswertung_subscriptions_recipients_chk CHECK (((NOT send_to_external) OR (array_length(recipient_emails, 1) > 0)));
ALTER TABLE ONLY public.dashboard_kv ADD CONSTRAINT dashboard_kv_pkey PRIMARY KEY (key);
ALTER TABLE ONLY public.email_recipients ADD CONSTRAINT email_recipients_email_frequency_key UNIQUE (email, frequency);
ALTER TABLE ONLY public.email_recipients ADD CONSTRAINT email_recipients_frequency_check CHECK ((frequency = ANY (ARRAY['daily'::text, 'weekly'::text])));
ALTER TABLE ONLY public.email_recipients ADD CONSTRAINT email_recipients_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.employees ADD CONSTRAINT employees_name_key UNIQUE (name);
ALTER TABLE ONLY public.employees ADD CONSTRAINT employees_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.event_dates ADD CONSTRAINT event_dates_event_id_fkey FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.event_dates ADD CONSTRAINT event_dates_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.event_form_fields ADD CONSTRAINT event_form_fields_event_id_field_key_key UNIQUE (event_id, field_key);
ALTER TABLE ONLY public.event_form_fields ADD CONSTRAINT event_form_fields_event_id_fkey FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.event_form_fields ADD CONSTRAINT event_form_fields_field_key_check CHECK ((field_key = ANY (ARRAY['vorname'::text, 'nachname'::text, 'plz'::text, 'ort'::text, 'geburtsdatum'::text, 'akp_nummer'::text, 'fh_nummer'::text, 'fachhaendler'::text, 'telefon'::text, 'email'::text, 'anreise_auto'::text, 'bemerkungen'::text])));
ALTER TABLE ONLY public.event_form_fields ADD CONSTRAINT event_form_fields_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.events ADD CONSTRAINT events_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.fh_contacts ADD CONSTRAINT fh_contacts_hauptzweig_check CHECK (((hauptzweig IS NULL) OR (hauptzweig = ANY (ARRAY['Vollsortiment'::text, 'Mobilfunk'::text, 'IT'::text, 'Kundendienst'::text, 'Industrie'::text, 'Akustik'::text, 'Optik'::text, 'Küchenhandel'::text, 'Uhrenhandel'::text, 'Grüne Ware'::text, 'Makler'::text, 'Projekt'::text, 'Sonstiges'::text]))));
ALTER TABLE ONLY public.fh_contacts ADD CONSTRAINT fh_contacts_pkey PRIMARY KEY (fh_nr);
ALTER TABLE ONLY public.fh_contacts ADD CONSTRAINT fh_contacts_segmentierung_check CHECK (((segmentierung IS NULL) OR (segmentierung = ANY (ARRAY['A+'::text, 'A'::text, 'B'::text, 'C+'::text, 'C'::text, 'D'::text]))));
ALTER TABLE ONLY public.fh_contacts ADD CONSTRAINT fh_contacts_segmentierung_prev_check CHECK (((segmentierung_prev IS NULL) OR (segmentierung_prev = ANY (ARRAY['A+'::text, 'A'::text, 'B'::text, 'C+'::text, 'C'::text, 'D'::text]))));
ALTER TABLE ONLY public.fh_contacts ADD CONSTRAINT fh_contacts_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth.users(id);
ALTER TABLE ONLY public.fh_deckungsgrad ADD CONSTRAINT fh_deckungsgrad_imported_by_fkey FOREIGN KEY (imported_by) REFERENCES auth.users(id);
ALTER TABLE ONLY public.fh_deckungsgrad ADD CONSTRAINT fh_deckungsgrad_pkey PRIMARY KEY (fh_nr);
ALTER TABLE ONLY public.fh_duplicate_merges ADD CONSTRAINT fh_duplicate_merges_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);
ALTER TABLE ONLY public.fh_duplicate_merges ADD CONSTRAINT fh_duplicate_merges_not_self CHECK ((alias_fh_nr <> canonical_fh_nr));
ALTER TABLE ONLY public.fh_duplicate_merges ADD CONSTRAINT fh_duplicate_merges_pkey PRIMARY KEY (alias_fh_nr);
ALTER TABLE ONLY public.fh_kooperation_pending ADD CONSTRAINT fh_kooperation_pending_pkey PRIMARY KEY (fh_nr);
ALTER TABLE ONLY public.filialgruppen_contacts ADD CONSTRAINT filialgruppen_contacts_pkey PRIMARY KEY (filialbetriebe);
ALTER TABLE ONLY public.filialgruppen_contacts ADD CONSTRAINT filialgruppen_contacts_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth.users(id);
ALTER TABLE ONLY public.import_log ADD CONSTRAINT import_log_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.import_log ADD CONSTRAINT import_log_source_check CHECK ((source = ANY (ARRAY['upload'::text, 'mail'::text, 'backfill'::text])));
ALTER TABLE ONLY public.pending_imports ADD CONSTRAINT pending_imports_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.pending_imports ADD CONSTRAINT pending_imports_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'processed'::text, 'failed'::text])));
ALTER TABLE ONLY public.performance_dialog_reports ADD CONSTRAINT performance_dialog_reports_employee_year_month_key UNIQUE (employee, year, month);
ALTER TABLE ONLY public.performance_dialog_reports ADD CONSTRAINT performance_dialog_reports_month_check CHECK (((month >= 1) AND (month <= 12)));
ALTER TABLE ONLY public.performance_dialog_reports ADD CONSTRAINT performance_dialog_reports_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.performance_dialog_reports ADD CONSTRAINT performance_dialog_reports_submitted_by_fkey FOREIGN KEY (submitted_by) REFERENCES auth.users(id);
ALTER TABLE ONLY public.profiles ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.profiles ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.profiles ADD CONSTRAINT profiles_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'aussendienst'::text, 'trainer'::text])));
ALTER TABLE ONLY public.registrations ADD CONSTRAINT registrations_event_date_id_fkey FOREIGN KEY (event_date_id) REFERENCES event_dates(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.registrations ADD CONSTRAINT registrations_event_id_fkey FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.registrations ADD CONSTRAINT registrations_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.trainerbesuche ADD CONSTRAINT trainerbesuche_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);
ALTER TABLE ONLY public.trainerbesuche ADD CONSTRAINT trainerbesuche_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.trainerbesuche ADD CONSTRAINT trainerbesuche_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth.users(id);
ALTER TABLE ONLY public.trainerbetreuung_weekly_reports ADD CONSTRAINT trainerbetreuung_weekly_reports_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.user_settings ADD CONSTRAINT user_settings_akp_days_check CHECK ((notif_akp_days = ANY (ARRAY[30, 60, 90])));
ALTER TABLE ONLY public.user_settings ADD CONSTRAINT user_settings_fh_days_check CHECK ((notif_fh_days = ANY (ARRAY[30, 60, 90])));
ALTER TABLE ONLY public.user_settings ADD CONSTRAINT user_settings_pkey PRIMARY KEY (user_id);
ALTER TABLE ONLY public.user_settings ADD CONSTRAINT user_settings_scope_check CHECK ((notif_scope = ANY (ARRAY['own'::text, 'all'::text, 'Klaus Witting'::text, 'Florian Hasibeder'::text, 'Dominik Szendi'::text, 'Helmut Otto'::text, 'Peter Peißer'::text, 'Thomas Eitzinger'::text])));
ALTER TABLE ONLY public.user_settings ADD CONSTRAINT user_settings_tb_freq_check CHECK ((notif_trainerbetreuung_frequency = ANY (ARRAY['never'::text, 'weekly'::text, 'monthly'::text])));
ALTER TABLE ONLY public.user_settings ADD CONSTRAINT user_settings_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

-- ============================================================
-- SECTION 3: INDIZES (ohne die bereits durch Constraints oben
-- impliziten PK/UNIQUE-Indizes)
-- ============================================================

CREATE INDEX akp_contacts_updated_by_idx ON public.akp_contacts USING btree (updated_by);
CREATE INDEX auswertung_subscription_sends_sub_idx ON public.auswertung_subscription_sends USING btree (subscription_id, period_end DESC);
CREATE UNIQUE INDEX auswertung_subscription_sends_unique_period ON public.auswertung_subscription_sends USING btree (subscription_id, period_end, is_endstand);
CREATE INDEX auswertung_subscriptions_active_idx ON public.auswertung_subscriptions USING btree (active) WHERE active;
CREATE INDEX auswertung_subscriptions_created_by_idx ON public.auswertung_subscriptions USING btree (created_by);
CREATE INDEX auswertung_subscriptions_entity_idx ON public.auswertung_subscriptions USING btree (auswertung_typ, entity_key);
CREATE INDEX employees_active_idx ON public.employees USING btree (active, sort_order);
CREATE INDEX event_dates_event_idx ON public.event_dates USING btree (event_id, sort_order);
CREATE UNIQUE INDEX events_single_active_idx ON public.events USING btree ((true)) WHERE is_active;
CREATE INDEX fh_contacts_updated_by_idx ON public.fh_contacts USING btree (updated_by);
CREATE INDEX fh_deckungsgrad_imported_by_idx ON public.fh_deckungsgrad USING btree (imported_by);
CREATE INDEX fh_duplicate_merges_canonical_idx ON public.fh_duplicate_merges USING btree (canonical_fh_nr);
CREATE INDEX fh_duplicate_merges_created_by_idx ON public.fh_duplicate_merges USING btree (created_by);
CREATE INDEX filialgruppen_contacts_updated_by_idx ON public.filialgruppen_contacts USING btree (updated_by);
CREATE INDEX import_log_imported_at_idx ON public.import_log USING btree (imported_at DESC NULLS LAST);
CREATE INDEX performance_dialog_reports_employee_idx ON public.performance_dialog_reports USING btree (employee, year, month);
CREATE INDEX performance_dialog_reports_submitted_by_idx ON public.performance_dialog_reports USING btree (submitted_by);
CREATE INDEX registrations_event_date_id_idx ON public.registrations USING btree (event_date_id);
CREATE INDEX registrations_event_idx ON public.registrations USING btree (event_id, event_date_id);
CREATE INDEX trainerbesuche_created_by_idx ON public.trainerbesuche USING btree (created_by);
CREATE INDEX trainerbesuche_endbericht_pending_idx ON public.trainerbesuche USING btree (besuch_datum) WHERE (endbericht_sent_at IS NULL);
CREATE INDEX trainerbesuche_fh_nr_idx ON public.trainerbesuche USING btree (fh_nr, besuch_datum DESC);
CREATE INDEX trainerbesuche_trainer_idx ON public.trainerbesuche USING btree (trainer_name, besuch_datum DESC);
CREATE INDEX trainerbesuche_updated_by_idx ON public.trainerbesuche USING btree (updated_by);
CREATE INDEX trainerbetreuung_weekly_reports_sent_at_idx ON public.trainerbetreuung_weekly_reports USING btree (sent_at DESC);

-- ============================================================
-- SECTION 4: ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE public.akp_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.akquise_geo ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.akquise_place_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auswertung_subscription_sends ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auswertung_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dashboard_kv ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_dates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_form_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fh_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fh_deckungsgrad ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fh_duplicate_merges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fh_kooperation_pending ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.filialgruppen_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.import_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pending_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.performance_dialog_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.registrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trainerbesuche ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trainerbetreuung_weekly_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated insert akp_contacts" ON public.akp_contacts FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated read akp_contacts" ON public.akp_contacts FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated update akp_contacts" ON public.akp_contacts FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated insert akquise_geo" ON public.akquise_geo FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated read akquise_geo" ON public.akquise_geo FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated update akquise_geo" ON public.akquise_geo FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated all akquise_place_status" ON public.akquise_place_status FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated all auswertung_subscription_sends" ON public.auswertung_subscription_sends FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated all auswertung_subscriptions" ON public.auswertung_subscriptions FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated insert dashboard_kv" ON public.dashboard_kv FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated read dashboard_kv" ON public.dashboard_kv FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated update dashboard_kv" ON public.dashboard_kv FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Admins manage email_recipients" ON public.email_recipients FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "Admins can delete employees" ON public.employees FOR DELETE TO authenticated USING (is_admin());
CREATE POLICY "Admins can insert employees" ON public.employees FOR INSERT TO authenticated WITH CHECK (is_admin());
CREATE POLICY "Admins can update employees" ON public.employees FOR UPDATE TO authenticated USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "Authenticated read employees" ON public.employees FOR SELECT TO authenticated USING (true);
CREATE POLICY "Admins delete event_dates" ON public.event_dates FOR DELETE TO authenticated USING (is_admin());
CREATE POLICY "Admins insert event_dates" ON public.event_dates FOR INSERT TO authenticated WITH CHECK (is_admin());
CREATE POLICY "Admins update event_dates" ON public.event_dates FOR UPDATE TO authenticated USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "Public read event_dates" ON public.event_dates FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Admins delete event_form_fields" ON public.event_form_fields FOR DELETE TO authenticated USING (is_admin());
CREATE POLICY "Admins insert event_form_fields" ON public.event_form_fields FOR INSERT TO authenticated WITH CHECK (is_admin());
CREATE POLICY "Admins update event_form_fields" ON public.event_form_fields FOR UPDATE TO authenticated USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "Public read event_form_fields" ON public.event_form_fields FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Admins delete events" ON public.events FOR DELETE TO authenticated USING (is_admin());
CREATE POLICY "Admins insert events" ON public.events FOR INSERT TO authenticated WITH CHECK (is_admin());
CREATE POLICY "Admins update events" ON public.events FOR UPDATE TO authenticated USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "Public read active events" ON public.events FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Authenticated insert fh_contacts" ON public.fh_contacts FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated read fh_contacts" ON public.fh_contacts FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated update fh_contacts" ON public.fh_contacts FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Admins can insert fh_deckungsgrad" ON public.fh_deckungsgrad FOR INSERT TO authenticated WITH CHECK (is_admin());
CREATE POLICY "Admins can update fh_deckungsgrad" ON public.fh_deckungsgrad FOR UPDATE TO authenticated USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "Admins can delete fh_duplicate_merges" ON public.fh_duplicate_merges FOR DELETE TO authenticated USING (is_admin());
CREATE POLICY "Admins can insert fh_duplicate_merges" ON public.fh_duplicate_merges FOR INSERT TO authenticated WITH CHECK (is_admin());
CREATE POLICY "Authenticated read fh_duplicate_merges" ON public.fh_duplicate_merges FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated delete fh_kooperation_pending" ON public.fh_kooperation_pending FOR DELETE TO authenticated USING (true);
CREATE POLICY "Authenticated insert fh_kooperation_pending" ON public.fh_kooperation_pending FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated read fh_kooperation_pending" ON public.fh_kooperation_pending FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated all filialgruppen_contacts" ON public.filialgruppen_contacts FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated insert import_log" ON public.import_log FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated read import_log" ON public.import_log FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated read pending_imports" ON public.pending_imports FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated update pending_imports" ON public.pending_imports FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Admin delete performance_dialog_reports" ON public.performance_dialog_reports FOR DELETE TO authenticated USING (is_admin());
CREATE POLICY "Own or admin insert performance_dialog_reports" ON public.performance_dialog_reports FOR INSERT TO authenticated WITH CHECK ((is_admin() OR (employee = ( SELECT profiles.name FROM profiles WHERE (profiles.id = ( SELECT auth.uid() AS uid))))));
CREATE POLICY "Own or admin read performance_dialog_reports" ON public.performance_dialog_reports FOR SELECT TO authenticated USING ((is_admin() OR (employee = ( SELECT profiles.name FROM profiles WHERE (profiles.id = ( SELECT auth.uid() AS uid))))));
CREATE POLICY "Own or admin update performance_dialog_reports" ON public.performance_dialog_reports FOR UPDATE TO authenticated USING ((is_admin() OR (employee = ( SELECT profiles.name FROM profiles WHERE (profiles.id = ( SELECT auth.uid() AS uid)))))) WITH CHECK ((is_admin() OR (employee = ( SELECT profiles.name FROM profiles WHERE (profiles.id = ( SELECT auth.uid() AS uid))))));
CREATE POLICY "Admins can update roles" ON public.profiles FOR UPDATE TO authenticated USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "Authenticated read profiles" ON public.profiles FOR SELECT TO authenticated USING (true);
CREATE POLICY "Admins delete registrations" ON public.registrations FOR DELETE TO authenticated USING (is_admin());
CREATE POLICY "Admins read registrations" ON public.registrations FOR SELECT TO authenticated USING (is_admin());
CREATE POLICY "Public insert registrations" ON public.registrations FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "Authenticated all trainerbesuche" ON public.trainerbesuche FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated all trainerbetreuung_weekly_reports" ON public.trainerbetreuung_weekly_reports FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Users insert own settings" ON public.user_settings FOR INSERT TO authenticated WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users read own settings" ON public.user_settings FOR SELECT TO authenticated USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users update own settings" ON public.user_settings FOR UPDATE TO authenticated USING ((( SELECT auth.uid() AS uid) = user_id)) WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));

-- storage.objects (Storage-RLS, pro Bucket)
CREATE POLICY "Admins delete event photos" ON storage.objects FOR DELETE TO authenticated USING (((bucket_id = 'event-photos'::text) AND is_admin()));
CREATE POLICY "Admins update event photos" ON storage.objects FOR UPDATE TO authenticated USING (((bucket_id = 'event-photos'::text) AND is_admin())) WITH CHECK (((bucket_id = 'event-photos'::text) AND is_admin()));
CREATE POLICY "Admins upload event photos" ON storage.objects FOR INSERT TO authenticated WITH CHECK (((bucket_id = 'event-photos'::text) AND is_admin()));
CREATE POLICY "Authenticated read auswertung-berichte" ON storage.objects FOR SELECT TO authenticated USING ((bucket_id = 'auswertung-berichte'::text));
CREATE POLICY "Authenticated read mail-imports" ON storage.objects FOR SELECT TO authenticated USING ((bucket_id = 'mail-imports'::text));
CREATE POLICY "Authenticated read trainerberichte" ON storage.objects FOR SELECT TO authenticated USING ((bucket_id = 'trainerberichte'::text));
CREATE POLICY "Public read event photos" ON storage.objects FOR SELECT TO anon, authenticated USING ((bucket_id = 'event-photos'::text));
-- Hinweis: INSERT/UPDATE auf auswertung-berichte/mail-imports/trainerberichte
-- läuft ausschließlich über den service_role Key in den Edge Functions
-- (dashboard-mail-poller, auswertung-scheduled-mail, trainerbetreuung-weekly-
-- mail) - service_role umgeht RLS grundsätzlich, daher bewusst keine
-- zusätzliche INSERT-Policy für "authenticated" auf diesen drei Buckets.

-- ============================================================
-- SECTION 5: FUNKTIONEN
-- ============================================================

CREATE OR REPLACE FUNCTION public.akp_monthly_json(v1 integer, v2 integer, v3 integer, v4 integer, v5 integer, v6 integer, v7 integer, v8 integer, v9 integer, v10 integer, v11 integer, v12 integer, v13 integer, v14 integer)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select coalesce(jsonb_object_agg(k, v) filter (where v <> 0), '{}'::jsonb)
  from unnest(
    array['2025-01','2025-02','2025-03','2025-04','2025-05','2025-06','2025-07',
          '2026-01','2026-02','2026-03','2026-04','2026-05','2026-06','2026-07'],
    array[v1,v2,v3,v4,v5,v6,v7,v8,v9,v10,v11,v12,v13,v14]
  ) as t(k, v);
$function$
;

CREATE OR REPLACE FUNCTION public.akp_monthly_json2(idxs integer[], vals integer[])
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select coalesce(jsonb_object_agg(k[i], v), '{}'::jsonb)
  from unnest(idxs, vals) as t(i, v),
  (select array['2025-01','2025-02','2025-03','2025-04','2025-05','2025-06','2025-07',
                '2026-01','2026-02','2026-03','2026-04','2026-05','2026-06','2026-07'] as k) m;
$function$
;

CREATE OR REPLACE FUNCTION public.akp_monthly_json_2425(idxs integer[], vals integer[])
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb)
  from unnest(idxs, vals) as t(i, v)
  join lateral (
    select (array[
      '2024-01','2024-02','2024-03','2024-04','2024-05','2024-06',
      '2024-07','2024-08','2024-09','2024-10','2024-11','2024-12',
      '2025-01','2025-02','2025-03','2025-04','2025-05','2025-06',
      '2025-07','2025-08','2025-09','2025-10','2025-11','2025-12'
    ])[t.i] as k
  ) m on true
  where v is not null and v <> 0;
$function$
;

CREATE OR REPLACE FUNCTION public.akp_profi_training_upsert(rows jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r jsonb;
  new_ts text;
  cur_ts text;
  rank_of jsonb := '{"teilgenommen":1,"service1":1,"verkauf1":1,"verkauf2":2,"service2":2,"verkauf3":2,"abgeschlossen":3,"500":4}'::jsonb;
  cur_year text := to_char(now(),'YYYY');
begin
  if auth.uid() is null then
    raise exception 'Anmeldung erforderlich';
  end if;
  for r in select * from jsonb_array_elements(rows) loop
    if coalesce(r->>'nr','') = '' then continue; end if;
    new_ts := nullif(r->>'training_status','');
    if new_ts is null then continue; end if;

    select training_status into cur_ts from public.akp_contacts where nr = r->>'nr';
    if not found then continue; end if;

    if cur_ts is distinct from '500'
       and (cur_ts is null or coalesce((rank_of->>new_ts)::int,0) > coalesce((rank_of->>cur_ts)::int,0)) then
      update public.akp_contacts set
        training_status = new_ts,
        training_status_by_year = jsonb_set(training_status_by_year, array[cur_year], to_jsonb(new_ts), true),
        updated_at = now()
      where nr = r->>'nr';
    end if;
  end loop;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.akp_sync_daily(rows jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r jsonb; nm text; vn text; nn text; sp int; mval int; mkey text; monthjson jsonb;
  poval numeric; f2val numeric; pojson jsonb; f2json jsonb;
  cur_year text; prev_year text; prev_status text; year_prod numeric;
  cur_ts text; cur_tsby jsonb; cur_prod jsonb;
begin
  if auth.uid() is null then
    raise exception 'Anmeldung erforderlich';
  end if;
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
    monthjson := case when mkey is not null then jsonb_build_object(mkey, mval) else '{}'::jsonb end;
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

    if mkey is not null then
      select training_status, training_status_by_year, prod_monthly
        into cur_ts, cur_tsby, cur_prod
        from public.akp_contacts where nr = r->>'nr';
      if cur_ts is distinct from '500' then
        cur_year := left(mkey,4);
        prev_year := (cur_year::int - 1)::text;
        prev_status := cur_tsby->>prev_year;
        if prev_status in ('abgeschlossen','teilgenommen') then
          select coalesce(sum(e.value::numeric),0) into year_prod
            from jsonb_each_text(coalesce(cur_prod,'{}'::jsonb)) e
            where e.key like cur_year || '-%';
          if year_prod >= 500 then
            update public.akp_contacts
              set training_status = '500',
                  training_status_by_year = jsonb_set(cur_tsby, array[cur_year], '"500"'::jsonb, true),
                  updated_at = now()
              where nr = r->>'nr';
          end if;
        end if;
      end if;
    end if;
  end loop;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.fh_deckungsgrad_for(p_fh_nr text)
 RETURNS TABLE(fh_nr text, bestand numeric, provision_lj numeric, schaeden_lj integer, schadenbetrag_lj numeric, dg1_ampel text, dg1_trend text, dg2_ampel text, dg2_trend text, db1_ampel text, db1_trend text, db2_ampel text, db2_trend text, imported_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if auth.uid() is null then
    raise exception 'Anmeldung erforderlich';
  end if;
  return query
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
end;
$function$
;

CREATE OR REPLACE FUNCTION public.fh_deckungsgrad_upsert(rows jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.fh_duplicate_merges_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if exists (select 1 from public.fh_duplicate_merges where canonical_fh_nr = new.alias_fh_nr) then
    raise exception 'FH-Nr % ist bereits kanonische Nummer fuer andere Aliase - keine Ketten erlaubt', new.alias_fh_nr;
  end if;
  if exists (select 1 from public.fh_duplicate_merges where alias_fh_nr = new.canonical_fh_nr) then
    raise exception 'FH-Nr % ist selbst bereits als Alias markiert - keine Ketten erlaubt', new.canonical_fh_nr;
  end if;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.fh_segmentierung_upsert(rows jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r jsonb; fhnr text; newseg text; curmonth text;
  oldseg text; oldmonth text; oldprev text; newprev text;
begin
  if auth.uid() is null then
    raise exception 'Anmeldung erforderlich';
  end if;
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
$function$
;

CREATE OR REPLACE FUNCTION public.fh_sync_daily(rows jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r jsonb; mval int; mkey text; monthjson jsonb; fhnr text;
  is_new boolean; pending_koop text;
begin
  if auth.uid() is null then
    raise exception 'Anmeldung erforderlich';
  end if;
  for r in select * from jsonb_array_elements(rows) loop
    fhnr := r->>'nr';
    if coalesce(fhnr,'') = '' then continue; end if;
    mkey := r->>'mk';
    mval := coalesce((r->>'mv')::int, 0);
    monthjson := case when mkey is not null then jsonb_build_object(mkey, mval) else '{}'::jsonb end;

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
$function$
;

CREATE OR REPLACE FUNCTION public.fh_sync_miete(rows jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r jsonb; monthlyj jsonb; sortimentj jsonb; clubnr text; mietename text;
begin
  if auth.uid() is null then
    raise exception 'Anmeldung erforderlich';
  end if;
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
$function$
;

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  insert into public.profiles (id, email, name, role)
  values (new.id, new.email, new.raw_user_meta_data->>'name', 'aussendienst');
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.is_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$function$
;

CREATE OR REPLACE FUNCTION public.mark_password_changed()
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  update public.profiles set must_change_password = false where id = auth.uid();
$function$
;

CREATE OR REPLACE FUNCTION public.protect_gesperrt_row()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if old.gesperrt_am is not null then
    if new.gesperrt_am is null then
      -- Entsperren: nur Admin darf das.
      if not public.is_admin() then
        raise exception 'Nur Admins dürfen einen gesperrten Datensatz entsperren.';
      end if;
      return new;
    else
      -- Datensatz bleibt gesperrt - jeder andere Schreibversuch wird
      -- stillschweigend verworfen (kein Fehler, damit z.B. ein Bulk-Import
      -- über viele Zeilen hinweg nicht an einem gesperrten FH abbricht).
      return old;
    end if;
  end if;
  return new;
end;
$function$
;

-- ============================================================
-- SECTION 6: TRIGGER
-- ============================================================

CREATE TRIGGER trg_protect_akp_gesperrt BEFORE UPDATE ON public.akp_contacts FOR EACH ROW EXECUTE FUNCTION protect_gesperrt_row();
CREATE TRIGGER trg_protect_fh_gesperrt BEFORE UPDATE ON public.fh_contacts FOR EACH ROW EXECUTE FUNCTION protect_gesperrt_row();
CREATE TRIGGER fh_duplicate_merges_guard_trg BEFORE INSERT OR UPDATE ON public.fh_duplicate_merges FOR EACH ROW EXECUTE FUNCTION fh_duplicate_merges_guard();

-- Zusätzlich (nicht per SQL hier re-erstellbar, da auf auth.users liegt -
-- im Supabase Dashboard unter Database > Triggers oder per separater
-- Migration auf schema "auth" anzulegen):
--   CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users
--     FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============================================================
-- SECTION 7: EXTENSIONS
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
-- supabase_vault + plpgsql sind in jedem Supabase-Projekt bereits vorhanden.

-- ============================================================
-- SECTION 8: STORAGE BUCKETS
-- ============================================================

insert into storage.buckets (id, name, public) values ('auswertung-berichte', 'auswertung-berichte', false) on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('event-photos', 'event-photos', true) on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('mail-imports', 'mail-imports', false) on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('trainerberichte', 'trainerberichte', false) on conflict (id) do nothing;
-- Storage-RLS-Policies für diese Buckets: siehe SECTION 4 oben
-- ("storage.objects (Storage-RLS, pro Bucket)").

-- ============================================================
-- SECTION 9: PG_CRON JOBS
-- ============================================================
-- WICHTIG: x-cron-secret-Werte unten sind PLATZHALTER, NICHT die echten
-- Secrets (die echten Werte NIE ins Repo committen). Beim Wiederaufbau:
-- 1. CRON_SECRET (und ggf. einen eigenen Wert für event-mailer) in den
--    Edge-Function-Secrets setzen (beliebiger neuer, zufälliger Wert ist
--    ausreichend - muss nur mit dem hier eingesetzten Wert übereinstimmen).
-- 2. <PROJECT_REF> durch die neue Supabase-Projekt-Referenz ersetzen.

select cron.schedule('event-mailer-daily', '0 6 * * *', $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/event-mailer',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<CRON_SECRET_EVENT_MAILER>'),
    body := jsonb_build_object('type','report','frequency','daily')
  );
$$);

select cron.schedule('event-mailer-weekly', '0 6 * * 1', $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/event-mailer',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<CRON_SECRET_EVENT_MAILER>'),
    body := jsonb_build_object('type','report','frequency','weekly')
  );
$$);

select cron.schedule('dashboard-mail-poll', '*/15 * * * *', $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/dashboard-mail-poller',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<CRON_SECRET>'),
    body := jsonb_build_object('trigger','cron'),
    timeout_milliseconds := 55000
  );
$$);

select cron.schedule('performance-dialog-reminder-daily', '0 6 * * *', $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/performance-dialog-reminder',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<CRON_SECRET>'),
    body := jsonb_build_object('trigger','cron'),
    timeout_milliseconds := 55000
  );
$$);

select cron.schedule('trainerbetreuung-weekly-mail-hourly', '0 * * * *', $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/trainerbetreuung-weekly-mail',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<CRON_SECRET>'),
    body := jsonb_build_object('trigger','cron'),
    timeout_milliseconds := 55000
  );
$$);

select cron.schedule('auswertung-scheduled-mail-daily', '0 6 * * *', $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/auswertung-scheduled-mail',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<CRON_SECRET>'),
    body := jsonb_build_object('trigger','cron'),
    timeout_milliseconds := 55000
  );
$$);
