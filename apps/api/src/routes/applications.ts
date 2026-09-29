import { eq, sql } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import type { AppDeps } from "../app";
import { applications } from "../db/schema";
import { ApiError, decodeBase64 } from "../http";
import { importApplications, ImportError } from "../services/importApplications";

const MAX_IMPORT_BYTES = 12 * 1024 * 1024;

const importBody = z.object({ fileName: z.string().min(1), dataBase64: z.string().min(1) });

export function applicationsRouter({ db }: AppDeps): Router {
  const r = Router();

  r.get("/", async (_req, res) => {
    const rows = await db
      .select({
        applicationId: applications.applicationId,
        applicantName: applications.applicantName,
        employerName: applications.employerName,
        statedIncomeAmount: applications.statedIncomeAmount,
        statedIncomeBasis: applications.statedIncomeBasis,
        statedMonthlyIncome: applications.statedMonthlyIncome,
        currency: applications.currency,
        sourceFileName: applications.sourceFileName,
        importedAt: applications.importedAt,
        // Columns are written out qualified: drizzle omits table names in single-table selects,
        // which would turn this correlated subquery into "application_id = application_id".
        submissionCount: sql<number>`(select count(*)::int from "submissions" s where s."application_id" = "applications"."application_id")`,
      })
      .from(applications)
      .orderBy(applications.applicationId);
    res.json({ applications: rows });
  });

  r.post("/import", async (req, res) => {
    const body = importBody.parse(req.body);
    const data = decodeBase64(body.dataBase64);
    if (!data || data.length === 0) throw new ApiError(400, "File content is empty or not valid base64.");
    if (data.length > MAX_IMPORT_BYTES) throw new ApiError(400, "File is larger than 12 MiB.");
    try {
      res.json(await importApplications(db, body.fileName, data));
    } catch (err) {
      if (err instanceof ImportError) throw new ApiError(400, err.message);
      throw err;
    }
  });

  // Purge all reference rows. Historical submissions and reports are untouched (FR10).
  r.delete("/", async (req, res) => {
    if (req.query.confirm !== "purge") throw new ApiError(400, "Purging requires ?confirm=purge.");
    const removed = await db.delete(applications).returning({ id: applications.applicationId });
    res.json({ deleted: removed.length });
  });

  r.get("/:id", async (req, res) => {
    const [row] = await db.select().from(applications).where(eq(applications.applicationId, req.params.id));
    if (!row) throw new ApiError(404, "Application not found.");
    res.json(row);
  });

  // Does not cascade to submissions.
  r.delete("/:id", async (req, res) => {
    const removed = await db.delete(applications).where(eq(applications.applicationId, req.params.id)).returning({ id: applications.applicationId });
    if (removed.length === 0) throw new ApiError(404, "Application not found.");
    res.json({ deleted: 1 });
  });

  return r;
}
