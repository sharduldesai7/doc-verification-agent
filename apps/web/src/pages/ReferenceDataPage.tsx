import { useRef, useState } from "react";
import { api, fileToBase64 } from "../api";
import { money, when } from "../format";
import { useLoad } from "../hooks";
import type { ImportSummary } from "../types";

export function ReferenceDataPage() {
  const list = useLoad(() => api.listApplications(), []);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  async function onImport(file: File | undefined) {
    if (!file) return;
    setBusy(true); setError(null); setSummary(null);
    try {
      setSummary(await api.importApplications(file.name, await fileToBase64(file)));
      list.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function onPurge() {
    setBusy(true); setError(null); setSummary(null);
    try {
      await api.purgeApplications();
      setConfirm("");
      list.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const rows = list.data?.applications ?? [];
  return (
    <>
      <h1>Reference data</h1>
      <p className="muted">Applications that submissions are checked against. There is no per-record editor: to correct a row, re-import a workbook containing it (rows are matched by application ID).</p>

      <section className="card">
        <h2>Import Application_data</h2>
        <input ref={fileRef} type="file" accept=".xlsx,.csv" disabled={busy} onChange={(e) => onImport(e.target.files?.[0])} />
        {summary && (
          <div role="status">
            <p><strong>{summary.imported}</strong> imported, <strong>{summary.updated}</strong> updated, <strong>{summary.skipped}</strong> skipped.</p>
            {summary.warnings.length > 0 && <ul className="small">{summary.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
          </div>
        )}
        {error && <p className="error" role="alert">{error}</p>}
      </section>

      <section className="card">
        <h2>Current dataset ({rows.length})</h2>
        <div className="tablewrap">
          <table>
            <thead><tr><th>Application</th><th>Applicant</th><th>Employer</th><th>Stated income</th><th>Basis</th><th>Monthly</th><th>Cur.</th><th>Submissions</th><th>Imported</th></tr></thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.applicationId}>
                  <td>{a.applicationId}</td><td>{a.applicantName ?? "n/a"}</td><td>{a.employerName ?? "n/a"}</td>
                  <td>{money(a.statedIncomeAmount)}</td><td>{a.statedIncomeBasis ?? "n/a"}</td><td>{money(a.statedMonthlyIncome)}</td>
                  <td>{a.currency ?? "n/a"}</td><td>{a.submissionCount}</td><td>{when(a.importedAt)}</td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={9} className="muted">No reference data. Import a workbook to begin.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card danger">
        <h2>Purge all reference data</h2>
        <p>Removes every reference row. Existing submissions, decisions and audit PDFs are kept, but new submissions will be rejected until data is re-imported.</p>
        <label>
          Type PURGE to confirm
          <input value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
        </label>
        <button className="danger" disabled={confirm !== "PURGE" || busy || rows.length === 0} onClick={onPurge}>Purge reference data</button>
      </section>
    </>
  );
}
