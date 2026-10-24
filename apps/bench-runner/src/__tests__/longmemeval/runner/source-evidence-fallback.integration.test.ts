import { prepareSourceRecordLexicalIndex } from "../../harness/recall/source-records-worker-fixture.js";
import { installHistoricalSignalReplay } from "../../harness/seeding/historical-signal-replay-fixture.js";
import { createHash } from "node:crypto";
import { initDatabase, SqliteSignalRepo } from "@do-soul/alaya-storage";
import { readGardenSourceTurnFallbackReceipt, readGardenSourceTurnFallbackArtifactSignalId } from "@do-soul/alaya-protocol";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import {
  startBenchDaemon,
  type BenchDaemonHandle
} from "../../../harness/daemon.js";
import {
  createCompileSeedRunner
} from "../../../runs/compile-seed.js";
import {
  buildLongMemEvalRoundMessages,
  pairSessionIntoRounds,
  type LongMemEvalQuestion
} from "../../../datasets/longmemeval/ingestion/dataset.js";
import { seedLongMemEvalQuestion } from
  "../../../datasets/longmemeval/runner/question/runner-question-seeding.js";
import { buildLongMemEvalSnapshotQuestion } from
  "../../../datasets/longmemeval/runner/question/runner-question-result.js";
import { assertSnapshotDatasetSubstrateIdentity } from
  "../../../runs/snapshot/substrate-binding.js";
import { RECALL_EVAL_SNAPSHOT_MANIFEST_VERSION } from
  "../../../runs/snapshot/materialize.js";
import { admitCompileSeedTurnCache, CREDENTIALLED_CONFIG, interpretationsEnvelope,
  withOpenSemanticFactorGraph } from
  "../compile-seed/compile-seed-fixture.js";
import { writeExtractionCacheTestManifest } from
  "../extraction/extraction-cache-test-fixture.js";

