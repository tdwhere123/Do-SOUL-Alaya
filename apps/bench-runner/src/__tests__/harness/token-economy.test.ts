import { describe, expect, it } from "vitest";
import {
  buildTokenEconomy,
  computeTokenSavedRatio
} from "@do-soul/alaya-eval";
import {
  RecallContextEventType,
  SignalEventType
} from "@do-soul/alaya-protocol";
import {
  aggregateBenchTokenMetrics,
  assertBenchTokenEconomyContract,
  deriveBenchTokenMetrics,
  BENCH_FULL_TURN_TOKENS_KEY,
  BENCH_SUMMARY_SEED_MARKER_KEY,
  BENCH_SUMMARY_TURN_SEED_INDEX_KEY,
  BENCH_STORED_CONTENT_TOKENS_KEY,
  type TokenEconomyEventRow
} from "../../harness/token-economy.js";

function emittedRow(rawPayload: Record<string, unknown>): TokenEconomyEventRow {
  return {
    event_type: SignalEventType.SOUL_SIGNAL_EMITTED,
    payload_json: {
      signal_id: "sig-1",
      workspace_id: "ws-1",
      run_id: "run-1",
      source: "garden_compile",
      signal_kind: "potential_preference",
      source_observation: null,
      source_memory_refs: [],
      supersedes_refs: [],
      exception_to_refs: [],
      contradicts_refs: [],
      incompatible_with_refs: [],
      raw_payload: rawPayload
    }
  };
}

function benchTokens(charCount: number): number {
  return Math.ceil(charCount / 4);
}

/**
 * Build the redacted EventLog-summary raw_payload shape that SignalService
 * persists for bench seed events.
 */
function summarySeedPayload(input: {
  readonly fullTurnTokens: number;
  readonly storedTokens: number;
  readonly turnSeedIndex?: number;
}): Record<string, unknown> {
  return {
    [BENCH_SUMMARY_SEED_MARKER_KEY]: true,
    [BENCH_FULL_TURN_TOKENS_KEY]: input.fullTurnTokens,
    [BENCH_STORED_CONTENT_TOKENS_KEY]: input.storedTokens,
    ...(input.turnSeedIndex === undefined
      ? {}
      : { [BENCH_SUMMARY_TURN_SEED_INDEX_KEY]: input.turnSeedIndex })
  };
}

/**
 * Build a summarized no-credentials seed. The source raw payload may have
 * only excerpt / distilled_fact, but deriveBenchTokenMetrics now consumes the
 * EventLog summary after SignalService redaction.
 */
function summarizedNoCredsSeedPayload(input: {
  readonly excerptChars: number;
  readonly distilledFactChars?: number;
  readonly turnSeedIndex?: number;
}): Record<string, unknown> {
  return summarySeedPayload({
    fullTurnTokens: benchTokens(input.excerptChars),
    storedTokens: benchTokens(input.distilledFactChars ?? input.excerptChars),
    turnSeedIndex: input.turnSeedIndex
  });
}

function lensRow(totalTokenEstimate: number): TokenEconomyEventRow {
  return {
    event_type: RecallContextEventType.SOUL_CONTEXT_LENS_ASSEMBLED,
    payload_json: {
      runtime_id: "lens-1",
      task_surface_ref: "surface-1",
      lens_entry_count: 3,
      total_token_estimate: totalTokenEstimate,
      run_id: "run-1",
      workspace_id: "ws-1",
      occurred_at: "2026-05-21T00:00:00.000Z"
    }
  };
}

