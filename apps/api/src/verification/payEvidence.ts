import type { EngineDocument, EvidenceItem, PayEvidence, PayValidation } from "./types";

/**
 * Section 6.4 - pay-evidence validation and minor-unit reconciliation.
 */

/** Decimal places per ISO 4217 currency. Anything not listed uses 2. */
export const MINOR_UNIT_DIGITS: Record<string, number> = {
  // 0 decimals
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0, PYG: 0,
  RWF: 0, UGX: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  // 3 decimals
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
  // 2 decimals (listed explicitly for the common ones)
  USD: 2, EUR: 2, GBP: 2, CAD: 2, AUD: 2, NZD: 2, CHF: 2, INR: 2, SGD: 2,
  HKD: 2, CNY: 2, MXN: 2, BRL: 2, ZAR: 2, SEK: 2, NOK: 2, DKK: 2,
};

export function minorUnitDigits(currency: string | null | undefined): number {
  if (!currency) return 2;
  return MINOR_UNIT_DIGITS[currency.trim().toUpperCase()] ?? 2;
}

export function toMinor(amount: number, currency: string | null | undefined): number {
  const factor = 10 ** minorUnitDigits(currency);
  // toPrecision on the *product* guards against binary-float artefacts such as 1.005 * 100 = 100.4999...
  return Math.round(Number((amount * factor).toPrecision(15)));
}

/** Printed-label allowlists, role specific. Matching is whole-phrase. */
export const LABEL_ALLOWLIST = {
  gross: [
    "gross pay", "total gross pay", "gross earnings", "total gross earnings",
    "gross wages", "total gross wages", "gross salary", "gross income",
    "total gross", "gross amount", "total earnings", "gross",
  ],
  deductions: [
    "total deductions", "total deduction", "deductions", "total withholdings",
    "total taxes and deductions", "total employee deductions", "deductions total",
  ],
  net: [
    "net pay", "net income", "net earnings", "net wages", "net salary",
    "net amount", "take home pay", "take home", "net payment",
  ],
} as const;

/** Amounts tied to any of these are not current-period figures. */
const REJECT_PATTERN =
  /\b(ytd|year to date|cumulative|cumul|taxable|fica|subject to|prior|previous|prev|last|next|this year|annual|yearly)\b/;
const CURRENT_PATTERN = /\b(current|curr|this|present|period)\b/;

function normalizeText(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function labelAllowed(role: keyof typeof LABEL_ALLOWLIST, label: string | null): boolean {
  const n = ` ${normalizeText(label)} `;
  if (n.trim() === "") return false;
  return LABEL_ALLOWLIST[role].some((phrase) => n.includes(` ${phrase} `));
}

interface RoleOutcome {
  inconsistent: string[];
  unresolved: string[];
}

function checkRole(
  role: keyof typeof LABEL_ALLOWLIST,
  item: EvidenceItem,
  out: RoleOutcome,
): void {
  const name = role;
  if (item.amount === null || !Number.isFinite(item.amount)) {
    out.unresolved.push(`No printed ${name} amount was extracted.`);
    return;
  }
  const combined = normalizeText(`${item.label ?? ""} ${item.periodScope ?? ""}`);
  if (REJECT_PATTERN.test(combined)) {
    out.inconsistent.push(
      `${name} amount is tied to a non-current-period figure ("${item.label ?? ""}" / "${item.periodScope ?? ""}").`,
    );
    return;
  }
  if (!labelAllowed(role, item.label)) {
    out.unresolved.push(`${name} label "${item.label ?? ""}" is not a recognised printed label.`);
    return;
  }
  if (!CURRENT_PATTERN.test(normalizeText(item.periodScope))) {
    out.unresolved.push(`${name} amount is not shown to be for the current pay period.`);
  }
}

export function validatePayEvidence(
  doc: Pick<EngineDocument, "grossPay" | "netPay" | "currency" | "payEvidence">,
  fallbackCurrency: string | null,
): PayValidation {
  const currency = doc.currency ?? fallbackCurrency;
  const digits = minorUnitDigits(currency);
  const base: PayValidation = {
    status: "unresolved",
    reasons: [],
    currency: currency ?? null,
    minorUnitDigits: digits,
    grossMinor: null,
    deductionsMinor: null,
    printedNetMinor: null,
    expectedNetMinor: null,
  };
  const evidence: PayEvidence | null = doc.payEvidence;
  if (!evidence) {
    return { ...base, reasons: ["No pay evidence was extracted from this document."] };
  }

  const out: RoleOutcome = { inconsistent: [], unresolved: [] };
  checkRole("gross", evidence.gross, out);
  checkRole("deductions", evidence.deductions, out);
  checkRole("net", evidence.net, out);

  // Top-level extracted figures must agree with the printed evidence.
  const crossChecks: Array<[string, number | null, number | null]> = [
    ["grossPay", doc.grossPay, evidence.gross.amount],
    ["netPay", doc.netPay, evidence.net.amount],
  ];
  for (const [field, top, printed] of crossChecks) {
    if (top !== null && printed !== null && Math.abs(toMinor(top, currency) - toMinor(printed, currency)) > 1) {
      out.inconsistent.push(`${field} (${top}) differs from the printed evidence amount (${printed}).`);
    }
  }

  if (out.inconsistent.length > 0) {
    return { ...base, status: "inconsistent", reasons: [...out.inconsistent, ...out.unresolved] };
  }
  if (out.unresolved.length > 0) {
    return { ...base, status: "unresolved", reasons: out.unresolved };
  }

  const grossMinor = toMinor(evidence.gross.amount!, currency);
  const deductionsMinor = toMinor(Math.abs(evidence.deductions.amount!), currency);
  const printedNetMinor = toMinor(evidence.net.amount!, currency);
  const expectedNetMinor = grossMinor - deductionsMinor;
  const filled = { ...base, grossMinor, deductionsMinor, printedNetMinor, expectedNetMinor };

  // Tolerance is exactly one minor unit.
  if (Math.abs(expectedNetMinor - printedNetMinor) > 1) {
    return {
      ...filled,
      status: "inconsistent",
      reasons: [
        `Gross minus deductions (${expectedNetMinor}) does not match printed net (${printedNetMinor}) within 1 minor unit.`,
      ],
    };
  }
  return { ...filled, status: "consistent", reasons: [] };
}
