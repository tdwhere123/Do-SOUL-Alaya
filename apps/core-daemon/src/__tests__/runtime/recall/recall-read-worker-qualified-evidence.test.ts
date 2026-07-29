import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RunMode,
  RunState,
  SignalEventType,
  SignalState,
  SoulSignalMaterializedPayloadSchema,
  WorkspaceKind,
  WorkspaceState,
  type CandidateMemorySignal,
  type EvidenceCapsule,
  type EvidenceSearchProjection
} from "@do-soul/alaya-protocol";
import {
  buildGardenTurnEvidenceArtifactRef,
  buildGardenTurnEvidenceFallback,
  buildGardenTurnEvidenceSearchProjections,
  resolveVerifiedGardenTurnEvidenceProjection
} from "@do-soul/alaya-soul";
import {
  initDatabase,
  SqliteEvidenceCapsuleRepo,
  SqliteEventLogRepo,
  SqliteRunRepo,
  SqliteSignalRepo,
  SqliteWorkspaceRepo
} from "@do-soul/alaya-storage";
import { beforeAll, describe, expect, it } from "vitest";
import { createRecallReadWorkerClient } from "../../../runtime/recall/recall-read-worker-client.js";

const builtWorkerUrl = new URL("../../../../dist/runtime/recall/recall-read-worker.js", import.meta.url);
const createdAt = "2026-07-27T12:00:00.000Z";
const userStatement = "I commute by bicycle.";
const assistantObservation = "Use the TrailShell pack because its roll-top keeps a laptop dry.";

beforeAll(() => {
  if (!existsSync(fileURLToPath(builtWorkerUrl))) {
    throw new Error("Built recall-read-worker dist missing. Run `rtk pnpm build` before this test.");
  }
});

