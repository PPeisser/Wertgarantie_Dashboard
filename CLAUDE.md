# Wertgarantie Performance Dashboard

Internes Dashboard für Außendienst/Trainer (AT+DE): Fachhändler (FH)-,
AKP- und AKQ-Betreuung, Performance Dialog, Auswertungen, Trainerbetreuung,
Events. Repo: `PPeisser/Wertgarantie_Dashboard`.

## Architektur (wichtig für JEDE Änderung)

- **Zwei Twin-Dateien, IMMER byte-identisch:** `index.html` und
  `wertgarantie-performance-dashboard-v2.html`. Nach JEDER Änderung prüfen
  (`diff -q index.html wertgarantie-performance-dashboard-v2.html`) bzw.
  synchronisieren (`cp index.html wertgarantie-performance-dashboard-v2.html`),
  **bevor** committet wird.
- Single-File-SPA ohne Build-Schritt, ohne Bundler, ohne Framework - reines
  HTML/CSS/JS in einer Datei (~14.500 Zeilen). Läuft komplett client-seitig
  gegen Supabase (supabase-js per CDN-Script im `<script>`-Tag).
- Deployment: Vercel-Projekt `wertgarantie-dashboard` (Team `wertgarantie`),
  Live-Domain `dashboard.wgaustria.at`. Automatischer Deploy bei jedem Push
  (Production bei `main`, Preview bei Feature-Branches).
- Backend: Supabase-Projekt `gfyjftwlombhmwirbyse`. Edge Functions unter
  `supabase/functions/*/index.ts` (Deno) für serverseitige Cron-/Mail-
  Aufgaben (u.a. `dashboard-mail-poller`, `auswertung-scheduled-mail`,
  `performance-dialog-reminder`, `trainerbetreuung-weekly-mail`,
  `event-daily-report`). Geplant via `pg_cron` + `net.http_post` (Header
  `x-cron-secret`, Secret-Wert im Supabase Dashboard unter Edge Functions →
  Secrets, nicht im Repo).
- Keine lokale Migrations-Historie im Repo - Schema-Änderungen gehen direkt
  per Supabase-MCP-Tool (`apply_migration`) live ins Projekt.
  `supabase/schema.sql` ist nur eine lose Referenz, nicht zwingend aktuell.

## Git-Workflow (verbindlich)

