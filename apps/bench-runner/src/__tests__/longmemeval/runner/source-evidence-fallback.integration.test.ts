import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import {
  startBenchDaemon,
  type BenchDaemonHandle
} from "../../../harness/daemon.js";
import {
  createCompileSeedRunner
} from "../../../longmemeval/compile-seed.js";
import type { LongMemEvalQuestion } from
  "../../../longmemeval/ingestion/dataset.js";
import { seedLongMemEvalQuestion } from
  "../../../longmemeval/runner/question/runner-question-seeding.js";
import { scoreLongMemEvalRecallHits } from
  "../../../longmemeval/runner/runner-scoring.js";
import { buildLongMemEvalSnapshotQuestion } from
  "../../../longmemeval/runner/question/runner-question-result.js";
import { assertSnapshotDatasetSubstrateIdentity } from
  "../../../longmemeval/snapshot/substrate-binding.js";
import { RECALL_EVAL_SNAPSHOT_MANIFEST_VERSION } from
  "../../../longmemeval/snapshot/materialize.js";
import { CREDENTIALLED_CONFIG } from
  "../compile-seed/compile-seed-fixture.js";
import { writeExtractionCacheTestManifest } from
  "../extraction/extraction-cache-test-fixture.js";

let daemon: BenchDaemonHandle | undefined;
let root: string | undefined;

