import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import request from "supertest";
import { createApp } from "../src/app";
import type { Db } from "../src/db/client";
import * as schema from "../src/db/schema";
import { silentLogger } from "../src/logger";
import type { ExtractionInput, ExtractionOutcome, ModelClient } from "../src/model/client";
import type { Extraction } from "../src/model/schema";
import { createMemoryStorage } from "../src/storage";

export type FakeExtraction = Extraction | { fail: string } | { throws: string };

/** Extraction results are looked up by file name; no network is involved. */
export function createFakeModel() {
  const byName = new Map<string, FakeExtraction>();
  /** When set, extraction waits on it, letting tests observe the in-flight `processing` state. */
  const control: { gate: Promise<void> | null } = { gate: null };
  const model: ModelClient = {
    async extract(input: ExtractionInput): Promise<ExtractionOutcome> {
      const meta = { provider: "fake", model: "fake-1", latencyMs: 1, attempts: 1 };
      if (control.gate) await control.gate;
      const r = byName.get(input.fileName);
      if (!r) return { ok: false, error: "No fake extraction configured.", meta };
      if ("throws" in r) throw new Error(r.throws);
      if ("fail" in r) return { ok: false, error: r.fail, meta };
      return { ok: true, data: r, meta };
    },
  };
  return { model, byName, control };
}

let sharedPg: PGlite | null = null;

/** One PGlite instance (and one migration run) per test file; tables are emptied between tests. */
export async function createHarness() {
  if (!sharedPg) {
    sharedPg = new PGlite();
    await migrate(drizzle(sharedPg), { migrationsFolder: path.join(__dirname, "../drizzle") });
  }
  const pg = sharedPg;
  await pg.exec("truncate table documents, submissions, applications cascade");
  const db = drizzle(pg, { schema }) as unknown as Db;
  const storage = createMemoryStorage();
  const fake = createFakeModel();
  const pending: Promise<unknown>[] = [];
  const app = createApp({
    config: { CORS_ORIGINS: "http://localhost", STALE_AFTER_MINUTES: 10 },
    db,
    storage,
    model: fake.model,
    logger: silentLogger,
    schedule: (w) => { pending.push(w); },
  });
  return {
    db, storage, app, fake, pg,
    api: request(app),
    /** Wait for all scheduled background verification to finish. */
    async settle() { await Promise.all(pending.splice(0)); },
  };
}
export type Harness = Awaited<ReturnType<typeof createHarness>>;

export const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const png = (extra = "x") => Buffer.concat([PNG_HEADER, Buffer.from(extra)]);
export const b64 = (b: Buffer) => b.toString("base64");
export const pngDoc = (fileName: string) => ({ fileName, mimeType: "image/png", dataBase64: b64(png(fileName)) });

export function csvB64(text: string) {
  return b64(Buffer.from(text, "utf8"));
}

/** A well-formed payslip transcription. */
export function payslip(payDate: string, gross = 5000, over: Partial<Extraction> = {}): Extraction {
  const item = (amount: number, label: string) => ({ amount, label, periodScope: "Current period" });
  return {
    isPayslip: true, documentType: "payslip", employerName: "Acme Corp", applicantName: "Jane Doe",
    grossPay: gross, netPay: gross - 1000, payDate, payPeriodStart: null, payPeriodEnd: payDate,
    payFrequency: "monthly", currency: "USD", notes: null,
    payEvidence: {
      gross: item(gross, "Gross Pay"), deductions: item(1000, "Total Deductions"), net: item(gross - 1000, "Net Pay"),
      additionalComponents: [], periodContext: { payPeriodText: null, notes: null },
    },
    ...over,
  };
}

export const DEFAULT_CSV =
  "Application ID,Applicant Name,Employer Name,Stated Income Amount,Stated Income Basis,Stated Monthly Income,Currency\n" +
  "APP-1,Jane Doe,Acme Corp,60000,Annual,5000,USD\n" +
  "APP-2,John Roe,Globex,3000,Monthly,3000,USD\n" +
  "APP-3,Mary Poe,Initech,90000,Annual,7500,USD\n";

/** Dates relative to *now* so the four expected months always line up. */
export function lastFourPayDates(now = new Date()): string[] {
  return [1, 2, 3, 4].map((back) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back + 1, 0));
    return d.toISOString().slice(0, 10);
  });
}
