import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SOURCE_STATEMENTS_PROMPT } from "@do-soul/alaya-soul";
import { startBenchDaemon } from "../../../harness/daemon.js";
import { createCompileSeedRunner } from "../../../runs/compile-seed.js";
import { buildLongMemEvalSessionMessages, type LongMemEvalQuestion } from
  "../../../datasets/longmemeval/ingestion/dataset.js";
import { buildLongMemEvalSnapshotQuestion } from
  "../../../datasets/longmemeval/runner/question/runner-question-result.js";
import { seedLongMemEvalQuestion } from
  "../../../datasets/longmemeval/runner/question/runner-question-seeding.js";
import { RECALL_EVAL_SNAPSHOT_MANIFEST_VERSION, type LongMemEvalSnapshotSidecarFile } from
  "../../../runs/snapshot/materialize.js";
import { assertSnapshotDatasetSubstrateIdentity } from "../../../runs/snapshot/substrate-binding.js";
import { admitStatementSessionCache, CREDENTIALLED_CONFIG } from "../compile-seed/compile-seed-fixture.js";
import { writeExtractionCacheTestManifest } from "../extraction/extraction-cache-test-fixture.js";
import { sourceEvidenceQuestion } from "./source-evidence/authority-question-fixture.js";

interface StatementSnapshotFixture {
  readonly dbPath: string;
  readonly question: LongMemEvalQuestion;
  readonly sidecar: LongMemEvalSnapshotSidecarFile;
}

const STATEMENTS = new Map([
  [0, "I plan to take the 7:15 train from Central Station."],
  [2, "I check the platform near the main entrance."]
]);
let root: string | undefined;
let fixture: StatementSnapshotFixture;
const HOOK_TIMEOUT_MS = process.platform === "win32" ? 60_000 : 15_000;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "statement-snapshot-authority-"));
  fixture = await seedStatementSnapshot(root);
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true });
}, HOOK_TIMEOUT_MS);

describe("statement snapshot authority", () => {
  it("accepts a snapshot whose statement memories are bound to their admitted rounds", () => {
    expect(fixture.sidecar.questions[0]!.seedRounds!.flatMap(round => round.memoryObjectIds)).toHaveLength(2);
    expect(() => verifyCopy()).not.toThrow();
  });

  it("rejects a source body changed after statement publication", () => {
    expect(() => verifyCopy((db) => {
      db.prepare("UPDATE source_records SET source_body = source_body || ' altered'").run();
    })).toThrow(/stored source body does not match its digest/u);
  });

  it("rejects a statement observation attached to a different canonical round", () => {
    expect(() => verifyCopy((db) => {
      db.prepare("UPDATE signals SET source_observation_json = json_set(source_observation_json, '$.source_event_id', ?) WHERE interpretation_contract = 'source-statements-v1'")
        .run(`${fixture.question.question_id}-s0-r999`);
    })).toThrow(/evidence round identity mismatch/u);
  });
});

async function seedStatementSnapshot(baseRoot: string): Promise<StatementSnapshotFixture> {
  const question = sourceEvidenceQuestion();
  const cacheRoot = join(baseRoot, "cache");
  const config = { ...CREDENTIALLED_CONFIG, sourcePacking: "session-statements" as const };
  writeExtractionCacheTestManifest({ cacheRoot, model: config.model, providerUrl: config.providerUrl,
    systemPrompt: SOURCE_STATEMENTS_PROMPT });
  const messages = buildLongMemEvalSessionMessages(question.haystack_sessions[0]!, question.haystack_dates[0]);
  await admitStatementSessionCache({ cacheRoot, config, messages, rawJson: request => JSON.stringify({
    messages: request.messages.map(message => {
      const text = STATEMENTS.get(messages.findIndex(source => source.message_id === message.message_id));
      return { message_id: message.message_id, statements: text === undefined ? [] : [{ text, relation: "plan" }] };
    }) }) });
  const daemon = await startBenchDaemon({ dataDirRoot: join(baseRoot, "daemon"),
    workspaceId: "statement-authority-workspace", runId: "statement-authority-run" });
  try {
    const workspace = { ...daemon, detach: async () => undefined };
    const state = await seedLongMemEvalQuestion({ workspace, question,
      seedRunner: createCompileSeedRunner({ config, cacheRoot }), seedFormationMode: "treatment_neutral" });
    return {
      dbPath: join(daemon.dataDir, "alaya.db"),
      question,
      sidecar: { schema_version: RECALL_EVAL_SNAPSHOT_MANIFEST_VERSION, variant: "longmemeval_s",
        questions: [buildLongMemEvalSnapshotQuestion({ question, workspace, seedState: state })] }
    };
  } finally {
    await daemon.shutdown();
  }
}

function verifyCopy(mutate?: (db: DatabaseSync) => void): void {
  const copyRoot = mkdtempSync(join(tmpdir(), "statement-snapshot-authority-copy-"));
  const dbPath = join(copyRoot, "snapshot.db");
  copyFileSync(fixture.dbPath, dbPath);
  const db = new DatabaseSync(dbPath);
  try {
    mutate?.(db);
  } finally {
    db.close();
  }
  try {
    assertSnapshotDatasetSubstrateIdentity({ dbPath, sidecar: fixture.sidecar, questions: [fixture.question],
      runtimeIdentity: "sidecar_bound" });
  } finally {
    rmSync(copyRoot, { recursive: true, force: true });
  }
}
