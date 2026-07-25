import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import {
  buildGardenSourceTurnFallbackReceiptPreimage,
  formatGardenSourceTurnFallbackSourceHash
} from "@do-soul/alaya-protocol";
import {
  startBenchDaemon,
  type BenchDaemonHandle
} from "../../../harness/daemon.js";
import { createCompileSeedRunner } from
  "../../../longmemeval/compile-seed.js";
import type { LongMemEvalQuestion } from
  "../../../longmemeval/ingestion/dataset.js";
import { buildLongMemEvalSnapshotQuestion } from
  "../../../longmemeval/runner/question/runner-question-result.js";
import { seedLongMemEvalQuestion } from
  "../../../longmemeval/runner/question/runner-question-seeding.js";
import {
  RECALL_EVAL_SNAPSHOT_MANIFEST_VERSION,
  type LongMemEvalSnapshotSidecarFile
} from "../../../longmemeval/snapshot/materialize.js";
import { assertSnapshotDatasetSubstrateIdentity } from
  "../../../longmemeval/snapshot/substrate-binding.js";
import { CREDENTIALLED_CONFIG } from
  "../compile-seed/compile-seed-fixture.js";
import { writeExtractionCacheTestManifest } from
  "../extraction/extraction-cache-test-fixture.js";

interface AuthorityFixture {
  readonly dbPath: string;
  readonly question: LongMemEvalQuestion;
  readonly sidecar: LongMemEvalSnapshotSidecarFile;
  readonly evidenceId: string;
  readonly signalId: string;
}

let root: string | undefined;
let fixture: AuthorityFixture;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "source-evidence-authority-base-"));
  fixture = await buildAuthorityFixture(root);
});

