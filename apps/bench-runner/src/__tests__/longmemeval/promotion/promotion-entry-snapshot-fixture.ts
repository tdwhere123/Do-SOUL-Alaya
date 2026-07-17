import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createLongMemEvalSelectionContractIdentity
} from "@do-soul/alaya-eval";
import { initDatabase, readSchemaMigrationLedger } from "@do-soul/alaya-storage";
import type { LongMemEvalQuestion } from "../../../longmemeval/ingestion/dataset.js";
import type { RecallEvalQuestionResult } from "../../../longmemeval/lifecycle/recall-eval/recall-eval-contract.js";
import {
  isLongMemEvalRunProvenanceGateEligible,
  type LongMemEvalRunProvenance
} from "../../../longmemeval/provenance/run.js";
import type { LongMemEvalSnapshotManifest } from "../../../longmemeval/snapshot/materialize.js";
import { deriveSnapshotAttribution } from "../../../longmemeval/snapshot/attribution.js";
import {
  buildSnapshotExtractionAuthority,
  buildSnapshotExtractionSummary,
  renderSnapshotExtractionAuthority
} from "../../../longmemeval/snapshot/extraction-authority.js";
import { compactSnapshotRunProvenance } from "../../../longmemeval/snapshot/run-provenance.js";
import { buildLongMemEvalQuestionRuntimeIdentity } from "../../../longmemeval/selection/question-runtime-identity.js";
import { RECALL_PIPELINE_VERSION } from "../../../shared/version.js";
import { promotionGoldId } from
  "../recall-eval/specialized-answerable-recall-fixture.js";
import {
  COMMIT_SHA7,
  DATASET_SHA,
  promotionSignalId,
  requireV3Cache,
  seedExtractionPath,
  seedRoundsForQuestion,
  sha256,
  type SnapshotFixtureOptions
} from "./promotion-entry-primitives-fixture.js";

