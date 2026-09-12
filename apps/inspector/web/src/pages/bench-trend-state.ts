import { useCallback, useMemo } from "react";
import { apiFetch } from "../api";
import { useApiQuery } from "../hooks/useApiQuery";
import {
  BENCH_ORDER,
  type BenchKey,
  type BenchTrendData,
  type BenchTrendResponse,
  type VisibleBenchTrend
} from "./bench-trend-types";

export interface BenchTrendState {
  readonly benches: readonly VisibleBenchTrend[];
  readonly error: string | null;
  readonly loading: boolean;
  readonly load: () => Promise<void>;
}

export function useBenchTrendState(): BenchTrendState {
  const fetchTrend = useCallback(async (signal: AbortSignal) => {
    const response = await apiFetch<BenchTrendResponse>("/bench-trend", {
      params: { limit: "30" },
      signal
    });
    return response.data;
  }, []);
  const { data, error, loading, refetch } = useApiQuery(fetchTrend, []);
  const load = useCallback(async () => {
    await refetch();
  }, [refetch]);
  return {
    benches: useVisibleBenches(data),
    error,
    loading,
    load
  };
}

function useVisibleBenches(data: BenchTrendData | null): readonly VisibleBenchTrend[] {
  return useMemo(() => BENCH_ORDER.flatMap((key) => visibleBench(data, key)), [data]);
}

function visibleBench(data: BenchTrendData | null, key: BenchKey): readonly VisibleBenchTrend[] {
  const trend = data?.[key] ?? null;
  if (trend === null || trend.points.length === 0) return [];
  return [{ key, trend }];
}
