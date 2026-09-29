import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  MODEL_API_KEY: z.string().min(1),
  MODEL_BASE_URL: z.string().url(),
  MODEL_ID: z.string().min(1),
  S3_ENDPOINT: z.string().url(),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_REGION: z.string().min(1).default("auto"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  CORS_ORIGINS: z.string().optional(),
  STALE_AFTER_MINUTES: z.coerce.number().positive().default(10),
});

export type Config = z.infer<typeof schema>;

export class ConfigError extends Error {}

/** Fails fast with one message naming every missing or invalid variable. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new ConfigError(`Invalid or missing environment configuration:\n  - ${problems.join("\n  - ")}`);
  }
  return parsed.data;
}
