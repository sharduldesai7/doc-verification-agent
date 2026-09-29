import { loadConfig } from "./config";
import { createApp } from "./app";
import { createDb } from "./db/client";
import { createLogger } from "./logger";
import { createModelClient } from "./model/client";
import { createS3Storage } from "./storage";

/** Builds the real app from environment variables. Throws (fail fast) if any are missing. */
export function createAppFromEnv(schedule: (work: Promise<unknown>) => void) {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);
  const deps = {
    config,
    logger,
    db: createDb(config.DATABASE_URL),
    storage: createS3Storage(config),
    model: createModelClient(config, { logger }),
    schedule,
  };
  return { app: createApp(deps), deps };
}
