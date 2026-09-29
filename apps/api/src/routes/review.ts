import { and, desc, eq, ilike, isNull, or, type SQL } from "drizzle-orm";
import { Router } from "express";
import type { AppDeps } from "../app";
import { documents, submissions } from "../db/schema";
import { ApiError } from "../http";
import { sweepStaleSubmissions } from "../services/pipeline";

const RESULT_FILTERS = ["Approve", "Manual Review", "Error", "Pending"] as const;

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function reviewRouter({ db, storage, config }: AppDeps): Router {
  const r = Router();
  const sweep = () => sweepStaleSubmissions(db, config.STALE_AFTER_MINUTES * 60_000);

  r.get("/stats", async (_req, res) => {
    await sweep();
    const rows = await db
      .select({ stage: submissions.stage, resultState: submissions.resultState, submittedAt: submissions.submittedAt, completedAt: submissions.completedAt })
      .from(submissions);
    const count = (s: string) => rows.filter((x) => x.resultState === s).length;
    const approve = count("Approve");
    const manual = count("Manual Review");
    const durations = rows.filter((x) => x.completedAt && x.resultState !== "Error").map((x) => (x.completedAt!.getTime() - x.submittedAt.getTime()) / 1000);
    res.json({
      total: rows.length,
      approve,
      manualReview: manual,
      error: count("Error"),
      processing: rows.filter((x) => x.stage === "processing").length,
      approvalRate: approve + manual > 0 ? approve / (approve + manual) : null,
      medianProcessingSeconds: median(durations),
    });
  });

  r.get("/submissions", async (req, res) => {
    await sweep();
    const filters: SQL[] = [];
    const rs = typeof req.query.resultState === "string" ? req.query.resultState : "";
    if (rs) {
      if (!(RESULT_FILTERS as readonly string[]).includes(rs)) throw new ApiError(400, `resultState must be one of ${RESULT_FILTERS.join(", ")}.`);
      filters.push(rs === "Pending" ? isNull(submissions.resultState) : eq(submissions.resultState, rs as "Approve"));
    }
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    if (search) {
      const pat = `%${escapeLike(search)}%`;
      filters.push(or(ilike(submissions.applicationId, pat), ilike(submissions.statedApplicantName, pat), ilike(submissions.statedEmployerName, pat), ilike(submissions.id, pat))!);
    }
    const rows = await db
      .select({
        id: submissions.id,
        applicationId: submissions.applicationId,
        applicantName: submissions.statedApplicantName,
        employerName: submissions.statedEmployerName,
        stage: submissions.stage,
        resultState: submissions.resultState,
        resultDescription: submissions.resultDescription,
        documentCount: submissions.documentCount,
        incomeRatio: submissions.incomeRatio,
        hasReport: submissions.hasReport,
        submittedAt: submissions.submittedAt,
        completedAt: submissions.completedAt,
      })
      .from(submissions)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(desc(submissions.submittedAt))
      .limit(500);
    res.json({ submissions: rows });
  });

  r.get("/submissions/:id", async (req, res) => {
    await sweep();
    const [row] = await db.select().from(submissions).where(eq(submissions.id, req.params.id));
    if (!row) throw new ApiError(404, "Submission not found.");
    const docs = await db.select().from(documents).where(eq(documents.submissionId, row.id)).orderBy(documents.createdAt);
    // Storage keys are internal; never expose them.
    const { reportObjectPath: _r, ...submission } = row;
    res.json({ submission, documents: docs.map(({ objectPath: _o, ...d }) => d) });
  });

  r.get("/submissions/:id/report.pdf", async (req, res) => {
    const [row] = await db.select({ hasReport: submissions.hasReport, key: submissions.reportObjectPath }).from(submissions).where(eq(submissions.id, req.params.id));
    if (!row || !row.hasReport || !row.key) throw new ApiError(404, "Report not available.");
    const pdf = await storage.getBlob(row.key);
    if (!pdf) throw new ApiError(404, "Report not available.");
    res.setHeader("content-type", "application/pdf");
    res.setHeader("content-disposition", `attachment; filename="income-verification-${req.params.id}.pdf"`);
    res.send(pdf);
  });

  return r;
}
