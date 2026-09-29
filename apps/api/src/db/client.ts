import { drizzle } from "drizzle-orm/postgres-js";
import type { PgDatabase } from "drizzle-orm/pg-core";
import postgres from "postgres";
import * as schema from "./schema";

/** Driver-agnostic handle so tests can run the same code on PGlite. */
export type Db = PgDatabase<any, typeof schema>;

/**
 * Serverless-friendly: one connection per function instance and no prepared
 * statements, which is what Neon's and Supabase's transaction poolers require.
 * DATABASE_URL should be the *pooled* connection string.
 */
export function createDb(url: string): Db {
  const client = postgres(url, { max: 1, prepare: false, idle_timeout: 20, connect_timeout: 15 });
  return drizzle(client, { schema });
}

export { schema };
