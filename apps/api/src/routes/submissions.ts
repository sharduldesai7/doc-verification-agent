import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import type { AppDeps } from "../app";
import { MAX_DOCUMENT_BYTES, MAX_DOCUMENTS } from "../limits";
import { applications, documents, submissions } from "../db/schema";
import { ApiError, decodeBase64 } from "../http";
import { processSubmission, sweepStaleSubmissions } from "../services/pipeline";

const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "application/pdf"]);

const body = z.object({
  applicationId: z.string().trim().min(1),
  documents: z
    .array(z.object({ fileName: z.string().trim().min(1).max(255), mimeType: z.string().trim().min(1), dataBase64: z.string().min(1) }))
    .min(1, "At least one document is required.")
    .max(MAX_DOCUMENTS, `At most ${MAX_DOCUMENTS} documents are allowed.`),
});

/** True when the leading bytes agree with the declared MIME type. */
function signatureMatches(mime: string, b: Buffer): boolean {
  if (mime === "application/pdf") return b.subarray(0, 5).toString("latin1") === "%PDF-";
  if (mime === "image/png") return b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mime === "image/jpeg" || mime === "image/jpg") return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (mime === "image/webp") return b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP";
  return false;
}

const safeName = (n: string) => n.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100);

export type PublicStatus = "processing" | "verified" | "under_review";
export function publicStatusOf(stage: string, resultState: string | null): PublicStatus {
  if (stage !== "complete") return "processing";
  return resultState === "Approve" ? "verified" : "under_review";
}

export function submissionsRouter(deps: AppDeps): Router {
  const { db, storage, schedule, logger, config } = deps;
  const r = Router();

  r.post("/", async (req, res) => {
    const input = body.parse(req.body);

    const decoded = input.documents.map((d) => {
      const mimeType = d.mimeType.toLowerCase();
      if (!ALLOWED_MIME.has(mimeType)) throw new ApiError(400, `Unsupported file type for ${d.fileName}. Use PNG, JPEG, WEBP or PDF.`);
      const data = decodeBase64(d.dataBase64);
      if (!data) throw new ApiError(400, `${d.fileName} is not valid base64.`);
      if (data.length === 0) throw new ApiError(400, `${d.fileName} is empty.`);
      if (data.length > MAX_DOCUMENT_BYTES) throw new ApiError(400, `${d.fileName} is larger than 12 MiB.`);
      if (!signatureMatches(mimeType, data)) throw new ApiError(400, `${d.fileName} does not look like a ${mimeType} file.`);
      return { fileName: d.fileName, mimeType, data };
    });

    const [app] = await db.select().from(applications).where(eq(applications.applicationId, input.applicationId));
    if (!app) throw new ApiError(404, "Application ID not found.");

    const submissionId = randomUUID();
    const stored: string[] = [];
    const docRows = [];
    try {
      for (const d of decoded) {
        const id = randomUUID();
        const key = `submissions/${submissionId}/${id}-${safeName(d.fileName)}`;
        await storage.putBlob(key, d.data, d.mimeType);
        stored.push(key);
        docRows.push({ id, submissionId, fileName: d.fileName, mimeType: d.mimeType, objectPath: key, extractionMetadata: { status: "pending" as const } });
      }
      const now = new Date();
      // FR2: snapshot reference values; later edits to `applications` never touch this row.
      await db.insert(submissions).values({
        id: submissionId,
        applicationId: app.applicationId,
        stage: "processing",
        statedApplicantName: app.applicantName,
        statedEmployerName: app.employerName,
        statedIncomeAmount: app.statedIncomeAmount,
        statedIncomeBasis: app.statedIncomeBasis,
        statedMonthlyIncome: app.statedMonthlyIncome,
        statedCurrency: app.currency,
        documentCount: docRows.length,
        submittedAt: now,
      });
      await db.insert(documents).values(docRows);
      res.status(201).json({
        submissionId,
        applicationId: app.applicationId,
        stage: "processing",
        publicStatus: "processing",
        documentCount: docRows.length,
        submittedAt: now.toISOString(),
      });
    } catch (err) {
      await Promise.allSettled(stored.map((k) => storage.deleteBlob(k)));
      throw err;
    }

    logger.info("submission accepted", { submissionId, documents: docRows.length });
    schedule(processSubmission({ db, storage, model: deps.model, logger }, submissionId));
  });

  r.get("/:id/status", async (req, res) => {
    await sweepStaleSubmissions(db, config.STALE_AFTER_MINUTES * 60_000);
    const [row] = await db
      .select({ id: submissions.id, applicationId: submissions.applicationId, stage: submissions.stage, resultState: submissions.resultState, documentCount: submissions.documentCount, submittedAt: submissions.submittedAt, completedAt: submissions.completedAt })
      .from(submissions)
      .where(eq(submissions.id, req.params.id));
    if (!row) throw new ApiError(404, "Submission not found.");
    // Neutral view only: never the internal result, reasoning or checks.
    res.json({
      submissionId: row.id,
      applicationId: row.applicationId,
      publicStatus: publicStatusOf(row.stage, row.resultState),
      documentCount: row.documentCount,
      submittedAt: row.submittedAt,
      completedAt: row.completedAt,
    });
  });

  return r;
}