describe("deriveBenchTokenMetrics", () => {
  it("prefers redacted numeric token summaries over full text when present", () => {
    const metrics = deriveBenchTokenMetrics(
      [
        emittedRow(summarySeedPayload({ fullTurnTokens: 20, storedTokens: 7, turnSeedIndex: 0 }))
      ],
      []
    );
    expect(metrics.raw_history_tokens).toBe(20);
    expect(metrics.stored_memory_tokens).toBe(7);
    expect(metrics.seed_event_count).toBe(1);
  });

  it("derives raw_history from summarized full-turn tokens and stored_memory from summarized fact tokens", () => {
    const metrics = deriveBenchTokenMetrics(
      [
        emittedRow(summarySeedPayload({ fullTurnTokens: 20, storedTokens: 2, turnSeedIndex: 0 }))
      ],
      []
    );
    expect(metrics.raw_history_tokens).toBe(20);
    expect(metrics.stored_memory_tokens).toBe(2);
    expect(metrics.seed_event_count).toBe(1);
  });

  it("counts the full turn ONCE when one turn fans out into N fact signals", () => {
    // A credentialled compile turn emits N atomic-fact signals, all sharing
    // the same turn_seed_index and the same full turn. raw_history must be
    // the full turn counted once, not N times; stored_memory sums every
    // distinct fact.
    const metrics = deriveBenchTokenMetrics(
      [
        emittedRow(summarySeedPayload({ fullTurnTokens: 100, storedTokens: 10, turnSeedIndex: 7 })),
        emittedRow(summarySeedPayload({ fullTurnTokens: 100, storedTokens: 5, turnSeedIndex: 7 })),
        emittedRow(summarySeedPayload({ fullTurnTokens: 100, storedTokens: 4, turnSeedIndex: 7 }))
      ],
      []
    );
    expect(metrics.raw_history_tokens).toBe(100); // counted once, NOT 300
    expect(metrics.stored_memory_tokens).toBe(10 + 5 + 4);
    expect(metrics.seed_event_count).toBe(3);
  });

  it("ignores unrelated raw_payload fields and trusts the summarized token counts", () => {
    const metrics = deriveBenchTokenMetrics(
      [
        emittedRow(
          {
            ...summarySeedPayload({ fullTurnTokens: 200, storedTokens: 10, turnSeedIndex: 1 }),
            turn_content_excerpt: "w".repeat(80),
            matched_text: "m".repeat(12)
          }
        )
      ],
      []
    );
    expect(metrics.raw_history_tokens).toBe(200);
    expect(metrics.stored_memory_tokens).toBe(10);
  });

  it("counts no-credentials summaries that preserved only numeric token totals", () => {
    const row = summarizedNoCredsSeedPayload({
      excerptChars: 160,
      distilledFactChars: 20,
      turnSeedIndex: 0
    });
    const metrics = deriveBenchTokenMetrics([emittedRow(row)], []);
    expect(metrics.raw_history_tokens).toBe(40);
    expect(metrics.stored_memory_tokens).toBe(5);
    expect(metrics.seed_event_count).toBe(1);
  });

  it("treats excerpt-backed no-credentials summaries as durable-fact tokens when no distilled fact exists", () => {
    const row = summarizedNoCredsSeedPayload({ excerptChars: 80 });
    const metrics = deriveBenchTokenMetrics([emittedRow(row)], []);
    expect(metrics.raw_history_tokens).toBe(20);
    expect(metrics.stored_memory_tokens).toBe(20);
    expect(metrics.seed_event_count).toBe(1);
  });

  it("counts a no-creds turn's raw_history exactly once (one signal per turn)", () => {
    // The no-creds path emits one signal per turn, each with its own
    // turn-seed index. Two distinct turns must each be counted once.
    const metrics = deriveBenchTokenMetrics(
      [
        emittedRow(summarizedNoCredsSeedPayload({ excerptChars: 40, turnSeedIndex: 0 })),
        emittedRow(summarizedNoCredsSeedPayload({ excerptChars: 120, turnSeedIndex: 1 }))
      ],
      []
    );
    expect(metrics.raw_history_tokens).toBe(40);
    expect(metrics.seed_event_count).toBe(2);
  });

  it("counts summarized credentialled events without consulting excerpt windows", () => {
    const metrics = deriveBenchTokenMetrics(
      [
        emittedRow(summarySeedPayload({ fullTurnTokens: 200, storedTokens: 10, turnSeedIndex: 2 }))
      ],
      []
    );
    expect(metrics.raw_history_tokens).toBe(200);
    expect(metrics.stored_memory_tokens).toBe(10);
  });

  it("counts distinct turns separately and de-duplicates within a turn", () => {
    const metrics = deriveBenchTokenMetrics(
      [
        emittedRow(summarySeedPayload({ fullTurnTokens: 100, storedTokens: 2, turnSeedIndex: 0 })),
        emittedRow(summarySeedPayload({ fullTurnTokens: 100, storedTokens: 1, turnSeedIndex: 0 })),
        emittedRow(summarySeedPayload({ fullTurnTokens: 200, storedTokens: 2, turnSeedIndex: 1 }))
      ],
      []
    );
    expect(metrics.raw_history_tokens).toBe(300);
    expect(metrics.stored_memory_tokens).toBe(2 + 1 + 2);
    expect(metrics.seed_event_count).toBe(3);
  });

  it("treats a seed row without a turn-seed index as its own turn", () => {
    // The generic proposeMemory seed omits the turn-seed index; each call is
    // a self-contained turn and is counted on its own.
    const metrics = deriveBenchTokenMetrics(
      [
        emittedRow(summarySeedPayload({ fullTurnTokens: 10, storedTokens: 2 })),
        emittedRow(summarySeedPayload({ fullTurnTokens: 20, storedTokens: 1 }))
      ],
      []
    );
    expect(metrics.raw_history_tokens).toBe(10 + 20);
    expect(metrics.stored_memory_tokens).toBe(2 + 1);
    expect(metrics.seed_event_count).toBe(2);
  });

  it("derives recalled_context totals and mean from context-lens events", () => {
    const metrics = deriveBenchTokenMetrics(
      [],
      [lensRow(150), lensRow(250)]
    );
    expect(metrics.recalled_context_tokens_total).toBe(400);
    expect(metrics.recall_event_count).toBe(2);
    expect(metrics.recalled_context_tokens_mean).toBe(200);
  });

  it("returns 0 mean when there are no recall events", () => {
    const metrics = deriveBenchTokenMetrics([], []);
    expect(metrics.recalled_context_tokens_mean).toBe(0);
    expect(metrics.recall_event_count).toBe(0);
  });

  it("skips a seed event carrying no bench KPI block", () => {
    const metrics = deriveBenchTokenMetrics(
      [emittedRow({ excerpt: "noise", turn_content_excerpt: "noise" })],
      []
    );
    expect(metrics.seed_event_count).toBe(0);
    expect(metrics.raw_history_tokens).toBe(0);
    expect(metrics.stored_memory_tokens).toBe(0);
  });

  it("skips rows whose event_type does not match the expected types", () => {
    const wrongType: TokenEconomyEventRow = {
      event_type: "soul.signal.materialized",
      payload_json: { anything: true }
    };
    const metrics = deriveBenchTokenMetrics([wrongType], [wrongType]);
    expect(metrics.seed_event_count).toBe(0);
    expect(metrics.recall_event_count).toBe(0);
  });

  it("skips rows whose payload fails the protocol schema", () => {
    const malformed: TokenEconomyEventRow = {
      event_type: SignalEventType.SOUL_SIGNAL_EMITTED,
      payload_json: { signal_id: "sig-1" }
    };
    const metrics = deriveBenchTokenMetrics([malformed], []);
    expect(metrics.seed_event_count).toBe(0);
  });
});

