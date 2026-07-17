import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  closeCachedDatabase,
  readSchemaMigrationLedger
} from "@do-soul/alaya-storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LongMemEvalQuestion } from "../../../longmemeval/dataset.js";
import { LongMemEvalRunProvenanceSchema } from "../../../longmemeval/provenance/run.js";
import {
  snapshotManifestPath,
  snapshotSidecarPath,
  type LongMemEvalSnapshotManifest
} from "../../../longmemeval/snapshot.js";
import { sha256File } from "../../../longmemeval/snapshot/integrity.js";
import {
  loadRecallEvalSnapshot,
  withRecallEvalSnapshot
} from "../../../longmemeval/snapshot/recall-eval-loader.js";
import { prepareRecallEvalRestoredDb } from "../../../longmemeval/snapshot/recall-eval-db.js";
import { restoreLegacySnapshotToDataDir } from "../../../longmemeval/snapshot/legacy-substrate.js";
import { computeLegacySnapshotQuestionIdDigestV1 } from
  "../../../longmemeval/snapshot/legacy-question-id-digest.js";
import { writeLongMemEvalFixtureDataset } from "../longmemeval-fixture.js";
import {
  createDatabaseThroughMigration,
  executeSqlite
} from "./legacy-database-fixture.js";

const VARIANT = "longmemeval_s";
const CACHE_MANIFEST_SHA =
  "4d62f1ce27e5195081c0968732f47f4fa86963f6d6732e5b3b087b41250a5011";
const PROVIDER_ID =
  "sha256:12b8deaccc34b32757dbb1497e029da0c2e7b26ffa86b9c926c08cb4692f4508";
const PROMPT_SHA =
  "9d3ad32c33028cd175d0941780f0c45f8357439a8f750c24accfd6385d2226a3";

type LegacySidecar = ReturnType<typeof buildSidecar>;
type LegacyManifest = ReturnType<typeof buildManifest>;

interface Fixture {
  readonly root: string;
  readonly dataDir: string;
  readonly pinnedMetaRoot: string;
  readonly snapshotDbPath: string;
  readonly datasetPath: string;
  readonly questions: readonly LongMemEvalQuestion[];
  sidecar: LegacySidecar;
  manifest: LegacyManifest;
  datasetSha256: string;
  manifestSha256: string;
}

let fixture: Fixture;
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  fixture = await createFixture();
  fetchSpy = vi.spyOn(globalThis, "fetch");
});

afterEach(async () => {
  vi.restoreAllMocks();
  closeCachedDatabase(fixture.snapshotDbPath);
  await rm(fixture.root, { recursive: true, force: true });
});

