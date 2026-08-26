import { createHash } from "node:crypto";
import {
  FACTOR_INCIDENCE_OPERATOR_ID,
  MemoryDimension,
  RunMode,
  RunState,
  ScopeClass,
  SOURCE_SPAN_IDENTITY_OPERATOR_ID,
  WorkspaceKind,
  WorkspaceState,
  hashAddressableSourceSpanId,
  hashContentDigest,
  hashFactorId,
  hashIncidenceId,
  hashSourceRecordId,
  type FieldContractSha256
} from "@do-soul/alaya-protocol";
import {
  initDatabase,
  SqliteMemoryEntryRepo,
  SqliteRunRepo,
  SqliteWorkspaceRepo,
  writeEmbeddingOverlayBind
} from "@do-soul/alaya-storage";
import BetterSqlite3 from "better-sqlite3";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createOverlaySchema } from "../../../bench/snapshot/recall-eval/embedding-cache-overlay/overlay-schema.js";

export const WORKSPACE_A = "workspace-a";
export const WORKSPACE_B = "workspace-b";
export const TOKEN_A = "zyxalphauniqtoken";
export const TOKEN_B = "zyxbetauniqtoken";
export const MEMORY_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const MEMORY_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const EVIDENCE_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
export const EVIDENCE_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const CLOCK = "2026-08-10T00:00:00.000Z";
const fieldSha256: FieldContractSha256 = (preimage) =>
  createHash("sha256").update(preimage, "utf8").digest("hex");

const PLANTED_PACKED_PROJECTION_DIGEST = "c".repeat(64);

export async function createPackedTwoWorkspaceDb(path: string): Promise<void> {
  const database = initDatabase({ filename: path });
  await seedHaystack(database, {
    workspaceId: WORKSPACE_A,
    runId: "run-a",
    memoryId: MEMORY_A,
    evidenceId: EVIDENCE_A,
    token: TOKEN_A
  });
  await seedHaystack(database, {
    workspaceId: WORKSPACE_B,
    runId: "run-b",
    memoryId: MEMORY_B,
    evidenceId: EVIDENCE_B,
    token: TOKEN_B
  });
  database.close();
}

// Packed receipts stay corpus-wide; each slice keeps only one workspace's
// relation_path_projections. The runtime gate compares those two numbers.
export function plantPackedPathProjections(path: string): void {
  const database = initDatabase({ filename: path });
  try {
    const generation = readActiveProjectionGeneration(database);
    plantOneWorkspaceProjection(database, generation, WORKSPACE_A, "path-a");
    plantOneWorkspaceProjection(database, generation, WORKSPACE_B, "path-b");
    database.connection.prepare(`
      UPDATE temporal_projection_generations
      SET projection_count = 2, projection_digest = ?
      WHERE generation = ?
    `).run(PLANTED_PACKED_PROJECTION_DIGEST, generation);
    database.connection.prepare(`
      UPDATE temporal_schema_state
      SET projection_count = 2, projection_digest = ?
      WHERE state_id = 1
    `).run(PLANTED_PACKED_PROJECTION_DIGEST);
  } finally {
    database.close();
  }
}

function readActiveProjectionGeneration(
  database: ReturnType<typeof initDatabase>
): string {
  const row = database.connection.prepare(`
    SELECT active_projection_generation AS generation
    FROM temporal_schema_state
    WHERE state_id = 1
  `).get() as { readonly generation: string | null } | undefined;
  if (row?.generation === undefined || row.generation === null || row.generation.length === 0) {
    throw new Error("planted packed db is missing an active temporal projection generation");
  }
  return row.generation;
}

function plantOneWorkspaceProjection(
  database: ReturnType<typeof initDatabase>,
  generation: string,
  workspaceId: string,
  pathId: string
): void {
  database.connection.prepare(`
    INSERT INTO relation_assertions (
      assertion_id, workspace_id, admission_event_id, identity_key,
      anchors_json, relation_kind, validity_json, formation_receipt_json, admitted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `assertion-${pathId}`,
    workspaceId,
    `admission-${pathId}`,
    `identity-${pathId}`,
    "[]",
    "related_to",
    JSON.stringify({ kind: "open", valid_from: CLOCK }),
    "{}",
    CLOCK
  );
  database.connection.prepare(`
    INSERT INTO relation_path_projections (
      generation, path_id, assertion_id, workspace_id, projection_json
    ) VALUES (?, ?, ?, ?, ?)
  `).run(
    generation,
    pathId,
    `assertion-${pathId}`,
    workspaceId,
    JSON.stringify({ path_id: pathId, workspace_id: workspaceId })
  );
}

export function writeOverlayBindBeside(dbPath: string, overlaySha256: string): string {
  const overlayFilename = `.embedding-cache-overlay-${overlaySha256}.sqlite`;
  const overlayPath = join(dirname(dbPath), overlayFilename);
  writeFileSync(overlayPath, "overlay-sidecar\n");
  writeEmbeddingOverlayBind({
    databaseFilename: dbPath,
    overlayFilename,
    overlaySha256
  });
  return overlayPath;
}

export function writeRealMemoryOverlayBeside(
  dbPath: string,
  objectId: string,
  workspaceId: string
): string {
  const overlayFilename = "overlay.sqlite";
  const overlayPath = join(dirname(dbPath), overlayFilename);
  const overlay = new BetterSqlite3(overlayPath);
  try {
    createOverlaySchema(overlay);
    overlay.prepare(`
      INSERT INTO memory_embeddings (
        object_id, workspace_id, content_hash, provider_kind, model_id,
        schema_version, dimensions, embedding_blob, vector_valid, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      objectId,
      workspaceId,
      "sha256:memory",
      "local_onnx",
      "fixture-model",
      1,
      2,
      encodeVector(new Float32Array([1, 2])),
      CLOCK,
      CLOCK
    );
  } finally {
    overlay.close();
  }
  writeEmbeddingOverlayBind({
    databaseFilename: dbPath,
    overlayFilename,
    overlaySha256: createHash("sha256").update(readFileSync(overlayPath)).digest("hex")
  });
  return overlayPath;
}

