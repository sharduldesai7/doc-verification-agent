import { z } from "zod";

/**
 * Every model response is validated and coerced here regardless of any
 * provider claim about structured output (FR5). Structure problems (not an
 * object, no boolean isPayslip) fail the document; a single malformed field
 * degrades to null so the engine treats it as missing evidence rather than
 * guessing.
 */

const nullableNumber = z.preprocess((v) => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (t === "") return null;
  const negative = /^\(.*\)$/.test(t) || /^-/.test(t);
  const n = Number(t.replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(n) || !/[0-9]/.test(t)) return null;
  return negative ? -n : n;
}, z.number().nullable());

const nullableString = z.preprocess((v) => {
  if (typeof v === "string") return v.trim() === "" ? null : v.trim();
  if (typeof v === "number") return String(v);
  return null;
}, z.string().nullable());

const nullableDate = z.preprocess((v) => {
  if (typeof v !== "string") return null;
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(v.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${m[1]}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}, z.string().nullable());

const currency = z.preprocess((v) => {
  if (typeof v !== "string") return null;
  const t = v.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(t) ? t : null;
}, z.string().nullable());

const bool = z.preprocess((v) => {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const t = v.trim().toLowerCase();
    if (t === "true") return true;
    if (t === "false") return false;
  }
  return v;
}, z.boolean());

const item = z
  .preprocess((v) => (v && typeof v === "object" ? v : {}), z.object({
    amount: nullableNumber.default(null),
    label: nullableString.default(null),
    periodScope: nullableString.default(null),
  }))
  .default({});

const component = z.object({
  label: nullableString.transform((s) => s ?? ""),
  amount: nullableNumber.default(null),
  periodScope: nullableString.default(null),
});

const additionalComponents = z.preprocess(
  (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : []),
  z.array(component),
);

const payEvidence = z
  .preprocess((v) => (v && typeof v === "object" ? v : {}), z.object({
    gross: item,
    deductions: item,
    net: item,
    additionalComponents: additionalComponents.default([]),
    periodContext: z
      .preprocess((v) => (v && typeof v === "object" ? v : {}), z.object({
        payPeriodText: nullableString.default(null),
        notes: nullableString.default(null),
      }))
      .default({}),
  }))
  .default({});

export const extractionSchema = z.object({
  isPayslip: bool,
  documentType: nullableString.default(null),
  employerName: nullableString.default(null),
  applicantName: nullableString.default(null),
  grossPay: nullableNumber.default(null),
  netPay: nullableNumber.default(null),
  payDate: nullableDate.default(null),
  payPeriodStart: nullableDate.default(null),
  payPeriodEnd: nullableDate.default(null),
  payFrequency: nullableString.default(null),
  currency: currency.default(null),
  notes: nullableString.default(null),
  payEvidence,
});

export type Extraction = z.infer<typeof extractionSchema>;

/** Pulls the first JSON object out of a model reply, tolerating code fences. */
export function parseModelJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = (fenced ? fenced[1]! : text).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("Response contained no JSON object.");
  return JSON.parse(body.slice(start, end + 1));
}

export function validateExtraction(raw: unknown): Extraction {
  return extractionSchema.parse(raw);
}
