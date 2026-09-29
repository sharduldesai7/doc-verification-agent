import ExcelJS from "exceljs";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { applications, documents, submissions } from "../src/db/schema";
import { sweepStaleSubmissions } from "../src/services/pipeline";
import { b64, createHarness, csvB64, DEFAULT_CSV, lastFourPayDates, payslip, png, pngDoc, type Harness } from "./harness";

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
  await h.api.post("/api/applications/import").send({ fileName: "apps.csv", dataBase64: csvB64(DEFAULT_CSV) }).expect(200);
});

/** Submit four good payslips (or the supplied set) and wait for verification. */
async function submitGood(names = ["a.png", "b.png", "c.png", "d.png"], mutate?: (i: number) => ReturnType<typeof payslip>) {
  const dates = lastFourPayDates();
  names.forEach((n, i) => h.fake.byName.set(n, mutate ? mutate(i) : payslip(dates[i]!)));
  const res = await h.api.post("/api/submissions").send({ applicationId: "APP-1", documents: names.map(pngDoc) });
  await h.settle();
  return res;
}
const detail = async (id: string) => (await h.api.get(`/api/review/submissions/${id}`).expect(200)).body;

describe("health", () => {
  it("reports liveness only", async () => {
    expect((await h.api.get("/api/healthz")).body).toEqual({ status: "ok" });
  });
});

describe("FR1 submission validation", () => {
  const ok = () => ({ applicationId: "APP-1", documents: [pngDoc("a.png")] });

  it("404 for an unknown application", async () => {
    await h.api.post("/api/submissions").send({ ...ok(), applicationId: "NOPE" }).expect(404);
  });
  it("400 for zero or more than ten documents", async () => {
    await h.api.post("/api/submissions").send({ applicationId: "APP-1", documents: [] }).expect(400);
    await h.api.post("/api/submissions").send({ applicationId: "APP-1", documents: Array.from({ length: 11 }, (_, i) => pngDoc(`f${i}.png`)) }).expect(400);
  });
  it("accepts exactly ten documents", async () => {
    await h.api.post("/api/submissions").send({ applicationId: "APP-1", documents: Array.from({ length: 10 }, (_, i) => pngDoc(`f${i}.png`)) }).expect(201);
    await h.settle();
  });
  it("400 for unsupported type, bad base64, empty and oversized files, and signature mismatch", async () => {
    const post = (d: object) => h.api.post("/api/submissions").send({ applicationId: "APP-1", documents: [d] });
    await post({ fileName: "a.gif", mimeType: "image/gif", dataBase64: b64(png()) }).then((r) => expect(r.status).toBe(400));
    await post({ fileName: "a.png", mimeType: "image/png", dataBase64: "@@@" }).then((r) => expect(r.status).toBe(400));
    await post({ fileName: "a.png", mimeType: "image/png", dataBase64: "AAAA" }).then((r) => expect(r.status).toBe(400)); // wrong signature
    await post({ fileName: "a.png", mimeType: "image/png", dataBase64: "=" }).then((r) => expect(r.status).toBe(400));
    const twelveMiB = 12 * 1024 * 1024;
    const atLimit = Buffer.concat([png(), Buffer.alloc(twelveMiB - png().length)]);
    const over = Buffer.concat([png(), Buffer.alloc(twelveMiB + 1 - png().length)]);
    expect(atLimit.length).toBe(twelveMiB);
    await post({ fileName: "big.png", mimeType: "image/png", dataBase64: b64(over) }).then((r) => {
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/12 MiB/);
    });
    await post({ fileName: "ok.png", mimeType: "image/png", dataBase64: b64(atLimit) }).then((r) => expect(r.status).toBe(201));
    await h.settle();
  });
  it("mime types are case-insensitive and image/jpg is allowed", async () => {
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]);
    await h.api.post("/api/submissions").send({ applicationId: "APP-1", documents: [
      { fileName: "a.png", mimeType: "IMAGE/PNG", dataBase64: b64(png()) },
      { fileName: "b.jpg", mimeType: "image/jpg", dataBase64: b64(jpg) },
    ] }).expect(201);
    await h.settle();
  });
});