describe("aggregateBenchTokenMetrics", () => {
  it("returns a zeroed baseline for an empty input", () => {
    const aggregate = aggregateBenchTokenMetrics([]);
    expect(aggregate.raw_history_tokens).toBe(0);
    expect(aggregate.stored_memory_tokens).toBe(0);
    expect(aggregate.recalled_context_tokens_total).toBe(0);
    expect(aggregate.recall_event_count).toBe(0);
    expect(aggregate.recalled_context_tokens_mean).toBe(0);
    expect(aggregate.seed_event_count).toBe(0);
  });

  it("sums per-question metrics and recomputes a question-weighted mean", () => {
    const aggregate = aggregateBenchTokenMetrics([
      {
        raw_history_tokens: 1_000,
        stored_memory_tokens: 100,
        recalled_context_tokens_total: 300,
        recall_event_count: 3,
        recalled_context_tokens_mean: 100,
        seed_event_count: 10
      },
      {
        raw_history_tokens: 2_000,
        stored_memory_tokens: 200,
        recalled_context_tokens_total: 700,
        recall_event_count: 1,
        recalled_context_tokens_mean: 700,
        seed_event_count: 20
      }
    ]);
    expect(aggregate.raw_history_tokens).toBe(3_000);
    expect(aggregate.stored_memory_tokens).toBe(300);
    expect(aggregate.recalled_context_tokens_total).toBe(1_000);
    expect(aggregate.recall_event_count).toBe(4);
    // weighted mean: 1000 total / 4 events = 250, NOT (100+700)/2 = 400.
    expect(aggregate.recalled_context_tokens_mean).toBe(250);
    expect(aggregate.seed_event_count).toBe(30);
  });
});

