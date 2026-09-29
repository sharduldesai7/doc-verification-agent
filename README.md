# Income Verification (Alpha)

Applicants upload payslips against an application ID. A vision model transcribes them, a deterministic
rules engine decides Approve / Manual Review / Error, and reviewers inspect evidence and download an audit PDF.

```
apps/api   Express app (Vercel catch-all function), Drizzle schema + migration, rules engine, tests
apps/web   React + Vite: applicant, reviewer and reference-data screens
api/       Vercel entry point
```

## Setup
1. Create hosted Postgres (Neon/Supabase), a private R2/S3 bucket, and an API key for a vision model provider.
2. Copy `.env.example` to `.env` and fill it in. Startup fails fast if any required variable is missing.
3. `pnpm install`, then `pnpm db:migrate`.
4. Local dev: `pnpm dev:api` and `pnpm dev:web` (web proxies `/api` to port 3001).
5. Deploy: import the `income-verification` directory as a Vercel project and set the same variables.

## Tests
`pnpm test` runs the rule tests (one or more per Section 6 rule, plus AC1-AC10) and API integration tests on
an in-process Postgres (PGlite), in-memory storage and a fake model. `pnpm typecheck` checks both apps.
`apps/api/test/demo-server.ts` runs the real app with no cloud accounts for UI exploration.

## Known limits (read before deploying)
- **Vercel request bodies are capped at about 4.5 MB.** The spec's base64 JSON upload (up to 10 x 12 MiB) will
  be rejected by Vercel beyond that. Fix later with direct-to-storage uploads (signed URLs).
- **Scanned PDFs are not supported.** PDFs are read via their text layer; image-only PDFs fail per document.
  Upload PNG/JPEG/WEBP instead.
- Not verified against a live provider or a live Vercel deploy. Measure function duration on first deploy.
- No authentication: all reviewer data is reachable by anyone with the URL. Demo use only.
- No durable job queue: a crash mid-verification leaves the submission `processing` until the stale sweep
  marks it `Error` (on the next read after `STALE_AFTER_MINUTES`).

## Decisions
See [DECISIONS.md](./DECISIONS.md).
