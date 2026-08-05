import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RunMode,
  RunState,
  SignalEventType,
  SignalState,
  SoulSignalMaterializedPayloadSchema,
  WorkspaceKind,
  WorkspaceState,
  type CandidateMemorySignal,
  type ConversationMessage,
  type EvidenceCapsule
} from "@do-soul/alaya-protocol";
import {
  buildGardenTurnEvidenceArtifactRef,
  buildGardenTurnEvidenceFallback,
  resolveVerifiedGardenTurnEvidenceProjection
} from "@do-soul/alaya-soul";
import {
  initDatabase,
  SqliteEvidenceCapsuleRepo,
  SqliteEventLogRepo,
  SqliteRunRepo,
  SqliteSignalRepo,
  SqliteWorkspaceRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";

const CREATED_AT = "2026-07-27T00:00:00.000Z";
const roots: string[] = [];

export interface OwnerFixtureInput {
  readonly signalId: string;
  readonly evidenceId: string;
  readonly messages: readonly ConversationMessage[];
  readonly receiptVersion?: 1 | 2;
}

export interface SeededOwner {
  readonly signal: CandidateMemorySignal;
  readonly evidenceId: string;
}

export async function cleanupProjectionRebuildFixtures(): Promise<void> {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
}

export async function createSourceFixture(
  owners: readonly OwnerFixtureInput[],
  mutate?: (db: StorageDatabase, owner: SeededOwner) => void
): Promise<{
  readonly root: string;
  readonly sourceDbPath: string;
  readonly evidenceIds: readonly string[];
  readonly currentSchemaVersion: number;
}> {
  const root = await mkdtemp(join(tmpdir(), "evidence-projection-rebuild-"));
  roots.push(root);
  const sourceDbPath = join(root, "source.db");
  const db = initDatabase({ filename: sourceDbPath });
  await seedRuntimeOwners(db);
  const seeded: SeededOwner[] = [];
  for (const owner of owners) seeded.push(await seedOwner(db, owner));
  if (mutate !== undefined && seeded[0] !== undefined) mutate(db, seeded[0]);
  const currentSchemaVersion = readLatestSchemaVersion(db);
  downgradeProjectionSchema(db);
  db.close();
  return {
    root,
    sourceDbPath,
    evidenceIds: Object.freeze(seeded.map((owner) => owner.evidenceId)),
    currentSchemaVersion
  };
}

async function seedRuntimeOwners(db: StorageDatabase): Promise<void> {
  const workspaces = new SqliteWorkspaceRepo(db);
  const runs = new SqliteRunRepo(db);
  for (const [workspaceId, runId] of [
    ["workspace-1", "run-1"],
    ["workspace-2", "run-2"]
  ] as const) {
    await workspaces.create({
      workspace_id: workspaceId,
      name: workspaceId,
      root_path: `/tmp/${workspaceId}`,
      workspace_kind: WorkspaceKind.LOCAL_REPO,
      default_engine_binding: null,
      workspace_state: WorkspaceState.ACTIVE
    });
    await runs.create({
      run_id: runId,
      workspace_id: workspaceId,
      title: runId,
      goal: null,
      run_mode: RunMode.CHAT,
      engine_binding_id: null,
      engine_class: null,
      run_state: RunState.IDLE,
      current_surface_id: null
    });
  }
}

async function seedOwner(
  db: StorageDatabase,
  input: OwnerFixtureInput
): Promise<SeededOwner> {
  const emitted = buildGardenTurnEvidenceFallback({
    turnContent: "legacy flattened content",
    ...(input.receiptVersion === 1 ? {} : { turnMessages: input.messages }),
    reason: "empty_extraction",
    signalId: input.signalId,
    workspaceId: "workspace-1",
    runId: "run-1",
    surfaceId: null,
    createdAt: CREATED_AT,
    sourceObservation: {
      observed_at: CREATED_AT,
      authority: "trusted_host_event",
      source_event_id: `event-${input.signalId}`
    }
  });
  if (emitted === null) throw new Error("fixture failed to build receipt signal");
  const signalRepo = new SqliteSignalRepo(db);
  await signalRepo.create(emitted);
  const sourceCorpus = emitted.raw_payload.full_turn_content;
  if (typeof sourceCorpus !== "string") throw new Error("fixture source corpus missing");
  const verified = resolveVerifiedGardenTurnEvidenceProjection(emitted, sourceCorpus);
  if (verified === null) throw new Error("fixture receipt did not verify");
  const capsule = evidenceCapsule(
    input.evidenceId,
    emitted,
    verified.sourceHash,
    sourceCorpus,
    verified.userContent ?? sourceCorpus
  );
  await new SqliteEvidenceCapsuleRepo(db).create(capsule);
  const signal = await signalRepo.updateState(
    emitted.signal_id,
    SignalState.MATERIALIZED
  );
  insertMaterializationEvent(db, signal, capsule.object_id);
  return Object.freeze({ signal, evidenceId: input.evidenceId });
}

function evidenceCapsule(
  evidenceId: string,
  signal: CandidateMemorySignal,
  sourceHash: string,
  sourceCorpus: string,
  excerpt: string
): EvidenceCapsule {
  return {
    object_id: evidenceId,
    object_kind: "evidence_capsule",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    created_by: "garden_compile",
    evidence_kind: "conversation_excerpt",
    semantic_anchor: {
      topic: "source turn",
      keywords: ["source", "turn"],
      summary: sourceCorpus
    },
    event_anchor: null,
    physical_anchor: {
      file_path: null,
      line_range: null,
      symbol_name: null,
      artifact_ref: buildGardenTurnEvidenceArtifactRef(signal.signal_id)
    },
    evidence_health_state: "verified",
    gist: sourceCorpus,
    excerpt,
    source_hash: sourceHash,
    run_id: signal.run_id,
    workspace_id: signal.workspace_id,
    surface_id: signal.surface_id
  };
}

function insertMaterializationEvent(
  db: StorageDatabase,
  signal: CandidateMemorySignal,
  evidenceId: string
): void {
  const payload = SoulSignalMaterializedPayloadSchema.parse({
    signal_id: signal.signal_id,
    workspace_id: signal.workspace_id,
    run_id: signal.run_id,
    created_objects: [{
      object_kind: "evidence_capsule",
      object_id: evidenceId
    }],
    success: true
  });
  new SqliteEventLogRepo(db).append({
    event_type: SignalEventType.SOUL_SIGNAL_MATERIALIZED,
    entity_type: "candidate_memory_signal",
    entity_id: signal.signal_id,
    workspace_id: signal.workspace_id,
    run_id: signal.run_id,
    caused_by: "materialization_router",
    payload_json: payload
  });
}

function downgradeProjectionSchema(db: StorageDatabase): void {
  db.connection.exec(`
    DROP TRIGGER IF EXISTS evidence_search_projection_fts_ai;
    DROP TRIGGER IF EXISTS evidence_search_projection_fts_ad;
    DROP TRIGGER IF EXISTS evidence_search_projection_fts_au;
    DROP TABLE IF EXISTS evidence_search_projection_fts;
    DROP TABLE IF EXISTS evidence_search_projection_fts_trigram;
    DROP TABLE IF EXISTS evidence_search_projections;
    DROP TABLE IF EXISTS evidence_fact_frame_formations;
    DELETE FROM schema_version WHERE version >= 109;
  `);
}

function readLatestSchemaVersion(db: StorageDatabase): number {
  const row = db.connection.prepare(`
    SELECT MAX(version) AS version FROM schema_version
  `).get() as Readonly<{ version: number }>;
  return row.version;
}

export interface StoredProjectionRow {
  readonly evidence_object_id: string;
  readonly projection_id: number;
  readonly projection_kind: string;
  readonly workspace_id: string;
  readonly source_hash: string;
  readonly content: string;
}

export function readProjectionRows(
  dbPath: string
): readonly StoredProjectionRow[] {
  const db = initDatabase({ filename: dbPath, temporalMode: "candidate" });
  try {
    return db.connection.prepare(`
      SELECT evidence_object_id, projection_id, projection_kind,
             workspace_id, source_hash, content
      FROM evidence_search_projections
      ORDER BY evidence_object_id ASC, projection_kind ASC, projection_id ASC
    `).all() as StoredProjectionRow[];
  } finally {
    db.close();
  }
}

export function insertStaleProjection(
  dbPath: string,
  evidenceId: string
): void {
  const db = initDatabase({ filename: dbPath, temporalMode: "candidate" });
  try {
    const owner = db.connection.prepare(`
      SELECT workspace_id, source_hash FROM evidence_capsules WHERE object_id = ?
    `).get(evidenceId) as Readonly<{
      workspace_id: string;
      source_hash: string;
    }>;
    db.connection.prepare(`
      INSERT INTO evidence_search_projections (
        evidence_object_id, projection_id, projection_kind,
        workspace_id, source_hash, content
      ) VALUES (?, 99, 'user_assertion', ?, ?, 'stale projection')
    `).run(evidenceId, owner.workspace_id, owner.source_hash);
  } finally {
    db.close();
  }
}

export async function fileSha256(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

export function message(
  messageId: string,
  role: ConversationMessage["role"],
  content: string
): ConversationMessage {
  return { message_id: messageId, role, content };
}

export function deleteMaterializationEvents(
  db: StorageDatabase,
  signalId: string
): void {
  db.connection.prepare(`
    DELETE FROM event_log
    WHERE entity_type = 'candidate_memory_signal' AND entity_id = ?
  `).run(signalId);
}

export function duplicateMaterializationEvent(
  db: StorageDatabase,
  owner: SeededOwner
): void {
  insertMaterializationEvent(db, owner.signal, owner.evidenceId);
}
