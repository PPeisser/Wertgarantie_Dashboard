# Grundgerüst-Sicherung & Rehosting-Anleitung

Stand: 06.10.2026. Diese Datei dokumentiert, wie das Wertgarantie Performance
Dashboard komplett neu aufgesetzt werden kann - auf einem neuen Supabase-
Projekt und/oder einem anderen Hosting als Vercel. Sie ergänzt
`supabase/schema.sql` (vollständiger Datenbank-Grundaufbau: Tabellen,
Constraints, RLS, Funktionen, Trigger, Extensions, Storage-Buckets,
pg_cron-Jobs).

**Umfang dieser Sicherung: nur Struktur, keine Daten.** `schema.sql` baut
leere Tabellen auf. Die eigentlichen Inhalte (FH-Kontakte, AKP-Liste,
Produktionszahlen, `dashboard_kv`-Blob `wg-state` usw.) sind NICHT Teil
dieser Sicherung und müssten im Ernstfall separat aus dem laufenden
Supabase-Projekt exportiert werden (z.B. per `pg_dump --data-only` mit
echten DB-Zugangsdaten, oder tabellenweise per Supabase Studio/CSV-Export),
bevor ein neues Projekt produktiv genutzt wird.

## 1. Aktuelle Infrastruktur (Referenz)

| Komponente | Wert |
|---|---|
| Supabase-Projekt-Ref | `gfyjftwlombhmwirbyse` |
| Supabase-Region | `eu-central-1` |
| Supabase-Organisation | `qgrmoufjhjebgmwrqeac` |
| Postgres-Version | 17.6 |
| Vercel-Projekt | `wertgarantie-dashboard` |
| Vercel-Team | `wertgarantie` |
| Live-Domain | `dashboard.wgaustria.at` |
| Deploy-Trigger | Push auf `main` → Production; Push auf Feature-Branch → Preview |

Die App selbst ist eine reine Single-File-SPA (`index.html`, Twin:
`wertgarantie-performance-dashboard-v2.html`) ohne Build-Schritt - jedes
beliebige statische Hosting (Vercel, Netlify, S3+CloudFront, nginx, ...)
kann sie ausliefern, solange es HTML/JS/CSS unverändert servt.

## 2. Neues Supabase-Projekt aufsetzen

1. Neues Projekt in Supabase anlegen (Region frei wählbar, `eu-central-1`
   empfiehlt sich wegen DSGVO/Latenz zu Österreich).
2. `supabase/schema.sql` komplett gegen die neue Projekt-Datenbank
   ausführen (SQL-Editor im Supabase Dashboard, oder `psql`/
   `apply_migration` via Supabase-CLI/MCP). Das legt Tabellen, Constraints,
   Indizes, RLS-Policies, Funktionen, Trigger, Extensions und
   Storage-Buckets an.
3. **Zusätzlich manuell nachziehen** (nicht per SQL im Skript enthalten,
   da sie auf dem `auth`-Schema liegen bzw. Dashboard-only sind):
   - Trigger `on_auth_user_created` auf `auth.users` (ruft
     `public.handle_new_user()` auf) - siehe Kommentar in `schema.sql`
     Abschnitt 6 für den exakten `CREATE TRIGGER`-Befehl.
   - Auth-Einstellungen im Dashboard: E-Mail/Passwort-Login aktivieren,
     "Leaked Password Protection" aktivieren (im Ursprungsprojekt war das
     zuletzt noch offen, siehe `CLAUDE.md`).
4. In `cron.schedule(...)` (Abschnitt 9 von `schema.sql`) die Platzhalter
   `<PROJECT_REF>` durch die neue Projekt-Referenz und `<CRON_SECRET>`/
   `<CRON_SECRET_EVENT_MAILER>` durch neu generierte, zufällige Geheimwerte
   ersetzen - diese müssen mit den unter Abschnitt 4 gesetzten
   Edge-Function-Secrets exakt übereinstimmen.
