/**
 * Pricing math for product discounts.
 *
 * Backend stores `price` (original) and `discount_percent` (0–90) separately.
 * The UI never persists a "sale price" — it derives it here, in one place,
 * so the listing page, detail page, cart, and checkout all agree.
 *
 * When we switch from USD to NGN, only `formatPrice` needs to change.
 */

export interface Priceable {
  price: number;
  discountPercent?: number | null;
}

/** Clamp to the same range the DB enforces, defending against bad payloads. */
function normalizeDiscount(d: number | null | undefined): number {
  if (!d || !Number.isFinite(d)) return 0;
  if (d <= 0) return 0;
  if (d >= 90) return 90;
  return d;
}

/** The price the customer actually pays (after discount). */
export function effectivePrice(p: Priceable): number {
  const d = normalizeDiscount(p.discountPercent ?? 0);
  if (d === 0) return p.price;
  return p.price * (1 - d / 100);
}

/** How much the customer saves vs. the original price. */
export function savings(p: Priceable): number {
  const diff = p.price - effectivePrice(p);
  return diff > 0 ? diff : 0;
}

/** True when there's a non-trivial discount worth showing in the UI. */
export function hasDiscount(p: Priceable): boolean {
  return normalizeDiscount(p.discountPercent ?? 0) > 0;
}

/** Single-source currency formatter.
 *
 * NGN is whole-kobo at the gateway but customers expect to see whole-naira
 * amounts in the UI (e.g. ₦15,000 not ₦15,000.00). We render with grouping
 * commas and no fractional digits.
 *
 * If we ever go multi-currency, only this function changes.
 */
export function formatPrice(amount: number): string {
  const safe = Number.isFinite(amount) ? amount : 0;
  return `₦${Math.round(safe).toLocaleString("en-NG")}`;
}

// ── Cart / checkout constants ────────────────────────────────────────────
// Single source so the cart page, checkout page, and marketing copy can't
// drift out of sync. Tweak here if business rules change.
/** Orders at/above this NGN amount ship free. */
export const FREE_SHIPPING_THRESHOLD = 50_000;
/** Flat shipping fee (NGN) when below the free-shipping threshold. */
export const SHIPPING_FEE = 1_500;
/** Nigerian VAT rate, applied to subtotal. */
export const TAX_RATE = 0.075;
