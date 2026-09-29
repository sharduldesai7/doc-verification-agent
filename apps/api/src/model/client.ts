import type { Config } from "../config";
import type { Logger } from "../logger";
import { silentLogger } from "../logger";
import { parseModelJson, validateExtraction, type Extraction } from "./schema";

export interface ExtractionInput {
  fileName: string;
  mimeType: string;
  data: Buffer;
}

export interface ExtractionMeta {
  provider: string;
  model: string;
  latencyMs: number;
  attempts: number;
}

export type ExtractionOutcome =
  | { ok: true; data: Extraction; meta: ExtractionMeta }
  | { ok: false; error: string; meta: ExtractionMeta };

/** Transcribes a document. Never decides approval. Never throws for per-document failures. */
export interface ModelClient {
  extract(input: ExtractionInput): Promise<ExtractionOutcome>;
}

export const SYSTEM_PROMPT = `You transcribe payslips into JSON. You only transcribe what is printed; you never judge, approve, correct or infer.
Rules:
- Reply with one JSON object and nothing else.
- Use null for anything not printed or not legible. Never guess or compute a value.
- Dates must be ISO YYYY-MM-DD.
- Amounts are plain numbers (no currency symbols or thousands separators).
- If the document is not a payslip (letter, bank statement, photo, blank), set isPayslip to false and fill only documentType and notes.
- For payEvidence.gross, .deductions and .net give: amount (current pay period only), label (the exact printed wording next to it), and periodScope (how the document scopes that amount, in its own words, for example "current", "this period", "YTD", "year to date"). If the page shows both a current-period and a year-to-date column, transcribe the current-period figure and use "current" for periodScope; do not transcribe the YTD figure into these fields.
- payEvidence.additionalComponents lists other printed pay lines (bonus, overtime, reimbursement) as {label, amount, periodScope}.
- payEvidence.periodContext: payPeriodText is the printed pay period wording; notes is anything relevant that does not fit elsewhere.
Schema: {"isPayslip":boolean,"documentType":string|null,"employerName":string|null,"applicantName":string|null,"grossPay":number|null,"netPay":number|null,"payDate":string|null,"payPeriodStart":string|null,"payPeriodEnd":string|null,"payFrequency":string|null,"currency":string|null,"notes":string|null,"payEvidence":{"gross":{"amount":number|null,"label":string|null,"periodScope":string|null},"deductions":{"amount":number|null,"label":string|null,"periodScope":string|null},"net":{"amount":number|null,"label":string|null,"periodScope":string|null},"additionalComponents":[{"label":string,"amount":number|null,"periodScope":string|null}],"periodContext":{"payPeriodText":string|null,"notes":string|null}}}
currency is the ISO 4217 code if printed or unambiguous, else null.`;

type FetchLike = typeof fetch;

export interface ModelClientOptions {
  fetchImpl?: FetchLike;
  logger?: Logger;
  timeoutMs?: number;
  maxAttempts?: number;
  /** Test hook to avoid real backoff sleeps. */
  sleep?: (ms: number) => Promise<void>;
  /** Test hook for PDF text extraction. */
  pdfText?: (data: Buffer) => Promise<string>;
}

async function defaultPdfText(data: Buffer): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(data));
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
}

function isRetryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export function createModelClient(
  config: Pick<Config, "MODEL_API_KEY" | "MODEL_BASE_URL" | "MODEL_ID">,
  options: ModelClientOptions = {},
): ModelClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.logger ?? silentLogger;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxAttempts = options.maxAttempts ?? 3;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pdfText = options.pdfText ?? defaultPdfText;
  const endpoint = `${config.MODEL_BASE_URL.replace(/\/+$/, "")}/chat/completions`;
  const provider = new URL(config.MODEL_BASE_URL).host;

  async function buildUserContent(input: ExtractionInput): Promise<unknown[] | string> {
    if (input.mimeType === "application/pdf") {
      const text = (await pdfText(input.data)).trim();
      if (text.length < 20) {
        throw new Error("PDF has no extractable text layer; upload an image (PNG, JPEG or WEBP) of the payslip instead.");
      }
      return `Transcribe this payslip. Text extracted from a PDF (layout may be flattened):\n\n${text.slice(0, 20_000)}`;
    }
    const mime = input.mimeType === "image/jpg" ? "image/jpeg" : input.mimeType;
    return [
      { type: "text", text: "Transcribe this payslip image into the JSON schema." },
      { type: "image_url", image_url: { url: `data:${mime};base64,${input.data.toString("base64")}` } },
    ];
  }

  return {
    async extract(input) {
      const started = Date.now();
      let attempts = 0;
      const meta = (): ExtractionMeta => ({ provider, model: config.MODEL_ID, latencyMs: Date.now() - started, attempts });
      const fail = (error: string): ExtractionOutcome => {
        log.warn("extraction failed", { provider, model: config.MODEL_ID, failureClass: error.slice(0, 80) });
        return { ok: false, error, meta: meta() };
      };

      let content: unknown[] | string;
      try {
        content = await buildUserContent(input);
      } catch (err) {
        return fail(err instanceof Error ? err.message : "Could not prepare document.");
      }

      let useJsonMode = true;
      let lastError = "Model request failed.";
      while (attempts < maxAttempts) {
        attempts += 1;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const res = await fetchImpl(endpoint, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${config.MODEL_API_KEY}` },
            body: JSON.stringify({
              model: config.MODEL_ID,
              temperature: 0,
              max_tokens: 2500,
              ...(useJsonMode ? { response_format: { type: "json_object" } } : {}),
              messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content },
              ],
            }),
            signal: controller.signal,
          });
          if (!res.ok) {
            lastError = `Model provider returned HTTP ${res.status}.`;
            if (res.status === 400 && useJsonMode) {
              // Some providers reject response_format for vision models; retry once without it.
              useJsonMode = false;
              attempts -= 1;
              continue;
            }
            if (isRetryable(res.status) && attempts < maxAttempts) {
              await sleep(500 * 2 ** (attempts - 1));
              continue;
            }
            return fail(lastError);
          }
          const body = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
          const text = body.choices?.[0]?.message?.content;
          if (typeof text !== "string" || text.trim() === "") return fail("Model returned an empty or refused response.");
          let raw: unknown;
          try {
            raw = parseModelJson(text);
          } catch {
            return fail("Model response was not valid JSON.");
          }
          try {
            const data = validateExtraction(raw);
            log.info("extraction ok", { provider, model: config.MODEL_ID, latencyMs: Date.now() - started, attempts });
            return { ok: true, data, meta: meta() };
          } catch {
            return fail("Model response did not match the extraction schema.");
          }
        } catch (err) {
          lastError = (err as Error).name === "AbortError" ? "Model request timed out." : "Model request failed.";
          if (attempts < maxAttempts) {
            await sleep(500 * 2 ** (attempts - 1));
            continue;
          }
          return fail(lastError);
        } finally {
          clearTimeout(timer);
        }
      }
      return fail(lastError);
    },
  };
}
