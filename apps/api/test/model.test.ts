import { describe, expect, it, vi } from "vitest";
import { ConfigError, loadConfig } from "../src/config";
import { createModelClient } from "../src/model/client";
import { parseModelJson, validateExtraction } from "../src/model/schema";
import { png } from "./harness";

const cfg = { MODEL_API_KEY: "sk-secret", MODEL_BASE_URL: "https://api.example.com/openai/v1/", MODEL_ID: "vision-x" };
const reply = (content: unknown, status = 200) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status });
const good = { isPayslip: true, employerName: "Acme", grossPay: "$5,000.00", payEvidence: { gross: { amount: "5,000", label: "Gross Pay", periodScope: "current" } } };
const noSleep = async () => {};

describe("extraction schema (FR5)", () => {
  it("coerces numbers, dates, currency and booleans; missing fields become null", () => {
    const x = validateExtraction({
      isPayslip: "true", grossPay: "$5,000.50", netPay: "(120.00)", payDate: "2026/8/31", currency: "usd",
      payEvidence: { gross: { amount: "5,000", label: " Gross Pay " } },
    });
    expect(x).toMatchObject({ isPayslip: true, grossPay: 5000.5, netPay: -120, payDate: "2026-08-31", currency: "USD", employerName: null });
    expect(x.payEvidence.gross).toEqual({ amount: 5000, label: "Gross Pay", periodScope: null });
    expect(x.payEvidence.deductions).toEqual({ amount: null, label: null, periodScope: null });
    expect(x.payEvidence.additionalComponents).toEqual([]);
  });
  it("malformed single fields degrade to null instead of failing the document", () => {
    const x = validateExtraction({ isPayslip: true, payDate: "August 31st", currency: "dollars", grossPay: "n/a", payEvidence: "oops" });
    expect(x).toMatchObject({ payDate: null, currency: null, grossPay: null });
  });
  it("structure problems fail validation", () => {
    expect(() => validateExtraction(null)).toThrow();
    expect(() => validateExtraction({ employerName: "x" })).toThrow(); // isPayslip is required
    expect(() => validateExtraction({ isPayslip: "maybe" })).toThrow();
  });
  it("parses JSON inside code fences and surrounding prose", () => {
    expect(parseModelJson('Here you go:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseModelJson('{"a":1} thanks')).toEqual({ a: 1 });
    expect(() => parseModelJson("I cannot help with that.")).toThrow();
  });
});

describe("model client", () => {
  it("posts an image data URL to <base>/chat/completions with the bearer key, and validates the reply", async () => {
    const fetchImpl = vi.fn(async () => reply(JSON.stringify(good)));
    const client = createModelClient(cfg, { fetchImpl, sleep: noSleep });
    const out = await client.extract({ fileName: "a.png", mimeType: "image/png", data: png() });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.data.grossPay).toBe(5000);
      expect(out.meta).toMatchObject({ provider: "api.example.com", model: "vision-x", attempts: 1 });
    }
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example.com/openai/v1/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-secret");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("vision-x");
    expect(body.temperature).toBe(0);
    expect(body.messages[1].content[1].image_url.url).toMatch(/^data:image\/png;base64,/);
  });

  it("retries on 429/5xx with backoff, then succeeds", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 429 }))
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(reply(JSON.stringify(good)));
    const sleep = vi.fn(noSleep);
    const out = await createModelClient(cfg, { fetchImpl, sleep }).extract({ fileName: "a.png", mimeType: "image/png", data: png() });
    expect(out.ok).toBe(true);
    expect(out.meta.attempts).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("gives up after the attempt limit and reports a per-document failure without throwing", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 500 }));
    const out = await createModelClient(cfg, { fetchImpl, sleep: noSleep, maxAttempts: 2 }).extract({ fileName: "a.png", mimeType: "image/png", data: png() });
    expect(out).toMatchObject({ ok: false, error: "Model provider returned HTTP 500." });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-retryable client errors", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 401 }));
    const out = await createModelClient(cfg, { fetchImpl, sleep: noSleep }).extract({ fileName: "a.png", mimeType: "image/png", data: png() });
    expect(out.ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries once without response_format when the provider rejects it", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 400 }))
      .mockResolvedValueOnce(reply(JSON.stringify(good)));
    const out = await createModelClient(cfg, { fetchImpl, sleep: noSleep }).extract({ fileName: "a.png", mimeType: "image/png", data: png() });
    expect(out.ok).toBe(true);
    const second = JSON.parse((fetchImpl.mock.calls[1] as unknown as [string, RequestInit])[1].body as string);
    expect(second.response_format).toBeUndefined();
  });

  it.each([
    ["a refusal / non-JSON reply", "I'm sorry, I can't help with that."],
    ["JSON with the wrong shape", JSON.stringify({ hello: "world" })],
    ["an empty reply", ""],
  ])("treats %s as a per-document failure", async (_n, content) => {
    const fetchImpl = vi.fn(async () => reply(content));
    const out = await createModelClient(cfg, { fetchImpl, sleep: noSleep }).extract({ fileName: "a.png", mimeType: "image/png", data: png() });
    expect(out.ok).toBe(false);
  });

  it("sends PDF text (not bytes) and fails clearly when there is no text layer", async () => {
    const fetchImpl = vi.fn(async () => reply(JSON.stringify(good)));
    const withText = createModelClient(cfg, { fetchImpl, sleep: noSleep, pdfText: async () => "Gross Pay 5,000.00 Net Pay 4,000.00 Employer Acme" });
    expect((await withText.extract({ fileName: "a.pdf", mimeType: "application/pdf", data: Buffer.from("%PDF-1.4") })).ok).toBe(true);
    const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(typeof body.messages[1].content).toBe("string");

    const empty = createModelClient(cfg, { fetchImpl, sleep: noSleep, pdfText: async () => "  " });
    const out = await empty.extract({ fileName: "scan.pdf", mimeType: "application/pdf", data: Buffer.from("%PDF-1.4") });
    expect(out).toMatchObject({ ok: false });
    expect(out.ok === false && out.error).toMatch(/text layer/);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // no model call for the scanned PDF
  });

  it("never puts the API key or document bytes into log fields", async () => {
    const lines: string[] = [];
    const logger = { debug() {}, info: (_m: string, f?: object) => lines.push(JSON.stringify(f)), warn: (_m: string, f?: object) => lines.push(JSON.stringify(f)), error() {}, child() { return logger; } };
    await createModelClient(cfg, { fetchImpl: async () => reply(JSON.stringify(good)), logger, sleep: noSleep }).extract({ fileName: "a.png", mimeType: "image/png", data: png("SECRETBYTES") });
    await createModelClient(cfg, { fetchImpl: async () => reply("nope"), logger, sleep: noSleep }).extract({ fileName: "a.png", mimeType: "image/png", data: png("SECRETBYTES") });
    const all = lines.join("\n");
    expect(all).not.toMatch(/sk-secret|SECRETBYTES|nope/);
  });
});

describe("config (fail fast)", () => {
  const full = {
    DATABASE_URL: "postgres://x", MODEL_API_KEY: "k", MODEL_BASE_URL: "https://m.example/v1", MODEL_ID: "m",
    S3_ENDPOINT: "https://s3.example", S3_BUCKET: "b", S3_ACCESS_KEY_ID: "a", S3_SECRET_ACCESS_KEY: "s",
  };
  it("loads a complete environment with defaults", () => {
    expect(loadConfig(full as unknown as NodeJS.ProcessEnv)).toMatchObject({ LOG_LEVEL: "info", S3_REGION: "auto", STALE_AFTER_MINUTES: 10 });
  });
  it("names every missing variable in one error", () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(ConfigError);
    try { loadConfig({ ...full, DATABASE_URL: "", MODEL_ID: "" } as unknown as NodeJS.ProcessEnv); } catch (e) {
      expect((e as Error).message).toMatch(/DATABASE_URL/);
      expect((e as Error).message).toMatch(/MODEL_ID/);
    }
  });
});
