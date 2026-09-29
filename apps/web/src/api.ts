import type {
  ApplicationRow, DocumentDetail, ImportSummary, PublicStatusResponse, Receipt, Stats, SubmissionDetail, SubmissionListItem,
} from "./types";

export class ApiClientError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiClientError(0, "Could not reach the server. Check your connection and try again.");
  }
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
  if (!res.ok) {
    const msg = (data as { error?: string } | null)?.error;
    if (msg) throw new ApiClientError(res.status, msg);
    if (res.status === 413) throw new ApiClientError(413, "The upload is too large for the server. Try fewer or smaller files.");
    throw new ApiClientError(res.status, `Request failed (HTTP ${res.status}).`);
  }
  return data as T;
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export const api = {
  submit: (applicationId: string, documents: { fileName: string; mimeType: string; dataBase64: string }[]) =>
    request<Receipt>("/api/submissions", json({ applicationId, documents })),
  status: (id: string) => request<PublicStatusResponse>(`/api/submissions/${encodeURIComponent(id)}/status`),
  stats: () => request<Stats>("/api/review/stats"),
  listSubmissions: (params: { resultState?: string; search?: string }) => {
    const q = new URLSearchParams();
    if (params.resultState) q.set("resultState", params.resultState);
    if (params.search) q.set("search", params.search);
    return request<{ submissions: SubmissionListItem[] }>(`/api/review/submissions?${q}`);
  },
  submissionDetail: (id: string) =>
    request<{ submission: SubmissionDetail; documents: DocumentDetail[] }>(`/api/review/submissions/${encodeURIComponent(id)}`),
  reportUrl: (id: string) => `/api/review/submissions/${encodeURIComponent(id)}/report.pdf`,
  listApplications: () => request<{ applications: ApplicationRow[] }>("/api/applications"),
  importApplications: (fileName: string, dataBase64: string) =>
    request<ImportSummary>("/api/applications/import", json({ fileName, dataBase64 })),
  purgeApplications: () => request<{ deleted: number }>("/api/applications?confirm=purge", { method: "DELETE" }),
};

export const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/jpg", "image/webp", "application/pdf"];
export const MAX_FILE_BYTES = 12 * 1024 * 1024;
export const MAX_FILES = 10;

/** Base64 of a File, without the data: URL prefix. */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.readAsDataURL(file);
  });
}
