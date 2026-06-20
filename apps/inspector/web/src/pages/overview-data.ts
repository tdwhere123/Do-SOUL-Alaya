import { useCallback } from "react";
import { apiFetch } from "../api";
import { useApiQuery } from "../hooks/useApiQuery";

export interface BenchSummaryShape {
  readonly latest_slug: string;
  readonly history_count: number;
  readonly payload: {
    readonly bench_name: "self" | "public" | "public-multiturn" | "live";
    readonly split: string;
    readonly run_at: string;
    readonly kpi: { readonly r_at_5: number };
  };
  readonly diff: {
    readonly previous_slug: string | null;
    readonly worst_verdict: "ok" | "warn" | "fail";
    readonly r_at_5_delta_pp: number | null;
  };
}

export interface BenchSummaryData {
  readonly self: BenchSummaryShape | null;
  readonly public: BenchSummaryShape | null;
  readonly publicMultiturn: BenchSummaryShape | null;
  readonly live: BenchSummaryShape | null;
}

interface PendingCountEnvelope {
  readonly success: boolean;
  readonly data: { readonly total_count: number };
}

interface BenchSummaryEnvelope {
  readonly success: boolean;
  readonly data: {
    readonly self: BenchSummaryShape | null;
    readonly public: BenchSummaryShape | null;
    readonly public_multiturn: BenchSummaryShape | null;
    readonly live: BenchSummaryShape | null;
  };
}

interface RecallStatsEnvelope {
  readonly success: boolean;
  readonly data: {
    readonly recall: { readonly total: number };
    readonly usage: { readonly used_ratio: number };
  };
}

interface OverviewQueryData {
  readonly pendingCount: number | null;
  readonly recallStats: { readonly total: number; readonly usedRatio: number } | null;
  readonly benchData: BenchSummaryData;
  readonly benchLoaded: boolean;
}

export const EMPTY_BENCH_DATA: BenchSummaryData = {
  self: null,
  public: null,
  publicMultiturn: null,
  live: null
};

const OVERVIEW_RECALL_WINDOW_HOURS = 24 * 7;

export function useOverviewData(workspaceId: string | null): OverviewQueryData {
  const fetchOverviewData = useCallback(
    (signal: AbortSignal) => loadOverviewData(workspaceId, signal),
    [workspaceId]
  );
  const { data } = useApiQuery(fetchOverviewData, [workspaceId]);
  return {
    pendingCount: data?.pendingCount ?? null,
    recallStats: data?.recallStats ?? null,
    benchData: data?.benchData ?? EMPTY_BENCH_DATA,
    benchLoaded: data?.benchLoaded ?? false
  };
}

async function loadOverviewData(
  workspaceId: string | null,
  signal: AbortSignal
): Promise<OverviewQueryData> {
  const [pendingResult, recallResult, benchResult] = await Promise.allSettled([
    fetchPendingCount(workspaceId, signal),
    fetchRecallStats(workspaceId, signal),
    fetchBenchData(signal)
  ]);
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  return {
    pendingCount: settledValue(pendingResult),
    recallStats: settledValue(recallResult),
    benchData: settledValue(benchResult) ?? EMPTY_BENCH_DATA,
    benchLoaded: true
  };
}

async function fetchPendingCount(
  workspaceId: string | null,
  signal: AbortSignal
): Promise<number | null> {
  if (workspaceId === null) return null;
  const envelope = await apiFetch<PendingCountEnvelope>(`/proposals/${workspaceId}/pending`, {
    signal
  });
  return envelope.data.total_count;
}

async function fetchRecallStats(
  workspaceId: string | null,
  signal: AbortSignal
): Promise<OverviewQueryData["recallStats"]> {
  if (workspaceId === null) return null;
  const since = new Date(
    Date.now() - OVERVIEW_RECALL_WINDOW_HOURS * 60 * 60 * 1000
  ).toISOString();
  const envelope = await apiFetch<RecallStatsEnvelope>(
    `/recall-stats/${workspaceId}?since=${encodeURIComponent(since)}`,
    { signal }
  );
  return {
    total: envelope.data.recall.total,
    usedRatio: envelope.data.usage.used_ratio
  };
}

async function fetchBenchData(signal: AbortSignal): Promise<BenchSummaryData> {
  const envelope = await apiFetch<BenchSummaryEnvelope>("/bench-summary", { signal });
  return {
    self: envelope.data.self,
    public: envelope.data.public,
    publicMultiturn: envelope.data.public_multiturn,
    live: envelope.data.live
  };
}

function settledValue<T>(result: PromiseSettledResult<T>): T | null {
  return result.status === "fulfilled" ? result.value : null;
}
