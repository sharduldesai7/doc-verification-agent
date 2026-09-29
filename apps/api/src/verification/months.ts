/** Section 6.3 helpers. All month arithmetic is UTC. */

export function monthKey(year: number, monthIndex0: number): string {
  const y = year + Math.floor(monthIndex0 / 12);
  const m = ((monthIndex0 % 12) + 12) % 12;
  return `${y}-${String(m + 1).padStart(2, "0")}`;
}

/**
 * The calendar month before `submittedAt` and its three predecessors,
 * newest first. Anchored on submission time, never completion time.
 */
export function expectedMonths(submittedAt: Date, count = 4): string[] {
  const y = submittedAt.getUTCFullYear();
  const m = submittedAt.getUTCMonth();
  return Array.from({ length: count }, (_, i) => monthKey(y, m - 1 - i));
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/;

/** Returns "YYYY-MM" for a valid ISO date string, else null. */
export function payMonthOf(isoDate: string | null | undefined): string | null {
  if (!isoDate) return null;
  const m = ISO_DATE.exec(isoDate);
  if (!m) return null;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${m[1]}-${m[2]}`;
}
