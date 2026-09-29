/**
 * Section 6.1 - income basis normalization.
 *
 * DECISION (documented in DECISIONS.md): the spec leaves the divisor for
 * semimonthly / biweekly / weekly bases as "pick and document one". We treat
 * `stated_income_amount` as an annualized figure for every non-monthly basis
 * and always divide by 12, so the "monthly equivalent" is coherent
 * regardless of how the basis is spelled. Change BASIS_DIVISORS to switch.
 */
export type IncomeBasis = "annual" | "semimonthly" | "biweekly" | "weekly" | "monthly";

export const BASIS_DIVISORS: Record<IncomeBasis, number> = {
  annual: 12,
  semimonthly: 12,
  biweekly: 12,
  weekly: 12,
  monthly: 1,
};

/** Months in the verification window. */
export const WINDOW_MONTHS = 4;

export function normalizeBasis(raw: string | null | undefined): IncomeBasis {
  const s = (raw ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (s.includes("annual") || s.includes("year")) return "annual";
  if (s.includes("semimonthly") || s.includes("semimonth")) return "semimonthly";
  if (s.includes("biweekly") || s.includes("fortnight") || s.includes("everytwoweeks")) {
    return "biweekly";
  }
  if (s.includes("week")) return "weekly";
  return "monthly";
}

export function monthlyEquivalent(amount: number, basis: string | null | undefined): number {
  return amount / BASIS_DIVISORS[normalizeBasis(basis)];
}