describe("FR2/FR3 receipt, snapshot and neutral status", () => {
  it("returns a minimal receipt immediately and stays processing until the pipeline runs", async () => {
    h.fake.byName.set("a.png", payslip(lastFourPayDates()[0]!));
    let release!: () => void;
    h.fake.control.gate = new Promise<void>((r) => { release = r; });
    const res = await h.api.post("/api/submissions").send({ applicationId: "APP-1", documents: [pngDoc("a.png")] }).expect(201);
    expect(Object.keys(res.body).sort()).toEqual(["applicationId", "documentCount", "publicStatus", "stage", "submissionId", "submittedAt"]);
    expect(res.body.stage).toBe("processing");
    const status = await h.api.get(`/api/submissions/${res.body.submissionId}/status`).expect(200);
    expect(status.body.publicStatus).toBe("processing");
    release();
    await h.settle();
    expect((await h.api.get(`/api/submissions/${res.body.submissionId}/status`)).body.publicStatus).toBe("under_review");
  });

  it("status never leaks internal result or reasoning", async () => {
    const res = await submitGood();
    const s = (await h.api.get(`/api/submissions/${res.body.submissionId}/status`).expect(200)).body;
    expect(s.publicStatus).toBe("verified");
    expect(JSON.stringify(s)).not.toMatch(/Approve|Manual|checks|reason|ratio/i);
    await h.api.get("/api/submissions/does-not-exist/status").expect(404);
  });

  it("Manual Review and Error both surface as under_review", async () => {
    const res = await submitGood(["a.png"]);
    const s = (await h.api.get(`/api/submissions/${res.body.submissionId}/status`)).body;
    expect(s.publicStatus).toBe("under_review");
  });

  it("FR2: reference edits after submission never change the stored snapshot", async () => {
    const res = await submitGood();
    await h.api.post("/api/applications/import").send({
      fileName: "fix.csv",
      dataBase64: csvB64("Application ID,Applicant Name,Employer Name,Stated Income Amount,Stated Income Basis,Currency\nAPP-1,Changed Name,Other Co,1,Monthly,EUR\n"),
    }).expect(200);
    const d = await detail(res.body.submissionId);
    expect(d.submission.statedEmployerName).toBe("Acme Corp");
    expect(d.submission.statedApplicantName).toBe("Jane Doe");
    expect(d.submission.statedIncomeAmount).toBe(60000);
    expect(d.submission.statedCurrency).toBe("USD");
  });
});

