// Preislogik Komplettschutz27 - MUSS identisch zu calcPrice() in
// aftersales/k.html bleiben (Browser zeigt an, Server rechnet beim Abschluss
// verbindlich nach und ignoriert den vom Browser gesendeten Preis).
//
// Nicht-Handys: bis 500 € → 4 €, bis 2.000 € → 6 €, bis 10.000 € → 8 €,
//               bis 15.000 € → 12 €, Premium optional +2 €.
// Handys:       bis 500 € → 7 €, bis 4.000 € → 10 €, Premium immer inklusive.
// Darüber: nicht versicherbar (null).

export const PRODUCT_NAME = "Komplettschutz27";
export const PREMIUM_SURCHARGE = 2;
export const PRICE_PERIOD = "monatlich";

export const MOBILE_CATEGORY = "Mobiltelefon / Smartphone";

export function isMobileDevice(geraet: string | null | undefined): boolean {
  const s = String(geraet || "").toLowerCase();
  return /handy|smartphone|mobiltelefon|mobil-telefon|iphone|mobile phone|^mobil/.test(s);
}

export function basePrice(kaufpreis: number, mobile: boolean): number | null {
  if (!(kaufpreis > 0)) return null;
  const tiers = mobile
    ? [[500, 7], [4000, 10]]
    : [[500, 4], [2000, 6], [10000, 8], [15000, 12]];
  for (const [max, price] of tiers) if (kaufpreis <= max) return price;
  return null;
}

export function calcPrice(kaufpreis: number, geraet: string | null | undefined, premiumWanted: boolean) {
  const mobile = isMobileDevice(geraet);
  const base = basePrice(kaufpreis, mobile);
  if (base === null) return { ok: false as const, mobile, reason: "Für diesen Kaufpreis ist kein Komplettschutz verfügbar." };
  const premium = mobile ? true : !!premiumWanted;
  const surcharge = !mobile && premium ? PREMIUM_SURCHARGE : 0;
  return { ok: true as const, mobile, base, premium, premiumIncluded: mobile, surcharge, total: base + surcharge };
}

// IMEI: 15 Ziffern mit Luhn-Prüfziffer.
export function isValidImei(v: string | null | undefined): boolean {
  const s = String(v || "").replace(/\s|-/g, "");
  if (!/^\d{15}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    let d = +s[i];
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

export function eur(n: number | null | undefined): string {
  if (n === null || n === undefined || isNaN(+n)) return "–";
  return "€ " + (+n).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
