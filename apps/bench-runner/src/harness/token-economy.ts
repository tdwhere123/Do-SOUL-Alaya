import {
  RecallContextEventType,
  SignalEventType,
  SoulContextLensAssembledPayloadSchema,
  SoulSignalEmittedPayloadSchema
} from "@do-soul/alaya-protocol";
import { computeTokenSavedRatio, type TokenEconomyInput } from "@do-soul/alaya-eval";
import type { BenchTokenMetrics } from "./daemon.js";

// @anchor bench-token-chars-per-token: the bench token-economy KPI is a
// coarse heuristic, not a native tokenizer. 4 chars/token mirrors the
// default branch of @do-soul/alaya-core makeTokenEstimator (the estimator
// the production ContextLensAssembler uses to populate
// total_token_estimate), so raw_history / stored_memory / recalled_context
// are all measured on one consistent scale.
const BENCH_CHARS_PER_TOKEN = 4;

/**
 * @anchor bench-token-economy-payload-keys — the seed raw_payload keys and
 * their EventLog-summary counterparts used by the bench token-economy flow.
 *
 * The production raw_payload only carries `turn_content_excerpt`, a narrow
 * matched-text window — never the full turn — so the fold cannot derive
 * raw_history_tokens from production fields. The full-turn / stored content
 * keys carry the harness's own ground truth, but are stamped ONLY when they
 * would not byte-duplicate a sibling field (`excerpt` / `distilled_fact`):
 * on the no-credentials path `excerpt` IS the full turn and `distilled_fact`
 * IS the durable fact, so a second copy would near-double raw_payload and
 * risk an over-cap drop. SignalService then converts that raw shape into a
 * redacted EventLog summary that preserves only bench_summary_* markers plus
 * numeric token counts, and deriveBenchTokenMetrics reads that summary shape.
 */
export const BENCH_FULL_TURN_CONTENT_KEY = "bench_full_turn_content";
export const BENCH_STORED_CONTENT_KEY = "bench_stored_content";
export const BENCH_TURN_SEED_INDEX_KEY = "bench_turn_seed_index";
export const BENCH_SEED_MARKER_KEY = "bench_seed";
export const BENCH_SUMMARY_SEED_MARKER_KEY = "bench_summary_seeded";
export const BENCH_SUMMARY_TURN_SEED_INDEX_KEY = "bench_summary_turn_seed_index";
export const BENCH_FULL_TURN_TOKENS_KEY = "bench_full_turn_tokens";
export const BENCH_STORED_CONTENT_TOKENS_KEY = "bench_stored_content_tokens";

/**
 * The minimal shape of an EventLog row the token-economy derivation reads.
 * Kept structural (not the full protocol EventLogEntry) so a unit test can
 * stub the EventLog with plain objects.
 */
export interface TokenEconomyEventRow {
  readonly event_type: string;
  readonly payload_json: unknown;
}