describe("assertBenchTokenEconomyContract", () => {
  it("throws when a seeded run emitted no full-turn marker", () => {
    // raw_history_tokens===0 with seeds present = the seed path forgot the
    // marker, so token_saved_ratio cannot be derived: fail closed.
    expect(() =>
      assertBenchTokenEconomyContract("public-locomo", {
        raw_history_tokens: 0,
        stored_memory_tokens: 0,
        recalled_context_tokens_total: 100,
        recall_event_count: 1,
        recalled_context_tokens_mean: 100,
        seed_event_count: 5
      })
    ).toThrow(/raw_history_tokens===0/);
  });

  it("passes a healthy run that carries a full-turn baseline", () => {
    expect(() =>
      assertBenchTokenEconomyContract("public-locomo", {
        raw_history_tokens: 1_000,
        stored_memory_tokens: 100,
        recalled_context_tokens_total: 50,
        recall_event_count: 1,
        recalled_context_tokens_mean: 50,
        seed_event_count: 5
      })
    ).not.toThrow();
  });

  it("exempts a run that seeded nothing (no history to save against)", () => {
    expect(() =>
      assertBenchTokenEconomyContract("public-locomo", {
        raw_history_tokens: 0,
        stored_memory_tokens: 0,
        recalled_context_tokens_total: 0,
        recall_event_count: 0,
        recalled_context_tokens_mean: 0,
        seed_event_count: 0
      })
    ).not.toThrow();
  });
});

/**
 * LoCoMo seeds each turn through workspace.proposeMemory, then SignalService
 * persists the redacted EventLog summary. This pins the EventLog-summary
 * contract end to end: fold -> aggregate -> contract -> token_economy +
 * saved ratio.
 * see also: apps/bench-runner/src/locomo/runner.ts runOneConversation
 */
describe("LoCoMo proposeMemory seed -> kpi token economy", () => {
  function locomoSeedRow(charCount: number): TokenEconomyEventRow {
    return emittedRow(
      summarySeedPayload({
        fullTurnTokens: benchTokens(charCount),
        storedTokens: benchTokens(charCount)
      })
    );
  }

  it("derives raw_history + a saved ratio from no-creds proposeMemory seeds", () => {
    // Two LoCoMo turns (each its own self-contained turn: no turn-seed index)
    // plus one recall delivering a small context window.
    const metrics = deriveBenchTokenMetrics(
      [locomoSeedRow(200), locomoSeedRow(120)],
      [lensRow(40)]
    );
    expect(metrics.raw_history_tokens).toBe(80); // 50 + 30, each turn once
    expect(metrics.stored_memory_tokens).toBe(80);
    expect(metrics.seed_event_count).toBe(2);

    const input = aggregateBenchTokenMetrics([metrics]);
    // Contract holds: a seeded LoCoMo run carries a full-turn baseline.
    expect(() =>
      assertBenchTokenEconomyContract("public-locomo", input)
    ).not.toThrow();

    const economy = buildTokenEconomy(input);
    expect(economy.raw_history_tokens).toBe(80);
    const ratio = computeTokenSavedRatio(input);
    // 1 - 40/80 = 0.5 saved vs re-reading the full history.
    expect(ratio).toBeCloseTo(0.5, 10);
  });

  it("contract fails a LoCoMo-shape run whose EventLog summary never stamped the marker", () => {
    // A regression where SignalService dropped the bench summary marker: the
    // fold skips the row, and the aggregate has zero raw_history despite real
    // recalls.
    const metrics = deriveBenchTokenMetrics(
      [emittedRow({ excerpt: "Caroline: hi", turn_content_excerpt: "hi" })],
      [lensRow(40)]
    );
    expect(metrics.seed_event_count).toBe(0);
    const input = aggregateBenchTokenMetrics([metrics]);
    expect(() =>
      assertBenchTokenEconomyContract("public-locomo", input)
    ).not.toThrow(); // seed_event_count===0 is exempt (honest empty)
    // But a run that DID seed yet folded to zero raw_history must fail:
    expect(() =>
      assertBenchTokenEconomyContract("public-locomo", {
        ...input,
        seed_event_count: 3
      })
    ).toThrow(/full-turn marker/);
  });
});
