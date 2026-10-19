// Gemeinsame Helfer der After-Sales Edge Functions.

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-sync-secret, apikey, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

export function escapeHtml(s: unknown) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string
  ));
}

// Öffentliche Basis-URL der After-Sales-App (Landingpage-Links, Logo in Mails).
export function appUrl(): string {
  return (Deno.env.get("AS_APP_URL") || "https://wertgarantie-aftersales.vercel.app").replace(/\/+$/, "");
}
export function functionsUrl(): string {
  return Deno.env.get("SUPABASE_URL")!.replace(/\/+$/, "") + "/functions/v1";
}

export function fmtDate(d: string | null | undefined): string {
  if (!d) return "–";
  const s = String(d);
  const dt = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + "T00:00:00") : new Date(s);
  if (isNaN(dt.getTime())) return s;
  return dt.toLocaleDateString("de-AT", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Europe/Vienna" });
}
export function fmtDateTime(d: string | Date): string {
  const dt = d instanceof Date ? d : new Date(d);
  return dt.toLocaleString("de-AT", {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Vienna",
  });
}

// Kurze, für Kunden lesbare Referenz aus der Datensatz-ID.
export function reference(id: string): string {
  return "AS-" + id.replace(/-/g, "").slice(0, 8).toUpperCase();
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
