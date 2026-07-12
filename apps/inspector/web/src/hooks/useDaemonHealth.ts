import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { AlayaStatusSchema, type AlayaStatus } from "@do-soul/alaya-protocol";
import { apiFetch, type ApiError } from "../api";
import { useToasts } from "../components/toast";

export type DaemonHealthState =
  | { readonly kind: "loading" }
  | { readonly kind: "ok"; readonly status: AlayaStatus }
  | { readonly kind: "schema_error"; readonly raw: unknown }
  | {
      readonly kind: "degraded";
      readonly message: string;
      readonly lastStatus: AlayaStatus | null;
    };

export interface DaemonHealthIndicator {
  readonly label: "OPERATIONAL" | "WARMING" | "OFFLINE";
  readonly colorClass: string;
}

export interface UseDaemonHealthResult {
  readonly state: DaemonHealthState;
  readonly indicator: DaemonHealthIndicator;
  readonly refresh: () => Promise<void>;
  readonly refreshing: boolean;
}

interface StatusEnvelope {
  readonly success?: boolean;
  readonly data?: unknown;
}

type FetchOutcome =
  | { readonly kind: "ok"; readonly status: AlayaStatus }
  | { readonly kind: "schema_error"; readonly raw: unknown }
  | { readonly kind: "network_error"; readonly message: string };

interface HealthRefs {
  readonly consecutiveFailuresRef: MutableRefObject<number>;
  readonly refreshLockRef: MutableRefObject<boolean>;
  readonly lastStatusRef: MutableRefObject<AlayaStatus | null>;
  readonly isMountedRef: MutableRefObject<boolean>;
  readonly cooldownTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  readonly inFlightTickRef: MutableRefObject<Promise<void> | null>;
}

const POLL_OK_MS = 5_000;
const POLL_BACKOFF_MS = 30_000;
const REFRESH_COOLDOWN_MS = 1_000;

/**
 * Polls the daemon status route, classifies degraded/schema-error states, and
 * exposes the same refresh cooldown contract used by the inspector status and
 * overview surfaces.
 */
