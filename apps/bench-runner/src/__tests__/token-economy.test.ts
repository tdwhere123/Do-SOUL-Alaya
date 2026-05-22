import { describe, expect, it } from "vitest";
import {
  RecallContextEventType,
  SignalEventType
} from "@do-soul/alaya-protocol";
import {
  aggregateBenchTokenMetrics,
  deriveBenchTokenMetrics,
  BENCH_FULL_TURN_CONTENT_KEY,
  BENCH_SEED_MARKER_KEY,
  BENCH_STORED_CONTENT_KEY,
  BENCH_TURN_SEED_INDEX_KEY,
  type TokenEconomyEventRow
} from "../longmemeval/token-economy.js";

function emittedRow(rawPayload: Record<string, unknown>): TokenEconomyEventRow {
  return {
    event_type: SignalEventType.SOUL_SIGNAL_EMITTED,
    payload_json: {
      signal_id: "sig-1",
      workspace_id: "ws-1",
      run_id: "run-1",
      source: "garden_compile",
      signal_kind: "potential_preference",
      raw_payload: rawPayload
    }
  };
}

/**
 * Build a credentialled-shape seed event raw_payload: it carries explicit
 * bench_full_turn_content / bench_stored_content keys because on the
 * credentialled path `excerpt` is only a narrow turn_content_excerpt window,
 * never the full turn. `extra` lets a test add the production-shaped fields
 * (turn_content_excerpt / excerpt) the fold must NOT mistake for the full
 * turn when the bench content keys are present.
 */
function seedPayload(input: {
  readonly fullTurn: string;
  readonly stored: string;
  readonly turnSeedIndex?: number;
  readonly extra?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    ...(input.extra ?? {}),
    [BENCH_SEED_MARKER_KEY]: true,
    [BENCH_FULL_TURN_CONTENT_KEY]: input.fullTurn,
    [BENCH_STORED_CONTENT_KEY]: input.stored,
    ...(input.turnSeedIndex === undefined
      ? {}
      : { [BENCH_TURN_SEED_INDEX_KEY]: input.turnSeedIndex })
  };
}

/**
 * Build a no-credentials-shape seed event raw_payload: it carries NO
 * bench_full_turn_content / bench_stored_content keys because the
 * benchTokenEconomyPayload helper omits them when they would byte-duplicate
 * `excerpt` / `distilled_fact` — on the no-creds path `excerpt` IS the full
 * turn and `distilled_fact` IS the durable fact. The fold must fall back to
 * those sibling fields. Only the content-free bench_seed marker (and the
 * turn-seed index) survive.
 */
