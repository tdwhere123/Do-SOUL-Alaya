import { useCallback, useEffect, useRef, useState } from "react";
import { AlayaStatusSchema, type AlayaStatus } from "@do-soul/alaya-protocol";
import { apiFetch, type ApiError } from "../api";
import { useToasts } from "../components/Toast";

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

const POLL_OK_MS = 5_000;
const POLL_BACKOFF_MS = 30_000;
const REFRESH_COOLDOWN_MS = 1_000;

export function useDaemonHealth(): UseDaemonHealthResult {
  const [state, setState] = useState<DaemonHealthState>({ kind: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const consecutiveFailuresRef = useRef(0);
  const refreshLockRef = useRef(false);
  const lastStatusRef = useRef<AlayaStatus | null>(null);
  const isMountedRef = useRef(true);
  const cooldownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { showToast } = useToasts();

  const fetchStatus = useCallback(async (): Promise<FetchOutcome> => {
    try {
      const envelope = await apiFetch<StatusEnvelope>("/status");
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

  const tick = useCallback(async () => {
    const outcome = await fetchStatus();
    if (!isMountedRef.current) return;
    if (outcome.kind === "ok") {
      lastStatusRef.current = outcome.status;
      setState({ kind: "ok", status: outcome.status });
      consecutiveFailuresRef.current = 0;
    } else if (outcome.kind === "schema_error") {
      setState({ kind: "schema_error", raw: outcome.raw });
      consecutiveFailuresRef.current = 0;
    } else {
      consecutiveFailuresRef.current += 1;
      setState({
        kind: "degraded",
        message: outcome.message,
        lastStatus: lastStatusRef.current
      });
      if (consecutiveFailuresRef.current === 1) {
        showToast({
          message: `Status fetch failed: ${outcome.message}`,
          type: "error"
        });
      }
    }
  }, [fetchStatus, showToast]);

  useEffect(() => {
    isMountedRef.current = true;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const loop = async () => {
      if (cancelled) return;
      await tick();
      if (cancelled) return;
      const delay =
        consecutiveFailuresRef.current > 0 ? POLL_BACKOFF_MS : POLL_OK_MS;
      timer = setTimeout(loop, delay);
    };

    void loop();
    return () => {
      cancelled = true;
      isMountedRef.current = false;
      if (timer) clearTimeout(timer);
      if (cooldownTimerRef.current) {
        clearTimeout(cooldownTimerRef.current);
        cooldownTimerRef.current = null;
      }
    };
  }, [tick]);

  const refresh = useCallback(async () => {
    if (refreshLockRef.current) return;
    refreshLockRef.current = true;
    setRefreshing(true);
    await tick();
    if (!isMountedRef.current) {
      refreshLockRef.current = false;
      return;
    }
    cooldownTimerRef.current = setTimeout(() => {
      cooldownTimerRef.current = null;
      refreshLockRef.current = false;
      if (isMountedRef.current) setRefreshing(false);
    }, REFRESH_COOLDOWN_MS);
  }, [tick]);

  const indicator = pickIndicator(state);

  return { state, indicator, refresh, refreshing };
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