describe("RecallReadWorkerClient qualified evidence", () => {
  it("preserves a typed match and the complete qualified wrapper", async () => {
    const directory = mkdtempSync(join(tmpdir(), "alaya-qualified-evidence-worker-"));
    const databasePath = join(directory, "alaya.db");
    const fixture = await seedQualifiedEvidence(databasePath);
    const client = createRecallReadWorkerClient({
      databaseFilename: databasePath,
      workerUrl: builtWorkerUrl
    });
    try {
      if (client === null) throw new Error("file-backed recall worker client is unavailable");
      const findQualified = client.evidenceSearchPort.findRecallQualifiedByIds;
      if (findQualified === undefined) throw new Error("qualified evidence reader is unavailable");

      await expect(findQualified("workspace-1", [{
        object_id: fixture.capsule.object_id,
        matched_projection: {
          projection_id: fixture.projection.projection_id,
          projection_kind: fixture.projection.projection_kind
        }
      }])).resolves.toEqual([{
        capsule: fixture.capsule,
        verified_user_projection: true,
        matched_projection: fixture.projection
      }]);
    } finally {
      await client?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

type TestDatabase = ReturnType<typeof initDatabase>;

async function seedQualifiedEvidence(databasePath: string): Promise<Readonly<{
  readonly capsule: Readonly<EvidenceCapsule>;
  readonly projection: Readonly<EvidenceSearchProjection>;
}>> {
  const database = initDatabase({ filename: databasePath });
  try {
    await seedWorkspaceAndRun(database);
    const emitted = await seedEmittedSignal(database);
    const seeded = await seedEvidenceCapsule(database, emitted);
    const materialized = await markSignalMaterialized(database, emitted);
    appendMaterializationEvent(database, materialized, seeded.capsule);
    return seeded;
  } finally {
    database.close();
  }
}

async function seedWorkspaceAndRun(database: TestDatabase): Promise<void> {
  await new SqliteWorkspaceRepo(database).create({
    workspace_id: "workspace-1",
    name: "workspace one",
    root_path: "/tmp/workspace-1",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE
  });
  await new SqliteRunRepo(database).create({
    run_id: "run-1",
    workspace_id: "workspace-1",
    title: "qualified evidence worker test",
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });
}

async function seedEmittedSignal(
  database: TestDatabase
): Promise<CandidateMemorySignal> {
  const emitted = buildGardenTurnEvidenceFallback({
    turnContent: `User: ${userStatement}\nAssistant: ${assistantObservation}`,
    turnMessages: [
      { message_id: "user-1", role: "user", content: userStatement },
      { message_id: "assistant-1", role: "assistant", content: assistantObservation }
    ],
    reason: "empty_extraction",
    signalId: randomUUID(),
    workspaceId: "workspace-1",
    runId: "run-1",
    surfaceId: null,
    createdAt,
    sourceObservation: {
      observed_at: createdAt,
      authority: "trusted_host_event",
      source_event_id: randomUUID()
    }
  });
  if (emitted === null) throw new Error("failed to build evidence fallback signal");
  await new SqliteSignalRepo(database).create(emitted);
  return emitted;
}

async function markSignalMaterialized(
  database: TestDatabase,
  emitted: CandidateMemorySignal
): Promise<CandidateMemorySignal> {
  await new SqliteSignalRepo(database).updateState(
    emitted.signal_id,
    SignalState.MATERIALIZED
  );
  return {
    ...emitted,
    signal_state: SignalState.MATERIALIZED
  };
}

async function seedEvidenceCapsule(
  database: TestDatabase,
  signal: CandidateMemorySignal
): Promise<Readonly<{
  readonly capsule: Readonly<EvidenceCapsule>;
  readonly projection: Readonly<EvidenceSearchProjection>;
}>> {
  const sourceCorpus = signal.raw_payload.full_turn_content;
  if (typeof sourceCorpus !== "string") throw new Error("fallback source corpus is missing");
  const verified = resolveVerifiedGardenTurnEvidenceProjection(signal, sourceCorpus);
  if (verified === null || verified.userContent === null) {
    throw new Error("verified user projection is missing");
  }
  const projections = buildGardenTurnEvidenceSearchProjections(signal);
  const projection = projections.find(
    (candidate) => candidate.projection_kind === "assistant_observation"
  );
  if (projection === undefined) throw new Error("assistant projection is missing");
  const capsule = await new SqliteEvidenceCapsuleRepo(database).create(
    buildEvidenceCapsule(signal, sourceCorpus, verified),
    projections
  );
  return { capsule, projection };
}

function buildEvidenceCapsule(
  signal: CandidateMemorySignal,
  sourceCorpus: string,
  verified: NonNullable<ReturnType<typeof resolveVerifiedGardenTurnEvidenceProjection>>
): EvidenceCapsule {
  return {
    object_id: randomUUID(),
    object_kind: "evidence_capsule",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: createdAt,
    updated_at: createdAt,
    created_by: "garden_compile",
    evidence_kind: "conversation_excerpt",
    semantic_anchor: { topic: "source turn", keywords: [], summary: userStatement },
    event_anchor: null,
    physical_anchor: {
      file_path: null,
      line_range: null,
      symbol_name: null,
      artifact_ref: buildGardenTurnEvidenceArtifactRef(signal.signal_id)
    },
    evidence_health_state: "verified",
    gist: sourceCorpus,
    excerpt: verified.userContent,
    source_hash: verified.sourceHash,
    run_id: signal.run_id,
    workspace_id: signal.workspace_id,
    surface_id: signal.surface_id
  };
}

function appendMaterializationEvent(
  database: TestDatabase,
  signal: CandidateMemorySignal,
  capsule: Readonly<EvidenceCapsule>
): void {
  const payload = SoulSignalMaterializedPayloadSchema.parse({
    signal_id: signal.signal_id,
    workspace_id: signal.workspace_id,
    run_id: signal.run_id,
    created_objects: [{ object_kind: "evidence_capsule", object_id: capsule.object_id }],
    success: true
  });
  new SqliteEventLogRepo(database).append({
    event_type: SignalEventType.SOUL_SIGNAL_MATERIALIZED,
    entity_type: "candidate_memory_signal",
    entity_id: signal.signal_id,
    workspace_id: signal.workspace_id,
    run_id: signal.run_id,
    caused_by: "materialization_router",
    payload_json: payload
  });
}
