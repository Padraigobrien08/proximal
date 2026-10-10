"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "./api";
import { DATA_CHANGED } from "./dataEvents";

/** Fetch a JSON resource; `reload()` refetches. setState only happens in async callbacks. */
export function useApiResource<T>(url: string) {
  const [state, setState] = useState<{ data: T | null; error: string | null }>({ data: null, error: null });
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api<T>(url).then(
      (data) => {
        if (!cancelled) setState({ data, error: null });
      },
      (err) => {
        if (!cancelled) setState((s) => ({ ...s, error: err instanceof ApiError ? err.message : "Could not load. Check that the local server is running." }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [url, version]);

  // Refetch when another view reports a persisted change (import, approval, session end, flag).
  useEffect(() => {
    const onChange = () => setVersion((v) => v + 1);
    window.addEventListener(DATA_CHANGED, onChange);
    return () => window.removeEventListener(DATA_CHANGED, onChange);
  }, []);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  const setData = useCallback((data: T) => setState({ data, error: null }), []);
  return { data: state.data, error: state.error, reload, setData };
}
