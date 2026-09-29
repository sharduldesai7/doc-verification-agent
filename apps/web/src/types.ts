export type ResultState = "Approve" | "Manual Review" | "Error";
export type CheckStatus = "pass" | "fail" | "warn" | "skipped";

export interface Check { id: string; title: string; status: CheckStatus; reason: string }

export interface EvidenceItem { amount: number | null; label: string | null; periodScope: string | null }
export interface PayEvidence {
  gross: EvidenceItem; deductions: EvidenceItem; net: EvidenceItem;
  additionalComponents: { label: string; amount: number | null; periodScope: string | null }[];
  periodContext: { payPeriodText: string | null; notes: string | null };
}
export interface PayValidation {
  status: "consistent" | "inconsistent" | "unresolved";
  reasons: string[];
  grossMinor: number | null; deductionsMinor: number | null; printedNetMinor: number | null; expectedNetMinor: number | null;
  minorUnitDigits: number;
}
export interface EmployerAggregate {
  employerGroup: string; matchesStatedEmployer: boolean; identifiedPayslips: number;
  countedPayslips: number; countedGrossTotal: number; countedMonths: string[]; isWorkingGroup: boolean;
}

export interface Receipt {
  submissionId: string; applicationId: string; stage: string; publicStatus: PublicStatus; documentCount: number; submittedAt: string;
}
export type PublicStatus = "processing" | "verified" | "under_review";
export interface PublicStatusResponse {
  submissionId: string; applicationId: string; publicStatus: PublicStatus; documentCount: number; submittedAt: string; completedAt: string | null;
}

export interface Stats {
  total: number; approve: number; manualReview: number; error: number; processing: number;
  approvalRate: number | null; medianProcessingSeconds: number | null;
}

export interface SubmissionListItem {
  id: string; applicationId: string; applicantName: string | null; employerName: string | null;
  stage: "processing" | "complete"; resultState: ResultState | null; resultDescription: string;
  documentCount: number; incomeRatio: number | null; hasReport: boolean; submittedAt: string; completedAt: string | null;
}

export interface SubmissionDetail {
  id: string; applicationId: string; stage: "processing" | "complete"; resultState: ResultState | null; resultDescription: string;
  statedApplicantName: string | null; statedEmployerName: string | null; statedIncomeAmount: number | null;
  statedIncomeBasis: string | null; statedMonthlyIncome: number | null; statedCurrency: string | null;
  documentCount: number; expectedWindowIncome: number | null; calculatedAggregateIncome: number | null; incomeRatio: number | null;
  expectedMonths: string[]; employerAggregates: EmployerAggregate[]; checks: Check[];
  hasReport: boolean; errorMessage: string | null; submittedAt: string; completedAt: string | null;
}

export interface DocumentDetail {
  id: string; fileName: string; mimeType: string; isPayslip: boolean | null; documentType: string | null;
  employerName: string | null; applicantName: string | null; grossPay: number | null; netPay: number | null;
  payDate: string | null; payPeriodStart: string | null; payPeriodEnd: string | null; payMonth: string | null;
  payFrequency: string | null; currency: string | null; payEvidence: PayEvidence | null; payValidation: PayValidation | null;
  extractionMetadata: { status: string; error?: string; model?: string; latencyMs?: number } | null;
  employerGroup: string | null; inWindow: boolean; includedInAggregate: boolean; exclusionReasons: string[]; notes: string | null;
}

export interface ApplicationRow {
  applicationId: string; applicantName: string | null; employerName: string | null; statedIncomeAmount: number | null;
  statedIncomeBasis: string | null; statedMonthlyIncome: number | null; currency: string | null;
  sourceFileName: string | null; importedAt: string; submissionCount: number;
}
export interface ImportSummary { imported: number; updated: number; skipped: number; warnings: string[] }
