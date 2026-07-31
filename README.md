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
2. **Datenbank-Tabelle anlegen**: Im Supabase-Dashboard → SQL Editor das Skript
   [`supabase/schema.sql`](supabase/schema.sql) einmalig ausführen. Es legt die
   Tabelle `dashboard_kv` an und aktiviert Row Level Security mit Policies, die
   Lese-/Schreibzugriff auf eingeloggte Nutzer beschränken.
3. **Login aktivieren**: Im Supabase-Dashboard → Authentication → Providers ist
   „Email" standardmäßig aktiv. Unter Authentication → Users die
   Mitarbeiter-Logins (E-Mail + Passwort) manuell anlegen.
4. **Nutzung**: Beim Öffnen der Datei erscheint ein Login-Fenster. Nach
   erfolgreicher Anmeldung wird der Datenstand aus Supabase geladen; „Excel
   einspielen" und persönliche Monatsziele schreiben automatisch zurück.
   Über den Button „Abmelden" im Header kann man sich ausloggen.

**Hinweis zum Key**: `sb_publishable_…` ist Supabases neuer öffentlicher
Client-Key (Nachfolger des `anon`-Keys) – er darf im Frontend-Code sichtbar
sein, die eigentliche Absicherung erfolgt über Row Level Security (Schritt 2)
und den Login-Zwang.