- Entwicklungsbranch: `claude/wertgarantie-migration-edge-deploy-a172du`.
- **Immer** auf den Feature-Branch pushen.
- **Nur** auf `main` pushen, wenn der Nutzer das explizit sagt ("push auf
  main" o.ä.) - sonst nie, auch nicht nach einem bestätigten Fix.
- Commit-Messages: deutsch, mit Root-Cause-Erklärung bei Bugfixes, Datum im
  Bug-Report-Stil ("Bug-Report DD.MM.YYYY: ...").

## Verifikations-Workflow (für jede Code-Änderung)

1. Twin-Sync prüfen/herstellen (siehe oben).
2. Node-Syntax-Check: `<script>`-Blöcke aus der HTML extrahieren und mit
   `new Function(s)` prüfen (CDN-Blöcke wie supabase-js/xlsx/jspdf dabei
   überspringen).
3. Bei funktionalen Änderungen: Playwright-Offline-Test. Immer
   `window.supabase.createClient()` per `page.addInitScript()` **vor**
   `page.goto()` stubben, danach `sb.from`/`sb.storage` per
   `page.evaluate()` monkey-patchen (nie `sb` selbst neu zuweisen, ist
   `const`). Lokaler Server: `python3 -m http.server 8917` im Scratchpad,
   Testseite unter `preview/test.html` (Kopie der aktuellen `index.html`).
   Browser-Start: `chromium.launch({ executablePath:
   '/opt/pw-browsers/chromium' })` (vorinstallierte Version - NICHT
   `npx playwright install` ausführen).
4. Commit + Push wie oben.

## Zentrale State-/Auth-Konzepte

- `sb` - Supabase-Client. `supaUser` - aktueller Auth-User. `myName`/
  `myRole` (`admin`|`aussendienst`|`trainer`) - aus Tabelle `profiles`.
- `state.latest` - zuletzt eingespielter Tages-Snapshot (Produktion,
  FH-Liste, AKP, AKQ, GL-Summen, ...). `state.dailyX` (`dailyGL`, `dailyFH`,
  `dailyAKP`, `dailyGLTotals`, `dailyFHTotals`, `dailyAktivierungsquote`) -
  Tageshistorien. Alles zusammen EIN großer JSON-Blob im Key-Value-Store
  `dashboard_kv` (Key `"wg-state"`), geladen/gespeichert über
  `loadAll()`/`saveData()`.
- `EMPLOYEES` (Array echter Mitarbeiternamen), `PERS_JAHRESZIELE`/
  `PERS_MIETEZIELE`/`AKQ_STAFFEL_ZIEL`/`PERF_GOALS_BY_EMPLOYEE` - geladen
  über `loadEmployees()` aus Tabelle `employees`. `matchEmployee(glRaw)`
  löst einen rohen GL-Namen aus einem Report über `EMP_NORM` (inkl.
  `match_aliases`) auf einen `EMPLOYEES`-Eintrag auf.
  **Wichtige Lektion (Vorfall 29.09.2026):** Jede Stelle, die beim
  Einspielen eines Reports `matchEmployee()` aufruft, muss sicherstellen,
  dass `EMPLOYEES`/`EMP_NORM` bereits geladen sind - sonst landen Daten
  unter falscher/fehlender Zuordnung. `processPendingImports()` hat dafür
  einen Guard (lädt bei Bedarf nach, bricht sonst komplett ab statt falsch
  zu mergen) - als Vorlage für ähnliche neue Importpfade verwenden.
- Admin-Feature-Toggles: Pattern `let xyzEnabled=false;` + `dashboard_kv`-
  Key `"xyz_enabled"` (`"1"`/sonst) + Checkbox im Admin-Panel. Neue
  Features defaulten i.d.R. auf `false`, bis ein Admin sie aktiviert.
- Modals: `.modal-bg` (Backdrop, Standard-z-index 50) > `.modal` (max
  430px) oder `.modal.wide` (max 760px, hat `max-height:85vh;overflow:
  auto`). Schließen-Button wird individuell pro Modal-ID verdrahtet
  (`{modalId}Close`), kein Click-Outside-Handler. Bei verschachtelten
  Modals auf z-index-Tier achten (Beispiele: `#fhModal`=60, `#akpModal`=65,
  `#pdfTargetModal`=70).
- DB-Konvention: `created_by`/`updated_by uuid references auth.users(id)`,
  RLS meist `"Authenticated all <table>"` (`for all to authenticated using
  (true) with check (true)`) - dieses Projekt vertraut angemeldeten Nutzern
  intern, keine feingranulare Row-Security pro Mitarbeiter.

## Bekannter aktueller Zustand (Stand 03.10.2026)

Abgeschlossen und produktiv: Performance Dialog, AKP-/FH-Kontaktdatenbank,
Trainerbetreuung, automatische Auswertungs-Mails (wiederkehrend, VJ/VVJ),
Virtuelle Mitarbeiter + Ranking, Mitarbeiter-DB-Fundament, Rollen/Admin-
Grundgerüst.

Zuletzt behoben: Mail-Poller-Absturz bei großen Anhängen
(`dashboard-mail-poller`, speichereffizienter IMAP-Read/Base64-Decode) und
ein Datenkorruptions-Bug (leere Mitarbeiterliste beim Einspielen führte zu
falscher GL-Zuordnung in FH/AKP/AKQ/Mitarbeiter-Summen - Daten repariert,
Code gehärtet).

Offen, nicht dringend: "Leaked Password Protection" in Supabase Auth ist
deaktiviert (nur manuell im Supabase-Dashboard aktivierbar).

## Orientierung in der Datei

Bei ~14.500 Zeilen lohnt sich kein Komplett-Read. Funktionsnamen folgen
Konventionen: `render*` (DOM-Ausgabe einer View/Kachel), `load*` (initiales
Nachladen aus Supabase), `sync*` (Hintergrund-Abgleich nach Einspielung),
`fh*`/`akp*`/`akq*`/`emp*`/`perf*` (Domänen-Präfix). Gezielt mit Grep
suchen statt die Datei komplett zu lesen.