function encodeVector(vector: Float32Array): Buffer {
  const bytes = Buffer.alloc(vector.length * Float32Array.BYTES_PER_ELEMENT);
  vector.forEach((value, index) => bytes.writeFloatLE(
    value, index * Float32Array.BYTES_PER_ELEMENT
  ));
  return bytes;
}

async function seedHaystack(
  database: ReturnType<typeof initDatabase>,
  input: {
    readonly workspaceId: string;
    readonly runId: string;
    readonly memoryId: string;
    readonly evidenceId: string;
    readonly token: string;
  }
): Promise<void> {
  await seedWorkspaceAndRun(database, input.workspaceId, input.runId);
  await seedMemory(database, input);
  insertEvidence(database, input);
  insertIncidence(database, input.workspaceId, input.token);
}

async function seedWorkspaceAndRun(
  database: ReturnType<typeof initDatabase>,
  workspaceId: string,
  runId: string
): Promise<void> {
  await new SqliteWorkspaceRepo(database).create({
    workspace_id: workspaceId,
    name: workspaceId,
    root_path: `/tmp/${workspaceId}`,
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    default_engine_class: "conversation_engine",
    workspace_state: WorkspaceState.ACTIVE
  });
  await new SqliteRunRepo(database).create({
    run_id: runId,
    workspace_id: workspaceId,
    title: workspaceId,
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });
}

async function seedMemory(
  database: ReturnType<typeof initDatabase>,
  input: {
    readonly workspaceId: string;
    readonly runId: string;
    readonly memoryId: string;
    readonly token: string;
  }
): Promise<void> {
  await new SqliteMemoryEntryRepo(database).create({
    object_id: input.memoryId,
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: CLOCK,
    updated_at: CLOCK,
    created_by: "workspace-slice-test",
    dimension: MemoryDimension.FACT,
    source_kind: "user",
    formation_kind: "explicit",
    scope_class: ScopeClass.PROJECT,
    content: `Planted memory ${input.token}`,
    domain_tags: [],
    evidence_refs: [],
    workspace_id: input.workspaceId,
    run_id: input.runId,
    surface_id: null,
    storage_tier: "hot",
    activation_score: 0.5,
    retention_score: null,
    manifestation_state: null,
    retention_state: null,
    decay_profile: null,
    confidence: null,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: null,
    contradiction_count: null,
    superseded_by: null
  });
}

function insertEvidence(
  database: ReturnType<typeof initDatabase>,
  input: {
    readonly workspaceId: string;
    readonly runId: string;
    readonly evidenceId: string;
    readonly token: string;
  }
): void {
  database.connection.prepare(`
    INSERT INTO evidence_capsules (
      object_id, created_at, updated_at, created_by, evidence_kind,
      semantic_anchor, physical_anchor, evidence_health_state, gist, excerpt,
      source_hash, run_id, workspace_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.evidenceId, CLOCK, CLOCK, "garden_compile", "conversation_excerpt",
    "{}", null, "verified", `Planted evidence ${input.token}`,
    `Planted evidence ${input.token}`, "sha256:fixture", input.runId, input.workspaceId
  );
}

function insertIncidence(
  database: ReturnType<typeof initDatabase>,
  workspaceId: string,
  token: string
): void {
  const content_digest = hashContentDigest(token, fieldSha256);
  const record_id = hashSourceRecordId({
    source_id: `${workspaceId}-src`,
    source_version: "v1",
    content_digest
  }, fieldSha256);
  database.connection.prepare(`
    INSERT INTO source_records (
      workspace_id, record_id, source_id, source_version, content_digest,
      evidence_object_id, recorded_at, event_time, valid_from, valid_to,
      operator_id, source_body
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    workspaceId, record_id, `${workspaceId}-src`, "v1", content_digest,
    null, CLOCK, null, null, null, SOURCE_SPAN_IDENTITY_OPERATOR_ID, token
  );
  const span_id = hashAddressableSourceSpanId({
    record_id,
    start_offset: 0,
    end_offset: token.length,
    purpose: "sentence",
    producer_version: SOURCE_SPAN_IDENTITY_OPERATOR_ID
  }, fieldSha256);
  database.connection.prepare(`
    INSERT INTO source_spans (
      workspace_id, span_id, record_id, start_offset, end_offset,
      purpose, producer_version, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    workspaceId, span_id, record_id, 0, token.length,
    "sentence", SOURCE_SPAN_IDENTITY_OPERATOR_ID, CLOCK
  );
  const factor_id = hashFactorId({
    family: "f0",
    canonical_payload: token,
    operator_id: FACTOR_INCIDENCE_OPERATOR_ID
  }, fieldSha256);
  database.connection.prepare(`
    INSERT INTO factor_descriptors (
      workspace_id, factor_id, family, canonical_payload, operator_id, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    workspaceId, factor_id, "f0", token, FACTOR_INCIDENCE_OPERATOR_ID, CLOCK
  );
  const incidence_id = hashIncidenceId({
    span_id,
    factor_id,
    scope: workspaceId,
    operator_id: FACTOR_INCIDENCE_OPERATOR_ID
  }, fieldSha256);
  database.connection.prepare(`
    INSERT INTO factor_incidences (
      workspace_id, incidence_id, span_id, factor_id, scope, operator_id, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    workspaceId, incidence_id, span_id, factor_id, workspaceId,
    FACTOR_INCIDENCE_OPERATOR_ID, CLOCK
  );
}
