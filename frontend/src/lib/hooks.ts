import { useCallback, useEffect, useRef, useState, type DependencyList } from 'react';

export function useResource<T = any>(loader: (signal?: AbortSignal) => Promise<T>, deps: DependencyList = [], intervalMs = 0) {
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const request = useRef(0);
  const pending = useRef(false);
  const [data, setData] = useState<T | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<any>(null);

  const reload = useCallback(async (quiet: boolean | unknown = false) => {
    if (quiet === true && pending.current) return undefined;
    controller.current?.abort();
    pending.current = true;
    const ac = new AbortController();
    controller.current = ac;
    const current = ++request.current;
    if (quiet !== true) setLoading(true);
    try {
      const result = await loaderRef.current(ac.signal);
      if (mounted.current && current === request.current && !ac.signal.aborted) {
        setData(result); setError(null);
      }
      return result;
    } catch (e) {
      if (mounted.current && current === request.current && !ac.signal.aborted) setError(e);
      return undefined;
    } finally {
      if (current === request.current) pending.current = false;
      if (mounted.current && current === request.current && !ac.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    setData(undefined); setError(null);
    void reload();
    const timer = intervalMs > 0 ? setInterval(() => { if (!document.hidden) void reload(true); }, intervalMs) : null;
    return () => { mounted.current = false; request.current++; pending.current = false; controller.current?.abort(); if (timer) clearInterval(timer); };
  }, [...deps, intervalMs, reload]);
  useEffect(() => {
    const refresh = () => { void reload(true); };
    window.addEventListener('jz:refresh', refresh);
    return () => window.removeEventListener('jz:refresh', refresh);
  }, [reload]);
  return { data, loading, error, reload, setData };
}

export function useDebouncedValue<T>(value: T, delay = 350) {
  const [result, setResult] = useState(value);
  useEffect(() => { const timer = setTimeout(() => setResult(value), delay); return () => clearTimeout(timer); }, [value, delay]);
  return result;
}
