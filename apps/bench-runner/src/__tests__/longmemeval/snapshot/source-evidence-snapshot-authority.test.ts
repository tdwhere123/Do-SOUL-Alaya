import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import type { SeedExtractionPath } from "@do-soul/alaya-eval";
import {
  buildGardenSourceTurnFallbackReceiptPreimage,
  formatGardenSourceTurnFallbackArtifactRef,
  formatGardenSourceTurnFallbackSourceHash
} from "@do-soul/alaya-protocol";
import {
  startBenchDaemon,
  type BenchDaemonHandle
} from "../../../harness/daemon.js";
import { createCompileSeedRunner } from
  "../../../longmemeval/compile-seed.js";
import {
  computeExtractionContentClosureSha256,
  computeExtractionKeySetSha256
} from "../../../longmemeval/compile-seed/compile-seed-cache.js";
import {
  EXTRACTION_CACHE_KEY_ALGO,
  EXTRACTION_CACHE_MANIFEST_VERSION,
  type ExtractionCacheManifestV3,
  writeExtractionCacheManifest
} from "../../../longmemeval/extraction/cache/extraction-cache-manifest.js";
import type { LongMemEvalQuestion } from
  "../../../longmemeval/ingestion/dataset.js";
import { inspectTurnContentKeySpace } from
  "../../../longmemeval/extraction/turn-contents.js";
import { buildLongMemEvalSnapshotQuestion } from
  "../../../longmemeval/runner/question/runner-question-result.js";
import { seedLongMemEvalQuestion } from
  "../../../longmemeval/runner/question/runner-question-seeding.js";
import {
  RECALL_EVAL_SNAPSHOT_MANIFEST_VERSION,
  type LongMemEvalSnapshotSeedRound,
  type LongMemEvalSnapshotSidecarFile
} from "../../../longmemeval/snapshot/materialize.js";
import { captureSnapshotExtractionAuthority } from
  "../../../longmemeval/snapshot/extraction-authority.js";
import { assertSnapshotSeedLedgerBinding } from
  "../../../longmemeval/snapshot/seed-ledger/seed-ledger-binding.js";
import { assertSnapshotDatasetSubstrateIdentity } from "../../../longmemeval/snapshot/substrate-binding.js";
import {
  CREDENTIALLED_CONFIG,
  signalsEnvelope
} from "../compile-seed/compile-seed-fixture.js";
import { writeExtractionCacheTestManifest } from "../extraction/extraction-cache-test-fixture.js";
import {
  SOURCE_EVIDENCE_USER_CONTENT,
  sourceEvidenceCorpus,
  sourceEvidenceQuestion
} from "./source-evidence/authority-question-fixture.js";

