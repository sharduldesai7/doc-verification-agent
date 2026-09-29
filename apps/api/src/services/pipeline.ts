import { and, eq, lt } from "drizzle-orm";
import type { Db } from "../db/client";
import { documents, submissions, type DocumentRow } from "../db/schema";
import type { Logger } from "../logger";
import type { ModelClient } from "../model/client";
import { buildReportPdf } from "../pdf/report";
import type { BlobStorage } from "../storage";
import { verify } from "../verification/engine";
import type { EngineDocument } from "../verification/types";

export interface PipelineDeps {
  db: Db;
  storage: BlobStorage;
  model: ModelClient;
  logger: Logger;
  extractionConcurrency?: number;
}

export const INTERRUPTED_MESSAGE = "Verification was interrupted before it completed. Please resubmit.";

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

function toEngineDoc(d: DocumentRow): EngineDocument {
  const ok = d.extractionMetadata?.status === "ok";
  return {
    id: d.id,
    fileName: d.fileName,
    extractionOk: ok,
    extractionError: d.extractionMetadata?.error ?? null,
    isPayslip: d.isPayslip,
    employerName: d.employerName,
    applicantName: d.applicantName,
    grossPay: d.grossPay,
    netPay: d.netPay,
    payDate: d.payDate,
    payPeriodEnd: d.payPeriodEnd,
    currency: d.currency,
    payEvidence: d.payEvidence ?? null,
  };
}

/**
 * Runs extraction, the deterministic engine and report generation for one
 * submission. Any thrown exception is a pipeline failure and ends in the
 * terminal `Error` state; a failed *check* is a Manual Review, not an Error.
 */
export async function processSubmission(deps: PipelineDeps, submissionId: string): Promise<void> {
  const { db, storage, model } = deps;
  const log = deps.logger.child({ submissionId });
  const started = Date.now();
  try {
    const [sub] = await db.select().from(submissions).where(eq(submissions.id, submissionId));
    if (!sub) throw new Error("Submission not found.");
    if (sub.stage === "complete") return; // immutable once decided
    log.info("stage: extracting", { documents: sub.documentCount });

    const docs = await db.select().from(documents).where(eq(documents.submissionId, submissionId));
    await mapLimit(docs, deps.extractionConcurrency ?? 3, async (d) => {
      const data = await storage.getBlob(d.objectPath);
      if (!data) {
        await db.update(documents).set({ extractionMetadata: { status: "failed", error: "Stored file could not be found." } }).where(eq(documents.id, d.id));
        return;
      }
      const res = await model.extract({ fileName: d.fileName, mimeType: d.mimeType, data });
      if (!res.ok) {
        await db.update(documents).set({ extractionMetadata: { status: "failed", error: res.error, provider: res.meta.provider, model: res.meta.model, latencyMs: res.meta.latencyMs, attempts: res.meta.attempts } }).where(eq(documents.id, d.id));
        return;
      }
      const x = res.data;
      await db.update(documents).set({
        isPayslip: x.isPayslip,
        documentType: x.documentType,
        employerName: x.employerName,
        applicantName: x.applicantName,
        grossPay: x.grossPay,
        netPay: x.netPay,
        payDate: x.payDate,
        payPeriodStart: x.payPeriodStart,
        payPeriodEnd: x.payPeriodEnd,
        payFrequency: x.payFrequency,
        currency: x.currency,
        notes: x.notes,
        payEvidence: x.payEvidence,
        extractionMetadata: { status: "ok", provider: res.meta.provider, model: res.meta.model, latencyMs: res.meta.latencyMs, attempts: res.meta.attempts },
      }).where(eq(documents.id, d.id));
    });

    log.info("stage: verifying");
    const extracted = await db.select().from(documents).where(eq(documents.submissionId, submissionId));
    const result = verify({
      submittedAt: sub.submittedAt, // anchor on submission time, never completion time
      stated: {
        applicantName: sub.statedApplicantName,
        employerName: sub.statedEmployerName,
        incomeAmount: sub.statedIncomeAmount,
        incomeBasis: sub.statedIncomeBasis,
        monthlyIncome: sub.statedMonthlyIncome,
        currency: sub.statedCurrency,
      },
      documents: extracted.map(toEngineDoc),
    });

    for (const a of result.documents) {
      await db.update(documents).set({
        payMonth: a.payMonth,
        employerGroup: a.employerGroup,
        inWindow: a.inWindow,
        includedInAggregate: a.includedInAggregate,
        exclusionReasons: a.exclusionReasons,
        payValidation: a.payValidation,
      }).where(eq(documents.id, a.id));
    }

    await db.update(submissions).set({
      stage: "complete",
      resultState: result.resultState,
      resultDescription: result.resultDescription,
      expectedWindowIncome: result.expectedWindowIncome,
      calculatedAggregateIncome: result.calculatedAggregateIncome,
      incomeRatio: result.incomeRatio,
      expectedMonths: result.expectedMonths,
      employerAggregates: result.employerAggregates,
      checks: result.checks,
      completedAt: new Date(),
    }).where(and(eq(submissions.id, submissionId), eq(submissions.stage, "processing")));
    log.info("stage: decided", { resultState: result.resultState, ms: Date.now() - started });

    await generateReport(deps, submissionId);
  } catch (err) {
    log.error("pipeline failed", { failureClass: (err as Error).name, ms: Date.now() - started });
    await db.update(submissions).set({
      stage: "complete",
      resultState: "Error",
      resultDescription: "Verification could not be completed.",
      errorMessage: (err as Error).message.slice(0, 500),
      completedAt: new Date(),
    }).where(and(eq(submissions.id, submissionId), eq(submissions.stage, "processing")));
  }
}

/** Report failure leaves a valid decision with hasReport=false (FR6). */
async function generateReport(deps: PipelineDeps, submissionId: string): Promise<void> {
  const log = deps.logger.child({ submissionId });
  try {
    const [sub] = await deps.db.select().from(submissions).where(eq(submissions.id, submissionId));
    if (!sub) return;
    const docs = await deps.db.select().from(documents).where(eq(documents.submissionId, submissionId));
    const pdf = await buildReportPdf(sub, docs);
    const key = `reports/${submissionId}.pdf`;
    await deps.storage.putBlob(key, pdf, "application/pdf");
    await deps.db.update(submissions).set({ hasReport: true, reportObjectPath: key }).where(eq(submissions.id, submissionId));
    log.info("stage: report stored");
  } catch (err) {
    log.error("report generation failed", { failureClass: (err as Error).name });
  }
}

/**
 * AC8: a submission still `processing` after a crash or restart would stay
 * stuck forever (there is no durable queue), so mark it terminal `Error`.
 * `olderThanMs = 0` sweeps everything (single-process dev restart).
 */
export async function sweepStaleSubmissions(db: Db, olderThanMs: number, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - olderThanMs);
  const rows = await db.update(submissions).set({
    stage: "complete",
    resultState: "Error",
    resultDescription: "Verification could not be completed.",
    errorMessage: INTERRUPTED_MESSAGE,
    completedAt: now,
  }).where(and(eq(submissions.stage, "processing"), lt(submissions.submittedAt, olderThanMs === 0 ? new Date(now.getTime() + 1) : cutoff))).returning({ id: submissions.id });
  return rows.length;
}