export function useDaemonHealth(): UseDaemonHealthResult {
  const [state, setState] = useState<DaemonHealthState>({ kind: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const refs = useHealthRefs();
  const { showToast } = useToasts();
  const fetchStatus = useStatusFetcher();
  const tick = useHealthTick(fetchStatus, setState, refs, showToast);
  useHealthPolling(tick, refs);
  const refresh = useHealthRefresh(tick, refs, setRefreshing);

  return { state, indicator: pickIndicator(state), refresh, refreshing };
}

function useHealthRefs(): HealthRefs {
  const consecutiveFailuresRef = useRef(0);
  const refreshLockRef = useRef(false);
  const lastStatusRef = useRef<AlayaStatus | null>(null);
  const isMountedRef = useRef(true);
  const cooldownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightTickRef = useRef<Promise<void> | null>(null);
  return useMemo(
    () => ({
      consecutiveFailuresRef,
      refreshLockRef,
      lastStatusRef,
      isMountedRef,
      cooldownTimerRef,
      inFlightTickRef
    }),
    []
  );
}

function useStatusFetcher() {
  return useCallback(async (signal?: AbortSignal): Promise<FetchOutcome> => {
    try {
      const envelope = await apiFetch<StatusEnvelope>("/status", { signal });
      const parsed = AlayaStatusSchema.safeParse(envelope.data);
      if (!parsed.success) {
        return { kind: "schema_error", raw: envelope.data };
      }
      return { kind: "ok", status: parsed.data };
    } catch (err) {
      if ((err as ApiError).status === 401) {
        throw err;
      }
      return {
        kind: "network_error",
        message: err instanceof Error ? err.message : "unknown error"
      };
    }
  }, []);
}

function useHealthTick(
  fetchStatus: (signal?: AbortSignal) => Promise<FetchOutcome>,
  setState: (state: DaemonHealthState) => void,
  refs: HealthRefs,
  showToast: ReturnType<typeof useToasts>["showToast"]
) {
  return useCallback(async () => {
    if (refs.inFlightTickRef.current !== null) {
      return await refs.inFlightTickRef.current;
    }
    const run = async (): Promise<void> => {
      try {
        const outcome = await fetchStatus();
        if (!refs.isMountedRef.current) return;
        applyHealthOutcome(outcome, setState, refs, showToast);
      } catch {
        // The global 401 handler owns session expiry; polling must still release
        // its lifecycle so a transient auth/network failure cannot wedge refresh.
      }
    };
    const promise = run().finally(() => {
      if (refs.inFlightTickRef.current === promise) {
        refs.inFlightTickRef.current = null;
      }
    });
    refs.inFlightTickRef.current = promise;
    await promise;
  }, [fetchStatus, refs, setState, showToast]);
}

function useHealthPolling(tick: () => Promise<void>, refs: HealthRefs) {
  useEffect(() => {
    refs.isMountedRef.current = true;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const loop = async () => {
      if (cancelled) return;
      await tick();
      if (cancelled) return;
      const delay = refs.consecutiveFailuresRef.current > 0 ? POLL_BACKOFF_MS : POLL_OK_MS;
      timer = setTimeout(loop, delay);
      timer.unref?.();
    };
    void loop();
    return () => {
      cancelled = true;
      refs.isMountedRef.current = false;
      if (timer) clearTimeout(timer);
      clearCooldownTimer(refs);
    };
  }, [tick, refs]);
}

function useHealthRefresh(
  tick: () => Promise<void>,
  refs: HealthRefs,
  setRefreshing: (refreshing: boolean) => void
) {
  return useCallback(async () => {
    if (refs.refreshLockRef.current) return;
    refs.refreshLockRef.current = true;
    setRefreshing(true);
    try {
      await tick();
    } finally {
      if (!refs.isMountedRef.current) {
        refs.refreshLockRef.current = false;
        return;
      }
    }
    refs.cooldownTimerRef.current = setTimeout(() => {
      refs.cooldownTimerRef.current = null;
      refs.refreshLockRef.current = false;
      if (refs.isMountedRef.current) setRefreshing(false);
    }, REFRESH_COOLDOWN_MS);
    refs.cooldownTimerRef.current.unref?.();
  }, [refs, setRefreshing, tick]);
}

function applyHealthOutcome(
  outcome: FetchOutcome,
  setState: (state: DaemonHealthState) => void,
  refs: HealthRefs,
  showToast: ReturnType<typeof useToasts>["showToast"]
) {
  if (outcome.kind === "ok") {
    refs.lastStatusRef.current = outcome.status;
    refs.consecutiveFailuresRef.current = 0;
    setState({ kind: "ok", status: outcome.status });
    return;
  }
  if (outcome.kind === "schema_error") {
    refs.consecutiveFailuresRef.current = 0;
    setState({ kind: "schema_error", raw: outcome.raw });
    return;
  }
  refs.consecutiveFailuresRef.current += 1;
  setState({
    kind: "degraded",
    message: outcome.message,
    lastStatus: refs.lastStatusRef.current
  });
  if (refs.consecutiveFailuresRef.current === 1) {
    showToast({ message: `Status fetch failed: ${outcome.message}`, type: "error" });
  }
}

function clearCooldownTimer(refs: HealthRefs) {
  if (refs.cooldownTimerRef.current) {
    clearTimeout(refs.cooldownTimerRef.current);
    refs.cooldownTimerRef.current = null;
  }
}

function pickIndicator(state: DaemonHealthState): DaemonHealthIndicator {
  if (state.kind === "degraded") {
    return { label: "WARMING", colorClass: "text-state-warm" };
  }
  if (state.kind === "ok" && state.status.daemon.ready) {
    return { label: "OPERATIONAL", colorClass: "text-morandi-green" };
  }
  if (state.kind === "ok") {
    return { label: "OFFLINE", colorClass: "text-morandi-pink" };
  }
  return { label: "OFFLINE", colorClass: "text-morandi-pink" };
}
