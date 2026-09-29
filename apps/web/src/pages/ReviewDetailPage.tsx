import { Link, useParams } from "react-router-dom";
import { api } from "../api";
import { money, text, when } from "../format";
import { useLoad } from "../hooks";
import type { CheckStatus, DocumentDetail, EvidenceItem, SubmissionDetail } from "../types";
import { stateClass } from "./ReviewListPage";

const CHECK_CLASS: Record<CheckStatus, string> = { pass: "ok", fail: "bad", warn: "warn", skipped: "muted" };

export function ReviewDetailPage() {
  const { id = "" } = useParams();
  const { data, error } = useLoad(() => api.submissionDetail(id), [id], (d) => d.submission.stage === "processing");
  if (error && !data) return <p className="error" role="alert">{error}</p>;
  if (!data) return <p className="muted">Loading...</p>;
  const { submission: s, documents } = data;
  const cur = s.statedCurrency;

  return (
    <>
      <p><Link to="/review">&larr; Review queue</Link></p>
      <div className="head">
        <h1>Submission <code>{s.id.slice(0, 8)}</code></h1>
        <span className={`badge big ${stateClass(s.resultState)}`}>{s.resultState ?? "Processing"}</span>
      </div>
      {s.resultDescription && <p>{s.resultDescription}</p>}
      {s.errorMessage && <p className="error">Error: {s.errorMessage}</p>}
      <p>
        {s.hasReport
          ? <a className="button" href={api.reportUrl(s.id)}>Download audit PDF</a>
          : <span className="muted">{s.stage === "processing" ? "Audit PDF will be available when processing completes." : "No audit PDF was generated for this submission."}</span>}
      </p>

      <Overview s={s} cur={cur} />

      <section className="card">
        <h2>Verification checks</h2>
        <ol className="checks">
          {s.checks.length === 0 && <li className="muted">Checks appear when processing completes.</li>}
          {s.checks.map((c) => (
            <li key={c.id}>
              <span className={`badge ${CHECK_CLASS[c.status]}`}>{c.status}</span>
              <div><strong>{c.title}</strong><div className="muted">{c.reason}</div></div>
            </li>
          ))}
        </ol>
      </section>

      {s.employerAggregates.length > 0 && (
        <section className="card">
          <h2>Employer aggregates</h2>
          <div className="tablewrap">
            <table>
              <thead><tr><th>Employer (as printed)</th><th>Matches stated</th><th>Identified</th><th>Counted</th><th>Counted gross</th><th>Months</th></tr></thead>
              <tbody>
                {s.employerAggregates.map((a) => (
                  <tr key={a.employerGroup}>
                    <td>{a.employerGroup}{a.isWorkingGroup && <span className="badge muted">working group</span>}</td>
                    <td>{a.matchesStatedEmployer ? "Yes" : "No"}</td>
                    <td>{a.identifiedPayslips}</td><td>{a.countedPayslips}</td>
                    <td>{money(a.countedGrossTotal, cur)}</td><td>{a.countedMonths.join(", ") || "none"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <h2>Extracted documents ({documents.length})</h2>
      {documents.map((d) => <DocumentCard key={d.id} d={d} />)}
    </>
  );
}

function Overview({ s, cur }: { s: SubmissionDetail; cur: string | null }) {
  return (
    <section className="card">
      <h2>Overview</h2>
      <dl className="kv two">
        <dt>Application</dt><dd>{s.applicationId}</dd>
        <dt>Stated applicant</dt><dd>{text(s.statedApplicantName)}</dd>
        <dt>Stated employer</dt><dd>{text(s.statedEmployerName)}</dd>
        <dt>Stated income</dt><dd>{money(s.statedIncomeAmount, cur)} ({text(s.statedIncomeBasis)})</dd>
        <dt>Expected 4-month income</dt><dd>{money(s.expectedWindowIncome, cur)}</dd>
        <dt>Calculated (counted gross)</dt><dd>{money(s.calculatedAggregateIncome, cur)}</dd>
        <dt>Income ratio</dt><dd>{s.incomeRatio === null ? "not computed" : s.incomeRatio.toFixed(4)} <span className="muted">(allowed 0.7000 to 1.3000)</span></dd>
        <dt>Expected months</dt><dd>{s.expectedMonths.join(", ") || "n/a"}</dd>
        <dt>Submitted</dt><dd>{when(s.submittedAt)}</dd>
        <dt>Completed</dt><dd>{when(s.completedAt)}</dd>
      </dl>
    </section>
  );
}

function Ev({ role, it }: { role: string; it: EvidenceItem }) {
  return (
    <tr><td>{role}</td><td>{it.amount === null ? "n/a" : it.amount.toFixed(2)}</td><td>{text(it.label)}</td><td>{text(it.periodScope)}</td></tr>
  );
}

function DocumentCard({ d }: { d: DocumentDetail }) {
  const failed = d.extractionMetadata?.status === "failed";
  const v = d.payValidation;
  return (
    <section className="card">
      <div className="head">
        <h3>{d.fileName}</h3>
        <span>
          {failed && <span className="badge bad">unreadable</span>}
          {d.isPayslip === false && <span className="badge muted">not a payslip</span>}
          {d.includedInAggregate && <span className="badge ok">counted</span>}
          {d.isPayslip && !d.includedInAggregate && <span className="badge warn">not counted</span>}
        </span>
      </div>
      {failed && <p className="error">{d.extractionMetadata?.error}</p>}
      {!failed && (
        <dl className="kv two">
          <dt>Type</dt><dd>{text(d.documentType)}</dd>
          <dt>Employer</dt><dd>{text(d.employerName)}</dd>
          <dt>Applicant</dt><dd>{text(d.applicantName)}</dd>
          <dt>Pay date</dt><dd>{text(d.payDate)} {d.payMonth && <span className="muted">(bucket {d.payMonth}{d.inWindow ? "" : ", outside window"})</span>}</dd>
          <dt>Period</dt><dd>{text(d.payPeriodStart)} to {text(d.payPeriodEnd)} ({text(d.payFrequency)})</dd>
          <dt>Gross / net</dt><dd>{money(d.grossPay, d.currency)} / {money(d.netPay, d.currency)}</dd>
        </dl>
      )}
      {v && (
        <p>
          Pay evidence: <span className={`badge ${v.status === "consistent" ? "ok" : v.status === "inconsistent" ? "bad" : "warn"}`}>{v.status}</span>
          {v.expectedNetMinor !== null && (
            <span className="muted"> gross {v.grossMinor} - deductions {v.deductionsMinor} = {v.expectedNetMinor}; printed net {v.printedNetMinor} (minor units, tolerance 1)</span>
          )}
        </p>
      )}
      {v && v.reasons.length > 0 && <ul>{v.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
      {d.payEvidence && (
        <div className="tablewrap">
          <table>
            <thead><tr><th>Line</th><th>Amount</th><th>Printed label</th><th>Period scope</th></tr></thead>
            <tbody>
              <Ev role="Gross" it={d.payEvidence.gross} />
              <Ev role="Deductions" it={d.payEvidence.deductions} />
              <Ev role="Net" it={d.payEvidence.net} />
              {d.payEvidence.additionalComponents.map((c, i) => <Ev key={i} role="Other" it={c} />)}
            </tbody>
          </table>
        </div>
      )}
      {d.exclusionReasons.length > 0 && (
        <div><strong>Excluded because:</strong><ul>{d.exclusionReasons.map((r) => <li key={r}>{r}</li>)}</ul></div>
      )}
      {d.notes && <p className="muted">Model notes: {d.notes}</p>}
    </section>
  );
}