interface AuthorityFixture {
  readonly dbPath: string;
  readonly question: LongMemEvalQuestion;
  readonly sidecar: LongMemEvalSnapshotSidecarFile;
  readonly evidenceId: string;
  readonly signalId: string;
  readonly extraction: ReturnType<typeof captureSnapshotExtractionAuthority>;
}
type SeededAuthorityFixture = Omit<AuthorityFixture, "extraction">;
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

  it("does not count receipt-bound direct answer evidence as an empty wipe", () => {
    const rounds = fixture.sidecar.questions[0]!.seedRounds!;
    expect(() => assertSnapshotSeedLedgerBinding({
      dbPath: fixture.dbPath,
      sidecar: fixture.sidecar,
      questions: [fixture.question],
      extraction: fixture.extraction.compact,
      extractionAuthority: fixture.extraction.authority,
      seedExtractionPath: seedExtractionPath(rounds),
      closureAuthority: {
        kind: "exact",
        questionWindow: { offset: 0, limit: 1 }
      }
    })).not.toThrow();
  });

  it("rejects a receipt anchor bound to a different source round", () => {
    expect(() => verifyCopy((db) => {
      db.prepare("UPDATE evidence_capsules SET physical_anchor = ? WHERE object_id = ?")
        .run(JSON.stringify({
          artifact_ref: formatGardenSourceTurnFallbackArtifactRef(
            "q-source-evidence-authority-s0-r1"
          )
        }), fixture.evidenceId);
    })).toThrow(/evidence_capsule source round mismatch/iu);
  });

  it("rejects a reserved receipt anchor without its source hash", () => {
    expect(() => verifyCopy((db) => {
      db.prepare("UPDATE evidence_capsules SET source_hash = NULL WHERE object_id = ?")
        .run(fixture.evidenceId);
    })).toThrow(/direct evidence DB closure mismatch|legacy sidecar evidence round identity mismatch/iu);
  });

  it("rejects a v2 receipt paired with a v1 source-hash version", () => {
    expect(() => verifyCopy((db) => {
      db.prepare("UPDATE evidence_capsules SET source_hash = REPLACE(source_hash, '-v2:', '-v1:') WHERE object_id = ?")
        .run(fixture.evidenceId);
    })).toThrow(/direct evidence receipt mismatch/iu);
  });

  it.each([
    ["created_by", "other_producer"],
    ["lifecycle_state", "retired"],
    ["evidence_health_state", "questionable"],
    ["evidence_kind", "inferred"],
    ["gist", SOURCE_EVIDENCE_USER_CONTENT]
  ])("rejects direct evidence with drifted %s", (column, value) => {
    expect(() => verifyCopy((db) => {
      db.prepare(`UPDATE evidence_capsules SET ${column} = ? WHERE object_id = ?`)
        .run(value, fixture.evidenceId);
    })).toThrow(/direct evidence receipt mismatch/iu);
  });

  it("rejects the full receipt corpus as the v2 excerpt", () => {
    expect(() => verifyCopy((db) => {
      db.prepare("UPDATE evidence_capsules SET excerpt = ? WHERE object_id = ?")
        .run(sourceEvidenceCorpus(), fixture.evidenceId);
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

  it("rejects a legacy v1 receipt from the current snapshot authority", () => {
    expect(() => verifyCopy((db) => {
      const canonical = sourceEvidenceCorpus();
      const sourceCorpus = canonical.slice(0, canonical.length - 2);
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
        ...question.sidecar,
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
  const fillDaemon = await startBenchDaemon({
    dataDirRoot: join(baseRoot, "fill"),
    workspaceId: "source-evidence-fill-workspace",
    runId: "source-evidence-fill-run"
  });
  try {
    const fill = await seedFixture(fillDaemon, cacheRoot, true);
    writeCompleteManifest(cacheRoot, fill.sidecar.questions[0]!.seedRounds!);
  } finally {
    await fillDaemon.shutdown();
  }
  const authorityDaemon = await startBenchDaemon({
    dataDirRoot: join(baseRoot, "authority"),
    workspaceId: "source-evidence-authority-workspace",
    runId: "source-evidence-authority-run"
  });
  try {
    return {
      ...await seedFixture(authorityDaemon, cacheRoot, false),
      extraction: captureSnapshotExtractionAuthority(cacheRoot)
    };
  } finally {
    await authorityDaemon.shutdown();
  }
}

async function seedFixture(
  daemon: BenchDaemonHandle,
  cacheRoot: string,
  allowLiveExtraction: boolean
): Promise<SeededAuthorityFixture> {
  const question = sourceEvidenceQuestion();
  const keySpace = inspectTurnContentKeySpace([question]);
  const runner = createCompileSeedRunner({
    config: CREDENTIALLED_CONFIG,
    cacheRoot,
    allowLiveExtraction,
    requiredTurnContents: keySpace.distinctTurnContents,
    requiredExtractionTurns: keySpace.distinctExtractionTurns,
    requiredQuestionWindow: { offset: 0, limit: 1 },
    extractorFactory: () => ({
      extract: async () => ({
        rawJson: signalsEnvelope([{
          matched: "I check the platform near the main entrance.",
          distilled: "The user checks the platform near the main entrance."
        }])
      })
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

function writeCompleteManifest(
  cacheRoot: string, rounds: readonly LongMemEvalSnapshotSeedRound[]
): void {
  const entries = rounds.map((round) => ({
    cacheKey: round.cacheKey!,
    rawJsonSha256: round.rawJsonSha256!,
    rawSignalCount: round.rawSignalCount!,
    parsedDraftCount: round.draftCount!
  })).sort((left, right) => left.cacheKey.localeCompare(right.cacheKey));
  const manifest: ExtractionCacheManifestV3 = {
    schema_version: EXTRACTION_CACHE_MANIFEST_VERSION,
    extraction_model: CREDENTIALLED_CONFIG.model,
    model_family: CREDENTIALLED_CONFIG.model,
    request_profile: CREDENTIALLED_CONFIG.requestProfile,
    provider_url: CREDENTIALLED_CONFIG.providerUrl,
    system_prompt_sha256: sha256(OFFICIAL_API_SYSTEM_PROMPT),
    cache_key_algo: EXTRACTION_CACHE_KEY_ALGO,
    dataset: "test-fixture",
    dataset_revision: "b".repeat(64),
    requested_turns: entries.length,
    cached_turns: entries.length,
    coverage: 1,
    fill_status: "complete",
    window_offset: 0,
    window_limit: 1,
    expected_turns: entries.length,
    expected_key_set_sha256: computeExtractionKeySetSha256(entries.map((entry) => entry.cacheKey)),
    content_closure_sha256: computeExtractionContentClosureSha256(entries.map((entry) => ({
      ...entry,
      model: CREDENTIALLED_CONFIG.model,
      requestProfile: CREDENTIALLED_CONFIG.requestProfile
    }))),
    content_closure_index: Object.fromEntries(entries.map((entry) => [
      entry.cacheKey,
      [entry.rawJsonSha256, entry.rawSignalCount, entry.parsedDraftCount] as const
    ])),
    storage: "git-tracked",
    built_at: "2026-07-26T00:00:00.000Z",
    builder: "test"
  };
  writeExtractionCacheManifest(cacheRoot, manifest);
}

function seedExtractionPath(rounds: readonly LongMemEvalSnapshotSeedRound[]): SeedExtractionPath {
  const sum = (value: (round: LongMemEvalSnapshotSeedRound) => number) =>
    rounds.reduce((total, round) => total + value(round), 0);
  const candidateAbsent = sum((round) => round.candidateAbsent);
  const materializationDrop = sum((round) => round.materializationDrop);
  return {
    path: "official_api_compile",
    extraction_attempts: rounds.length,
    cache_hits: rounds.length,
    llm_calls: 0,
    offline_fallbacks: 0,
    live_extraction_failures: 0,
    cached_extraction_failures: 0,
    facts_produced: sum((round) => round.factsProduced),
    signals_dropped: sum((round) => round.parseDropped + round.compileOverflowDropped) +
      candidateAbsent + materializationDrop,
    parse_dropped: sum((round) => round.parseDropped),
    compile_overflow_dropped: sum((round) => round.compileOverflowDropped),
    signals_dropped_by_reason: {
      candidate_absent: candidateAbsent,
      materialization_drop: materializationDrop
    }
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

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
