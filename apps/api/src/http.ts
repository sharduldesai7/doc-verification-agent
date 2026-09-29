import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Decodes standard base64 (optionally a data: URL). Returns null if malformed. */
export function decodeBase64(input: string): Buffer | null {
  const raw = input.replace(/^data:[^,]*;base64,/i, "").replace(/\s+/g, "");
  if (raw.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(raw)) return null;
  return Buffer.from(raw, "base64");
}

export function errorHandler(logger: { error: (m: string, f?: Record<string, unknown>) => void }) {
  return (err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ApiError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    if (err instanceof ZodError) {
      res.status(400).json({ error: "Invalid request.", issues: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
      return;
    }
    const e = err as { type?: string; status?: number };
    if (e.type === "entity.too.large") {
      res.status(413).json({ error: "Request body is too large." });
      return;
    }
    if (e.type === "entity.parse.failed") {
      res.status(400).json({ error: "Request body is not valid JSON." });
      return;
    }
    logger.error("unhandled error", { requestId: (req as Request & { id?: string }).id, failureClass: (err as Error)?.name });
    res.status(500).json({ error: "Internal server error." });
  };
}
