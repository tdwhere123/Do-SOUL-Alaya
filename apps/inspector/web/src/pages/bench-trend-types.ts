export interface BenchTrendPoint {
  readonly slug: string;
  readonly bench_name: string;
  readonly split: string;
  readonly run_at: string;
  readonly embedding_provider: string;
  readonly policy_shape: string;
  readonly simulate_report: string;
  readonly evaluated_count: number;
  readonly sample_size: number;
  readonly r_at_1: number;
  readonly r_at_5: number;
  readonly r_at_10: number;
  readonly latency_ms_p95: number;
  readonly token_saved_ratio_vs_full_prompt: number;
  readonly raw_history_tokens: number | null;
  readonly stored_memory_tokens: number | null;
  readonly recalled_context_tokens_mean: number | null;
  readonly path_expansion_share: number | null;
  readonly graph_expansion_share: number | null;
}

export interface BenchTrend {
  readonly bench_name: string;
  readonly history_count: number;
  readonly points: readonly BenchTrendPoint[];
}

export interface BenchTrendResponse {
  readonly success: boolean;
  readonly data: BenchTrendData;
}

export interface BenchTrendData {
  readonly self: BenchTrend | null;
  readonly public: BenchTrend | null;
  readonly public_multiturn: BenchTrend | null;
  readonly public_crossquestion: BenchTrend | null;
  readonly public_locomo: BenchTrend | null;
  readonly live: BenchTrend | null;
  readonly errors: Readonly<Record<string, string | null>>;
}

export const BENCH_ORDER = [
  "public",
  "public_locomo",
  "public_multiturn",
  "public_crossquestion",
  "self",
  "live"
] as const;

export type BenchKey = (typeof BENCH_ORDER)[number];

export interface VisibleBenchTrend {
  readonly key: BenchKey;
  readonly trend: BenchTrend;
}