function noCredsSeedPayload(input: {
  readonly excerpt: string;
  readonly distilledFact?: string;
  readonly turnSeedIndex?: number;
}): Record<string, unknown> {
  return {
    [BENCH_SEED_MARKER_KEY]: true,
    excerpt: input.excerpt,
    ...(input.distilledFact === undefined
      ? {}
      : { distilled_fact: input.distilledFact }),
    ...(input.turnSeedIndex === undefined
      ? {}
      : { [BENCH_TURN_SEED_INDEX_KEY]: input.turnSeedIndex })
  };
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
  it("derives raw_history from the full turn and stored_memory from the stored fact", () => {
    // full turn 80 chars -> 20 tokens; stored fact 8 chars -> 2 tokens.
    const metrics = deriveBenchTokenMetrics(
      [
        emittedRow(
          seedPayload({
            fullTurn: "x".repeat(80),
            stored: "y".repeat(8),
            turnSeedIndex: 0
          })
        )
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
    const fullTurn = "h".repeat(400); // 100 tokens
    const metrics = deriveBenchTokenMetrics(
      [
        emittedRow(
          seedPayload({ fullTurn, stored: "a".repeat(40), turnSeedIndex: 7 })
        ),
        emittedRow(
          seedPayload({ fullTurn, stored: "b".repeat(20), turnSeedIndex: 7 })
        ),
        emittedRow(
          seedPayload({ fullTurn, stored: "c".repeat(16), turnSeedIndex: 7 })
        )
      ],
      []
    );
    expect(metrics.raw_history_tokens).toBe(100); // counted once, NOT 300
    expect(metrics.stored_memory_tokens).toBe(10 + 5 + 4);
    expect(metrics.seed_event_count).toBe(3);
  });

  it("ignores the production turn_content_excerpt window in favour of the bench full turn", () => {
    // The compile path's production raw_payload carries only a narrow
    // turn_content_excerpt window; the fold must read the bench full-turn
    // key, never the window.
    const metrics = deriveBenchTokenMetrics(
      [
        emittedRow(
          seedPayload({
            fullTurn: "f".repeat(800), // 200 tokens — the true turn
            stored: "s".repeat(40),
            turnSeedIndex: 1,
            extra: {
              turn_content_excerpt: "w".repeat(80), // 20 tokens — the window
              matched_text: "m".repeat(12)
            }
          })
        )
      ],
      []
    );
    expect(metrics.raw_history_tokens).toBe(200);
    expect(metrics.stored_memory_tokens).toBe(10);
  });

  it("falls back to excerpt / distilled_fact on a no-credentials-shape seed event", () => {
    // The no-creds seed path stamps NO bench_full_turn_content /
    // bench_stored_content (they would byte-duplicate excerpt /
    // distilled_fact). The fold must reconstruct raw_history from `excerpt`
    // and stored_memory from `distilled_fact`.
    const fullTurn = "n".repeat(160); // 40 tokens
    const fact = "d".repeat(20); // 5 tokens
    const row = noCredsSeedPayload({
      excerpt: fullTurn,
      distilledFact: fact,
      turnSeedIndex: 0
    });
    // The no-creds raw_payload must NOT carry a duplicated full turn.
    expect(row[BENCH_FULL_TURN_CONTENT_KEY]).toBeUndefined();
    expect(row[BENCH_STORED_CONTENT_KEY]).toBeUndefined();
    const metrics = deriveBenchTokenMetrics([emittedRow(row)], []);
    expect(metrics.raw_history_tokens).toBe(40);
    expect(metrics.stored_memory_tokens).toBe(5);
    expect(metrics.seed_event_count).toBe(1);
  });

  it("falls back to excerpt for stored_memory when a no-creds seed has no distilled_fact", () => {
    // The generic proposeMemory no-creds seed omits distilled_fact; the
    // harness then treats the seeded content itself as the durable fact, so
    // the fold's stored fallback chain terminates at `excerpt`.
    const fullTurn = "g".repeat(80); // 20 tokens
    const row = noCredsSeedPayload({ excerpt: fullTurn });
    expect(row[BENCH_FULL_TURN_CONTENT_KEY]).toBeUndefined();
    expect(row[BENCH_STORED_CONTENT_KEY]).toBeUndefined();
    const metrics = deriveBenchTokenMetrics([emittedRow(row)], []);
    expect(metrics.raw_history_tokens).toBe(20);
    expect(metrics.stored_memory_tokens).toBe(20);
    expect(metrics.seed_event_count).toBe(1);
  });

  it("counts a no-creds turn's raw_history exactly once (one signal per turn)", () => {
    // The no-creds path emits one signal per turn, each with its own
    // turn-seed index. Two distinct turns must each be counted once.
    const turnA = "a".repeat(40); // 10 tokens
    const turnB = "b".repeat(120); // 30 tokens
    const metrics = deriveBenchTokenMetrics(
      [
        emittedRow(noCredsSeedPayload({ excerpt: turnA, turnSeedIndex: 0 })),
        emittedRow(noCredsSeedPayload({ excerpt: turnB, turnSeedIndex: 1 }))
      ],
      []
    );
    expect(metrics.raw_history_tokens).toBe(40);
    expect(metrics.seed_event_count).toBe(2);
  });

  it("prefers the bench full-turn key over excerpt on a credentialled-shape event", () => {
    // The credentialled path stamps bench_full_turn_content (the real full
    // turn) and leaves `excerpt` as the narrow window. The fold must use the
    // bench key, never the window.
    const metrics = deriveBenchTokenMetrics(
      [
        emittedRow(
          seedPayload({
            fullTurn: "f".repeat(800), // 200 tokens — the true turn
            stored: "s".repeat(40), // 10 tokens
            turnSeedIndex: 2,
            extra: { excerpt: "w".repeat(40) } // 10 tokens — the window
          })
        )
      ],
      []
    );
    expect(metrics.raw_history_tokens).toBe(200);
    expect(metrics.stored_memory_tokens).toBe(10);
  });

  it("counts distinct turns separately and de-duplicates within a turn", () => {
    const turnA = "a".repeat(400); // 100 tokens
    const turnB = "b".repeat(800); // 200 tokens
    const metrics = deriveBenchTokenMetrics(
      [
        emittedRow(
          seedPayload({ fullTurn: turnA, stored: "x".repeat(8), turnSeedIndex: 0 })
        ),
        emittedRow(
          seedPayload({ fullTurn: turnA, stored: "y".repeat(4), turnSeedIndex: 0 })
        ),
        emittedRow(
          seedPayload({ fullTurn: turnB, stored: "z".repeat(8), turnSeedIndex: 1 })
        )
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
        emittedRow(seedPayload({ fullTurn: "a".repeat(40), stored: "f".repeat(8) })),
        emittedRow(seedPayload({ fullTurn: "b".repeat(80), stored: "g".repeat(4) }))
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
