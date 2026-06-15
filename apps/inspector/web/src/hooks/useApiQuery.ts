import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiError } from "../api";

type QueryMode = "replace" | "background";

export interface UseApiQueryOptions<T> {
  readonly enabled?: boolean;
  readonly initialData?: T | null;
  readonly onError?: (message: string, error: unknown) => void;
}

export interface UseApiQueryResult<T> {
  readonly data: T | null;
  readonly error: string | null;
  readonly loading: boolean;
  readonly refetch: (mode?: QueryMode) => Promise<T | null>;
}

/**
 * Runs an abortable API-backed query and ignores stale responses when the
 * inputs change quickly or the page unmounts.
 *
 * The hook owns only the GET-style load lifecycle. Callers keep page-specific
 * refresh indicators, pagination, and mutation flows local to the page.
 */
export function useApiQuery<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
  options: UseApiQueryOptions<T> = {}
): UseApiQueryResult<T> {
  const { enabled = true, initialData = null, onError } = options;
  const [data, setData] = useState<T | null>(initialData);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(enabled);
  const mountedRef = useRef(false);
  const requestIdRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const run = useCallback(
    async (mode: QueryMode = "replace"): Promise<T | null> => {
      if (!enabled) {
        setLoading(false);
        setError(null);
        return null;
      }

      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      const requestId = ++requestIdRef.current;

      if (mode === "replace") {
        setLoading(true);
      }
      setError(null);

      try {
        const nextData = await fetcher(controller.signal);
        if (!mountedRef.current || requestId !== requestIdRef.current) {
          return null;
        }
        setData(nextData);
        return nextData;
      } catch (err) {
        if (!mountedRef.current || requestId !== requestIdRef.current) {
          return null;
        }
        if (
          controller.signal.aborted ||
          (err instanceof DOMException && err.name === "AbortError") ||
          (err as ApiError).status === 401
        ) {
          return null;
        }
        const message = err instanceof Error ? err.message : "unknown error";
        setError(message);
        onErrorRef.current?.(message, err);
        return null;
      } finally {
        if (controllerRef.current === controller) {
          controllerRef.current = null;
        }
        if (mode === "replace" && mountedRef.current && requestId === requestIdRef.current) {
          setLoading(false);
        }
      }
    },
    [enabled, fetcher]
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!enabled) {
      controllerRef.current?.abort();
      controllerRef.current = null;
      setLoading(false);
      setError(null);
      return;
    }

    void run("replace");
    return () => {
      controllerRef.current?.abort();
    };
  }, [enabled, run, ...deps]);

  return { data, error, loading, refetch: run };
}
