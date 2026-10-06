// Temporaeres Debug-Tool (04./05.09.2026) zur Diagnose des Mistral-Modell-
// Tier-Fehlers - Zweck erfuellt, deaktiviert (kein delete_edge_function-Tool
// verfuegbar). verify_jwt:true entfernt den bisher offenen Zugriff.
Deno.serve(() => new Response("disabled", { status: 410 }));
