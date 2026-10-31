import { prepareSourceRecordLexicalIndex } from "../../harness/recall/source-records-worker-fixture.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SOURCE_STATEMENTS_PROMPT } from "@do-soul/alaya-soul";
import {
  startBenchDaemon,
  type BenchDaemonHandle
} from "../../../harness/daemon.js";
import { createCompileSeedRunner } from "../../../runs/compile-seed.js";
import {
  buildLongMemEvalSessionMessages,
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
import { admitStatementSessionCache, CREDENTIALLED_CONFIG } from
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

describe("LongMemEval statement-free source delivery", () => {
  it("delivers admitted source text without minting fallback evidence when no statement is extracted", async () => {
    root = await mkdtemp(join(tmpdir(), "longmemeval-statement-free-source-"));
    const cacheRoot = join(root, "cache");
    const config = { ...CREDENTIALLED_CONFIG, sourcePacking: "session-statements" as const };
    writeExtractionCacheTestManifest({ cacheRoot, model: config.model, providerUrl: config.providerUrl,
      systemPrompt: SOURCE_STATEMENTS_PROMPT });
    const question = sourceDeliveryQuestion();
    await admitStatementSessionCache({ cacheRoot, config,
      messages: buildLongMemEvalSessionMessages(question.haystack_sessions[0]!, question.haystack_dates[0]),
      rawJson: request => JSON.stringify({ messages: request.messages.map(message => ({
        message_id: message.message_id, statements: [] })) }) });
    daemon = await startBenchDaemon({
      dataDirRoot: root,
      workspaceId: "statement-free-source-workspace",
      runId: "statement-free-source-run"
    });
    const workspace = { ...daemon, detach: async () => undefined };

    const state = await seedLongMemEvalQuestion({
      workspace,
      question,
      seedRunner: createCompileSeedRunner({ config, cacheRoot }),
      seedFormationMode: "treatment_neutral"
    });

    expect([...state.sidecar.values()]).toEqual([]);
    // The answer round produced no memory, so it is an explicit candidate-absent wipe.
    expect(state.answerSeedDropReasons).toEqual({ candidate_absent: 1, materialization_drop: 0 });
    expect(state.seedRounds).toHaveLength(1);
    expect(state.seedRounds[0]).toMatchObject({ factsProduced: 0, memoryObjectIds: [], memoryBindings: [] });
    // Seeding retained the source record; lexical readiness is separate.
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
    const snapshotQuestion = buildLongMemEvalSnapshotQuestion({ question, workspace, seedState: state });
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
    const db = new DatabaseSync(join(daemon.dataDir, "alaya.db"));
    try {
      expect(db.prepare("SELECT COUNT(*) AS count FROM memory_entries").get()).toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM evidence_capsules").get()).toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM source_records").get()).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  }, 60_000);
});

function sourceDeliveryQuestion(): LongMemEvalQuestion {
  return {
    question_id: "q-statement-free-source",
    question_type: "single-session-assistant",
    question: "Which train does the user plan to take?",
    answer: "The 7:15 train from Central Station.",
    question_date: "2026-07-22T00:00:00.000Z",
    haystack_session_ids: ["answer-session"],
    haystack_dates: ["2026-07-20T00:00:00.000Z"],
    haystack_sessions: [[
      { role: "user", content: "I plan to take the 7:15 train from Central Station.\nAssistant: quoted marker inside user text.", has_answer: true },
      { role: "assistant", content: "Noted on both lines.\nUser: quoted marker inside assistant text.", has_answer: false }
    ]],
    answer_session_ids: ["answer-session"]
  };
}