afterAll(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

describe("source evidence snapshot authority", () => {
  it("accepts a receipt-bound direct evidence snapshot", () => {
    expect(() => verifyCopy()).not.toThrow();
  });

  it.each([
    ["created_by", "other_producer"],
    ["lifecycle_state", "retired"],
    ["evidence_health_state", "questionable"],
    ["evidence_kind", "inferred"]
  ])("rejects direct evidence with drifted %s", (column, value) => {
    expect(() => verifyCopy((db) => {
      db.prepare(`UPDATE evidence_capsules SET ${column} = ? WHERE object_id = ?`)
        .run(value, fixture.evidenceId);
    })).toThrow(/direct evidence receipt mismatch/iu);
  });

  it("rejects content that differs from its receipt", () => {
    expect(() => verifyCopy((db) => {
      db.prepare("UPDATE evidence_capsules SET excerpt = ? WHERE object_id = ?")
        .run("Assistant: altered source", fixture.evidenceId);
    })).toThrow(/direct evidence receipt mismatch/iu);
  });

  it("rejects a receipt whose digest no longer verifies", () => {
    expect(() => verifyCopy((db) => {
      const row = db.prepare("SELECT raw_payload_json FROM signals WHERE signal_id = ?")
        .get(fixture.signalId) as { raw_payload_json: string };
      const payload = JSON.parse(row.raw_payload_json) as Record<string, unknown>;
      payload.full_turn_content = "Assistant: altered source";
      db.prepare("UPDATE signals SET raw_payload_json = ? WHERE signal_id = ?")
        .run(JSON.stringify(payload), fixture.signalId);
    })).toThrow(/direct evidence receipt mismatch/iu);
  });

  it("rejects digest-valid truncation that does not match canonical content", () => {
    expect(() => verifyCopy((db) => {
      const sourceCorpus = "Assistant: Take the 7:15 train from Central Station";
      const receipt = {
        signal_id: fixture.signalId,
        workspace_id: fixture.sidecar.questions[0]!.workspaceId,
        run_id: fixture.sidecar.questions[0]!.runId,
        surface_id: "answer-session",
        created_at: "2026-07-20T00:00:00.000Z",
        source_observation: {
          observed_at: "2026-07-20T00:00:00.000Z",
          authority: "trusted_host_event" as const,
          source_event_id: fixture.signalId
        },
        source_corpus: sourceCorpus,
        reason: "empty_extraction" as const,
        truncated: true,
        chars_clipped: 2
      };
      const digest = sha256(buildGardenSourceTurnFallbackReceiptPreimage(receipt));
      db.prepare("UPDATE signals SET raw_payload_json = ? WHERE signal_id = ?")
        .run(JSON.stringify({
          full_turn_content: sourceCorpus,
          evidence_preservation: {
            version: 1,
            reason: receipt.reason,
            truncated: true,
            chars_clipped: 2,
            source_receipt_sha256: digest
          }
        }), fixture.signalId);
      db.prepare(`
        UPDATE evidence_capsules
           SET gist = ?, excerpt = ?, source_hash = ?
         WHERE object_id = ?
      `).run(
        sourceCorpus,
        sourceCorpus,
        formatGardenSourceTurnFallbackSourceHash(digest),
        fixture.evidenceId
      );
    })).toThrow(/direct evidence receipt mismatch/iu);
  });

  it("rejects a direct binding without its exact materialization event", () => {
    expect(() => verifyCopy((db) => {
      db.prepare(`
        DELETE FROM event_log
         WHERE entity_id = ?
      `).run(fixture.signalId);
    })).toThrow(/direct evidence materialization mismatch/iu);
  });

  it("rejects an extra unbound direct evidence row", () => {
    expect(() => verifyCopy((db) => {
      db.prepare(`
        INSERT INTO evidence_capsules
        SELECT 'extra-direct', object_kind, schema_version, lifecycle_state,
               created_at, updated_at, created_by, evidence_kind, semantic_anchor,
               event_anchor, physical_anchor, evidence_health_state, gist, excerpt,
               source_hash, run_id, workspace_id, surface_id
          FROM evidence_capsules WHERE object_id = ?
      `).run(fixture.evidenceId);
    })).toThrow(/direct evidence DB closure mismatch/iu);
  });

  it("requires every direct sidecar object to have a seed-round binding", () => {
    const question = fixture.sidecar.questions[0]!;
    const rounds = question.seedRounds!.map((round) => ({
      ...round,
      directEvidenceBindings: undefined
    }));
    const sidecar = withQuestion({ ...question, seedRounds: rounds });

    expect(() => verifyCopy(undefined, sidecar))
      .toThrow(/direct evidence seed binding is incomplete/iu);
  });

  it("rejects a direct evidence id that collides with a memory id", () => {
    const question = fixture.sidecar.questions[0]!;
    const evidenceEntry = question.sidecar[0]!;
    const sidecar = withQuestion({
      ...question,
      sidecar: [
        evidenceEntry,
        {
          ...evidenceEntry,
          objectKind: "memory_entry"
        }
      ]
    });

    expect(() => verifyCopy((db) => {
      db.prepare(`
        INSERT INTO evidence_capsules
        SELECT 'supporting-evidence', object_kind, schema_version, lifecycle_state,
               created_at, updated_at, 'fixture', 'inferred', semantic_anchor,
               event_anchor, '{"artifact_ref":"q-source-evidence-authority-s0-r0"}',
               'questionable', gist, excerpt, NULL, run_id, workspace_id, surface_id
          FROM evidence_capsules WHERE object_id = ?
      `).run(fixture.evidenceId);
      db.prepare(`
        INSERT INTO memory_entries (
          object_id, object_kind, schema_version, lifecycle_state,
          created_at, updated_at, created_by, dimension, scope_class,
          source_kind, formation_kind, domain_tags, content, evidence_refs, run_id,
          workspace_id, surface_id
        ) VALUES (?, 'memory_entry', 1, 'active', ?, ?, 'fixture',
                  'episode', 'project', 'user', 'atomic', '[]',
                  'same id memory', ?, ?, ?, ?)
      `).run(
        fixture.evidenceId,
        "2026-07-20T00:00:00.000Z",
        "2026-07-20T00:00:00.000Z",
        JSON.stringify(["supporting-evidence"]),
        question.runId,
        question.workspaceId,
        evidenceEntry.sessionId
      );
    }, sidecar)).toThrow(/cross-kind object id collision/iu);
  });

  it("does not treat ordinary supporting evidence as an extra direct object", () => {
    expect(() => verifyCopy((db) => {
      db.prepare(`
        INSERT INTO evidence_capsules
        SELECT 'ordinary-evidence', object_kind, schema_version, lifecycle_state,
               created_at, updated_at, 'fixture', 'inferred', semantic_anchor,
               event_anchor, '{"artifact_ref":"ordinary-ref"}',
               'questionable', gist, excerpt, NULL, run_id, workspace_id, surface_id
          FROM evidence_capsules WHERE object_id = ?
      `).run(fixture.evidenceId);
    })).not.toThrow();
  });
});

async function buildAuthorityFixture(baseRoot: string): Promise<AuthorityFixture> {
  const cacheRoot = join(baseRoot, "cache");
  writeExtractionCacheTestManifest({
    cacheRoot,
    model: CREDENTIALLED_CONFIG.model,
    providerUrl: CREDENTIALLED_CONFIG.providerUrl,
    systemPrompt: OFFICIAL_API_SYSTEM_PROMPT
  });
  const daemon = await startBenchDaemon({
    dataDirRoot: baseRoot,
    workspaceId: "source-evidence-authority-workspace",
    runId: "source-evidence-authority-run"
  });
  try {
    return await seedFixture(daemon, cacheRoot);
  } finally {
    await daemon.shutdown();
  }
}

async function seedFixture(
  daemon: BenchDaemonHandle,
  cacheRoot: string
): Promise<AuthorityFixture> {
  const question = sourceEvidenceQuestion();
  const runner = createCompileSeedRunner({
    config: CREDENTIALLED_CONFIG,
    cacheRoot,
    allowLiveExtraction: true,
    extractorFactory: () => ({
      extract: async () => ({ rawJson: "{\"signals\":[]}" })
    })
  });
  const workspace = { ...daemon, detach: async () => undefined };
  const state = await seedLongMemEvalQuestion({
    workspace,
    question,
    seedRunner: runner,
    seedFormationMode: "treatment_neutral"
  });
  const snapshotQuestion = buildLongMemEvalSnapshotQuestion({
    question,
    workspace,
    seedState: state
  });
  const binding = snapshotQuestion.seedRounds?.[0]?.directEvidenceBindings?.[0];
  if (binding === undefined) throw new Error("fixture direct evidence binding missing");
  return {
    dbPath: join(daemon.dataDir, "alaya.db"),
    question,
    sidecar: {
      schema_version: RECALL_EVAL_SNAPSHOT_MANIFEST_VERSION,
      variant: "longmemeval_s",
      questions: [snapshotQuestion]
    },
    evidenceId: binding.evidenceId,
    signalId: binding.signalId
  };
}

function verifyCopy(
  mutate?: (db: DatabaseSync) => void,
  sidecar = fixture.sidecar
): void {
  const copyRoot = mkdtempSync(join(tmpdir(), "source-evidence-authority-copy-"));
  const dbPath = join(copyRoot, "snapshot.db");
  copyFileSync(fixture.dbPath, dbPath);
  const db = new DatabaseSync(dbPath);
  try {
    mutate?.(db);
  } finally {
    db.close();
  }
  try {
    assertSnapshotDatasetSubstrateIdentity({
      dbPath,
      sidecar,
      questions: [fixture.question],
      runtimeIdentity: "sidecar_bound"
    });
  } finally {
    rmSync(copyRoot, { recursive: true, force: true });
  }
}

function withQuestion(
  question: LongMemEvalSnapshotSidecarFile["questions"][number]
): LongMemEvalSnapshotSidecarFile {
  return { ...fixture.sidecar, questions: [question] };
}

function sourceEvidenceQuestion(): LongMemEvalQuestion {
  return {
    question_id: "q-source-evidence-authority",
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

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
