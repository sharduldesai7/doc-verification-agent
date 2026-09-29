/**
 * Section 6.2 - name matching.
 *
 * Small deviation from the literal spec: combining marks are stripped after
 * NFKD so "Café" becomes "cafe" rather than "cafe " with a stray split point.
 */
const CORPORATE_SUFFIXES = new Set([
  "inc", "incorporated", "llc", "lc", "llp", "lp", "ltd", "limited", "corp",
  "corporation", "co", "company", "plc", "gmbh", "sa", "nv", "bv", "ag",
  "group", "holdings", "holding", "the",
]);

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export function normalizeEmployer(name: string): string {
  const tokens = tokenize(name);
  const stripped = tokens.filter((t) => !CORPORATE_SUFFIXES.has(t));
  return (stripped.length > 0 ? stripped : tokens).join(" ");
}

export function employersMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const na = normalizeEmployer(a);
  const nb = normalizeEmployer(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

function applicantTokens(name: string): string[] {
  return tokenize(name).filter((t) => t.length > 1);
}

/**
 * The shorter token list's first and last tokens must each appear somewhere
 * in the other side's token set. Middle names and order may differ.
 */
export function applicantsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const ta = applicantTokens(a);
  const tb = applicantTokens(b);
  if (ta.length === 0 || tb.length === 0) return false;
  const [shorter, longer] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const set = new Set(longer);
  return set.has(shorter[0]!) && set.has(shorter[shorter.length - 1]!);
}