describe("end to end decisions", () => {
  it("AC1: four consistent payslips approve, with stored checks, documents and a PDF report", async () => {
    const res = await submitGood();
    const d = await detail(res.body.submissionId);
    expect(d.submission.stage).toBe("complete");
    expect(d.submission.resultState).toBe("Approve");
    expect(d.submission.checks).toHaveLength(11);
    expect(d.submission.incomeRatio).toBe(1);
    expect(d.submission.expectedMonths).toHaveLength(4);
    expect(d.documents).toHaveLength(4);
    expect(d.documents.every((x: { includedInAggregate: boolean }) => x.includedInAggregate)).toBe(true);
    expect(d.submission.reportObjectPath).toBeUndefined(); // storage keys never exposed
    expect(d.documents[0].objectPath).toBeUndefined();
    expect(d.submission.hasReport).toBe(true);
    const pdf = await h.api.get(`/api/review/submissions/${res.body.submissionId}/report.pdf`).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (c) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("AC3/AC6: an incomplete set is Manual Review and is not treated as low income", async () => {
    const res = await submitGood(["a.png", "b.png", "c.png"]);
    const d = await detail(res.body.submissionId);
    expect(d.submission.resultState).toBe("Manual Review");
    expect(d.submission.incomeRatio).toBeNull();
    expect(d.submission.checks.find((c: { id: string }) => c.id === "income_within_band").status).toBe("skipped");
  });

  it("AC7: one unreadable upload beside four good payslips still approves", async () => {
    const dates = lastFourPayDates();
    ["a.png", "b.png", "c.png", "d.png"].forEach((n, i) => h.fake.byName.set(n, payslip(dates[i]!)));
    h.fake.byName.set("bad.png", { fail: "Model response was not valid JSON." });
    const res = await h.api.post("/api/submissions").send({ applicationId: "APP-1", documents: ["a.png", "b.png", "c.png", "d.png", "bad.png"].map(pngDoc) }).expect(201);
    await h.settle();
    const d = await detail(res.body.submissionId);
    expect(d.submission.resultState).toBe("Approve");
    expect(d.submission.checks.find((c: { id: string }) => c.id === "documents_readable").status).toBe("warn");
    const bad = d.documents.find((x: { fileName: string }) => x.fileName === "bad.png");
    expect(bad.extractionMetadata.status).toBe("failed");
    expect(bad.exclusionReasons.join(" ")).toMatch(/Could not be read/);
  });

  it("AC7: zero identified payslips is an Error", async () => {
    h.fake.byName.set("a.png", { ...payslip("2026-01-01"), isPayslip: false });
    const res = await h.api.post("/api/submissions").send({ applicationId: "APP-1", documents: [pngDoc("a.png")] }).expect(201);
    await h.settle();
    expect((await detail(res.body.submissionId)).submission.resultState).toBe("Error");
  });

  it("a pipeline exception (not a failed check) ends in Error", async () => {
    h.fake.byName.set("a.png", { throws: "boom" });
    const res = await h.api.post("/api/submissions").send({ applicationId: "APP-1", documents: [pngDoc("a.png")] }).expect(201);
    await h.settle();
    const d = await detail(res.body.submissionId);
    expect(d.submission.stage).toBe("complete");
    expect(d.submission.resultState).toBe("Error");
    expect(d.submission.errorMessage).toBe("boom");
    expect(d.submission.hasReport).toBe(false);
  });

  it("FR6: a report failure leaves a valid decision with hasReport=false", async () => {
    const real = h.storage.putBlob;
    h.storage.putBlob = async (k, b, t) => {
      if (k.startsWith("reports/")) throw new Error("disk full");
      return real(k, b, t);
    };
    const res = await submitGood();
    const d = await detail(res.body.submissionId);
    expect(d.submission.resultState).toBe("Approve");
    expect(d.submission.hasReport).toBe(false);
    await h.api.get(`/api/review/submissions/${res.body.submissionId}/report.pdf`).expect(404);
  });

  it("completed decisions are immutable: reprocessing does nothing", async () => {
    const res = await submitGood();
    const before = await detail(res.body.submissionId);
    const { processSubmission } = await import("../src/services/pipeline");
    h.fake.byName.clear();
    await processSubmission({ db: h.db, storage: h.storage, model: h.fake.model, logger: (await import("../src/logger")).silentLogger }, res.body.submissionId);
    expect((await detail(res.body.submissionId)).submission).toEqual(before.submission);
  });
});

describe("AC8 interrupted verification", () => {
  it("a stale processing submission becomes a terminal Error", async () => {
    const old = new Date(Date.now() - 60 * 60_000);
    await h.db.insert(submissions).values({ id: "stuck", applicationId: "APP-1", documentCount: 1, submittedAt: old });
    const recent = { id: "fresh", applicationId: "APP-1", documentCount: 1 };
    await h.db.insert(submissions).values(recent);
    const s = await h.api.get("/api/submissions/stuck/status").expect(200);
    expect(s.body.publicStatus).toBe("under_review");
    const d = await detail("stuck");
    expect(d.submission.stage).toBe("complete");
    expect(d.submission.resultState).toBe("Error");
    expect(d.submission.errorMessage).toMatch(/interrupted/);
    expect((await detail("fresh")).submission.stage).toBe("processing"); // still within the grace window
  });

  it("a startup sweep with no grace period fails everything still processing", async () => {
    await h.db.insert(submissions).values({ id: "x", applicationId: "APP-1", documentCount: 1 });
    expect(await sweepStaleSubmissions(h.db, 0)).toBe(1);
    expect((await detail("x")).submission.resultState).toBe("Error");
  });
});

describe("reference data (FR9, FR10, AC9, AC10)", () => {
  it("lists applications with a computed submissionCount and gets one by id", async () => {
    await submitGood();
    const list = (await h.api.get("/api/applications").expect(200)).body.applications;
    expect(list).toHaveLength(3);
    expect(list.find((a: { applicationId: string }) => a.applicationId === "APP-1").submissionCount).toBe(1);
    expect(list.find((a: { applicationId: string }) => a.applicationId === "APP-2").submissionCount).toBe(0);
    expect((await h.api.get("/api/applications/APP-2").expect(200)).body.employerName).toBe("Globex");
    await h.api.get("/api/applications/NOPE").expect(404);
  });

  it("AC10: reimporting one corrected row updates only that application", async () => {
    const before = await h.db.select().from(applications);
    const res = await h.api.post("/api/applications/import").send({
      fileName: "fix.csv",
      dataBase64: csvB64("Application ID,Applicant Name,Employer Name,Stated Income Amount,Stated Income Basis,Stated Monthly Income,Currency\nAPP-2,John Roe,Globex Corp,42000,Annual,3500,USD\nAPP-9,New Person,NewCo,1000,Monthly,1000,GBP\n"),
    }).expect(200);
    expect(res.body).toMatchObject({ imported: 1, updated: 1, skipped: 0 });
    const after = await h.db.select().from(applications);
    expect(after).toHaveLength(4);
    const pick = (rows: typeof before, id: string) => rows.find((r) => r.applicationId === id)!;
    expect(pick(after, "APP-2").employerName).toBe("Globex Corp");
    expect(pick(after, "APP-2").statedIncomeAmount).toBe(42000);
    expect(pick(after, "APP-1")).toEqual(pick(before, "APP-1"));
    expect(pick(after, "APP-3")).toEqual(pick(before, "APP-3"));
  });

  it("tolerates alternate header spellings, currency symbols and blank rows; reports skipped rows", async () => {
    const res = await h.api.post("/api/applications/import").send({
      fileName: "alt.csv",
      dataBase64: csvB64("App ID,Full Name,Company,Annual Income,Frequency,ccy\nX-1,Al Bo,Zed Ltd,\"$85,000.50\",per year,usd\n,No Id,Zed,1,Monthly,USD\n"),
    }).expect(200);
    expect(res.body).toMatchObject({ imported: 1, skipped: 1 });
    const [row] = await h.db.select().from(applications).where(eq(applications.applicationId, "X-1"));
    expect(row).toMatchObject({ applicantName: "Al Bo", employerName: "Zed Ltd", statedIncomeAmount: 85000.5, statedIncomeBasis: "per year", currency: "USD" });
  });

  it("imports .xlsx workbooks", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Application_data");
    ws.addRow(["Application ID", "Applicant", "Employer", "Stated Income", "Basis", "Currency"]);
    ws.addRow([1001, "Xi Yu", "Wu Inc", 4200, "Monthly", "GBP"]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const res = await h.api.post("/api/applications/import").send({ fileName: "Application_data.xlsx", dataBase64: b64(buf) }).expect(200);
    expect(res.body.imported).toBe(1);
    expect((await h.api.get("/api/applications/1001").expect(200)).body.applicantName).toBe("Xi Yu");
  });

  it("rejects unsupported files and files without an application ID column", async () => {
    await h.api.post("/api/applications/import").send({ fileName: "x.txt", dataBase64: csvB64("a") }).expect(400);
    await h.api.post("/api/applications/import").send({ fileName: "x.csv", dataBase64: csvB64("foo,bar\n1,2\n") }).expect(400);
  });

  it("AC9: purge needs confirmation and leaves historical submissions and reports readable", async () => {
    const res = await submitGood();
    await h.api.delete("/api/applications").expect(400);
    await h.api.delete("/api/applications?confirm=PURGE").expect(400); // literal lowercase value required
    const purged = await h.api.delete("/api/applications?confirm=purge").expect(200);
    expect(purged.body.deleted).toBe(3);
    expect((await h.api.get("/api/applications")).body.applications).toEqual([]);
    const d = await detail(res.body.submissionId);
    expect(d.submission.resultState).toBe("Approve");
    expect(d.documents).toHaveLength(4);
    await h.api.get(`/api/review/submissions/${res.body.submissionId}/report.pdf`).expect(200);
    await h.api.post("/api/submissions").send({ applicationId: "APP-1", documents: [pngDoc("a.png")] }).expect(404);
  });

  it("deleting one reference row does not cascade to submissions", async () => {
    const res = await submitGood();
    await h.api.delete("/api/applications/APP-1").expect(200);
    await h.api.delete("/api/applications/APP-1").expect(404);
    await detail(res.body.submissionId);
    expect(await h.db.select().from(documents)).toHaveLength(4);
  });
});

describe("reviewer list and stats (FR7)", () => {
  it("lists newest first, filters by result state, and searches", async () => {
    const first = await submitGood();
    const second = await submitGood(["z.png"]);
    const all = (await h.api.get("/api/review/submissions").expect(200)).body.submissions;
    expect(all.map((s: { id: string }) => s.id)).toEqual([second.body.submissionId, first.body.submissionId]);
    const approved = (await h.api.get("/api/review/submissions?resultState=Approve")).body.submissions;
    expect(approved.map((s: { id: string }) => s.id)).toEqual([first.body.submissionId]);
    expect((await h.api.get("/api/review/submissions?resultState=Manual%20Review")).body.submissions).toHaveLength(1);
    await h.api.get("/api/review/submissions?resultState=Bogus").expect(400);
    expect((await h.api.get("/api/review/submissions?search=jane")).body.submissions).toHaveLength(2);
    expect((await h.api.get("/api/review/submissions?search=acme")).body.submissions).toHaveLength(2);
    expect((await h.api.get(`/api/review/submissions?search=${first.body.submissionId.slice(0, 8)}`)).body.submissions).toHaveLength(1);
    expect((await h.api.get("/api/review/submissions?search=%25")).body.submissions).toHaveLength(0); // LIKE wildcards escaped
    expect((await h.api.get("/api/review/submissions?search=nobody")).body.submissions).toHaveLength(0);
  });

  it("reports totals, approval rate and median processing time", async () => {
    await submitGood();
    await submitGood(["z.png"]);
    const stats = (await h.api.get("/api/review/stats").expect(200)).body;
    expect(stats).toMatchObject({ total: 2, approve: 1, manualReview: 1, error: 0, processing: 0, approvalRate: 0.5 });
    expect(typeof stats.medianProcessingSeconds).toBe("number");
    await h.api.get("/api/review/submissions/nope").expect(404);
    await h.api.get("/api/review/submissions/nope/report.pdf").expect(404);
  });

  it("stats are empty-safe", async () => {
    const stats = (await h.api.get("/api/review/stats")).body;
    expect(stats).toMatchObject({ total: 0, approvalRate: null, medianProcessingSeconds: null });
  });
});
