export const money = (n: number | null | undefined, currency?: string | null) =>
  n === null || n === undefined ? "n/a" : `${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${currency ? ` ${currency}` : ""}`;
export const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : "n/a");
export const text = (s: string | null | undefined) => (s && s.length > 0 ? s : "n/a");
export const bytes = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MiB` : `${Math.max(1, Math.round(n / 1024))} KiB`);
