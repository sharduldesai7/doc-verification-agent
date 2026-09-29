import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { ALLOWED_TYPES, api, fileToBase64, MAX_FILE_BYTES, MAX_FILES } from "../api";
import { bytes } from "../format";

export function SubmitPage() {
  const nav = useNavigate();
  const [applicationId, setApplicationId] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function pick(list: FileList | null) {
    setError(null);
    setFiles(list ? Array.from(list) : []);
  }

  function validate(): string | null {
    if (!applicationId.trim()) return "Enter your application ID.";
    if (files.length === 0) return "Select at least one document.";
    if (files.length > MAX_FILES) return `Select at most ${MAX_FILES} documents.`;
    for (const f of files) {
      if (!ALLOWED_TYPES.includes(f.type.toLowerCase())) return `${f.name}: only PNG, JPEG, WEBP or PDF files are accepted.`;
      if (f.size === 0) return `${f.name} is empty.`;
      if (f.size > MAX_FILE_BYTES) return `${f.name} is larger than 12 MiB.`;
    }
    return null;
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const problem = validate();
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      const documents = await Promise.all(files.map(async (f) => ({ fileName: f.name, mimeType: f.type.toLowerCase(), dataBase64: await fileToBase64(f) })));
      const receipt = await api.submit(applicationId.trim(), documents);
      nav(`/status/${receipt.submissionId}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <section className="card narrow">
      <h1>Verify your income</h1>
      <p className="muted">Upload your recent payslips. We check them against your application; you will see a simple status when we are done.</p>
      <form onSubmit={onSubmit}>
        <label>
          Application ID
          <input value={applicationId} onChange={(e) => setApplicationId(e.target.value)} autoComplete="off" placeholder="e.g. APP-1001" />
        </label>
        <label>
          Income documents (1 to {MAX_FILES} files: PNG, JPEG, WEBP or PDF, up to 12 MiB each)
          <input type="file" multiple accept={ALLOWED_TYPES.join(",")} onChange={(e) => pick(e.target.files)} />
        </label>
        {files.length > 0 && (
          <ul className="files">
            {files.map((f) => <li key={f.name + f.size}>{f.name} <span className="muted">{bytes(f.size)}</span></li>)}
          </ul>
        )}
        {error && <p className="error" role="alert">{error}</p>}
        <button type="submit" disabled={busy}>{busy ? "Uploading..." : "Submit for verification"}</button>
      </form>
    </section>
  );
}
