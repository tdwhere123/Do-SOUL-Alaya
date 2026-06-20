export interface BenchTokenMetrics {
  readonly raw_history_tokens: number;
  readonly stored_memory_tokens: number;
  readonly recalled_context_tokens_total: number;
  readonly recall_event_count: number;
  readonly recalled_context_tokens_mean: number;
  readonly seed_event_count: number;
}