function readRawNumber(
  rawPayload: Record<string, unknown>,
  key: string
): number | null {
  const value = rawPayload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * @anchor deriveBenchTokenMetrics — the pure event -> token-economy fold.
 *
 * Every figure is derived FROM EVENTS, never recomputed from in-memory
 * bench state:
 *
 * - SOUL_SIGNAL_EMITTED — each seed signal carries the bench KPI block, and
 *   SignalService persists the redacted EventLog summary:
 *   BENCH_SUMMARY_SEED_MARKER_KEY identifies a bench row,
 *   BENCH_SUMMARY_TURN_SEED_INDEX_KEY carries the turn fan-out identity,
 *   and BENCH_FULL_TURN_TOKENS_KEY / BENCH_STORED_CONTENT_TOKENS_KEY carry
 *   numeric token counts without storing the source text. raw_history_tokens
 *   counts one source turn ONCE per distinct turn-seed index — a source turn
 *   that fans out into N fact signals contributes its full-turn token count
 *   exactly once, not N times. A row without a turn-seed index (the generic
 *   proposeMemory seed, where each call is its own self-contained turn) is
 *   counted on its own.
 *   stored_memory_tokens sums the durable-fact token count over EVERY fact
 *   signal, since each fact materializes a distinct memory_entry.
 * - SOUL_CONTEXT_LENS_ASSEMBLED — total_token_estimate is the tokens
 *   delivered for one recall.
 *
 * Rows whose event_type does not match, or whose payload fails the
 * protocol schema, are skipped. A SOUL_SIGNAL_EMITTED row carrying no bench
 * seed marker is skipped rather than charged 0, so it does not dilute the
 * economy figures.
 */
export function deriveBenchTokenMetrics(
  signalEmittedRows: readonly TokenEconomyEventRow[],
  contextLensRows: readonly TokenEconomyEventRow[]
): BenchTokenMetrics {
  let storedMemoryTokens = 0;
  let seedEventCount = 0;
  // raw_history is counted once per source turn. Rows that share a
  // bench_turn_seed_index are the same turn's fact fan-out; rows without an
  // index are each their own turn and get a unique synthetic key.
  const fullTurnByKey = new Map<string, number>();
  let anonymousTurnSeq = 0;
  for (const row of signalEmittedRows) {
    if (row.event_type !== SignalEventType.SOUL_SIGNAL_EMITTED) {
      continue;
    }
    const parsed = SoulSignalEmittedPayloadSchema.safeParse(row.payload_json);
    if (!parsed.success) {
      continue;
    }
    const rawPayload = parsed.data.raw_payload;
    if (rawPayload[BENCH_SUMMARY_SEED_MARKER_KEY] !== true) {
      continue;
    }
    seedEventCount += 1;
    const fullTurnTokens = readRawNumber(rawPayload, BENCH_FULL_TURN_TOKENS_KEY);
    const storedContentTokens = readRawNumber(rawPayload, BENCH_STORED_CONTENT_TOKENS_KEY);
    if (storedContentTokens !== null) {
      storedMemoryTokens += storedContentTokens;
    }
    const indexValue = rawPayload[BENCH_SUMMARY_TURN_SEED_INDEX_KEY];
    if (fullTurnTokens !== null) {
      const turnKey =
        typeof indexValue === "number"
          ? `turn:${indexValue}`
          : `anon:${anonymousTurnSeq++}`;
      // First signal of a turn wins; later facts of the same turn carry the
      // identical token count, so the turn is counted once.
      if (!fullTurnByKey.has(turnKey)) {
        fullTurnByKey.set(turnKey, fullTurnTokens);
      }
    }
  }
  let rawHistoryTokens = 0;
  for (const fullTurn of fullTurnByKey.values()) {
    rawHistoryTokens += fullTurn;
  }

  let recalledContextTokensTotal = 0;
  let recallEventCount = 0;
  for (const row of contextLensRows) {
    if (row.event_type !== RecallContextEventType.SOUL_CONTEXT_LENS_ASSEMBLED) {
      continue;
    }
    const parsed = SoulContextLensAssembledPayloadSchema.safeParse(
      row.payload_json
    );
    if (!parsed.success) {
      continue;
    }
    recalledContextTokensTotal += parsed.data.total_token_estimate;
    recallEventCount += 1;
  }

  return Object.freeze({
    raw_history_tokens: rawHistoryTokens,
    stored_memory_tokens: storedMemoryTokens,
    recalled_context_tokens_total: recalledContextTokensTotal,
    recall_event_count: recallEventCount,
    recalled_context_tokens_mean:
      recallEventCount === 0
        ? 0
        : recalledContextTokensTotal / recallEventCount,
    seed_event_count: seedEventCount
  });
}

/**
 * Aggregate per-question event-sourced token metrics into one run-level
 * TokenEconomyInput.
 *
 * Each LongMemEval question runs in its own bench daemon / DB / EventLog,
 * so its BenchTokenMetrics already covers exactly that question's seed
 * loop and recalls. Summing the raw counts across questions yields the
 * run totals. recalled_context_tokens_mean is recomputed from the SUMMED
 * total and SUMMED event count — a question-weighted mean — rather than
 * averaging the per-question means, so a question with more recalls is
 * not under-counted.
 */
export function aggregateBenchTokenMetrics(
  perQuestion: readonly BenchTokenMetrics[]
): TokenEconomyInput {
  let rawHistoryTokens = 0;
  let storedMemoryTokens = 0;
  let recalledContextTokensTotal = 0;
  let recallEventCount = 0;
  let seedEventCount = 0;
  for (const metrics of perQuestion) {
    rawHistoryTokens += metrics.raw_history_tokens;
    storedMemoryTokens += metrics.stored_memory_tokens;
    recalledContextTokensTotal += metrics.recalled_context_tokens_total;
    recallEventCount += metrics.recall_event_count;
    seedEventCount += metrics.seed_event_count;
  }
  return {
    raw_history_tokens: rawHistoryTokens,
    stored_memory_tokens: storedMemoryTokens,
    recalled_context_tokens_total: recalledContextTokensTotal,
    recall_event_count: recallEventCount,
    recalled_context_tokens_mean:
      recallEventCount === 0
        ? 0
        : recalledContextTokensTotal / recallEventCount,
    seed_event_count: seedEventCount
  };
}

/**
 * @anchor assertBenchTokenEconomyContract — harness-level contract gate.
 *
 * token_saved_ratio_vs_full_prompt is a required output for EVERY integrated
 * benchmark: a benchmark that seeded turns but emitted no full-turn marker
 * folds to raw_history_tokens === 0, so no savings ratio can be derived and
 * its kpi would silently carry a 0 baseline. We fail closed here rather than
 * publish a meaningless 0 — any new benchmark must wire the seed-side marker
 * (benchTokenEconomyPayload) or this throws. A benchmark that truly seeds
 * nothing (seed_event_count === 0) is exempt: no history to save against, so
 * a 0 ratio is honest, not a missing marker.
 * see also: apps/bench-runner/src/harness/daemon.ts benchTokenEconomyPayload
 */
export function assertBenchTokenEconomyContract(
  benchName: string,
  input: TokenEconomyInput
): void {
  if (input.seed_event_count > 0 && input.raw_history_tokens === 0) {
    throw new Error(
      `[token-economy contract] ${benchName}: seeded ${input.seed_event_count} ` +
        `turn(s) but raw_history_tokens===0 — the seed path emitted no ` +
        `full-turn marker, so token_saved_ratio_vs_full_prompt cannot be ` +
        `derived. Wire benchTokenEconomyPayload on the seed signal.`
    );
  }
}
