import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch } from "../api";
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
  const [data, setData] = useState<BenchTrendData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useBenchTrendLoader(setData, setError, setLoading);
  useEffect(() => {
    void load();
  }, [load]);
  return {
    benches: useVisibleBenches(data),
    error,
    loading,
    load
  };
}

function useBenchTrendLoader(
  setData: (data: BenchTrendData) => void,
  setError: (error: string | null) => void,
  setLoading: (loading: boolean) => void
) {
  return useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await apiFetch<BenchTrendResponse>("/bench-trend", {
        params: { limit: "30" }
      });
      setData(response.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [setData, setError, setLoading]);
}

function useVisibleBenches(data: BenchTrendData | null): readonly VisibleBenchTrend[] {
  return useMemo(() => BENCH_ORDER.flatMap((key) => visibleBench(data, key)), [data]);
}

function visibleBench(data: BenchTrendData | null, key: BenchKey): readonly VisibleBenchTrend[] {
  const trend = data?.[key] ?? null;
  if (trend === null || trend.points.length === 0) return [];
  return [{ key, trend }];
}