5. Mindestens einen Admin-User anlegen: regulär per Supabase Auth
   registrieren (der Trigger aus Schritt 3 legt automatisch eine
   `profiles`-Zeile mit Rolle `aussendienst` an), danach per SQL
   `update public.profiles set role='admin' where email='...';`.

## 3. Edge Functions

Alle 18 produktiv deployten Edge Functions liegen jetzt vollständig unter
`supabase/functions/*/index.ts` im Repo (7 davon waren bisher nur live in
Supabase deployt, nie committet - wurden am 06.10.2026 nachgezogen).

| Function | Zweck | Status |
|---|---|---|
| `dashboard-mailer` | Mailversand (PDF-Anhänge, SMTP) aus dem Dashboard/anderen Functions | aktiv |
| `dashboard-mail-poller` | IMAP-Postfach abfragen, Report-Anhänge für Import vormerken | aktiv (Cron) |
| `performance-dialog-reminder` | Erinnerungsmails Performance Dialog | aktiv (Cron) |
| `performance-dialog-annual-summary` | KI-gestützte Jahresauswertung | aktiv |
| `auswertung-scheduled-mail` | Wiederkehrende Auswertungs-Mails (Abos) | aktiv (Cron) |
| `trainerbetreuung-weekly-mail` | Trainerbetreuung-Fortschrittsbericht (PDF) | aktiv (Cron) |
| `event-mailer` | Event-Landingpage: Anmeldebestätigung + Status-Mails | aktiv |
| `sync-from-events` | Sync events.wgaustria.at → Dashboard | aktiv |
| `admin-users` | Admin: User anlegen/verwalten | aktiv |
| `lookup-akp` | AKP-Nachschlage-Endpunkt (für events-Sync) | aktiv |
| `akq-import-notify` | Benachrichtigung bei AKQ-Import | aktiv |
| `akquise-google` | Google-Maps/Places-Proxy für Akquisetool | aktiv |
| `chefgespraech-ai-comparison` | KI-Vergleich Chefgespräch | aktiv |
| `kooperationsgespraech-ai-comparison` | KI-Vergleich Kooperationsgespräch | aktiv |
| `akp-peer-ai-comparison` | KI-Vergleich AKP Peer-Group | aktiv |
| `import-akp-contacts` | *stillgelegt* (410 Gone) - einmaliger Altimport, nicht mehr nötig |
| `debug-mail-fetch` | *stillgelegt* (410 Gone) - temporäres Debug-Tool |
| `debug-xlsx-inspect` | *stillgelegt* (410 Gone) - temporäres Debug-Tool |
| `debug-mistral-test` | *stillgelegt* (410 Gone) - temporäres Debug-Tool |

Die vier stillgelegten Functions müssen bei einem Rehosting NICHT neu
deployt werden (reiner Stub, keine Funktion). Die übrigen 14 sollten per
Supabase-CLI (`supabase functions deploy <name>`) oder MCP
(`deploy_edge_function`) auf das neue Projekt deployt werden.

### Benötigte Secrets (NUR Namen - Werte NIE ins Repo!)

Secrets werden im Supabase Dashboard unter *Edge Functions → Secrets*
gesetzt und gelten projektweit für alle Functions.

