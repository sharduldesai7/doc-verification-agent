import { useCallback, useEffect, useRef, useState } from "react";

export interface Loaded<T> { data: T | null; error: string | null; loading: boolean; reload: () => void }

/** Loads on mount / when deps change; optionally re-polls while `shouldPoll(data)` is true. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[], shouldPoll?: (d: T) => boolean, pollMs = 3000): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const pollRef = useRef(shouldPoll);
  pollRef.current = shouldPoll;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setLoading(true);
    fnRef.current()
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setError(null);
        if (pollRef.current?.(d)) timer = setTimeout(() => setTick((t) => t + 1), pollMs);
      })
      .catch((e: Error) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}