async function writeSnapshotFixture(
  root: string,
  collected: readonly RecallEvalQuestionResult[],
  selection: ReturnType<typeof createLongMemEvalSelectionContractIdentity>,
  provenance: LongMemEvalRunProvenance,
  questions: readonly LongMemEvalQuestion[],
  options: SnapshotFixtureOptions
) {
  const dbPath = path.join(root, "snapshot.db");
  seedSnapshotDatabase(dbPath, questions);
  const db = await readFile(dbPath);
  const schemaMigrationVersion = readSchemaMigrationLedger(dbPath).at(-1)!;
  const sidecar = {
    schema_version: 2,
    variant: "longmemeval_s",
    questions: questions.map((question) => {
      const runtime = buildLongMemEvalQuestionRuntimeIdentity(question.question_id);
      const sessionId = question.answer_session_ids[0]!;
      const seedRounds = seedRoundsForQuestion(question);
      return {
        questionId: question.question_id,
        question: question.question,
        questionDate: question.question_date,
        answerSessionIds: [sessionId],
        sidecar: [{
          objectId: promotionGoldId(question.question_id),
          objectKind: "memory_entry" as const,
          sessionId,
          hasAnswer: true,
          sourceRounds: seedRounds
            .filter((round) => round.memoryObjectIds.includes(promotionGoldId(question.question_id)))
            .map(({ sessionIndex, roundIndex, sessionId: sourceSessionId, hasAnswer }) => ({
              sessionIndex,
              roundIndex,
              sessionId: sourceSessionId,
              hasAnswer
            }))
        }],
        seedRounds,
        workspaceId: runtime.workspaceId,
        runId: runtime.runId
      };
    })
  };
  tamperCanonicalSidecar(sidecar, options.tamperCanonical);
  tamperSeedLedger(sidecar, options.tamperSeedLedger);
  const duplicate = options.duplicateObject;
  if (duplicate !== undefined) {
    const original = sidecar.questions[0]!.sidecar[0]!;
    sidecar.questions[0]!.sidecar.push(duplicate === "exact"
      ? { ...original }
      : { ...original, sessionId: "conflicting-session", hasAnswer: false });
  }
  const sidecarContents = `${JSON.stringify(sidecar, null, 2)}\n`;
  const cache = requireV3Cache(provenance);
  const { manifest_sha256: sourceManifestSha256, ...sourceManifest } = cache;
  const extraction = buildSnapshotExtractionSummary(
    sourceManifest,
    sourceManifestSha256
  );
  const extractionAuthority = buildSnapshotExtractionAuthority(
    sourceManifest,
    sourceManifestSha256,
    extraction
  );
  const authorityContents = renderSnapshotExtractionAuthority(extractionAuthority);
  const compactRunProvenance = compactSnapshotRunProvenance(provenance);
  const manifest = {
    schema_version: 2,
    variant: "longmemeval_s",
    question_count: collected.length,
    recall_pipeline_version: options.recallPipelineVersion ?? RECALL_PIPELINE_VERSION,
    schema_migration_version: schemaMigrationVersion + (options.schemaMigrationOffset ?? 0),
    bench_runner_version: "0.3.11",
    alaya_commit: COMMIT_SHA7,
    db_filename: "snapshot.db",
    sidecar_filename: "snapshot.db.sidecar.json",
    built_at: "2026-07-16T00:00:00.000Z",
    extraction_provenance: extraction,
    seed_extraction_path: {
      ...seedExtractionPath(),
      facts_produced: seedExtractionPath().facts_produced +
        (options.seedFactsProducedOffset ?? 0)
    },
    artifact_integrity: {
      db_sha256: sha256(db),
      sidecar_sha256: sha256(sidecarContents),
      extraction_authority_filename: "snapshot.db.extraction-authority.json",
      extraction_authority_sha256: sha256(authorityContents),
      extraction_authority_bytes: authorityContents.byteLength
    },
    run_provenance: compactRunProvenance,
    question_id_digest: selection.selected_id_digest,
    dataset_sha256: DATASET_SHA,
    attribution: {
      status: "attributed",
      gate_eligible: options.storedGateEligible ?? true
    }
  } satisfies LongMemEvalSnapshotManifest;
  const derived = deriveSnapshotAttribution({
    artifactIntegrity: manifest.artifact_integrity,
    runProvenance: compactRunProvenance,
    questionIdDigest: manifest.question_id_digest,
    datasetSha256: manifest.dataset_sha256,
    seedExtractionPath: manifest.seed_extraction_path,
    extractionProvenance: manifest.extraction_provenance
  });
  if (!isLongMemEvalRunProvenanceGateEligible(provenance) ||
      derived.gate_eligible !== true) {
    throw new Error(
      `invalid promotion snapshot fixture: run=${isLongMemEvalRunProvenanceGateEligible(provenance)} ` +
      `snapshot=${derived.gate_eligible}`
    );
  }
  const manifestContents = `${JSON.stringify(manifest, null, 2)}\n`;
  await Promise.all([
    writeFile(`${dbPath}.sidecar.json`, sidecarContents),
    writeFile(`${dbPath}.manifest.json`, manifestContents),
    writeFile(`${dbPath}.extraction-authority.json`, authorityContents)
  ]);
  return { manifest, manifestSha256: sha256(manifestContents), schemaMigrationVersion };
}


function seedSnapshotDatabase(
  dbPath: string,
  questions: readonly LongMemEvalQuestion[]
): void {
  const database = initDatabase({ filename: dbPath });
  try {
    for (const question of questions) seedSnapshotQuestion(database, question);
  } finally {
    database.close();
  }
}