afterEach(async () => {
  await daemon?.shutdown().catch(() => undefined);
  daemon = undefined;
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("LongMemEval source evidence fallback integration", () => {
  it("recalls and scores an empty extraction through verified source evidence", async () => {
    root = await mkdtemp(join(tmpdir(), "longmemeval-source-evidence-"));
    const cacheRoot = join(root, "cache");
    writeExtractionCacheTestManifest({
      cacheRoot,
      model: CREDENTIALLED_CONFIG.model,
      providerUrl: CREDENTIALLED_CONFIG.providerUrl,
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT
    });
    daemon = await startBenchDaemon({
      dataDirRoot: root,
      workspaceId: "source-evidence-workspace",
      runId: "source-evidence-run"
    });
    const runner = createCompileSeedRunner({
      config: CREDENTIALLED_CONFIG,
      cacheRoot,
      allowLiveExtraction: true,
      extractorFactory: () => ({
        extract: async () => ({ rawJson: "{\"signals\":[]}" })
      })
    });

    const state = await seedLongMemEvalQuestion({
      workspace: { ...daemon, detach: async () => undefined },
      question: sourceEvidenceQuestion(),
      seedRunner: runner,
      seedFormationMode: "treatment_neutral"
    });

    const entries = [...state.sidecar.values()];
    expect(entries).toEqual([expect.objectContaining({
      objectKind: "evidence_capsule",
      hasAnswer: true,
      sourceRounds: [{
        sessionIndex: 0,
        roundIndex: 0,
        sessionId: "answer-session",
        hasAnswer: true
      }]
    })]);
    expect(state.coherenceMembers).toEqual([]);
    expect(state.answerSeedDropReasons).toEqual({
      candidate_absent: 0,
      materialization_drop: 0
    });
    expect(state.seedRounds[0]).toMatchObject({
      factsProduced: 0,
      memoryObjectIds: [],
      memoryBindings: [],
      directEvidenceBindings: [{
        signalId: expect.any(String),
        evidenceId: entries[0]?.objectId
      }]
    });
    const recallResult = await daemon.recall(sourceEvidenceQuestion().question, {
      maxResults: 10,
      referenceTime: sourceEvidenceQuestion().question_date
    });
    expect(recallResult.results).toContainEqual(expect.objectContaining({
      object_id: entries[0]?.objectId,
      object_kind: "evidence_capsule"
    }));
    expect(scoreLongMemEvalRecallHits({
      results: recallResult.results,
      sidecar: state.sidecar,
      answerSessionIds: state.answerSessionSet
    })).toMatchObject({
      hitAt1: true,
      hitAt5: true,
      hitAt10: true
    });
    const snapshotQuestion = buildLongMemEvalSnapshotQuestion({
      question: sourceEvidenceQuestion(),
      workspace: { ...daemon, detach: async () => undefined },
      seedState: state
    });
    expect(() => assertSnapshotDatasetSubstrateIdentity({
      dbPath: join(daemon!.dataDir, "alaya.db"),
      sidecar: {
        schema_version: RECALL_EVAL_SNAPSHOT_MANIFEST_VERSION,
        variant: "longmemeval_s",
        questions: [snapshotQuestion]
      },
      questions: [sourceEvidenceQuestion()],
      runtimeIdentity: "sidecar_bound"
    })).not.toThrow();

    const db = new DatabaseSync(join(daemon.dataDir, "alaya.db"));
    try {
      expect(db.prepare("SELECT COUNT(*) AS count FROM memory_entries")
        .get()).toEqual({ count: 0 });
      expect(db.prepare(
        `SELECT object_id, object_kind, created_by, evidence_kind,
                evidence_health_state, source_hash, excerpt
         FROM evidence_capsules`
      ).get()).toMatchObject({
        object_id: entries[0]?.objectId,
        object_kind: "evidence_capsule",
        created_by: "garden_compile",
        evidence_kind: "conversation_excerpt",
        evidence_health_state: "verified",
        source_hash: expect.stringMatching(
          /^sha256:garden-source-turn-fallback-v1:[a-f0-9]{64}$/u
        ),
        excerpt: expect.stringContaining("7:15 train")
      });
    } finally {
      db.close();
    }
  }, 60_000);

  it("does not promote an ordinary unroutable evidence-only signal into scored source evidence", async () => {
    root = await mkdtemp(join(tmpdir(), "longmemeval-unroutable-evidence-"));
    const cacheRoot = join(root, "cache");
    writeExtractionCacheTestManifest({
      cacheRoot,
      model: CREDENTIALLED_CONFIG.model,
      providerUrl: CREDENTIALLED_CONFIG.providerUrl,
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT
    });
    daemon = await startBenchDaemon({
      dataDirRoot: root,
      workspaceId: "unroutable-evidence-workspace",
      runId: "unroutable-evidence-run"
    });
    const runner = createCompileSeedRunner({
      config: CREDENTIALLED_CONFIG,
      cacheRoot,
      allowLiveExtraction: true,
      extractorFactory: () => ({
        extract: async () => ({
          rawJson: JSON.stringify({
            signals: [{
              signal_kind: "potential_claim",
              object_kind: "unroutable_observation",
              confidence: 0.4,
              matched_text: "I take the 7:15 train.",
              distilled_fact: "The user takes the 7:15 train.",
              source_locator: {
                contract_version: 2,
                kind: "assertion_catalog",
                assertion_id: 1
              }
            }]
          })
        })
      })
    });

    const result = await runner.seedTurn({
      daemon,
      turnContent: "I take the 7:15 train.",
      turnMessages: [{
        message_id: "user-1",
        role: "user",
        content: "I take the 7:15 train."
      }],
      evidenceRefBase: "q-unroutable-s0-r0",
      seedIndex: 0,
      workspaceId: daemon.workspaceId,
      runId: daemon.runId,
      sourceEvidenceFallback: "trusted_source_turn",
      sourceObservedAt: "2026-07-20T00:00:00.000Z"
    });

    expect(result.seeds).toEqual([]);
    expect(runner.stats.signalsDroppedByReason.candidate_absent).toBe(1);
    const forgedFallback = await daemon.proposeMemoriesFromCompileSignals([{
      signalKind: "potential_claim",
      objectKind: "source_turn",
      confidence: 1,
      distilledFact: "I take the 7:15 train.",
      turnContent: "I take the 7:15 train.",
      evidenceRef: "q-forged-fallback",
      turnSeedIndex: 1,
      extractionProvider: "official_api_compile",
      evidenceFallbackReason: "empty_extraction"
    }]);
    expect(forgedFallback).toMatchObject({
      seeds: [],
      createdEvidence: false,
      dropped: [expect.objectContaining({ reason: "materialization_drop" })]
    });
    const db = new DatabaseSync(join(daemon.dataDir, "alaya.db"));
    try {
      expect(db.prepare("SELECT COUNT(*) AS count FROM memory_entries")
        .get()).toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM evidence_capsules")
        .get()).toEqual({ count: 1 });
      expect(db.prepare("SELECT source_hash FROM evidence_capsules")
        .get()).not.toMatchObject({
          source_hash: expect.stringContaining(
            "sha256:garden-source-turn-fallback-v1:"
          )
        });
    } finally {
      db.close();
    }
  }, 60_000);

  it("uses the trusted no-evidence-created fallback when an extracted signal creates nothing", async () => {
    root = await mkdtemp(join(tmpdir(), "longmemeval-no-created-evidence-"));
    const cacheRoot = join(root, "cache");
    writeExtractionCacheTestManifest({
      cacheRoot,
      model: CREDENTIALLED_CONFIG.model,
      providerUrl: CREDENTIALLED_CONFIG.providerUrl,
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT
    });
    daemon = await startBenchDaemon({
      dataDirRoot: root,
      workspaceId: "no-created-evidence-workspace",
      runId: "no-created-evidence-run"
    });
    const runner = createCompileSeedRunner({
      config: CREDENTIALLED_CONFIG,
      cacheRoot,
      allowLiveExtraction: true,
      extractorFactory: () => ({
        extract: async () => ({
          rawJson: JSON.stringify({
            signals: [{
              signal_kind: "potential_claim",
              object_kind: "unroutable_observation",
              confidence: 0.2,
              matched_text: "I take the 7:15 train.",
              distilled_fact: "The user takes the 7:15 train.",
              source_locator: {
                contract_version: 2,
                kind: "assertion_catalog",
                assertion_id: 1
              }
            }]
          })
        })
      })
    });

    const result = await runner.seedTurn({
      daemon,
      turnContent: "I take the 7:15 train.",
      turnMessages: [{
        message_id: "user-1",
        role: "user",
        content: "I take the 7:15 train."
      }],
      evidenceRefBase: "q-deferred-s0-r0",
      seedIndex: 0,
      workspaceId: daemon.workspaceId,
      runId: daemon.runId,
      sourceEvidenceFallback: "trusted_source_turn",
      sourceObservedAt: "2026-07-20T00:00:00.000Z"
    });

    expect(result.seeds).toEqual([
      expect.objectContaining({
        kind: "evidence_capsule",
        truncated: false
      })
    ]);
    expect(runner.stats.signalsDroppedByReason.candidate_absent).toBe(1);
    const db = new DatabaseSync(join(daemon.dataDir, "alaya.db"));
    try {
      expect(db.prepare("SELECT COUNT(*) AS count FROM memory_entries")
        .get()).toEqual({ count: 0 });
      expect(db.prepare(
        "SELECT source_hash FROM evidence_capsules"
      ).get()).toMatchObject({
        source_hash: expect.stringMatching(
          /^sha256:garden-source-turn-fallback-v1:[a-f0-9]{64}$/u
        )
      });
    } finally {
      db.close();
    }
  }, 60_000);
});

function sourceEvidenceQuestion(): LongMemEvalQuestion {
  return {
    question_id: "q-source-evidence",
    question_type: "single-session-assistant",
    question: "Which train did the assistant recommend?",
    answer: "The 7:15 train from Central Station.",
    question_date: "2026-07-22T00:00:00.000Z",
    haystack_session_ids: ["answer-session"],
    haystack_dates: ["2026-07-20T00:00:00.000Z"],
    haystack_sessions: [[{
      role: "assistant",
      content: "Take the 7:15 train from Central Station.",
      has_answer: true
    }]],
    answer_session_ids: ["answer-session"]
  };
}
