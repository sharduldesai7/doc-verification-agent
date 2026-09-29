import { waitUntil } from "@vercel/functions";
import { createAppFromEnv } from "./bootstrap";

// One catch-all serverless function wraps the Express app (see /api/index.ts and vercel.json).
// Background verification is kept alive after the 201 response with waitUntil.
export const { app } = createAppFromEnv((work) => waitUntil(work));
