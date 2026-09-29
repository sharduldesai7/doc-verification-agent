import { randomUUID } from "node:crypto";
import cors from "cors";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type { Config } from "./config";
import type { Db } from "./db/client";
import { errorHandler } from "./http";
import type { Logger } from "./logger";
import type { ModelClient } from "./model/client";
import { applicationsRouter } from "./routes/applications";
import { reviewRouter } from "./routes/review";
import { submissionsRouter } from "./routes/submissions";
import type { BlobStorage } from "./storage";

export interface AppDeps {
  config: Pick<Config, "CORS_ORIGINS" | "STALE_AFTER_MINUTES">;
  db: Db;
  storage: BlobStorage;
  model: ModelClient;
  logger: Logger;
  /** Runs work after the response is sent (Vercel waitUntil in production). */
  schedule: (work: Promise<unknown>) => void;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable("x-powered-by");

  const origins = deps.config.CORS_ORIGINS?.split(",").map((s) => s.trim()).filter(Boolean);
  if (origins && origins.length > 0) app.use(cors({ origin: origins }));
  else {
    deps.logger.warn("CORS_ORIGINS is not set; allowing all origins. Restrict this before any shared deployment.");
    app.use(cors());
  }

  app.use((req: Request & { id?: string }, res: Response, next: NextFunction) => {
    req.id = (req.header("x-request-id") ?? randomUUID()).slice(0, 64);
    res.setHeader("x-request-id", req.id);
    const started = Date.now();
    res.on("finish", () => {
      deps.logger.info("request", { requestId: req.id, method: req.method, route: req.route?.path ?? req.path, status: res.statusCode, ms: Date.now() - started });
    });
    next();
  });

  // 10 documents x 12 MiB, base64-encoded, plus JSON overhead.
  app.use(express.json({ limit: "180mb" }));

  // Liveness only: does not prove DB, storage or model readiness.
  app.get("/api/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use("/api/applications", applicationsRouter(deps));
  app.use("/api/submissions", submissionsRouter(deps));
  app.use("/api/review", reviewRouter(deps));

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found." });
  });
  app.use(errorHandler(deps.logger));
  return app;
}
