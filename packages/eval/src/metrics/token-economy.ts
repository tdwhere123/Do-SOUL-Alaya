import type { TokenEconomy } from "../schema/kpi-schema.js";

/**
 * Raw event-sourced token counts a bench run derives from its EventLog.
 * Shaped to be filled straight from the bench harness reader
 * (apps/bench-runner/src/harness/daemon.ts queryTokenMetrics) without the
 * eval package importing the bench-runner.
 */
export interface TokenEconomyInput {
  readonly raw_history_tokens: number;
  readonly stored_memory_tokens: number;
  readonly recalled_context_tokens_total: number;
  readonly recall_event_count: number;
  readonly recalled_context_tokens_mean: number;
  readonly seed_event_count: number;
}

const TOKEN_ECONOMY_SCHEMA_VERSION = "bench-token-economy.v1" as const;

/**
 * Build the persisted token_economy KPI block from raw event-sourced
 * counts. Pure projection: it only stamps the schema version and copies
 * the figures the harness already derived from the EventLog.
 */
export function buildTokenEconomy(input: TokenEconomyInput): TokenEconomy {
  return {
    schema_version: TOKEN_ECONOMY_SCHEMA_VERSION,
    raw_history_tokens: input.raw_history_tokens,
    stored_memory_tokens: input.stored_memory_tokens,
    recalled_context_tokens_total: input.recalled_context_tokens_total,
    recall_event_count: input.recall_event_count,
    recalled_context_tokens_mean: input.recalled_context_tokens_mean,
    seed_event_count: input.seed_event_count
  };
}

/**
 * token_saved_ratio_vs_full_prompt — the share of context tokens a recall
 * SAVES versus carrying the whole ingested history.
 *
 * Formula (plain terms): an agent answering WITHOUT a memory plane would
 * re-supply the entire conversation history (raw_history_tokens) on every
 * turn. With Alaya it instead receives only the recalled facts for that
 * turn (recalled_context_tokens_mean). The saved fraction is
 *
 *     1 - recalled_context_tokens_mean / raw_history_tokens
 *
 * clamped to [0, 1]. 0 when there is no history to compare against (a
 * recall cannot "save" against an empty haystack) or when the recalled
 * context somehow exceeds the full history. The mean per-recall figure is
 * used (not the summed total) because each recall answers one question;
 * the agent never receives the union of every recall at once.
 */
export function computeTokenSavedRatio(input: TokenEconomyInput): number {
  if (input.raw_history_tokens <= 0) {
    return 0;
  }
  const ratio =
    1 - input.recalled_context_tokens_mean / input.raw_history_tokens;
  if (!Number.isFinite(ratio)) {
    return 0;
  }
  return Math.min(Math.max(ratio, 0), 1);
}
