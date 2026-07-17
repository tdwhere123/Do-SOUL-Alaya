import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  startBenchDaemon,
  type BenchDaemonHandle,
  type BenchSignalSeedInput
} from "../../../harness/daemon.js";
import type {
  CompileSeedExtractionStats,
  CompileSeedTurnInput
} from "../../../longmemeval/compile-seed.js";
import type { LongMemEvalQuestion } from "../../../longmemeval/ingestion/dataset.js";
import { seedLongMemEvalQuestion } from "../../../longmemeval/runner/question/runner-question-seeding.js";
import { buildLongMemEvalSnapshotQuestion } from "../../../longmemeval/runner/question/runner-question-result.js";
import { deriveLongMemEvalGoldMemoryIds } from "../../../longmemeval/runner/runner-scoring.js";
import { assertSeedLedgerMaterializationProof } from "../../../longmemeval/snapshot/seed-ledger/seed-ledger-materialization-proof.js";

let daemon: BenchDaemonHandle | undefined;
let root: string | undefined;

afterEach(async () => {
  await daemon?.shutdown().catch(() => undefined);
  daemon = undefined;
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  root = undefined;
  vi.unstubAllEnvs();
});

describe("LongMemEval reconciliation provenance integration", () => {
  it("maps an identical-NOOP from the real router to both source rounds", async () => {
    vi.stubEnv("ALAYA_INGEST_RECONCILIATION_ENABLED", "1");
    root = await mkdtemp(join(tmpdir(), "longmemeval-reconcile-"));
    daemon = await startBenchDaemon({
      dataDirRoot: root,
      workspaceId: "longmemeval-reconcile-workspace",
      runId: "longmemeval-reconcile-run"
    });
    const workspace = { ...daemon, detach: async () => undefined };
    const stats = seedStats();
    const source = question();
    const state = await seedLongMemEvalQuestion({
      workspace,
      question: source,
      seedRunner: {
        stats,
        seedTurn: async (input) => await seedIdenticalFact(input, stats)
      },
      seedFormationMode: "treatment_neutral"
    });

    expect(state.seedRounds.map((round) => round.memoryObjectIds)).toEqual([
      [expect.any(String)],
      [expect.any(String)]
    ]);
    expect(state.seedRounds[0]!.memoryObjectIds[0])
      .toBe(state.seedRounds[1]!.memoryObjectIds[0]);
    expect([...state.sidecar.values()]).toEqual([
      expect.objectContaining({
        sessionId: "session-first",
        hasAnswer: false,
        sourceRounds: [
          { sessionIndex: 0, roundIndex: 0, sessionId: "session-first", hasAnswer: false },
          { sessionIndex: 1, roundIndex: 0, sessionId: "session-answer", hasAnswer: true }
        ]
      })
    ]);
    expect(deriveLongMemEvalGoldMemoryIds(
      state.sidecar,
      new Set(["session-answer"])
    )).toEqual([state.seedRounds[0]!.memoryObjectIds[0]]);
    const snapshotQuestion = buildLongMemEvalSnapshotQuestion({
      question: source,
      workspace,
      seedState: state
    });
    const db = new DatabaseSync(join(daemon.dataDir, "alaya.db"));
    try {
      expect(() => assertSeedLedgerMaterializationProof({
        db,
        question: snapshotQuestion,
        source,
        ledger: snapshotQuestion.seedRounds!
      })).not.toThrow();
      db.prepare("DELETE FROM event_log WHERE caused_by = 'reconciliation_noop'").run();
      expect(() => assertSeedLedgerMaterializationProof({
        db,
        question: snapshotQuestion,
        source,
        ledger: snapshotQuestion.seedRounds!
      })).toThrow(/NOOP proof/iu);
    } finally {
      db.close();
    }
  }, 60_000);

  it("keeps one survivor and every materialized binding for same-round ADD then NOOP", async () => {
    vi.stubEnv("ALAYA_INGEST_RECONCILIATION_ENABLED", "1");
    root = await mkdtemp(join(tmpdir(), "longmemeval-reconcile-same-round-"));
    daemon = await startBenchDaemon({
      dataDirRoot: root,
      workspaceId: "longmemeval-reconcile-same-round-workspace",
      runId: "longmemeval-reconcile-same-round-run"
    });
    const workspace = { ...daemon, detach: async () => undefined };
    const stats = seedStats();
    const source = duplicateQuestion();
    const state = await seedLongMemEvalQuestion({
      workspace,
      question: source,
      seedRunner: {
        stats,
        seedTurn: async (input) => await seedDuplicateFacts(input, stats)
      },
      seedFormationMode: "treatment_neutral"
    });

    expect(state.seedRounds[0]).toMatchObject({
      factsProduced: 2,
      memoryObjectIds: [expect.any(String)],
      memoryBindings: [
        { objectId: expect.any(String), signalId: expect.any(String), evidenceId: expect.any(String) },
        { objectId: expect.any(String), signalId: expect.any(String), evidenceId: null }
      ]
    });
    const bindings = state.seedRounds[0]!.memoryBindings!;
    expect(new Set(bindings.map((binding) => binding.objectId))).toEqual(
      new Set(state.seedRounds[0]!.memoryObjectIds)
    );
    expect(state.coherenceMembers).toHaveLength(1);
    expect([...state.sidecar.values()][0]?.sourceRounds).toEqual([
      { sessionIndex: 0, roundIndex: 0, sessionId: "session-answer", hasAnswer: true }
    ]);
    const snapshotQuestion = buildLongMemEvalSnapshotQuestion({
      question: source,
      workspace,
      seedState: state
    });
    const db = new DatabaseSync(join(daemon.dataDir, "alaya.db"));
    try {
      expect(() => assertSeedLedgerMaterializationProof({
        db,
        question: snapshotQuestion,
        source,
        ledger: snapshotQuestion.seedRounds!
      })).not.toThrow();
      const hq = db.prepare("SELECT hqs_json FROM memory_hq WHERE object_id = ?")
        .get(state.seedRounds[0]!.memoryObjectIds[0]!) as { readonly hqs_json: string };
      expect(JSON.parse(hq.hqs_json)).toEqual([
        "Which drink was preferred?",
        "I prefer tea.",
        "What beverage did the user choose?"
      ]);
    } finally {
      db.close();
    }
  }, 60_000);
});

