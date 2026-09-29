import { Link, useParams } from "react-router-dom";
import { api } from "../api";
import { when } from "../format";
import { useLoad } from "../hooks";
import type { PublicStatus } from "../types";

const COPY: Record<PublicStatus, { title: string; body: string }> = {
  processing: { title: "Processing", body: "We are reading your documents. This page updates automatically." },
  verified: { title: "Verified", body: "Your income documents have been verified. No further action is needed." },
  under_review: { title: "Under review", body: "Your submission needs a closer look from our team. We will be in touch if we need anything else." },
};

export function StatusPage() {
  const { id = "" } = useParams();
  const { data, error } = useLoad(() => api.status(id), [id], (d) => d.publicStatus === "processing");

  return (
    <section className="card narrow">
      <h1>Submission status</h1>
      {error && !data && <p className="error" role="alert">{error}</p>}
      {data && (
        <>
          <p><span className={`badge status-${data.publicStatus}`}>{COPY[data.publicStatus].title}</span></p>
          <p>{COPY[data.publicStatus].body}</p>
          <dl className="kv">
            <dt>Application</dt><dd>{data.applicationId}</dd>
            <dt>Documents</dt><dd>{data.documentCount}</dd>
            <dt>Submitted</dt><dd>{when(data.submittedAt)}</dd>
            <dt>Reference</dt><dd><code>{data.submissionId}</code></dd>
          </dl>
        </>
      )}
      <p><Link to="/">Submit more documents</Link></p>
    </section>
  );
}