function seedSnapshotQuestion(
  database: ReturnType<typeof initDatabase>,
  question: LongMemEvalQuestion
): void {
  const runtime = buildLongMemEvalQuestionRuntimeIdentity(question.question_id);
  const sessionId = question.answer_session_ids[0]!;
  const evidenceId = `${question.question_id}-evidence`;
  const createdAt = "2026-07-16T00:00:00.000Z";
  database.connection.prepare(`
    INSERT OR IGNORE INTO workspaces (
      workspace_id, name, root_path, workspace_kind, workspace_state, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(runtime.workspaceId, "fixture", "/fixture", "project", "active", createdAt);
  database.connection.prepare(`
    INSERT OR IGNORE INTO runs (
      run_id, workspace_id, title, run_mode, run_state, created_at, last_active_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    runtime.runId, runtime.workspaceId, "fixture", "bench", "idle", createdAt, createdAt
  );
  database.connection.prepare(`
    INSERT INTO signals (
      signal_id, workspace_id, run_id, surface_id, source, signal_kind,
      object_kind, scope_hint, domain_tags_json, confidence, evidence_refs_json,
      raw_payload_json, signal_state, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    promotionSignalId(question.question_id), runtime.workspaceId, runtime.runId,
    sessionId, "garden_compile", "potential_preference", "fact", "project",
    "[]", 0.9, JSON.stringify([`${question.question_id}-s0-r0`]),
    JSON.stringify({ distilled_fact: "fixture" }),
    "materialized", createdAt
  );
  database.connection.prepare(`
    INSERT INTO evidence_capsules (
      object_id, object_kind, schema_version, lifecycle_state, created_at, updated_at,
      created_by, evidence_kind, semantic_anchor, physical_anchor, evidence_health_state,
      gist, run_id, workspace_id, surface_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    evidenceId, "evidence_capsule", 1, "active", createdAt, createdAt,
    "garden_compile", "external_reference", "{}",
    JSON.stringify({ artifact_ref: `${question.question_id}-s0-r0` }),
    "verified", "fixture", runtime.runId, runtime.workspaceId, sessionId
  );
  database.connection.prepare(`
    INSERT INTO memory_entries (
      object_id, object_kind, schema_version, lifecycle_state, created_at, updated_at,
      created_by, dimension, source_kind, formation_kind, scope_class, content,
      domain_tags, evidence_refs, workspace_id, run_id, surface_id, storage_tier
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    promotionGoldId(question.question_id), "memory_entry", 1, "active", createdAt,
    createdAt, "garden_compile", "semantic", "inferred", "observed", "session",
    "fixture", "[]", JSON.stringify([evidenceId]), runtime.workspaceId, runtime.runId,
    sessionId, "hot"
  );
  database.connection.prepare(`
    INSERT INTO event_log (
      event_id, event_type, entity_type, entity_id, workspace_id, run_id,
      caused_by, revision, payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `${question.question_id}-materialized-event`,
    "soul.signal.materialized",
    "candidate_memory_signal",
    promotionSignalId(question.question_id),
    runtime.workspaceId,
    runtime.runId,
    "materialization_router",
    0,
    JSON.stringify({
      signal_id: promotionSignalId(question.question_id),
      workspace_id: runtime.workspaceId,
      run_id: runtime.runId,
      created_objects: [
        { object_kind: "evidence_capsule", object_id: evidenceId },
        { object_kind: "memory_entry", object_id: promotionGoldId(question.question_id) }
      ],
      success: true
    }),
    createdAt
  );
}

function tamperCanonicalSidecar(
  sidecar: {
    questions: Array<{
      question: string;
      questionDate: string;
      answerSessionIds: string[];
      sidecar: Array<{ sessionId: string; hasAnswer: boolean }>;
    }>;
  },
  tamper: SnapshotFixtureOptions["tamperCanonical"]
): void {
  if (tamper === undefined) return;
  const question = sidecar.questions[0]!;
  if (tamper === "question") question.question = "forged question";
  if (tamper === "question_date") question.questionDate = "2026-07-17T00:00:00.000Z";
  if (tamper === "answer_sessions") question.answerSessionIds = [];
  if (tamper === "sidecar_session") question.sidecar[0]!.sessionId = "forged-session";
  if (tamper === "has_answer") question.sidecar[0]!.hasAnswer = false;
  if (tamper === "omit_distractor_round") {
    (question as { seedRounds?: unknown[] }).seedRounds?.pop();
  }
}

function tamperSeedLedger(
  sidecar: { questions: Array<{ seedRounds: ReturnType<typeof seedRoundsForQuestion> }> },
  tamper: SnapshotFixtureOptions["tamperSeedLedger"]
): void {
  if (tamper === undefined) return;
  const round = sidecar.questions[0]!.seedRounds[0]! as {
    extractionSource: "cache" | "live";
    rawJsonSha256: string;
    rawSignalCount: number;
    draftCount: number;
    parseDropped: number;
    compileOverflowDropped: number;
    memoryObjectIds: string[];
  };
  if (tamper === "source") round.extractionSource = "live";
  if (tamper === "raw_digest") round.rawJsonSha256 = "f".repeat(64);
  if (tamper === "raw_count") {
    round.rawSignalCount += 1;
    round.parseDropped += 1;
  }
  if (tamper === "draft_count") {
    round.rawSignalCount += 1;
    round.draftCount += 1;
    round.compileOverflowDropped += 1;
  }
  if (tamper === "memory_ids") round.memoryObjectIds = [];
}


export { writeSnapshotFixture };