| Secret-Name | Wozu | Wird gebraucht von |
|---|---|---|
| `SUPABASE_URL` | Projekt-URL (für den service_role-Client) | praktisch allen Functions |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-Role-Key (RLS-Bypass serverseitig) | praktisch allen Functions |
| `CRON_SECRET` | Schutz der cron-getriggerten Functions (`x-cron-secret`-Header) | `dashboard-mailer`, `dashboard-mail-poller`, `performance-dialog-reminder`, `trainerbetreuung-weekly-mail`, `auswertung-scheduled-mail`, `akq-import-notify` |
| `CRON_SECRET` (zweiter, eigener Wert möglich) | dasselbe Prinzip, historisch mit eigenem Wert für `event-mailer` | `event-mailer` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM_EMAIL`, `SMTP_FROM_NAME` | Mailversand (eigener SMTP-Client, siehe `dashboard-mailer`) | `dashboard-mailer`, `event-mailer` |
| `IMAP_HOST`, `IMAP_PORT`, `IMAP_USERNAME`, `IMAP_PASSWORD` | Postfach-Abfrage für eingehende Report-Mails | `dashboard-mail-poller` |
| `MISTRAL_API_KEY` | KI-Vergleiche (Mistral-API) | `chefgespraech-ai-comparison`, `kooperationsgespraech-ai-comparison`, `akp-peer-ai-comparison`, `performance-dialog-annual-summary` |
| `GOOGLE_MAPS_SERVER_KEY` | Google Places/Geocoding (Server-seitig, verlässt Supabase nie) | `akquise-google` |
| `EVENTS_SYNC_SECRET`, `EVENTS_SYNC_URL` | Sync zu/von der externen Events-Landingpage | `admin-users`, `sync-from-events` |
| `EVENTS_LOOKUP_SECRET` | Absicherung des AKP-Lookup-Endpunkts | `lookup-akp` |
| `FROM_EVENTS_SYNC_SECRET` | Gegenstück zu `EVENTS_SYNC_SECRET` auf der Empfängerseite | `sync-from-events` |

Alle Werte sind beim Rehosting frei neu wählbar (zufällige, ausreichend
lange Strings für die `*_SECRET`-Werte) - sie müssen nur konsistent
zwischen den Edge-Function-Secrets und den `cron.schedule(...)`-Aufrufen
in `schema.sql` (Abschnitt 9) übereinstimmen, und bei SMTP/IMAP/Mistral/
Google den echten Zugangsdaten des jeweiligen externen Dienstes entsprechen.

## 4. Storage

4 Buckets (siehe `schema.sql` Abschnitt 8+4): `auswertung-berichte`,
`mail-imports`, `trainerberichte` (alle privat, Zugriff nur per
service_role bzw. authenticated-read) und `event-photos` (öffentlich
lesbar, Admin-Upload). Werden durch `schema.sql` automatisch angelegt.

## 5. Client-Konfiguration (index.html)

Die Supabase-URL und der `anon`-Key sind direkt im `<script>`-Tag von
`index.html`/`wertgarantie-performance-dashboard-v2.html` hinterlegt (per
`supabase-js`-CDN-Script, kein Build-Schritt, kein `.env`). Bei einem
Projektwechsel müssen beide Werte dort angepasst werden (Grep nach
`createClient(` in der Datei).

## 6. Rehosting-Checkliste (Kurzfassung)

1. Neues Supabase-Projekt anlegen, `schema.sql` einspielen (Abschnitt 2).
2. `auth.users`-Trigger `on_auth_user_created` manuell nachziehen.
3. Alle Secrets aus der Tabelle oben im neuen Projekt setzen (Abschnitt 3).
4. `<PROJECT_REF>`/`<CRON_SECRET>`-Platzhalter in den `cron.schedule(...)`-
   Aufrufen durch echte Werte ersetzen.
5. Die 14 aktiven Edge Functions auf das neue Projekt deployen.
6. `index.html`/`wertgarantie-performance-dashboard-v2.html`: neue
   Supabase-URL + `anon`-Key eintragen (beide Dateien, byte-identisch
   halten!).
7. Mindestens einen Admin-User anlegen (Abschnitt 2, Schritt 5).
8. Neues Hosting für die statischen Dateien aufsetzen (Vercel-Projekt neu
   verknüpfen, oder beliebiges anderes statisches Hosting) und die
   gewünschte Domain verbinden.
9. Falls eine echte Datenübernahme gewünscht ist: Daten aus dem alten
   Projekt separat exportieren und in die neuen (durch `schema.sql` leer
   angelegten) Tabellen importieren, bevor Nutzer freigeschaltet werden.