let daemon: BenchDaemonHandle | undefined;
let root: string | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  await daemon?.shutdown().catch(() => undefined);
  daemon = undefined;
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("LongMemEval source evidence fallback integration", () => {
  it("preserves verified fallback evidence and delivers prepared retained source text", async () => {
    root = await mkdtemp(join(tmpdir(), "longmemeval-source-evidence-"));
    const cacheRoot = join(root, "cache");
    writeExtractionCacheTestManifest({
      cacheRoot,
      model: CREDENTIALLED_CONFIG.model,
      providerUrl: CREDENTIALLED_CONFIG.providerUrl,
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT
    });
    const question = sourceEvidenceQuestion();
    const session = question.haystack_sessions[0]!;
    const round = pairSessionIntoRounds(session)[0]!;
    await admitCompileSeedTurnCache({ cacheRoot, turnContent: round.content,
      turnMessages: buildLongMemEvalRoundMessages(session, round,
        `${question.question_id}-s0-r0`), rawJson: '{"interpretations":[]}' });
    daemon = await startBenchDaemon({
      dataDirRoot: root,
      workspaceId: "source-evidence-workspace",
      runId: "source-evidence-run"
    });
    const runner = createCompileSeedRunner({ config: CREDENTIALLED_CONFIG, cacheRoot });

    const state = await seedLongMemEvalQuestion({
      workspace: { ...daemon, detach: async () => undefined },
      question,
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
    // Seeding retained the source records and fallback capsule; lexical readiness is separate.
    prepareSourceRecordLexicalIndex(daemon.dataDir, daemon.workspaceId);
    const recallResult = await daemon.recall(question.question, {
      maxResults: 10,
      referenceTime: question.question_date
    });
    expect(recallResult.results.length).toBeGreaterThan(0);
    expect(recallResult.results.every((row) => row.object_kind === "source_evidence")).toBe(true);
    expect(recallResult.results).toEqual(expect.arrayContaining([expect.objectContaining({
      content_preview: expect.stringContaining("I plan to take the 7:15 train from Central Station."),
      target: expect.objectContaining({ kind: "source_evidence" })
    })]));
    const snapshotQuestion = buildLongMemEvalSnapshotQuestion({
      question,
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
      questions: [question],
      runtimeIdentity: "sidecar_bound"
    })).not.toThrow();

    const assistantOnly = await daemon.proposeMemoriesFromCompileSignals([{
      signalKind: "potential_evidence_anchor",
      objectKind: "source_turn",
      confidence: 1,
      distilledFact: "Assistant-only archive content.",
      turnContent: "Assistant: Assistant-only archive content.",
      turnMessages: [{
        message_id: "assistant-only",
        role: "assistant",
        content: "Assistant-only archive content."
      }],
      evidenceRef: "q-assistant-only-fallback",
      turnSeedIndex: 1,
      extractionProvider: "official_api_compile",
      evidenceFallbackReason: "empty_extraction"
    }]);
    expect(assistantOnly).toMatchObject({
      seeds: [],
      createdEvidence: false,
      dropped: [expect.objectContaining({ reason: "materialization_drop" })]
    });

    const db = new DatabaseSync(join(daemon.dataDir, "alaya.db"));
    try {
      const signalId = state.seedRounds[0]!.directEvidenceBindings![0]!.signalId;
      const signal = await new SqliteSignalRepo(initDatabase({
        filename: join(daemon.dataDir, "alaya.db")
      })).getById(signalId);
      expect(signal).not.toBeNull();
      const receipt = readGardenSourceTurnFallbackReceipt(signal!);
      expect(receipt).not.toBeNull();
      expect(receipt).toMatchObject({ signal_id: signalId, source_corpus: sourceEvidenceCorpus() });
      const digest = createHash("sha256").update(receipt!.preimage, "utf8").digest("hex");
      expect(receipt!.digest).toBe(digest);
      expect(db.prepare("SELECT COUNT(*) AS count FROM memory_entries")
        .get()).toEqual({ count: 0 });
      expect(db.prepare(
        `SELECT object_id, object_kind, created_by, evidence_kind,
                evidence_health_state, source_hash, gist, excerpt
         FROM evidence_capsules`
      ).get()).toMatchObject({
        object_id: entries[0]?.objectId,
        object_kind: "evidence_capsule",
        created_by: "garden_compile",
        evidence_kind: "conversation_excerpt",
        evidence_health_state: "verified",
        source_hash: `sha256:garden-source-turn-fallback-v2:${digest}`,
        gist: sourceEvidenceCorpus(),
        excerpt: SOURCE_EVIDENCE_USER_CONTENT
      });
      await daemon.proposeMemoriesFromCompileSignals([{
        signalKind: "potential_evidence_anchor", objectKind: "source_turn", confidence: 1,
        distilledFact: "I moved the archive to Oslo.", turnContent: "User: I moved the archive to Oslo.",
        turnMessages: [{ message_id: "different-user-turn", role: "user", content: "I moved the archive to Oslo." }],
        evidenceRef: "q-distinct-fallback", turnSeedIndex: 2,
        extractionProvider: "official_api_compile", evidenceFallbackReason: "empty_extraction"
      }]);
      const other = db.prepare("SELECT json_extract(physical_anchor, '$.artifact_ref') AS artifact_ref, source_hash FROM evidence_capsules WHERE object_id != ?")
        .get(entries[0]!.objectId) as { artifact_ref: string; source_hash: string };
      expect(other).toBeDefined();
      const otherSignalId = readGardenSourceTurnFallbackArtifactSignalId(other.artifact_ref);
      expect(otherSignalId).not.toBe(signalId);
      const otherSignal = await new SqliteSignalRepo(initDatabase({ filename: join(daemon.dataDir, "alaya.db") }))
        .getById(otherSignalId!);
      const otherReceipt = readGardenSourceTurnFallbackReceipt(otherSignal!)!;
      const otherDigest = createHash("sha256").update(otherReceipt.preimage, "utf8").digest("hex");
      expect(other.source_hash).toBe(`sha256:garden-source-turn-fallback-v2:${otherDigest}`);
      expect(otherDigest).not.toBe(digest);
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
    const turnMessages = [{ message_id: "user-1", role: "user" as const,
      content: "I take the 7:15 train." }];
    // The historical receive fixture bypasses extraction; this admitted turn
    // supplies the runner's exact cache coverage and request identity.
    await admitCompileSeedTurnCache({ cacheRoot,
      turnContent: "I take the 7:15 train.",
      turnMessages,
      rawJson: interpretationsEnvelope([{ matched: "I take the 7:15 train." }]) });
    daemon = await startBenchDaemon({
      dataDirRoot: root,
      workspaceId: "unroutable-evidence-workspace",
      runId: "unroutable-evidence-run"
    });
    installHistoricalSignalReplay(JSON.stringify({
            signals: [withOpenSemanticFactorGraph({
              signal_kind: "potential_claim",
              object_kind: "unroutable_observation",
              confidence: 0.4,
              matched_text: "I take the 7:15 train.",
              distilled_fact: "The user takes the 7:15 train.",
              source_locator: {
                contract_version: 4,
                kind: "assertion_catalog",
                assertion_id: 1
              }
            })]
          }));
    const runner = createCompileSeedRunner({ config: CREDENTIALLED_CONFIG, cacheRoot });

    const result = await runner.seedTurn({
      daemon,
      turnContent: "I take the 7:15 train.",
      turnMessages,
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
    const turnMessages = [{ message_id: "user-1", role: "user" as const,
      content: "I take the 7:15 train." }];
    await admitCompileSeedTurnCache({ cacheRoot,
      turnContent: "I take the 7:15 train.",
      turnMessages,
      rawJson: interpretationsEnvelope([{ matched: "I take the 7:15 train." }]) });
    daemon = await startBenchDaemon({
      dataDirRoot: root,
      workspaceId: "no-created-evidence-workspace",
      runId: "no-created-evidence-run"
    });
    installHistoricalSignalReplay(JSON.stringify({
            signals: [withOpenSemanticFactorGraph({
              signal_kind: "potential_claim",
              object_kind: "unroutable_observation",
              confidence: 0.2,
              matched_text: "I take the 7:15 train.",
              distilled_fact: "The user takes the 7:15 train.",
              source_locator: {
                contract_version: 4,
                kind: "assertion_catalog",
                assertion_id: 1
              }
            })]
          }));
    const runner = createCompileSeedRunner({ config: CREDENTIALLED_CONFIG, cacheRoot });

    const result = await runner.seedTurn({
      daemon,
      turnContent: "I take the 7:15 train.",
      turnMessages,
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
          /^sha256:garden-source-turn-fallback-v2:[a-f0-9]{64}$/u
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
    question: "Which train does the user plan to take?",
    answer: "The 7:15 train from Central Station.",
    question_date: "2026-07-22T00:00:00.000Z",
    haystack_session_ids: ["answer-session"],
    haystack_dates: ["2026-07-20T00:00:00.000Z"],
    haystack_sessions: [[
      { role: "user", content: SOURCE_EVIDENCE_USER_CONTENT, has_answer: true },
      { role: "assistant", content: SOURCE_EVIDENCE_ASSISTANT_CONTENT, has_answer: false }
    ]],
    answer_session_ids: ["answer-session"]
  };
}

const SOURCE_EVIDENCE_USER_CONTENT =
  "I plan to take the 7:15 train from Central Station.\nAssistant: quoted marker inside user text.";
const SOURCE_EVIDENCE_ASSISTANT_CONTENT =
  "Noted on both lines.\nUser: quoted marker inside assistant text.";

function sourceEvidenceCorpus(): string {
  return `User: ${SOURCE_EVIDENCE_USER_CONTENT}\nAssistant: ${SOURCE_EVIDENCE_ASSISTANT_CONTENT}`;
}
