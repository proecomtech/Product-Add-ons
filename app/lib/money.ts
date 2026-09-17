/**
 * Money helpers shared by the admin UI and the server.
 *
 * Prices are held as integer minor units (cents) everywhere. Floats are only
 * ever produced at the edges, for display: 0.1 + 0.2 is the reason a cart
 * subtotal can disagree with checkout by a cent.
 *
 * This file has no `.server` suffix on purpose — the group editor runs these in
 * the browser, so they must be safe to bundle for the client.
 */

/** Minor units to the decimal string the Admin API wants: 450 -> "4.50". */
export function centsToMoney(cents: number): string {
  return (cents / 100).toFixed(2);
}

/**
 * Parses what a merchant typed into minor units.
 *
 * Accepts "4", "4.5", "4.50" and the comma decimal separator used across most
 * of Europe. Returns null for anything else — including an empty string — so
 * the caller can tell "they typed nothing" from "they typed zero".
 */
export function moneyToCents(value: string): number | null {
  const normalized = value.trim().replace(",", ".");
  if (normalized === "") return null;
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  return Math.round(Number(normalized) * 100);
}

/** Formats cents for display, e.g. 450 + "USD" -> "$4.50". */
export function formatMoney(cents: number, currencyCode: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currencyCode,
    }).format(cents / 100);
  } catch {
    // An unknown currency code should not blank the page.
    return `${centsToMoney(cents)} ${currencyCode}`;
  }
}
