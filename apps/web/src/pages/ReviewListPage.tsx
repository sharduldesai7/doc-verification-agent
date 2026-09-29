import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { when } from "../format";
import { useDebounced, useLoad } from "../hooks";
import type { ResultState } from "../types";

export const stateClass = (s: ResultState | null) => (s === "Approve" ? "ok" : s === "Manual Review" ? "warn" : s === "Error" ? "bad" : "muted");

export function ReviewListPage() {
  const [filter, setFilter] = useState("");
  const [search, setSearch] = useState("");
  const q = useDebounced(search);
  const stats = useLoad(() => api.stats(), [], undefined);
  const list = useLoad(() => api.listSubmissions({ resultState: filter, search: q }), [filter, q], (d) => d.submissions.some((s) => s.stage === "processing"));
  const s = stats.data;

  return (
    <>
      <h1>Review queue</h1>
      {s && (
        <div className="stats">
          <Stat label="Total" value={s.total} />
          <Stat label="Approved" value={s.approve} />
          <Stat label="Manual review" value={s.manualReview} />
          <Stat label="Errors" value={s.error} />
          <Stat label="Processing" value={s.processing} />
          <Stat label="Approval rate" value={s.approvalRate === null ? "n/a" : `${(s.approvalRate * 100).toFixed(0)}%`} />
          <Stat label="Median time" value={s.medianProcessingSeconds === null ? "n/a" : `${s.medianProcessingSeconds.toFixed(1)}s`} />
        </div>
      )}
      <div className="toolbar">
        <input type="search" placeholder="Search application ID, applicant, employer or submission ID" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter by result">
          <option value="">All results</option>
          <option>Approve</option>
          <option>Manual Review</option>
          <option>Error</option>
          <option value="Pending">Pending</option>
        </select>
      </div>
      {list.error && <p className="error" role="alert">{list.error}</p>}
      <div className="tablewrap">
        <table>
          <thead><tr><th>Submitted</th><th>Application</th><th>Applicant</th><th>Employer</th><th>Docs</th><th>Ratio</th><th>Result</th></tr></thead>
          <tbody>
            {list.data?.submissions.map((r) => (
              <tr key={r.id}>
                <td><Link to={`/review/${r.id}`}>{when(r.submittedAt)}</Link></td>
                <td>{r.applicationId}</td>
                <td>{r.applicantName ?? "n/a"}</td>
                <td>{r.employerName ?? "n/a"}</td>
                <td>{r.documentCount}</td>
                <td>{r.incomeRatio === null ? "n/a" : r.incomeRatio.toFixed(4)}</td>
                <td><span className={`badge ${stateClass(r.resultState)}`}>{r.resultState ?? "Processing"}</span></td>
              </tr>
            ))}
            {list.data && list.data.submissions.length === 0 && <tr><td colSpan={7} className="muted">No submissions match.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return <div className="stat"><div className="statv">{value}</div><div className="statl">{label}</div></div>;
}