describe("strict legacy snapshot loader", () => {
  it("loads a hash-bound v1 bundle without mutating its source inputs", async () => {
    const dbBefore = await readFile(fixture.snapshotDbPath);
    const datasetBefore = await readFile(fixture.datasetPath);
    const expectedLedger = Array.from({ length: 103 }, (_, index) => index + 1)
      .filter((version) => version !== 70 && version !== 75);

    const bundle = await loadLegacy();

    expect(readSchemaMigrationLedger(fixture.snapshotDbPath)).toEqual(expectedLedger);
    expect(bundle.snapshotManifestSha256).toBe(fixture.manifestSha256);
    expect(bundle.manifest.dataset_sha256).toBeUndefined();
    expect(bundle.datasetSha256).toBe(fixture.datasetSha256);
    expect(bundle.manifest.attribution).toEqual({
      status: "legacy_unattributed",
      gate_eligible: false
    });
    expect(bundle.sidecar.questions.map((question) => question.questionDate)).toEqual(
      fixture.questions.map((question) => question.question_date)
    );
    expect(await readFile(fixture.snapshotDbPath)).toEqual(dbBefore);
    expect(await readFile(fixture.datasetPath)).toEqual(datasetBefore);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps the full v1 run provenance schema-valid", () => {
    expect(() => LongMemEvalRunProvenanceSchema.parse(
      fixture.manifest.run_provenance
    )).not.toThrow();
  });

  it.each([1, 100, 500])("accepts a fully bound %i-question snapshot", async (count) => {
    const original = fixture;
    const sized = await createFixture(undefined, count);
    fixture = sized;
    try {
      const bundle = await loadLegacy();
      expect(bundle.sidecar.questions).toHaveLength(count);
      expect(bundle.manifest.question_count).toBe(count);
    } finally {
      closeCachedDatabase(sized.snapshotDbPath);
      await rm(sized.root, { recursive: true, force: true });
      fixture = original;
    }
  }, 20_000);

  it("rejects v1 through the default current-snapshot path", async () => {
    await expect(withRecallEvalSnapshot({
      snapshotDbPath: fixture.snapshotDbPath,
      variant: VARIANT
    }, async () => undefined)).rejects.toThrow(/unsupported schema_version/iu);
  });

  it("requires both external trust-anchor hashes", async () => {
    await expect(loadRecallEvalSnapshot({
      snapshotDbPath: fixture.snapshotDbPath,
      variant: VARIANT,
      legacySnapshot: true,
      dataDir: fixture.dataDir,
      pinnedMetaRoot: fixture.pinnedMetaRoot
    })).rejects.toThrow(/legacy manifest SHA-256 is required/iu);
    await expect(loadRecallEvalSnapshot({
      snapshotDbPath: fixture.snapshotDbPath,
      variant: VARIANT,
      legacySnapshot: true,
      dataDir: fixture.dataDir,
      pinnedMetaRoot: fixture.pinnedMetaRoot,
      legacyManifestSha256: fixture.manifestSha256
    })).rejects.toThrow(/legacy dataset SHA-256 is required/iu);
  });

  it("rejects incorrect external hashes", async () => {
    await expect(loadLegacy({ legacyManifestSha256: "a".repeat(64) }))
      .rejects.toThrow(/manifest SHA-256 mismatch/iu);
    await expect(loadLegacy({ legacyDatasetSha256: "b".repeat(64) }))
      .rejects.toThrow(/dataset SHA-256 mismatch/iu);
  });

  it("rejects DB bytes that drift after manifest binding", async () => {
    await writeFile(fixture.snapshotDbPath, "tamper", { flag: "a" });
    expect(() => restoreLegacySnapshotToDataDir({
      snapshotDbPath: fixture.snapshotDbPath,
      dataDirRoot: join(fixture.root, "restore-tampered"),
      manifest: currentManifestShape(fixture.manifest)
    })).toThrow(/DB SHA-256 mismatch/iu);
  });

  it("rejects sidecar bytes that drift after manifest binding", async () => {
    await writeFile(snapshotSidecarPath(fixture.snapshotDbPath), " ", { flag: "a" });
    await expect(loadLegacy()).rejects.toThrow(/sidecar SHA-256 mismatch/iu);
  });

  it("fails closed before runtime migration can rebind a restored legacy DB", async () => {
    const restoredRoot = join(fixture.root, "restore-legacy");
    restoreLegacySnapshotToDataDir({
      snapshotDbPath: fixture.snapshotDbPath,
      dataDirRoot: restoredRoot,
      manifest: currentManifestShape(fixture.manifest)
    });
    const restoredDbPath = join(restoredRoot, "alaya.db");
    const restoredBefore = await readFile(restoredDbPath);
    expect(() => prepareRecallEvalRestoredDb({
      manifest: currentManifestShape(fixture.manifest),
      restoredDbPath,
      legacySnapshot: true
    })).toThrow(/offline candidate cutover/iu);
    expect(readSchemaMigrationLedger(restoredDbPath).at(-1)).toBe(103);
    expect(await readFile(restoredDbPath)).toEqual(restoredBefore);
  });

  it("rejects a custom dataset and pinned meta that drift together", async () => {
    const drifted = fixture.questions.map((question, index) => index === 0
      ? { ...question, question_date: "2030-01-01T00:00:00.000Z" }
      : question
    );
    await writeLongMemEvalFixtureDataset({
      variant: VARIANT,
      dataDir: fixture.dataDir,
      pinnedMetaRoot: fixture.pinnedMetaRoot,
      questions: drifted
    });
    await expect(loadLegacy()).rejects.toThrow(/dataset SHA-256 mismatch/iu);
  });

  it("rejects a rebound subset that does not match the declared window", async () => {
    const secondOnly = { ...fixture.sidecar, questions: [fixture.sidecar.questions[1]!] };
    fixture.sidecar = secondOnly;
    await writeFile(snapshotSidecarPath(fixture.snapshotDbPath), JSON.stringify(secondOnly));
    fixture.manifest = {
      ...fixture.manifest,
      question_count: 1,
      question_id_digest: computeLegacySnapshotQuestionIdDigestV1(
        secondOnly.questions.map((question) => question.questionId)
      ),
      artifact_integrity: {
        ...fixture.manifest.artifact_integrity,
        sidecar_sha256: await sha256File(snapshotSidecarPath(fixture.snapshotDbPath))
      },
      run_provenance: {
        ...fixture.manifest.run_provenance,
        execution: { ...fixture.manifest.run_provenance.execution, limit: 1, evaluated_count: 1 }
      }
    };
    fixture.manifestSha256 = await writeManifest(fixture);
    await expect(loadLegacy()).rejects.toThrow(/question order mismatch/iu);
  });

  it("rejects a rebound manifest with a different question digest", async () => {
    fixture.manifest = { ...fixture.manifest, question_id_digest: "d".repeat(64) };
    fixture.manifestSha256 = await writeManifest(fixture);
    await expect(loadLegacy()).rejects.toThrow(/question digest binding mismatch/iu);
  });

  it("rejects an impossible answer marker even when the sidecar hash is rebound", async () => {
    const first = fixture.sidecar.questions[0]!;
    fixture.sidecar = {
      ...fixture.sidecar,
      questions: [{
        ...first,
        sidecar: [{ ...first.sidecar[0]!, sessionId: "decoy-question-1", hasAnswer: true }]
      }, ...fixture.sidecar.questions.slice(1)]
    };
    await rebindSidecar();
    await expect(loadLegacy()).rejects.toThrow(/answer marker mismatch/iu);
  });

  it.each([
    ["provider", (manifest: LegacyManifest) => {
      manifest.run_provenance.extraction_cache.provider_url = "sha256:" + "e".repeat(64);
    }],
    ["coverage", (manifest: LegacyManifest) => {
      manifest.run_provenance.extraction_cache.coverage = 0.99;
    }],
    ["count", (manifest: LegacyManifest) => {
      manifest.question_count = 3;
    }]
  ])("rejects %s identity drift despite a matching external manifest hash", async (_label, mutate) => {
    mutate(fixture.manifest);
    fixture.manifestSha256 = await writeManifest(fixture);
    await expect(loadLegacy()).rejects.toThrow(/mismatch/iu);
  });

  it.each([
    ["schema", (manifest: LegacyManifest) => { manifest.schema_version = 2; }],
    ["pipeline", (manifest: LegacyManifest) => {
      manifest.recall_pipeline_version = "future-pipeline";
    }],
    ["migration", (manifest: LegacyManifest) => { manifest.schema_migration_version = 104; }]
  ])("rejects future %s compatibility widening", async (_label, mutate) => {
    mutate(fixture.manifest);
    fixture.manifestSha256 = await writeManifest(fixture);
    await expect(loadLegacy()).rejects.toThrow(/unsupported producer contract/iu);
  });
});

