import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
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

interface QueryController<T> {
  readonly data: T | null;
  readonly error: string | null;
  readonly loading: boolean;
  readonly setData: (data: T | null) => void;
  readonly setError: (error: string | null) => void;
  readonly setLoading: (loading: boolean) => void;
  readonly mountedRef: MutableRefObject<boolean>;
  readonly requestIdRef: MutableRefObject<number>;
  readonly controllerRef: MutableRefObject<AbortController | null>;
  readonly onErrorRef: MutableRefObject<UseApiQueryOptions<T>["onError"]>;
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
  const controller = useQueryController<T>(enabled, initialData, onError);
  const run = useQueryRunner(fetcher, enabled, controller);
  useQueryMountLifecycle(controller);
  useQueryAutoRun(enabled, run, deps, controller);
  return {
    data: controller.data,
    error: controller.error,
    loading: controller.loading,
    refetch: run
  };
}

function useQueryController<T>(
  enabled: boolean,
  initialData: T | null,
  onError: UseApiQueryOptions<T>["onError"]
): QueryController<T> {
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
  return useMemo(
    () => ({
      data,
      error,
      loading,
      setData,
      setError,
      setLoading,
      mountedRef,
      requestIdRef,
      controllerRef,
      onErrorRef
    }),
    [data, error, loading]
  );
}

function useQueryRunner<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  enabled: boolean,
  controller: QueryController<T>
) {
  return useCallback(
    async (mode: QueryMode = "replace"): Promise<T | null> => {
      if (!enabled) {
        controller.setLoading(false);
        controller.setError(null);
        return null;
      }

      const request = beginQueryRequest(controller);

      if (mode === "replace") {
        controller.setLoading(true);
      }
      controller.setError(null);

      try {
        const nextData = await fetcher(request.controller.signal);
        if (!isCurrentRequest(controller, request.id)) {
          return null;
        }
        controller.setData(nextData);
        return nextData;
      } catch (err) {
        return handleQueryError(controller, request, err);
      } finally {
        finishQueryRequest(controller, request, mode);
      }
    },
    [enabled, fetcher]
  );
}

function useQueryMountLifecycle<T>(controller: QueryController<T>) {
  useEffect(() => {
    controller.mountedRef.current = true;
    return () => {
      controller.mountedRef.current = false;
      abortActiveController(controller);
    };
  }, []);
}

function useQueryAutoRun<T>(
  enabled: boolean,
  run: (mode?: QueryMode) => Promise<T | null>,
  deps: readonly unknown[],
  controller: QueryController<T>
) {
  useEffect(() => {
    if (!enabled) {
      abortActiveController(controller);
      controller.setLoading(false);
      controller.setError(null);
      return;
    }

    void run("replace");
    return () => {
      controller.controllerRef.current?.abort();
    };
  }, [enabled, run, ...deps]);
}

function beginQueryRequest<T>(controller: QueryController<T>) {
  abortActiveController(controller);
  const abortController = new AbortController();
  controller.controllerRef.current = abortController;
  return { controller: abortController, id: ++controller.requestIdRef.current };
}

function finishQueryRequest<T>(
  controller: QueryController<T>,
  request: { readonly controller: AbortController; readonly id: number },
  mode: QueryMode
) {
  if (controller.controllerRef.current === request.controller) controller.controllerRef.current = null;
  if (mode === "replace" && isCurrentRequest(controller, request.id)) controller.setLoading(false);
}

function handleQueryError<T>(
  controller: QueryController<T>,
  request: { readonly controller: AbortController; readonly id: number },
  err: unknown
): null {
  if (!isCurrentRequest(controller, request.id) || isSilentQueryError(err, request.controller)) {
    return null;
  }
  const message = err instanceof Error ? err.message : "unknown error";
  controller.setError(message);
  controller.onErrorRef.current?.(message, err);
  return null;
}

function isCurrentRequest<T>(controller: QueryController<T>, requestId: number): boolean {
  return controller.mountedRef.current && requestId === controller.requestIdRef.current;
}

function isSilentQueryError(err: unknown, controller: AbortController): boolean {
  return (
    controller.signal.aborted ||
    (err instanceof DOMException && err.name === "AbortError") ||
    (err as ApiError).status === 401
  );
}

function abortActiveController<T>(controller: QueryController<T>) {
  controller.controllerRef.current?.abort();
  controller.controllerRef.current = null;
}
