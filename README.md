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
- Top 20 AKQ mit Jahrgangsfilter (2024/2025/2026/gesamt)
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

## Domain (`dashboard.wgaustria.at`)

Eigenes Vercel-Projekt **`wertgarantie-dashboard`** (Team `wertgarantie`,
bereits live unter `wertgarantie-dashboard.vercel.app`). Die Custom Domain
lässt sich nicht per API hinzufügen (kein Tool dafür verfügbar) – einmalig
manuell einrichten:

1. [vercel.com/wertgarantie/wertgarantie-dashboard/settings/domains](https://vercel.com/wertgarantie/wertgarantie-dashboard/settings/domains) öffnen.
2. `dashboard.wgaustria.at` eintragen und hinzufügen – Vercel zeigt danach
   den nötigen DNS-Eintrag an (i. d. R. ein **CNAME** auf `cname.vercel-dns.com`).
3. Bei Easyname eintragen: Login auf easyname.com → **CloudPit** → Domain
   `wgaustria.at` suchen → „Mehr" (`⋯`) → **DNS-Verwaltung** → ggf. auf
   manuelle Verwaltung umschalten → **+ DNS-Eintrag hinzufügen** → Typ
   **CNAME**, Name `dashboard`, Wert wie von Vercel angezeigt.
4. Nach DNS-Propagierung (meist wenige Minuten bis Stunden) zeigt Vercel die
   Domain als „Valid" an – das Dashboard ist dann unter
   `https://dashboard.wgaustria.at` erreichbar.

✅ **Erledigt und getestet** (Stand 14.08.2026): `https://dashboard.wgaustria.at`
liefert HTTP 200 und zeigt das Dashboard korrekt an.

## Mailversand (`dashboard@wgaustria.at`, Edge Function `dashboard-mailer`)

[`supabase/functions/dashboard-mailer/index.ts`](supabase/functions/dashboard-mailer/index.ts)
(bereits deployt) verschickt Mails über **SMTP** (Easyname-Postfach
`dashboard@wgaustria.at`), mit den Aktionen `test` (einzelne Testmail),
`send` (generischer Versand, x-cron-secret-geschützt) und `sendPdf`
(PDF-Versand aus dem Dashboard – Auth über die normale Nutzer-Session, kein
Secret im Browser-Code nötig). `sendPdf` wird über den "📧 Versenden"-Button
aufgerufen, der bei jedem PDF-Export (Haupt-Dashboard, FH- und AKP-Datenblatt)
als Alternative zu "🖨 Drucken" erscheint – Empfänger ist entweder die eigene
hinterlegte Adresse oder eine frei eingegebene (dann mit "Lieber Kunde, …"-
Anrede und Signatur des angemeldeten Nutzers).

**Einmalig einzurichten** (Supabase-Dashboard des Projekts
`gfyjftwlombhmwirbyse` → *Project Settings → Edge Functions → Secrets*, kein
Tool dafür in dieser Session verfügbar):

| Secret | Wert |
|---|---|
| `SMTP_HOST` | `web8.wh20.easyname.systems` |
| `SMTP_PORT` | `465` |
| `SMTP_USERNAME` | `dashboard@wgaustria.at` |
| `SMTP_PASSWORD` | *(Postfach-Passwort, wie bei Easyname vergeben)* |
| `SMTP_FROM_EMAIL` | `dashboard@wgaustria.at` |
| `SMTP_FROM_NAME` | z. B. `Wertgarantie Dashboard` |
| `CRON_SECRET` | `wjRIsCww0sGxg9Hf6V45-j02penc_-hZ9azxv6blcVU` |

Postfach `dashboard@wgaustria.at` existiert bereits bei Easyname
(Server `web8.wh20.easyname.systems`, Verschlüsselung SSL/TLS, Port 465
laut Easyname-Postfachdaten). Nur `SMTP_PASSWORD` muss noch als Secret
gesetzt werden – das Passwort selbst ist nirgends hinterlegt und mir nicht
bekannt.

Test nach Einrichtung:
```bash
curl -X POST https://gfyjftwlombhmwirbyse.supabase.co/functions/v1/dashboard-mailer \
  -H "Content-Type: application/json" -H "x-cron-secret: wjRIsCww0sGxg9Hf6V45-j02penc_-hZ9azxv6blcVU" \
  -d '{"type":"test","to":"deine@adresse.at"}'
```

Erneut deployen nach Code-Änderungen:
```bash
supabase functions deploy dashboard-mailer --project-ref gfyjftwlombhmwirbyse
```

## Automatischer Excel-Mail-Import (`input@wgaustria.at`)

Ziel: die tägliche `Auswertung_TAG.xlsx` (bzw. die Akquisestaffeln-Datei)
muss nicht mehr manuell über „Excel einspielen" hochgeladen werden – eine
Mail mit der Datei im Anhang an `input@wgaustria.at` genügt, der Import
passiert danach automatisch.

**Architektur (bewusst kein serverseitiger Nachbau des Excel-Parsers):**
Eine Edge Function (`dashboard-mail-poller`) ruft das Postfach per **IMAP**
ab, sucht ungelesene Mails mit `.xlsx`/`.xls`-Anhang, lädt den Anhang in den
privaten Storage-Bucket `mail-imports` hoch und legt eine Zeile in
`public.pending_imports` an. Das eigentliche **Parsen und Einspielen**
übernimmt weiterhin der bereits ausführlich getestete clientseitige Parser
(`parseAuswertung` in `index.html`, identisch zum manuellen Excel-Upload) –
`processPendingImports()` holt offene `pending_imports` beim Login bzw. bei
jeder Aktualisierung automatisch ab, parst sie genauso wie eine manuelle
Einspielung und markiert sie danach als `processed`. Das vermeidet doppelte,
potenziell abweichende Parser-Logik auf Server und Client.

- [`supabase/functions/dashboard-mail-poller/index.ts`](supabase/functions/dashboard-mail-poller/index.ts)
  (bereits deployt): IMAP-Abruf, Storage-Upload, `pending_imports`-Eintrag.
- `pg_cron`-Job **`dashboard-mail-poll`** (bereits eingerichtet, Projekt
  `gfyjftwlombhmwirbyse`): ruft die Function alle 15 Minuten auf.
- `processPendingImports()` in `index.html`: verarbeitet offene
  `pending_imports` clientseitig (siehe oben).

**Einmalig einzurichten:**

1. Postfach `input@wgaustria.at` bei Easyname anlegen, falls noch nicht
   vorhanden (CloudPit → E-Mail → Postfach anlegen).
2. Secrets im Supabase-Dashboard des Projekts `gfyjftwlombhmwirbyse` →
   *Project Settings → Edge Functions → Secrets* hinterlegen:

   | Secret | Wert |
   |---|---|
   | `IMAP_HOST` | `web8.wh20.easyname.systems` |
   | `IMAP_PORT` | `993` |
   | `IMAP_USERNAME` | `input@wgaustria.at` |
   | `IMAP_PASSWORD` | *(Postfach-Passwort, wie bei Easyname vergeben)* |
   | `CRON_SECRET` | `wjRIsCww0sGxg9Hf6V45-j02penc_-hZ9azxv6blcVU` *(identischer Wert wie beim Mailversand oben)* |

3. Danach läuft der Import vollautomatisch: Mail an `input@wgaustria.at`
   schicken (Anhang `.xlsx`, egal ob Auswertung_TAG oder Akquisestaffeln –
   `parseAuswertung` erkennt das Format automatisch), spätestens 15 Minuten
   später ist sie abgeholt, und beim nächsten Login/„Aktualisieren" eines
   beliebigen Nutzers wird sie automatisch eingespielt.

✅ **Erledigt und live getestet** (Stand 14.08.2026): eine an
`input@wgaustria.at` weitergeleitete `Auswertung_TAG.xlsx` wurde erfolgreich
abgeholt und lag danach korrekt in `pending_imports`
(`storage_path`/`source_subject`/`source_from` gesetzt, ~280 KB Anhang).
Dabei wurde ein Bug behoben: die Bibliothek `imapflow` hängt sich beim
eigentlichen Byte-Transfer eines Anhangs unter der Deno-Laufzeitumgebung von
Supabase Edge Functions auf (getestet über drei verschiedene imapflow-APIs -
`fetchOne({source:true})`, `client.download()` und
`fetchOne({bodyParts:[...]})` - alle drei hängen identisch). Login, Suche und
`bodyStructure`-Abfrage über imapflow funktionieren dagegen zuverlässig.
Behoben durch eine minimale, eigene IMAP-Rohimplementierung
(`rawFetchLiteral` in `dashboard-mail-poller/index.ts`) direkt über
`Deno.connectTls`, ausschließlich für den Anhang-Download. Außerdem war der
`pg_net`-Standard-Timeout (5 s) für einen echten IMAP-Abruf zu kurz - im
`pg_cron`-Job und bei manuellen Testaufrufen jetzt `timeout_milliseconds :=
55000` gesetzt.

Manueller Test-Aufruf (holt sofort ab, statt auf den nächsten
15-Minuten-Takt zu warten):
```bash
curl -X POST https://gfyjftwlombhmwirbyse.supabase.co/functions/v1/dashboard-mail-poller \
  -H "Content-Type: application/json" -H "x-cron-secret: wjRIsCww0sGxg9Hf6V45-j02penc_-hZ9azxv6blcVU"
```

Erneut deployen nach Code-Änderungen:
```bash
supabase functions deploy dashboard-mail-poller --project-ref gfyjftwlombhmwirbyse
```

**Fehlerfall**: schlägt das Parsen einer Mail clientseitig fehl (z. B.
unbekanntes Format), wird die `pending_imports`-Zeile auf `status="failed"`
mit Fehlermeldung gesetzt statt endlos erneut versucht zu werden – Abfrage
in Supabase: `select * from pending_imports where status='failed' order by received_at desc;`

---

# Event-Landingpage & Event-Admin (`events/`)

Eigenständige Anwendung im Ordner [`events/`](events/) für die Anmeldung zu
Wertgarantie-Veranstaltungen (**mehrere Veranstaltungen gleichzeitig
möglich**, je mit mehreren Terminen/Orten). **Bewusst vollständig getrennt**
vom Performance-Dashboard: eigenes Supabase-Projekt, eigenes Vercel-Projekt,
eigene Domain, eigener Login – nichts wird zwischen den beiden Anwendungen
geteilt.

**Startseite = Admin-Login, keine öffentliche Übersicht.** Die Domain
(`events.wgaustria.at` bzw. `/`) zeigt standardmäßig das Admin-Panel mit
Login. Jede Veranstaltung bekommt stattdessen einen eigenen, sprechenden
Kurzlink (z.B. `events.wgaustria.at/roadshow-linz`) plus QR-Code zum
Verschicken – es gibt nirgends eine öffentlich einsehbare Liste aller
Veranstaltungen, nur wer einen Link/QR-Code bekommt, kommt zur Anmeldeseite.

- **[`events/index.html`](events/index.html)** – Admin-Panel, eigener Login
  (Supabase Auth dieses Projekts, jeder hier registrierte Nutzer ist Admin).
  Tabs:
  - **Veranstaltungen**: Übersicht aller Veranstaltungen (Titel, Kurzlink,
    Aktiv/Geschlossen-Umschalter, Link & QR-Code, Löschen) sowie Formular zum
    Anlegen einer neuen Veranstaltung. Ein Klick auf „Öffnen" wählt die
    Veranstaltung aus – alle anderen Tabs beziehen sich dann auf sie.
  - **Details**: Titel, Kurzlink (mit „Aus Titel vorschlagen"-Button, frei
    editierbar), Link kopieren/QR-Code anzeigen, Foto (Upload), frei
    editierbare Beschreibung, Datenschutzhinweise
  - **Termine**: Datum, Uhrzeit (von/bis), Veranstaltungsort inkl.
    Straße/PLZ/Ort und Google-Maps-Link – hinzufügen, bearbeiten, löschen; zu
    jedem Termin lässt sich ein **QR-Code** anzeigen/herunterladen (Button
    „QR-Code" in der Termin-Zeile, öffnet sich zusätzlich automatisch direkt
    nach dem Anlegen eines neuen Termins). Der QR-Code verlinkt auf den
    Kurzlink der Veranstaltung mit bereits vorausgewähltem Termin
    (`?termin=<id>`), sodass er z.B. am Veranstaltungsort ausgehängt werden
    kann.
  - **Formularfelder**: Auswahl aus dem festen Katalog (Vorname, Name, PLZ,
    Ort, Geburtsdatum, AKP-Nummer, FH-Nummer, Fachhändler, Telefonnummer,
    E-Mail-Adresse, Anreise mit Auto, sonstige Bemerkungen) inkl.
    Aktiv/Pflichtfeld-Umschalter, Beschriftung und Reihenfolge
  - **E-Mail-Empfänger**: Adressen, die den automatischen täglichen bzw.
    wöchentlichen Gesamt-Anmeldestand dieser Veranstaltung erhalten
  - **Anmeldungen**: Übersicht aller Anmeldungen dieser Veranstaltung inkl.
    Löschen je Anmeldung und CSV-Export (inkl. AKP/FH-Datenbankabgleich)
- **[`events/register.html`](events/register.html)** – öffentliche
  Anmeldeseite (kein Login), nur über den individuellen Kurzlink einer
  Veranstaltung erreichbar (`?event=<slug>`, von Vercel aus `/<slug>`
  umgeschrieben, siehe `events/vercel.json`). Zeigt Titel/Beschreibung/Foto
  der Veranstaltung, bei nur einem Termin dessen Adresse direkt, bei
  mehreren ein Dropdown, und das konfigurierte Anmeldeformular. Ohne
  gültigen/aktiven Kurzlink erscheint nur ein neutraler Hinweis, keine Liste
  anderer Veranstaltungen. Nach dem Absenden wird – sofern die E-Mail-Adresse
  erfasst wurde – automatisch eine Bestätigungsmail verschickt, und im
  Hintergrund unsichtbar der AKP/FH-Datenbankabgleich angestoßen.
- **[`events/admin.html`](events/admin.html)** – nur noch ein Redirect-Stub
  für alte Lesezeichen, leitet auf `/` weiter.

## Supabase-Projekt

Eigenes Projekt **`wgaustria-events`** (Projekt-ID `jtgoytbcqkqopdpjlozq`,
Region `eu-central-1`, Free Tier). Schema: [`events/supabase/schema.sql`](events/supabase/schema.sql)
(Tabellen `events`, `event_dates`, `event_form_fields`, `registrations`,
`email_recipients` + `profiles`/`is_admin` fürs Admin-Login), RLS-abgesichert:
- Anmeldeformular (`registrations`) ist per `INSERT` öffentlich (kein Login),
  Lesen/Löschen nur für eingeloggte Admins.
- `events`, `event_dates`, `event_form_fields` sind öffentlich lesbar
  (nötig für die Anmeldeseite ohne Login), Schreiben nur für Admins. Jede
  Veranstaltung hat einen eindeutigen `slug` (Kurzlink); mehrere
  Veranstaltungen können gleichzeitig `is_active` sein.
- `email_recipients` ist ausschließlich für Admins sichtbar/änderbar.
- Storage-Bucket `event-photos` (öffentlich lesbar, Upload nur für Admins).

### Nutzer-Synchronisation mit dem Dashboard

Das Event-Panel hat **keine eigene Nutzerverwaltung** – jeder Nutzer, der im
Performance-Dashboard angelegt oder gelöscht wird, wird automatisch auch hier
angelegt/gelöscht (alle Dashboard-Nutzer, unabhängig von ihrer Dashboard-Rolle,
bekommen vollen Admin-Zugriff auf das Event-Panel inkl. Teilnehmerdaten). Auch
**Passwörter werden in beide Richtungen synchronisiert**:
- Ändert ein Nutzer sein Passwort im Dashboard selbst (erzwungener
  Passwortwechsel bei Erstlogin), wird dasselbe Passwort automatisch auch im
  Event-Panel gesetzt (dort ohne erneuten Zwang zur Änderung).
- Setzt ein Admin im Dashboard-Nutzerverwaltungspanel das Passwort eines
  Nutzers zurück, wird das Übergangspasswort ebenfalls ins Event-Panel
  übernommen (dort ebenfalls mit Zwang zur Änderung beim nächsten Login).
- Ändert ein Nutzer sein Passwort umgekehrt im Event-Panel selbst (erzwungener
  Passwortwechsel bei Erstlogin nach Sync), wird dasselbe Passwort automatisch
  auch im Dashboard gesetzt.

Das läuft über vier Edge Functions:
- **[`events/supabase/functions/sync-user/index.ts`](events/supabase/functions/sync-user/index.ts)**
  (im Projekt `wgaustria-events`, bereits deployt): nimmt `create`/`delete`/
  `set_password`/`reset_password`/`bulk_create`-Aufrufe vom Dashboard entgegen
  (geschützt durch das Secret `SYNC_SECRET`), sowie die Selbstbedienungs-Aktion
  `syncMyPasswordToDashboard` direkt vom eingeloggten Event-Nutzer (über dessen
  eigenes Auth-Token, kein Secret). Neu synchronisierte Nutzer bekommen das
  Erstpasswort `WertGARANTIE` und müssen es beim ersten Login im Admin-Panel
  ändern (`must_change_password`).
- **[`supabase/functions/admin-users/index.ts`](supabase/functions/admin-users/index.ts)**
  (im Dashboard-Projekt `gfyjftwlombhmwirbyse`, bereits neu deployt): ruft nach
  jedem Anlegen/Löschen/Passwort-Reset eines Dashboard-Nutzers `sync-user` auf,
  sowie über die Selbstbedienungs-Aktion `syncMyPassword` (jeder eingeloggte
  Nutzer für sich selbst) nach eigener Passwortänderung.
- **[`supabase/functions/sync-from-events/index.ts`](supabase/functions/sync-from-events/index.ts)**
  (im Dashboard-Projekt, neu, bereits deployt): Gegenstück zu `sync-user` –
  nimmt Passwort-Updates vom Events-Projekt entgegen, geschützt durch
  `FROM_EVENTS_SYNC_SECRET`.
- Best-effort überall: schlägt ein Sync fehl (z.B. weil ein Secret unten noch
  fehlt), wird die eigentliche Aktion trotzdem ausgeführt, nur der
  `eventsSync`/`dashboardSync`-Status in der Antwort zeigt
  `"not_configured"`/`"failed"` statt `"ok"`.

**Einmalig einzurichtende Secrets** (Supabase-Dashboard → Project Settings →
Edge Functions → Secrets, kein Tool dafür in dieser Session verfügbar):

| Projekt | Secret | Wert |
|---|---|---|
| `wgaustria-events` | `SYNC_SECRET` | *(separat mitgeteilt)* |
| `wgaustria-events` | `DASHBOARD_SYNC_URL` | `https://gfyjftwlombhmwirbyse.supabase.co/functions/v1/sync-from-events` |
| `wgaustria-events` | `DASHBOARD_SYNC_SECRET` | *(separat mitgeteilt)* |
| `gfyjftwlombhmwirbyse` (Dashboard) | `EVENTS_SYNC_URL` | `https://jtgoytbcqkqopdpjlozq.supabase.co/functions/v1/sync-user` |
| `gfyjftwlombhmwirbyse` (Dashboard) | `EVENTS_SYNC_SECRET` | *(identischer Wert wie `SYNC_SECRET` oben)* |
| `gfyjftwlombhmwirbyse` (Dashboard) | `FROM_EVENTS_SYNC_SECRET` | *(identischer Wert wie `DASHBOARD_SYNC_SECRET` oben)* |

**Einmaliger Bulk-Import der bereits bestehenden Dashboard-Nutzer:** Sobald
`SYNC_SECRET` im Projekt `wgaustria-events` gesetzt ist, per `curl` (oder
gleichwertig) einmalig ausführen, um die 9 aktuellen Dashboard-Nutzer ins
Event-Panel zu übernehmen:

```bash
curl -X POST https://jtgoytbcqkqopdpjlozq.supabase.co/functions/v1/sync-user \
  -H "Content-Type: application/json" \
  -H "x-sync-secret: <SYNC_SECRET>" \
  -d '{"action":"bulk_create","users":[
    {"email":"d.szendi@wertgarantie.com","name":"Dominik Szendi"},
    {"email":"f.hasibeder@wertgarantie.com","name":"Florian Hasibeder"},
    {"email":"h.otto@wertgarantie.com","name":"Helmut Otto"},
    {"email":"k.scheiermann@wertgarantie.com","name":"Konstantin Scheiermann"},
    {"email":"k.witting@wertgarantie.com","name":"Klaus Witting"},
    {"email":"p.peisser@wertgarantie.com","name":"Peter Peißer"},
    {"email":"peter@peisser.com","name":"Peter Peißer (ADMIN)"},
    {"email":"s.eigenseer@wertgarantie.com","name":"Sergej Eigenseer"},
    {"email":"t.eitzinger@wertgarantie.com","name":"Thomas Eitzinger"}
  ]}'
```

Danach hat jeder dieser Nutzer im Event-Panel das Erstpasswort `WertGARANTIE`
und wird beim ersten Login zur Passwortänderung aufgefordert.

## AKP/FH-Datenabgleich mit dem Dashboard

Trägt jemand im Anmeldeformular eine AKP- und/oder FH-Nummer ein, wird diese
im Hintergrund (unsichtbar für die anmeldende Person, keinerlei Auswirkung
auf den Anmeldeschritt) mit den echten Stammdaten aus dem
Dashboard-Projekt (`akp_contacts`/`fh_contacts`) abgeglichen. Das Ergebnis
landet in `registrations.matched_akp` und wird im Admin-Panel als Spalte
"DB-Abgleich" sowie mit allen Detailfeldern im CSV-Export angezeigt.

Ablauf über zwei Edge Functions:
- **[`events/supabase/functions/match-registration/index.ts`](events/supabase/functions/match-registration/index.ts)**
  (im Projekt `wgaustria-events`, bereits deployt): wird von `index.html`
  direkt nach jeder Anmeldung mit der neuen `registration_id` aufgerufen,
  liest die eingegebene AKP-/FH-Nummer aus, ruft `lookup-akp` im
  Dashboard-Projekt auf und speichert das Ergebnis in `matched_akp`.
- **[`supabase/functions/lookup-akp/index.ts`](supabase/functions/lookup-akp/index.ts)**
  (im Dashboard-Projekt `gfyjftwlombhmwirbyse`, bereits deployt): sucht in
  `akp_contacts` per AKP-Nummer (liefert dabei auch die hinterlegte
  FH-Nummer mit) und in `fh_contacts` per FH-Nummer, geschützt durch
  `EVENTS_LOOKUP_SECRET`.
- Best-effort: fehlt eine Nummer, gibt es keinen Treffer, oder sind die
  Secrets unten noch nicht gesetzt, bleibt `matched_akp` einfach leer – die
  Anmeldung selbst ist davon nie betroffen.

**Einmalig einzurichtende Secrets** (Supabase-Dashboard → Project Settings →
Edge Functions → Secrets):

| Projekt | Secret | Wert |
|---|---|---|
| `wgaustria-events` | `DASHBOARD_LOOKUP_URL` | `https://gfyjftwlombhmwirbyse.supabase.co/functions/v1/lookup-akp` |
| `wgaustria-events` | `DASHBOARD_LOOKUP_SECRET` | *(separat mitgeteilt)* |
| `gfyjftwlombhmwirbyse` (Dashboard) | `EVENTS_LOOKUP_SECRET` | *(identischer Wert wie `DASHBOARD_LOOKUP_SECRET` oben)* |

## Mailversand (Edge Function `event-mailer`)

[`events/supabase/functions/event-mailer/index.ts`](events/supabase/functions/event-mailer/index.ts)
übernimmt vier Aufgaben:
1. **Bestätigungsmail** an den Anmelder direkt nach dem Absenden des
   Formulars – persönlich in Du-Form ("Hallo Vorname, ... Dein Wertgarantie
   Österreich Team"). Enthält ganz unten einen unauffälligen, klein
   gehaltenen Abmelde-Link ("Kannst du doch nicht kommen? Hier von der
   Veranstaltung abmelden"), der zur statischen Seite
   [`events/abmelden.html`](events/abmelden.html) führt (siehe unten).
2. **Zwei Reminder** an jede Anmeldung mit E-Mail – Betreff `Reminder:
   <normaler Betreff>`, inhaltlich wie die Bestätigungsmail (Termin-Details,
   Maps-Link) plus demselben Abmelde-Link:
   - **72h vor dem Termin** (`registrations.reminder_72h_sent_at`)
   - **am Tag der Veranstaltung ab 12:00 Wiener Ortszeit**, unabhängig von
     der Startzeit (`registrations.reminder_day_sent_at`)

   Beide ausgelöst stündlich über `pg_cron` + `pg_net` (Job
   `event-reminder-check`, siehe unten); die jeweilige `*_sent_at`-Spalte
   verhindert Doppelversand.
3. **Status-Report** (Anmeldestand je Termin/Ort **inkl. Liste der
   angemeldeten Personen**) – **je aktiver Veranstaltung ein eigener Report**
   an genau die für diese Veranstaltung im Admin-Panel (Tab „E-Mail-Empfänger“)
   hinterlegten Empfänger, täglich, wöchentlich oder monatlich, ausgelöst über
   `pg_cron` + `pg_net` (siehe unten). Betreff-Format:
   `<Veranstaltung> // Anmeldezahlen // <Datum> // <Ort>` (bei mehreren
   Terminen einer Veranstaltung z.B. `// 3 Termine` statt einem einzelnen
   Datum/Ort). Bereits im Projekt deployt.
4. **SMTP-Test** (`{"type":"test","to":"..."}`, mit `x-cron-secret`-Header):
   verschickt eine einzelne Testmail, um die SMTP-Verbindung zu prüfen.

### Selbst-Abmeldung (`events/abmelden.html` + Edge Function `cancel-registration`)

Der Abmelde-Link in Bestätigungs-/Reminder-Mails führt zur statischen Seite
[`events/abmelden.html`](events/abmelden.html) (`.../abmelden.html?id=<registration_id>`,
Registrierungs-ID als UUID-Zugriffs-Token, kein Login nötig) – **nicht**
direkt zur Edge Function. Grund: Supabase Edge Functions liefern bei
GET-Requests grundsätzlich kein `text/html` aus – die Plattform schreibt
den Content-Type zwangsweise auf `text/plain` um (offiziell dokumentiertes
Verhalten, kein Bug), wodurch ein direkter Funktions-Link im Browser nur
den rohen HTML-Quelltext als Text angezeigt hätte statt einer gerenderten
Seite.

`abmelden.html` ruft dafür
[`events/supabase/functions/cancel-registration/index.ts`](events/supabase/functions/cancel-registration/index.ts)
per `fetch()` als reine JSON-API auf. **GET** liefert nur Anzeige-Infos
(Termin, ob eine Abmeldung noch möglich ist) und löscht nichts; **POST**
löscht wirklich. Die Seite löst den POST erst beim tatsächlichen Klick auf
den "Ja, endgültig abmelden"-Button aus, nicht schon beim Laden – Grund:
Firmen-Mailgateways rufen Links in eingehenden Mails automatisch per GET
ab, um sie auf Schadsoftware zu prüfen ("Link-Prefetching"); ein sofort
löschendes GET würde dadurch Anmeldungen löschen, ohne dass die Person die
Mail überhaupt gesehen hat (das ist real passiert). Die Function prüft bei
beiden Methoden serverseitig die 48h-Frist (Zeitzone Europa/Wien,
DST-sicher); ist sie bereits vorbei, zeigt die Seite einen Hinweis, sich
direkt an die Veranstaltung zu wenden.

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
| `CRON_SECRET` | *(separat mitgeteilt)* |
| `SYNC_SECRET` | *(separat mitgeteilt, für die Nutzer-Synchronisation, siehe oben)* |

Erneut deployen nach Code-Änderungen:
```bash
supabase functions deploy event-mailer --project-ref jtgoytbcqkqopdpjlozq
```

## Automatischer Report – täglich/wöchentlich/monatlich (`pg_cron`)

Drei `pg_cron`-Jobs im Projekt `wgaustria-events` rufen `event-mailer` mit
`{"type":"report","frequency":"daily"|"weekly"|"monthly"}` auf:
- `event-daily-report`: täglich um 06:00 UTC
- `event-weekly-report`: montags um 06:00 UTC
- `event-monthly-report`: am 1. jedes Monats um 06:00 UTC

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
