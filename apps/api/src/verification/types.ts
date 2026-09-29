export type CheckId =
  | "documents_readable"
  | "payslips_identified"
  | "pay_evidence_consistency"
  | "employer_match"
  | "single_employer"
  | "applicant_match"
  | "applicant_consistent"
  | "payslip_count"
  | "month_coverage"
  | "currency_match"
  | "income_within_band";

/** Fixed evaluation order (Section 6.5). Do not reorder. */
export const CHECK_ORDER: readonly CheckId[] = [
  "documents_readable",
  "payslips_identified",
  "pay_evidence_consistency",
  "employer_match",
  "single_employer",
  "applicant_match",
  "applicant_consistent",
  "payslip_count",
  "month_coverage",
  "currency_match",
  "income_within_band",
] as const;

export type CheckStatus = "pass" | "fail" | "warn" | "skipped";

export interface CheckResult {
  id: CheckId;
  title: string;
  status: CheckStatus;
  reason: string;
  evidence: Record<string, unknown>;
}

export type ResultState = "Approve" | "Manual Review" | "Error";

/** One printed amount as transcribed from the document. */
export interface EvidenceItem {
  amount: number | null;
  /** Label exactly as printed next to the amount, e.g. "Gross Pay". */
  label: string | null;
  /**
   * Which period the printed amount covers, as the document shows it,
   * e.g. "current", "this period", "YTD". Null when the document does not say.
   */
  periodScope: string | null;
}

export interface AdditionalComponent {
  label: string;
  amount: number | null;
  periodScope: string | null;
}

export interface PayEvidence {
  gross: EvidenceItem;
  deductions: EvidenceItem;
  net: EvidenceItem;
  additionalComponents: AdditionalComponent[];
  periodContext: { payPeriodText: string | null; notes: string | null };
}

export type EvidenceStatus = "consistent" | "inconsistent" | "unresolved";

export interface PayValidation {
  status: EvidenceStatus;
  reasons: string[];
  currency: string | null;
  minorUnitDigits: number;
  grossMinor: number | null;
  deductionsMinor: number | null;
  printedNetMinor: number | null;
  expectedNetMinor: number | null;
}

/** What the engine needs to know about one uploaded document. */
export interface EngineDocument {
  id: string;
  fileName: string;
  /** False when the AI call failed or its response failed schema validation. */
  extractionOk: boolean;
  extractionError?: string | null;
  isPayslip: boolean | null;
  employerName: string | null;
  applicantName: string | null;
  grossPay: number | null;
  netPay: number | null;
  /** ISO date (YYYY-MM-DD) or null. */
  payDate: string | null;
  payPeriodEnd: string | null;
  currency: string | null;
  payEvidence: PayEvidence | null;
}

export interface StatedIncome {
  applicantName: string | null;
  employerName: string | null;
  incomeAmount: number | null;
  incomeBasis: string | null;
  monthlyIncome: number | null;
  currency: string | null;
}

export interface EngineInput {
  /** Anchor for the four-month window. Must be the submission time, not completion time. */
  submittedAt: Date;
  stated: StatedIncome;
  documents: EngineDocument[];
}

export interface DocumentAnnotation {
  id: string;
  payMonth: string | null;
  employerGroup: string | null;
  inWindow: boolean;
  includedInAggregate: boolean;
  exclusionReasons: string[];
  payValidation: PayValidation | null;
}

export interface EmployerAggregate {
  employerGroup: string;
  matchesStatedEmployer: boolean;
  identifiedPayslips: number;
  countedPayslips: number;
  countedGrossTotal: number;
  countedMonths: string[];
  isWorkingGroup: boolean;
}

export interface EngineResult {
  resultState: ResultState;
  resultDescription: string;
  checks: CheckResult[];
  documents: DocumentAnnotation[];
  employerAggregates: EmployerAggregate[];
  expectedMonths: string[];
  /** Monthly-equivalent stated income x 4, in major units. Null when unresolvable. */
  expectedWindowIncome: number | null;
  /** Sum of counted gross pay, in major units. Null when no ratio was computed. */
  calculatedAggregateIncome: number | null;
  /** Rounded to 4 decimal places. Null when not computed (never defaulted to 0). */
  incomeRatio: number | null;
}