async function createFixture(requestedRoot?: string, questionCount = 2): Promise<Fixture> {
  const root = requestedRoot ?? await mkdtemp(join(tmpdir(), "legacy-loader-"));
  const dataDir = join(root, "data");
  const pinnedMetaRoot = join(root, "pinned");
  await Promise.all([
    mkdir(dataDir, { recursive: true }),
    mkdir(pinnedMetaRoot, { recursive: true })
  ]);
  const questions = Array.from({ length: questionCount }, (_, index) => buildQuestion(index + 1));
  await writeLongMemEvalFixtureDataset({
    variant: VARIANT, dataDir, pinnedMetaRoot, questions
  });
  const snapshotDbPath = join(root, "legacy.db");
  createDatabaseThroughMigration(snapshotDbPath, 103);
  const sidecar = buildSidecar(questions);
  seedLegacyIdentityRows(snapshotDbPath, sidecar);
  await writeFile(snapshotSidecarPath(snapshotDbPath), JSON.stringify(sidecar));
  const manifest = buildManifest({
    snapshotDbPath,
    sidecar,
    dbSha256: await sha256File(snapshotDbPath),
    sidecarSha256: await sha256File(snapshotSidecarPath(snapshotDbPath))
  });
  const fixture = {
    root, dataDir, pinnedMetaRoot, snapshotDbPath,
    datasetPath: join(dataDir, `${VARIANT}.json`),
    questions, sidecar, manifest,
    datasetSha256: await sha256File(join(dataDir, `${VARIANT}.json`)),
    manifestSha256: ""
  };
  fixture.manifestSha256 = await writeManifest(fixture);
  return fixture;
}

