import PDFDocument from "pdfkit";
import type { DocumentRow, SubmissionRow } from "../db/schema";

const fmt = (n: number | null | undefined, d = 2) => (n === null || n === undefined ? "n/a" : n.toFixed(d));
const dash = (s: string | null | undefined) => (s && s.length > 0 ? s : "n/a");

/**
 * Audit report (FR6): verdict, pay-evidence assessment, document ledger,
 * employer aggregates, per-document transcriptions, exclusion reasons.
 * Built only from stored rows so a report is a faithful snapshot of the
 * stored decision, never a re-evaluation.
 */
export function buildReportPdf(submission: SubmissionRow, docs: DocumentRow[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ size: "A4", margin: 50, info: { Title: `Income verification ${submission.id}` } });
    const chunks: Buffer[] = [];
    pdf.on("data", (c: Buffer) => chunks.push(c));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);

    const h1 = (t: string) => { pdf.moveDown(0.8).font("Helvetica-Bold").fontSize(14).fillColor("#111").text(t).moveDown(0.3); };
    const h2 = (t: string) => { pdf.moveDown(0.4).font("Helvetica-Bold").fontSize(11).fillColor("#111").text(t); };
    const line = (t: string) => { pdf.font("Helvetica").fontSize(9.5).fillColor("#222").text(t); };
    const kv = (k: string, v: string) => { pdf.font("Helvetica-Bold").fontSize(9.5).fillColor("#222").text(`${k}: `, { continued: true }).font("Helvetica").text(v); };

    pdf.font("Helvetica-Bold").fontSize(20).fillColor("#111").text("Income Verification Report");
    pdf.font("Helvetica").fontSize(9).fillColor("#555").text("Evidence transcription and rule-checking record. Not a fraud or authenticity assessment.");

    h1("1. Verdict");
    kv("Result", submission.resultState ?? "Pending");
    kv("Description", dash(submission.resultDescription));
    if (submission.errorMessage) kv("Error", submission.errorMessage);
    kv("Submission", submission.id);
    kv("Application", submission.applicationId);
    kv("Submitted (UTC)", submission.submittedAt.toISOString());
    kv("Completed (UTC)", submission.completedAt?.toISOString() ?? "n/a");
    kv("Expected months", submission.expectedMonths.join(", ") || "n/a");
    kv("Stated applicant", dash(submission.statedApplicantName));
    kv("Stated employer", dash(submission.statedEmployerName));
    kv("Stated income", `${fmt(submission.statedIncomeAmount)} (${dash(submission.statedIncomeBasis)}) ${dash(submission.statedCurrency)}`);
    kv("Expected 4-month income", fmt(submission.expectedWindowIncome));
    kv("Counted gross total", fmt(submission.calculatedAggregateIncome));
    kv("Income ratio", fmt(submission.incomeRatio, 4));

    h1("2. Verification checks");
    for (const c of submission.checks) {
      line(`[${c.status.toUpperCase()}] ${c.title} - ${c.reason}`);
      pdf.moveDown(0.2);
    }

    h1("3. Pay-evidence assessment");
    for (const d of docs.filter((x) => x.isPayslip)) {
      const v = d.payValidation;
      h2(d.fileName);
      line(`Status: ${v?.status ?? "n/a"}`);
      if (v && v.grossMinor !== null) {
        line(`Gross ${v.grossMinor} - deductions ${v.deductionsMinor} = expected net ${v.expectedNetMinor}; printed net ${v.printedNetMinor} (minor units, ${v.minorUnitDigits} decimals, tolerance 1).`);
      }
      for (const r of v?.reasons ?? []) line(`- ${r}`);
    }

    h1("4. Document ledger");
    for (const d of docs) {
      line(
        `${d.fileName} | ${dash(d.documentType)} | payslip: ${d.isPayslip === null ? "unknown" : d.isPayslip ? "yes" : "no"} | month: ${dash(d.payMonth)} | employer: ${dash(d.employerGroup)} | gross: ${fmt(d.grossPay)} | ${d.includedInAggregate ? "COUNTED" : "not counted"}`,
      );
      pdf.moveDown(0.2);
    }

    h1("5. Employer aggregates");
    if (submission.employerAggregates.length === 0) line("None.");
    for (const a of submission.employerAggregates) {
      line(
        `${a.employerGroup}${a.isWorkingGroup ? " (working group)" : ""} | matches stated: ${a.matchesStatedEmployer ? "yes" : "no"} | identified: ${a.identifiedPayslips} | counted: ${a.countedPayslips} | counted gross: ${fmt(a.countedGrossTotal)} | months: ${a.countedMonths.join(", ") || "none"}`,
      );
      pdf.moveDown(0.2);
    }

    h1("6. Per-document transcriptions");
    for (const d of docs) {
      h2(d.fileName);
      kv("Type", dash(d.documentType));
      kv("Employer", dash(d.employerName));
      kv("Applicant", dash(d.applicantName));
      kv("Pay date / period", `${dash(d.payDate)} / ${dash(d.payPeriodStart)} to ${dash(d.payPeriodEnd)}`);
      kv("Frequency / currency", `${dash(d.payFrequency)} / ${dash(d.currency)}`);
      kv("Gross / net", `${fmt(d.grossPay)} / ${fmt(d.netPay)}`);
      const ev = d.payEvidence;
      if (ev) {
        for (const role of ["gross", "deductions", "net"] as const) {
          const it = ev[role];
          line(`${role}: ${fmt(it.amount)} | label "${dash(it.label)}" | scope "${dash(it.periodScope)}"`);
        }
        for (const c of ev.additionalComponents) line(`extra: ${c.label} ${fmt(c.amount)} (${dash(c.periodScope)})`);
      }
      if (d.notes) kv("Notes", d.notes);
      const meta = d.extractionMetadata;
      if (meta) kv("Extraction", `${meta.status}${meta.error ? ` - ${meta.error}` : ""}${meta.model ? ` (${meta.model})` : ""}`);
    }

    h1("7. Exclusion reasons");
    const excluded = docs.filter((d) => d.exclusionReasons.length > 0);
    if (excluded.length === 0) line("No documents were excluded.");
    for (const d of excluded) {
      h2(d.fileName);
      for (const r of d.exclusionReasons) line(`- ${r}`);
    }
    pdf.end();
  });
}
