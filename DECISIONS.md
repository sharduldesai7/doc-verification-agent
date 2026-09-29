# Decisions where the PRD left a choice

| Topic | Choice |
| --- | --- |
| 6.1 divisors | **Confirmed by the product owner:** stated income amounts are annual. Every non-monthly basis (annual, semimonthly, biweekly, weekly) divides the stated amount by 12; monthly divides by 1. Single table `BASIS_DIVISORS` in `verification/basis.ts`. A row whose basis reads "Monthly" is taken at face value as a monthly amount, so an annual figure mislabelled "Monthly" gives a target 12 times too high and goes to Manual Review. |
| 6.3 selection order | **Fixed.** One payslip is chosen per expected month before validity exclusions, so duplicate or out-of-window months can never displace a required older month. Best candidate per month: valid gross and not inconsistent, then consistent evidence, then latest pay date. |
| Undated payslips | Never counted; produce a `warn` on `month_coverage`. |
| Pay month source | `payDate`, falling back to `payPeriodEnd`. |
| Unresolved evidence | Slip stays countable, but `pay_evidence_consistency` fails, blocking approval. Inconsistent evidence is also excluded from the count. |
| Zero identified payslips | Result `Error` (AC7), with all checks still recorded. |
| Working employer group | Group matching the stated employer, else the largest group. Another employer inside the window fails `single_employer`; outside the window only warns. |
| Missing stated data | Missing stated employer, applicant or currency fails the relevant check rather than passing by default. |
| Foreign keys | `documents.submission_id` is a real FK with cascade. `submissions.application_id` is deliberately **not** an FK so purging reference data never touches submissions (FR10). |
| Name normalization | Combining marks are stripped after NFKD (small deviation from the literal 6.2 text). |
| Storage | S3-compatible (Cloudflare R2) for genuinely private objects; accessed only through the API. |
| Model | Any OpenAI-compatible chat-completions endpoint with image input. Falls back to no `response_format` if a provider rejects JSON mode. |
| Uploads | JSON with base64, as specified (see the 4.5 MB Vercel limit in the README). File signatures are checked against the declared MIME type. |
| Reference import | JSON `{fileName, dataBase64}`, not multipart. Last duplicate row in a file wins, with a warning. |
| Public status | `processing`, `verified` (Approve) or `under_review` (Manual Review and Error). |
| Stuck submissions | Swept to `Error` on reads after `STALE_AFTER_MINUTES`, and immediately on local dev-server startup. |