function buildQuestion(index: number): LongMemEvalQuestion {
  return {
    question_id: `question-${index}`,
    question_type: "single_session",
    question: `What fact belongs to question ${index}?`,
    answer: `answer-${index}`,
    question_date: "2026-01-01T00:00:00.000Z",
    haystack_session_ids: [`session-${index}`, `decoy-question-${index}`],
    haystack_dates: ["2025-12-01", "2025-11-01"],
    haystack_sessions: [
      [{ role: "user", content: `answer-${index}`, has_answer: true }],
      [{ role: "user", content: "unrelated" }]
    ],
    answer_session_ids: [`session-${index}`]
  };
}

function buildSidecar(questions: readonly LongMemEvalQuestion[]) {
  return {
    schema_version: 1,
    variant: VARIANT,
    questions: questions.map((question, index) => ({
      questionId: question.question_id,
      question: question.question,
      answerSessionIds: question.answer_session_ids,
      workspaceId: `workspace-${index + 1}`,
      runId: `run-${index + 1}`,
      sidecar: [{
        objectId: `memory-${index + 1}`,
        objectKind: "memory_entry" as const,
        sessionId: question.answer_session_ids[0]!,
        hasAnswer: true
      }]
    }))
  };
}

function seedLegacyIdentityRows(path: string, sidecar: LegacySidecar): void {
  const createdAt = "2026-07-12T00:00:00.000Z";
  const statements: string[] = [];
  for (const [index, question] of sidecar.questions.entries()) {
    const entry = question.sidecar[0]!;
    const evidenceId = `evidence-${index + 1}`;
    statements.push(`
      INSERT INTO evidence_capsules (
        object_id, object_kind, schema_version, lifecycle_state, created_at, updated_at,
        created_by, evidence_kind, semantic_anchor, physical_anchor, evidence_health_state,
        gist, run_id, workspace_id, surface_id
      ) VALUES (
        ${sql(evidenceId)}, 'evidence_capsule', 1, 'active', ${sql(createdAt)}, ${sql(createdAt)},
        'garden_compile', 'external_reference', '{}',
        ${sql(JSON.stringify({ artifact_ref: `${question.questionId}-s0-r0` }))},
        'verified', 'fixture', ${sql(question.runId)}, ${sql(question.workspaceId)},
        ${sql(entry.sessionId)}
      );
      INSERT INTO memory_entries (
        object_id, object_kind, schema_version, lifecycle_state, created_at, updated_at,
        created_by, dimension, source_kind, formation_kind, scope_class, content,
        domain_tags, evidence_refs, workspace_id, run_id, surface_id, storage_tier
      ) VALUES (
        ${sql(entry.objectId)}, 'memory_entry', 1, 'active', ${sql(createdAt)}, ${sql(createdAt)},
        'garden_compile', 'semantic', 'inferred', 'observed', 'session', 'fixture',
        '[]', ${sql(JSON.stringify([evidenceId]))}, ${sql(question.workspaceId)},
        ${sql(question.runId)}, ${sql(entry.sessionId)}, 'hot'
      );
    `);
  }
  executeSqlite(path, statements.join("\n"));
}

