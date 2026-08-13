# Wertgarantie Performance Dashboard Österreich

Interaktives Vertriebs-Dashboard für die tägliche Auswertung der Vertragsproduktion in Österreich.
Eine einzige HTML-Datei – ohne Installation direkt im Browser lauffähig (Doppelklick genügt).

**Aktuelle Version: `wertgarantie-performance-dashboard-v2.html`**
(`…-v1.html` liegt zum Vergleich bei.)

---

## Verwendung

1. Datei `wertgarantie-performance-dashboard-v2.html` im Browser öffnen (Chrome/Edge/Safari).
2. Oben rechts über **„Excel einspielen"** die tägliche `Auswertung_TAG.xlsx` hochladen.
3. Mitarbeiter im Dropdown wählen, Zeiträume über die Tabs umschalten, per **PDF**-Button drucken/exportieren.

Die Produktion vom Vortag wird bei jeder Einspielung fortgeschrieben – daraus entstehen
automatisch Tages- und Wochenvergleiche. Persönliche Monatsziele der Mitarbeiter werden
per Popup erfasst und lokal gespeichert.

## Datenquelle (Auswertung_TAG.xlsx)

| Blatt | Verwendung |
|---|---|
| `ZE_Region` | Meta (Jahr, Monat, „Tage Ist von Soll", Berichtsdatum), PLAN Monat & EWR (Zeile „Auswertung", Blöcke „Plan LJ"/„EWR LJ"), KS/GS-Anteile (Detailblock, Spalten AA bzw. K) |
| `Region_nach_GL` | Produktion je Gebietsleiter (Vortag, Monat, Monat VJ, Jahr, Vorjahr), Sparten-Nebentabelle (Brille/Hörgeräte/Küche/Uhren) |
| `data_Region_nach_GL_4` | Gebrauchtgeräte-Quote LJ/VJ je Gebietsleiter |
| `FH_Liste` | Alle Händler mit FH-Nr, Betreuer (GL), Vortag/Monat/LJ/VJ, Jahresplan |
| `AKP Liste` | Aktivpartner mit FH-Nr, Vortag/Monat/LJ/VJ |
| `AKQ-Liste` | Akquisekunden mit Beginn Zusammenarbeit, Adresse, Telefon, Produktion 2024–2026, Besuchen |

