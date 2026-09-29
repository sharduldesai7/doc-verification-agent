import {
  boolean, doublePrecision, index, integer, jsonb, numeric, pgTable, text, timestamp,
} from "drizzle-orm/pg-core";
import type { CheckResult, EmployerAggregate, PayEvidence, PayValidation } from "../verification/types";

/** Reference / answer-key rows. Upserted by application_id on import. */
export const applications = pgTable("applications", {
  applicationId: text("application_id").primaryKey(),
  applicantName: text("applicant_name"),
  employerName: text("employer_name"),
  statedIncomeAmount: numeric("stated_income_amount", { precision: 14, scale: 2, mode: "number" }),
  statedIncomeBasis: text("stated_income_basis"),
  statedMonthlyIncome: numeric("stated_monthly_income", { precision: 14, scale: 2, mode: "number" }),
  currency: text("currency"),
  sourceFileName: text("source_file_name"),
  importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One row per verification run.
 * `application_id` is deliberately NOT a foreign key: purging reference data
 * must never remove historical submissions (FR10 / AC9). The stated_* columns
 * are an immutable snapshot taken at submission time (FR2).
 */
export const submissions = pgTable(
  "submissions",
  {
    id: text("id").primaryKey(),
    applicationId: text("application_id").notNull(),
    stage: text("stage", { enum: ["processing", "complete"] }).notNull().default("processing"),
    resultState: text("result_state", { enum: ["Approve", "Manual Review", "Error"] }),
    /** Empty string while pending, by design (Section 13). */
    resultDescription: text("result_description").notNull().default(""),
    statedApplicantName: text("stated_applicant_name"),
    statedEmployerName: text("stated_employer_name"),
    statedIncomeAmount: numeric("stated_income_amount", { precision: 14, scale: 2, mode: "number" }),
    statedIncomeBasis: text("stated_income_basis"),
    statedMonthlyIncome: numeric("stated_monthly_income", { precision: 14, scale: 2, mode: "number" }),
    statedCurrency: text("stated_currency"),
    documentCount: integer("document_count").notNull(),
    expectedWindowIncome: doublePrecision("expected_window_income"),
    calculatedAggregateIncome: doublePrecision("calculated_aggregate_income"),
    incomeRatio: doublePrecision("income_ratio"),
    expectedMonths: text("expected_months").array().notNull().default([]),
    employerAggregates: jsonb("employer_aggregates").$type<EmployerAggregate[]>().notNull().default([]),
    checks: jsonb("checks").$type<CheckResult[]>().notNull().default([]),
    hasReport: boolean("has_report").notNull().default(false),
    reportObjectPath: text("report_object_path"),
    errorMessage: text("error_message"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    index("submissions_application_id_idx").on(t.applicationId),
    index("submissions_submitted_at_idx").on(t.submittedAt),
  ],
);

export interface ExtractionMetadata {
  provider?: string;
  model?: string;
  latencyMs?: number;
  attempts?: number;
  status: "ok" | "failed" | "pending";
  error?: string;
}

/** One row per uploaded file. Real FK: documents cannot outlive their submission. */
export const documents = pgTable(
  "documents",
  {
    id: text("id").primaryKey(),
    submissionId: text("submission_id")
      .notNull()
      .references(() => submissions.id, { onDelete: "cascade" }),
    fileName: text("file_name").notNull(),
    mimeType: text("mime_type").notNull(),
    objectPath: text("object_path").notNull(),
    isPayslip: boolean("is_payslip"),
    documentType: text("document_type"),
    employerName: text("employer_name"),
    applicantName: text("applicant_name"),
    grossPay: doublePrecision("gross_pay"),
    netPay: doublePrecision("net_pay"),
    payDate: text("pay_date"),
    payPeriodStart: text("pay_period_start"),
    payPeriodEnd: text("pay_period_end"),
    payMonth: text("pay_month"),
    payFrequency: text("pay_frequency"),
    currency: text("currency"),
    payEvidence: jsonb("pay_evidence").$type<PayEvidence | null>(),
    payValidation: jsonb("pay_validation").$type<PayValidation | null>(),
    extractionMetadata: jsonb("extraction_metadata").$type<ExtractionMetadata>(),
    employerGroup: text("employer_group"),
    inWindow: boolean("in_window").notNull().default(false),
    includedInAggregate: boolean("included_in_aggregate").notNull().default(false),
    exclusionReasons: jsonb("exclusion_reasons").$type<string[]>().notNull().default([]),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("documents_submission_id_idx").on(t.submissionId)],
);

export type ApplicationRow = typeof applications.$inferSelect;
export type SubmissionRow = typeof submissions.$inferSelect;
export type DocumentRow = typeof documents.$inferSelect;