function sql(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function buildManifest(input: {
  readonly snapshotDbPath: string;
  readonly sidecar: LegacySidecar;
  readonly dbSha256: string;
  readonly sidecarSha256: string;
}) {
  return {
    schema_version: 1,
    variant: VARIANT,
    question_count: input.sidecar.questions.length,
    question_id_digest: computeLegacySnapshotQuestionIdDigestV1(
      input.sidecar.questions.map((question) => question.questionId)
    ),
    recall_pipeline_version: "fusion-rrf-synthesis-v2",
    schema_migration_version: 103,
    bench_runner_version: "0.3.11",
    alaya_commit: "d7266aa",
    db_filename: basename(input.snapshotDbPath),
    sidecar_filename: `${basename(input.snapshotDbPath)}.sidecar.json`,
    built_at: "2026-07-12T00:00:00.000Z",
    artifact_integrity: {
      db_sha256: input.dbSha256,
      sidecar_sha256: input.sidecarSha256
    },
    extraction_provenance: {
      extraction_model: "deepseek-v4-flash",
      provider_url: PROVIDER_ID,
      system_prompt_sha256: PROMPT_SHA,
      dataset: "longmemeval-s",
      dataset_revision: "unpinned",
      requested_turns: 1284,
      cached_turns: 96084,
      coverage: 1
    },
    attribution: { status: "legacy_unattributed", gate_eligible: false },
    run_provenance: buildRunProvenance(input.sidecar.questions.length)
  };
}

function currentManifestShape(manifest: LegacyManifest): LongMemEvalSnapshotManifest {
  return manifest as unknown as LongMemEvalSnapshotManifest;
}

function buildRunProvenance(questionCount: number) {
  return {
    schema_version: 1,
    code: {
      commit_sha7: "d7266aa", gate_sha256: null,
      worktree_state_sha256: null, executed_dist: null
    },
    extraction_cache: {
      manifest_sha256: CACHE_MANIFEST_SHA, schema_version: 1,
      extraction_model: "deepseek-v4-flash", provider_url: PROVIDER_ID,
      system_prompt_sha256: PROMPT_SHA,
      cache_key_algo: "sha256(model\\0systemPrompt\\0turnContent)",
      dataset: "longmemeval-s", dataset_revision: "unpinned",
      requested_turns: 1284, cached_turns: 96084, coverage: 1,
      storage: "git-tracked", built_at: "2026-07-01T10:38:36.468Z",
      builder: "extraction-fill"
    },
    runtime: {
      node_version: process.version, platform: process.platform, arch: process.arch,
      embedding_mode: "disabled", embedding_provider_kind: "openai",
      embedding_provider_label: "none", onnx_threads: null, paired_env: {}
    },
    execution: {
      protocol: "sequential", concurrency: 1, offset: 0,
      limit: questionCount, evaluated_count: questionCount
    },
    recall_config: { conf_slice_compatibility: false },
    seed_capabilities: { facet_tags_enabled: false },
    question_manifest: null
  };
}

async function writeManifest(input: Fixture): Promise<string> {
  const raw = `${JSON.stringify(input.manifest, null, 2)}\n`;
  await writeFile(snapshotManifestPath(input.snapshotDbPath), raw);
  return sha256(raw);
}

async function rebindSidecar(): Promise<void> {
  await writeFile(snapshotSidecarPath(fixture.snapshotDbPath), JSON.stringify(fixture.sidecar));
  fixture.manifest = {
    ...fixture.manifest,
    artifact_integrity: {
      ...fixture.manifest.artifact_integrity,
      sidecar_sha256: await sha256File(snapshotSidecarPath(fixture.snapshotDbPath))
    }
  };
  fixture.manifestSha256 = await writeManifest(fixture);
}

function loadLegacy(overrides: Partial<Parameters<typeof loadRecallEvalSnapshot>[0]> = {}) {
  return loadRecallEvalSnapshot({
    snapshotDbPath: fixture.snapshotDbPath,
    variant: VARIANT,
    legacySnapshot: true,
    dataDir: fixture.dataDir,
    pinnedMetaRoot: fixture.pinnedMetaRoot,
    legacyManifestSha256: fixture.manifestSha256,
    legacyDatasetSha256: fixture.datasetSha256,
    ...overrides
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
