import type { EngineDocument, EngineInput, PayEvidence, StatedIncome } from "../src/verification/types";

export const SUBMITTED = new Date("2026-09-15T10:00:00Z"); // window: 2026-08, 07, 06, 05

export const STATED: StatedIncome = {
  applicantName: "Jane Q Doe",
  employerName: "Acme Corp",
  incomeAmount: 60000,
  incomeBasis: "annual",
  monthlyIncome: 5000,
  currency: "USD",
};
// annual 60000 / 12 * 4 = 20000 target

export function evidence(gross: number, deductions: number, net: number, over: Partial<PayEvidence> = {}): PayEvidence {
  return {
    gross: { amount: gross, label: "Gross Pay", periodScope: "Current period" },
    deductions: { amount: deductions, label: "Total Deductions", periodScope: "Current period" },
    net: { amount: net, label: "Net Pay", periodScope: "Current period" },
    additionalComponents: [],
    periodContext: { payPeriodText: null, notes: null },
    ...over,
  };
}

let n = 0;
export function slip(payDate: string | null, over: Partial<EngineDocument> = {}, gross = 5000): EngineDocument {
  n += 1;
  return {
    id: `d${n}`,
    fileName: `slip-${n}.png`,
    extractionOk: true,
    isPayslip: true,
    employerName: "Acme Corp",
    applicantName: "Jane Doe",
    grossPay: gross,
    netPay: gross - 1000,
    payDate,
    payPeriodEnd: payDate,
    currency: "USD",
    payEvidence: evidence(gross, 1000, gross - 1000),
    ...over,
  };
}

export const FOUR_MONTHS = ["2026-08-31", "2026-07-31", "2026-06-30", "2026-05-31"];
export const goodSlips = (gross = 5000) => FOUR_MONTHS.map((d) => slip(d, {}, gross));

export function input(documents: EngineDocument[], stated: Partial<StatedIncome> = {}, submittedAt = SUBMITTED): EngineInput {
  return { submittedAt, stated: { ...STATED, ...stated }, documents };
}