async function seedIdenticalFact(
  input: CompileSeedTurnInput,
  stats: CompileSeedExtractionStats
) {
  const signal = identicalSignal(input);
  const result = await input.daemon.proposeMemoriesFromCompileSignals([signal]);
  recordSeedStats(stats, input, 1);
  return { seeds: result.seeds, turnTruncated: false, charsClipped: 0 };
}

async function seedDuplicateFacts(
  input: CompileSeedTurnInput,
  stats: CompileSeedExtractionStats
) {
  const signal = identicalSignal(input);
  const result = await input.daemon.proposeMemoriesFromCompileSignals([
    { ...signal, productionRawPayload: { hqs: ["Which drink was preferred?"] } },
    { ...signal, productionRawPayload: { hqs: ["What beverage did the user choose?"] } }
  ]);
  recordSeedStats(stats, input, 2);
  return { seeds: result.seeds, turnTruncated: false, charsClipped: 0 };
}

function identicalSignal(input: CompileSeedTurnInput): BenchSignalSeedInput {
  return {
    signalKind: "potential_preference",
    objectKind: "fact",
    confidence: 0.9,
    distilledFact: "I prefer tea.",
    matchedText: "I prefer tea.",
    turnContent: "I prefer tea.",
    evidenceRef: input.evidenceRefBase,
    turnSeedIndex: input.seedIndex,
    extractionProvider: "official_api_compile",
    ...(input.surfaceId === undefined ? {} : { surfaceId: input.surfaceId }),
    ...(input.sourceObservedAt === undefined
      ? {}
      : { sourceObservedAt: input.sourceObservedAt })
  };
}

function recordSeedStats(
  stats: CompileSeedExtractionStats,
  input: CompileSeedTurnInput,
  count: number
): void {
  stats.extractionAttempts = (stats.extractionAttempts ?? 0) + 1;
  stats.cacheHits += 1;
  stats.factsProduced += count;
  stats.lastExtractionSource = "cache";
  stats.lastCacheKey = sha256(input.turnContent.trim());
  stats.lastRawJsonSha256 = sha256("identical fixture response");
  stats.lastTurnRawSignalCount = count;
  stats.lastTurnDraftCount = count;
}

function question(): LongMemEvalQuestion {
  return {
    question_id: "q-real-reconciliation",
    question_type: "single-session-user",
    question: "What preference was stated?",
    answer: "The same preference.",
    question_date: "2026-07-17T00:00:00.000Z",
    haystack_session_ids: ["session-first", "session-answer"],
    haystack_dates: ["2026-07-15T00:00:00.000Z", "2026-07-16T00:00:00.000Z"],
    haystack_sessions: [
      [{ role: "user", content: "I prefer tea." }],
      [{ role: "user", content: "I prefer tea.", has_answer: true }]
    ],
    answer_session_ids: ["session-answer"]
  };
}

function duplicateQuestion(): LongMemEvalQuestion {
  return {
    question_id: "q-real-reconciliation-same-round",
    question_type: "single-session-user",
    question: "What preference was stated?",
    answer: "Tea.",
    question_date: "2026-07-17T00:00:00.000Z",
    haystack_session_ids: ["session-answer"],
    haystack_dates: ["2026-07-16T00:00:00.000Z"],
    haystack_sessions: [[{ role: "user", content: "I prefer tea.", has_answer: true }]],
    answer_session_ids: ["session-answer"]
  };
}

function seedStats(): CompileSeedExtractionStats {
  return {
    path: "official_api_compile",
    extractionAttempts: 0,
    cacheHits: 0,
    llmCalls: 0,
    offlineFallbacks: 0,
    liveExtractionFailures: 0,
    cachedExtractionFailures: 0,
    factsProduced: 0,
    signalsDropped: 0,
    signalsDroppedByReason: { candidate_absent: 0, materialization_drop: 0 },
    parseDropped: 0,
    compileOverflowDropped: 0,
    lastTurnRawSignalCount: 0,
    lastTurnDraftCount: 0,
    lastExtractionSource: null,
    lastCacheKey: null,
    lastRawJsonSha256: null
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
