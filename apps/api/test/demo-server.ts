/**
 * Test/demo only: runs the real Express app on PGlite + in-memory storage with a stand-in
 * "model" that reads a JSON transcription appended to the uploaded file. Lets the UI be
 * exercised without any cloud accounts. Never used in production.
 *   pnpm --filter @iv/api exec tsx test/demo-server.ts
 */
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { createApp } from "../src/app";
import type { Db } from "../src/db/client";
import * as schema from "../src/db/schema";
import { createLogger } from "../src/logger";
import type { ModelClient } from "../src/model/client";
import { validateExtraction } from "../src/model/schema";
import { createMemoryStorage } from "../src/storage";

async function main() {
  const pg = new PGlite();
  await migrate(drizzle(pg), { migrationsFolder: path.join(__dirname, "../drizzle") });
  const model: ModelClient = {
    async extract({ data }) {
      const meta = { provider: "demo", model: "demo-json", latencyMs: 1, attempts: 1 };
      const s = data.toString("latin1");
      const i = s.indexOf("{");
      if (i < 0) return { ok: false, error: "No transcription embedded in this demo file.", meta };
      try {
        return { ok: true, data: validateExtraction(JSON.parse(data.subarray(i).toString("utf8"))), meta };
      } catch {
        return { ok: false, error: "Demo transcription was not valid.", meta };
      }
    },
  };
  const logger = createLogger("warn");
  const app = createApp({
    config: { CORS_ORIGINS: undefined, STALE_AFTER_MINUTES: 10 },
    db: drizzle(pg, { schema }) as unknown as Db,
    storage: createMemoryStorage(),
    model,
    logger,
    schedule: (w) => { void w; },
  });
  const port = Number(process.env.PORT ?? 3001);
  app.listen(port, () => console.log(`demo api on ${port}`));
}
main();