Händler ohne zugeordneten Betreuer (z. B. „ohne Zuordnung", „Technischer GL", „Akquise")
zählen nur in „Österreich gesamt".

## Fest hinterlegte Ziele

- **Jahresziel Österreich:** 120.000 · **PLAN Jahr:** 109.500
- **PLAN Monat:** aus `ZE_Region` (Zeile „Auswertung", Plan-LJ-Summe)
- **Persönliches Monatsziel Österreich gesamt (fest):**
  Jän 9.867 · Feb 8.679 · Mär 9.284 · Apr 8.998 · Mai 8.998 · Jun 8.998 ·
  Jul 10.175 · Aug 9.856 · Sep 10.318 · Okt 10.318 · Nov 12.452 · Dez 12.452
- **Persönliche Jahresziele:** Witting 20.000 · Hasibeder 17.000 · Eitzinger 15.000 ·
  Szendi 55.000 · Otto 7.000 · Peißer 7.000
- **Gebrauchtgeräte-Ziel:** 40 %

## Saisonale Hochrechnung

`Hochrechnung = Ist-Produktion ÷ erwarteter Jahresanteil`

- bis 30.09.: `Anteil = 71 % × (Arbeitstage seit 1.1. ÷ Arbeitstage Jän–Sep)`
- ab 01.10.: `Anteil = 71 % + 29 % × (Arbeitstage seit 1.10. ÷ Arbeitstage Okt–Dez)`

Arbeitstage = Montag–Samstag abzüglich österreichischer Feiertage (inkl. beweglicher
Feiertage, automatisch je Jahr berechnet). Die Hochrechnungs-Prozente beziehen sich
auf den **Plan** (109.500).

## Funktionen (V2)

- 5 Zielkarten mit Soll-Linie & saisonaler Hochrechnung (Österreich-Ansicht: 4 Karten)
- Produktmix Komplettschutz vs. Geräteschutz, Gebrauchtgeräte-Quote (Ziel 40 %), Sparten
- KPI-Karten Tag / Monat (vs. VJ) / Jahr (vs. VJ)
- Händler Top & Flop 10 (Tag/Woche/Monat/Jahr) – Top ohne negative Entwicklung,
  Negative automatisch in der Flop-Liste; Monat vs. eigenem Ø-Monat
- Besondere Beobachtungen (Ausreißer, Jahres-Einbrüche, Akquisen ohne Besuch)
- Top & Flop 3 AKP (Woche/Monat/Jahr) + PopUp „Top/Flop 5–30"
- Top 20 AKQ mit Jahrgangsfilter (2024/2025/2026/gesamt), ohne FH > 300 VJ-Verträge
- Akquise ohne Produktion 2026 (Kontaktliste mit Telefon-Links) & 9-Wochen-Plan (⚠️ bei < 5 Terminen und < 20 Verträgen)
- PDF-Export (nativer Druckdialog bzw. direkter PDF-Download in Sandbox-Umgebungen)

## Technik

Vanilla JS in einer HTML-Datei. Externe Bibliotheken via CDN: SheetJS (Excel-Import),
html2canvas + jsPDF (PDF-Export), Supabase JS (Login & Datenpersistenz). Datenstand
und Ziele werden – sofern eingeloggt – zentral in Supabase gespeichert, sonst über
eine Storage-API bzw. im Speicher gehalten; die zuletzt eingebettete Auswertung dient
als Startzustand.

## Supabase-Setup

Das Dashboard ist per Login geschützt und speichert Zieldaten & eingespielte
Auswertungen zentral in Supabase (statt nur lokal im Browser), damit alle
Mitarbeiter denselben Stand sehen.

1. **Projekt & Key**: Project URL und der *Publishable Key* (`sb_publishable_…`,
   sicher für den Client-Code, siehe unten) sind bereits fest in
   `index.html` / `wertgarantie-performance-dashboard-v2.html` hinterlegt
   (`SUPABASE_URL`, `SUPABASE_ANON_KEY`).
2. **Datenbank-Tabellen anlegen**: Im Supabase-Dashboard → SQL Editor das Skript
   [`supabase/schema.sql`](supabase/schema.sql) einmalig ausführen. Es legt die
   Tabelle `dashboard_kv` (Ziele/Excel-Daten) sowie `profiles` (Rollen) an und
   aktiviert Row Level Security mit Policies, die Zugriff auf eingeloggte
   Nutzer beschränken.
3. **Login aktivieren**: Im Supabase-Dashboard → Authentication → Providers ist
   „Email" standardmäßig aktiv. Unter Authentication → Users die
   Mitarbeiter-Logins (E-Mail + Passwort) manuell anlegen.
4. **Nutzung**: Beim Öffnen der Datei erscheint ein Login-Fenster. Nach
   erfolgreicher Anmeldung wird der Datenstand aus Supabase geladen; „Excel
   einspielen" und persönliche Monatsziele schreiben automatisch zurück.
   Über den Button „Abmelden" im Header kann man sich ausloggen.

## Rollen (Admin / Außendienst)

Jeder Nutzer hat in `public.profiles` einen Namen (`name`) und eine Rolle
(`admin` oder `aussendienst`, Standard für neu registrierte Nutzer). Nach dem
Login wird unterhalb von „Vertragsproduktion …" im Header „Herzlich
Willkommen, NAME" angezeigt, außerdem die Rolle als Badge.

- **Außendienst**: voller Zugriff auf das Dashboard inkl. aller Mitarbeiter
  (wie bisher, keine Einschränkung).
- **Admin**: zusätzlich zu allem, was Außendienst kann, sichtbarer
  „⚙ Admin"-Button im Header, der das Admin-Panel öffnet.

## Admin-Panel

Nur für Nutzer mit Rolle `admin` sichtbar. Enthält:
- Excel einspielen (identisch zur Funktion im Hauptheader)
- Neue Nutzer anlegen (Name, E-Mail, Passwort, Rolle) – landet direkt in Supabase Auth
- Nutzerübersicht: Name (bearbeitbar), E-Mail, Rolle-Umschalter, Passwort-Reset, Löschen-Button

**Wichtig zur Sicherheit**: Nutzer anlegen/löschen/Passwort setzen sind
privilegierte Supabase-Operationen (Admin API), die einen `service_role`-Key
brauchen. Dieser Key darf niemals im Browser-Code stehen. Deshalb läuft das
über eine separate **Supabase Edge Function**
([`supabase/functions/admin-users/index.ts`](supabase/functions/admin-users/index.ts)),
die serverseitig in Supabase läuft, den Key nur dort verwendet und jeden
Aufruf gegen `profiles.role = 'admin'` prüft, bevor sie etwas tut.

**Einmaliges Deployment der Edge Function** (Supabase CLI erforderlich):
```bash
supabase functions deploy admin-users --project-ref gfyjftwlombhmwirbyse
```
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` etc. werden von Supabase
automatisch als Umgebungsvariablen in jede Edge Function injiziert –
es ist keine zusätzliche Secret-Konfiguration nötig.

**Hinweis zum Key**: `sb_publishable_…` ist Supabases neuer öffentlicher
Client-Key (Nachfolger des `anon`-Keys) – er darf im Frontend-Code sichtbar
sein, die eigentliche Absicherung erfolgt über Row Level Security (Schritt 2)
und den Login-Zwang.

---

# Event-Landingpage & Event-Admin (`events/`)

Eigenständige Anwendung im Ordner [`events/`](events/) für die Anmeldung zu
einer Wertgarantie-Veranstaltung (eine Veranstaltung, mehrere Termine/Orte).
**Bewusst vollständig getrennt** vom Performance-Dashboard: eigenes
Supabase-Projekt, eigenes Vercel-Projekt, eigene Domain, eigener Login –
nichts wird zwischen den beiden Anwendungen geteilt.

- **[`events/index.html`](events/index.html)** – öffentliche Anmeldeseite
  (kein Login). Zeigt Titel/Beschreibung/Foto der aktiven Veranstaltung, ein
  Dropdown mit allen Terminen (Datum, Uhrzeit, Ort) und ein Anmeldeformular,
  dessen Felder im Admin-Panel konfiguriert werden. Nach dem Absenden wird –
  sofern die E-Mail-Adresse erfasst wurde – automatisch eine
  Bestätigungsmail verschickt. Ganz unten im Kleingedruckten verlinkt ein
  „Admin"-Link auf das Admin-Panel.
- **[`events/admin.html`](events/admin.html)** – Admin-Panel, eigener Login
  (Supabase Auth dieses Projekts, jeder hier registrierte Nutzer ist Admin).
  Hier werden verwaltet:
  - **Veranstaltung**: Titel, Foto (Upload), frei editierbare Beschreibung,
    Datenschutzhinweise (Standardtext per Klick einfügbar, überschreibbar)
  - **Termine**: Datum, Uhrzeit (von/bis), Ort – hinzufügen, bearbeiten, löschen
  - **Formularfelder**: Auswahl aus dem festen Katalog (Vorname, Name, PLZ,
    Ort, Geburtsdatum, AKP-Nummer, FH-Nummer, Fachhändler, Telefonnummer,
    E-Mail-Adresse, Anreise mit Auto, sonstige Bemerkungen) inkl.
    Aktiv/Pflichtfeld-Umschalter, Beschriftung und Reihenfolge
  - **E-Mail-Empfänger**: Adressen, die den automatischen täglichen bzw.
    wöchentlichen Gesamt-Anmeldestand erhalten
  - **Anmeldungen**: Übersicht aller Anmeldungen inkl. CSV-Export

## Supabase-Projekt

Eigenes Projekt **`wgaustria-events`** (Projekt-ID `jtgoytbcqkqopdpjlozq`,
Region `eu-central-1`, Free Tier). Schema: [`events/supabase/schema.sql`](events/supabase/schema.sql)
(Tabellen `events`, `event_dates`, `event_form_fields`, `registrations`,
`email_recipients` + `profiles`/`is_admin` fürs Admin-Login), RLS-abgesichert:
- Anmeldeformular (`registrations`) ist per `INSERT` öffentlich (kein Login),
  Lesen/Löschen nur für eingeloggte Admins.
- `events`, `event_dates`, `event_form_fields` sind öffentlich lesbar
  (nötig für die Landingpage ohne Login), Schreiben nur für Admins.
- `email_recipients` ist ausschließlich für Admins sichtbar/änderbar.
- Storage-Bucket `event-photos` (öffentlich lesbar, Upload nur für Admins).

### Ersten Admin-Nutzer anlegen

Dieses Projekt hat noch keinen Nutzer. Im Supabase-Dashboard des Projekts
`wgaustria-events` → **Authentication → Users → Add user** einen Nutzer mit
E-Mail + Passwort anlegen (z.B. `peter@peisser.com`) – er wird durch den
`handle_new_user`-Trigger automatisch als Admin angelegt und kann sich danach
in `events/admin.html` einloggen.

## Mailversand (Edge Function `event-mailer`)

[`events/supabase/functions/event-mailer/index.ts`](events/supabase/functions/event-mailer/index.ts)
übernimmt zwei Aufgaben:
1. **Bestätigungsmail** an den Anmelder direkt nach dem Absenden des Formulars.
2. **Status-Report** (aktueller Gesamt-Anmeldestand je Termin/Ort) an alle im
   Admin-Panel hinterlegten Empfänger – täglich bzw. wöchentlich, ausgelöst
   über `pg_cron` + `pg_net` (siehe unten). Bereits im Projekt deployt.

Der Mailversand läuft über **SMTP** (Easyname-Postfach `events@wgaustria.at`)
und braucht folgende Secrets, die **einmalig manuell** im Supabase-Dashboard
des Projekts `wgaustria-events` hinterlegt werden müssen
(_Project Settings → Edge Functions → Secrets_, da hierfür kein
Secrets-Tool in dieser Session zur Verfügung stand):

| Secret | Wert |
|---|---|
| `SMTP_HOST` | `web8.wh20.easyname.systems` |
| `SMTP_PORT` | `465` |
| `SMTP_USERNAME` | `events@wgaustria.at` |
| `SMTP_PASSWORD` | *(Postfach-Passwort, wie separat mitgeteilt)* |
| `SMTP_FROM_EMAIL` | `events@wgaustria.at` |
| `SMTP_FROM_NAME` | z.B. `Wertgarantie Veranstaltungen` |
| `CRON_SECRET` | *(wurde beim Einrichten von `pg_cron` erzeugt, identischer Wert wie dort hinterlegt – separat mitgeteilt)* |

Erneut deployen nach Code-Änderungen:
```bash
supabase functions deploy event-mailer --project-ref jtgoytbcqkqopdpjlozq
```

## Automatischer täglicher/wöchentlicher Report (`pg_cron`)

Zwei `pg_cron`-Jobs im Projekt `wgaustria-events` rufen `event-mailer` mit
`{"type":"report","frequency":"daily"|"weekly"}` auf:
- `event-daily-report`: täglich um 06:00 UTC
- `event-weekly-report`: montags um 06:00 UTC

Zeiten anpassen (z.B. andere Uhrzeit/Zeitzone):
```sql
select cron.alter_job(job_id := (select jobid from cron.job where jobname='event-daily-report'), schedule := '0 5 * * *');
```

## Vercel-Projekt & Domain

**Eigenes Vercel-Projekt**, *Root Directory* auf `events` gestellt (damit
`events/index.html` unter „/" ausgeliefert wird und `events/vercel.json`
unabhängig vom Dashboard-Vercel-Projekt gilt). Domain: **`events.wgaustria.at`**.

Einrichtung (sobald die Vercel-Integration für diese Session autorisiert ist,
aktuell noch nicht der Fall – bis dahin manuell im Vercel-Dashboard):
1. Neues Vercel-Projekt aus diesem GitHub-Repo anlegen, *Root Directory* = `events`.
2. Unter *Settings → Domains* `events.wgaustria.at` hinzufügen – Vercel zeigt
   den nötigen DNS-Eintrag an (i.d.R. ein **CNAME** auf `cname.vercel-dns.com`
   für eine Subdomain wie `events`).
3. Diesen Eintrag bei Easyname eintragen: Login auf easyname.com → **CloudPit**
   → Domain `wgaustria.at` suchen → „Mehr" (`⋯`) → **DNS-Verwaltung** → ggf.
   auf manuelle Verwaltung umschalten → **+ DNS-Eintrag hinzufügen** → Typ
   **CNAME**, Name `events`, Wert wie von Vercel angezeigt.
