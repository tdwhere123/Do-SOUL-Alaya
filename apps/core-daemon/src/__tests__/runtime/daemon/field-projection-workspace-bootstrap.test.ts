import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EventPublisher,
  EventPublisherPropagationError,
  WorkspaceService,
  fieldContractSha256
} from "@do-soul/alaya-core";
import {
  FACTOR_INCIDENCE_OPERATOR_ID,
  RuntimeGovernanceEventType,
  SOURCE_SPAN_IDENTITY_OPERATOR_ID,
  WorkspaceKind,
  WorkspaceRunEventType,
  WorkspaceState,
  fieldReceiptContractFields,
  hashAddressableSourceSpanId,
  hashContentDigest,
  hashFactorId,
  hashIncidenceId,
  hashSourceRecordId,
  type EventLogEntry
} from "@do-soul/alaya-protocol";
import {
  initDatabase,
  SqliteEventLogRepo,
  SqliteRunRepo,
  SqliteWorkspaceRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { createDaemonFieldComposition } from
  "../../../runtime/field/field-composition.js";
import {
  createFieldProjectionWorkspaceBirthMutation,
  createFieldProjectionWorkspaceEnsureMutation
} from "../../../runtime/daemon/wiring/field-projection-workspace-bootstrap.js";
import { withSecurityStatusWorkspaceService } from
  "../../../security/status-bootstrap.js";

const CREATED_AT = "2020-01-01T00:00:00.000Z";
const NOW = "2026-08-19T12:00:00.000Z";
const EVIDENCE_ID = "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9";
const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }
  databases.clear();
});

describe("field projection workspace birth", () => {
  it("does not mint a generation from an unwrapped ensure (query pin stays fail-closed)", async () => {
    const { composition, service } = openHarness();
    const workspace = await service.ensureLocalWorkspace(ensureInput("ws_unwrapped_ensure"));

    expect(composition.fieldRepos.generations.readActive(workspace.workspace_id)).toBeNull();
    expect(() => composition.querySession.pinActiveGeneration(
      workspace.workspace_id,
      workspace.created_at
    )).toThrow(/active projection generation is missing/u);
  });

  it("commits an active generation with create so query pin succeeds", async () => {
    const { composition, service } = openHarness();
    const born = withBirth(service, composition);
    const workspace = await born.create({
      name: "projection-bootstrap-create",
      root_path: "/tmp/projection-bootstrap-create",
      workspace_kind: WorkspaceKind.LOCAL_REPO
    });

    expect(composition.fieldRepos.generations.readActive(workspace.workspace_id)).not.toBeNull();
    expect(() => composition.querySession.pinActiveGeneration(
      workspace.workspace_id,
      workspace.created_at
    )).not.toThrow();
  });

  it("rolls back workspace row and WORKSPACE_CREATED when projection init fails during create", async () => {
    const { composition, database, service } = openHarness();
    const born = withBirth(service, withFailingRebuild(composition));

    await expect(born.create({
      name: "projection-bootstrap-fail",
      root_path: "/tmp/projection-bootstrap-fail",
      workspace_kind: WorkspaceKind.LOCAL_REPO
    })).rejects.toThrow(/planted projection rebuild failure/u);

    expect(countRows(database, "workspaces")).toBe(0);
    expect(countRows(database, "projection_generations")).toBe(0);
    expect(listCreatedEvents(database)).toHaveLength(0);
  });

  it("rebuilds a seeded workspace at injected now so later source is in the active artifacts", async () => {
    const { composition, database, service, workspaceRepo } = openHarness();
    seedLegacyWorkspace(database, "ws_recovery_now");
    const seeded = await workspaceRepo.getById("ws_recovery_now");
    expect(seeded?.created_at).toBe(CREATED_AT);
    seedEvidence(database, "ws_recovery_now", NOW);
    seedCurrentSource(composition.stores, "ws_recovery_now", NOW);

    const wrapped = withEnsure(service, composition);
    const workspace = await wrapped.ensureLocalWorkspace(ensureInput("ws_recovery_now"));
    const active = composition.fieldRepos.generations.readActive(workspace.workspace_id);
    const artifacts = active === null
      ? null
      : composition.fieldRepos.generations.readArtifacts(
        workspace.workspace_id,
        active.generation_id
      );

    expect(active?.recorded_at).toBe(NOW);
    expect(active?.recorded_at).not.toBe(CREATED_AT);
    expect(artifacts).not.toBeNull();
    expect(JSON.parse(artifacts!.artifacts_json).slice_keys.length).toBeGreaterThan(0);
    expect(() => composition.querySession.pinActiveGeneration(
      workspace.workspace_id,
      NOW
    )).not.toThrow();
  });

  it("does not rebuild an already-active generation merely by ensure", async () => {
    const { composition, service } = openHarness();
    const born = withBirth(service, composition);
    const workspace = await born.create({
      name: "projection-active-ensure",
      root_path: "/tmp/projection-active-ensure",
      workspace_kind: WorkspaceKind.LOCAL_REPO
    });
    let ensureRebuilds = 0;
    const counting = {
      ...composition,
      projectionLifecycle: {
        ...composition.projectionLifecycle,
        rebuild(workspaceId: string, recordedAt: string) {
          ensureRebuilds += 1;
          return composition.projectionLifecycle.rebuild(workspaceId, recordedAt);
        }
      }
    };
    const wrapped = withEnsure(born, counting);
    await wrapped.ensureLocalWorkspace(ensureInput(workspace.workspace_id));

    expect(ensureRebuilds).toBe(0);
    expect(composition.fieldRepos.generations.readActive(workspace.workspace_id)).not.toBeNull();
  });

  it("does not mint a generation from getById or list", async () => {
    const { composition, database, service } = openHarness();
    seedLegacyWorkspace(database, "ws_no_mint_get");
    const wrapped = withEnsure(service, composition);

    await wrapped.getById("ws_no_mint_get");
    await wrapped.list();

    expect(composition.fieldRepos.generations.readActive("ws_no_mint_get")).toBeNull();
    expect(() => composition.querySession.pinActiveGeneration("ws_no_mint_get", NOW))
      .toThrow(/active projection generation is missing/u);
  });

  it("initializes security on ensure with existing nonfatal propagation semantics", async () => {
    const { composition, service } = openHarness();
    const initializeWorkspace = vi.fn(async () => {
      throw createPropagationError();
    });
    const recordInitializationFailure = vi.fn(async () => undefined);
    const wrapped = withEnsure(service, composition, {
      initializeWorkspace,
      recordInitializationFailure
    });

    const workspace = await wrapped.ensureLocalWorkspace(ensureInput("ws_security_ensure"));
    expect(workspace.workspace_id).toBe("ws_security_ensure");
    expect(initializeWorkspace).toHaveBeenCalledWith("ws_security_ensure");
    expect(recordInitializationFailure).not.toHaveBeenCalled();
    expect(composition.fieldRepos.generations.readActive(workspace.workspace_id)).not.toBeNull();
  });

  it("converges concurrent ensure onto one active generation", async () => {
    const { composition, database, service } = openHarness();
    const wrapped = withEnsure(withBirth(service, composition), composition);
    const target = ensureInput("ws_concurrent_birth");

    const [first, second] = await Promise.all([
      wrapped.ensureLocalWorkspace(target),
      wrapped.ensureLocalWorkspace(target)
    ]);

    expect(first.workspace_id).toBe("ws_concurrent_birth");
    expect(second.workspace_id).toBe("ws_concurrent_birth");
    expect(countRows(database, "workspaces")).toBe(1);
    expect(countActiveGenerations(database, "ws_concurrent_birth")).toBe(1);
    expect(listCreatedEvents(database)).toHaveLength(1);
  });

  it("converges concurrent recovery of a generation-less workspace onto one active generation", async () => {
    const { composition, database, service } = openHarness();
    seedLegacyWorkspace(database, "ws_concurrent_recovery");
    const wrapped = withEnsure(service, composition);
    const target = ensureInput("ws_concurrent_recovery");

    await Promise.all([
      wrapped.ensureLocalWorkspace(target),
      wrapped.ensureLocalWorkspace(target)
    ]);

    expect(countActiveGenerations(database, "ws_concurrent_recovery")).toBe(1);
    expect(composition.fieldRepos.generations.readActive("ws_concurrent_recovery")?.recorded_at)
      .toBe(NOW);
  });
});

function openHarness() {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  const workspaceRepo = new SqliteWorkspaceRepo(database);
  const runRepo = new SqliteRunRepo(database);
  const eventLogRepo = new SqliteEventLogRepo(database);
  const eventPublisher = new EventPublisher({
    eventLogRepo,
    runHotStateService: { apply: () => {} },
    runtimeNotifier: { notify: () => {}, notifyEntry: () => {} }
  });
  const composition = createDaemonFieldComposition({
    database,
    eventLogRepo,
    sha256: fieldContractSha256
  });
  const service = new WorkspaceService({
    workspaceRepo,
    runRepo,
    eventPublisher
  });
  return { composition, database, eventLogRepo, service, workspaceRepo };
}

function withBirth(
  service: WorkspaceService,
  composition: ReturnType<typeof createDaemonFieldComposition>
): WorkspaceService {
  return new WorkspaceService({
    ...service.dependencies,
    workspaceCreationMutation: createFieldProjectionWorkspaceBirthMutation(composition)
  });
}

function withEnsure(
  service: WorkspaceService,
  composition: ReturnType<typeof createDaemonFieldComposition>,
  security: {
    readonly initializeWorkspace?: (workspaceId: string) => Promise<unknown>;
    readonly recordInitializationFailure?: () => Promise<void>;
  } = {}
): WorkspaceService {
  return withSecurityStatusWorkspaceService(
    service,
    {
      initializeWorkspace: (security.initializeWorkspace ?? (async (workspaceId: string) => ({
        workspace_id: workspaceId,
        posture: "baseline" as const,
        zero_day_active: false,
        active_security_locks: 0,
        last_assessment_at: NOW,
        active_protections: []
      }))) as never,
      recordInitializationFailure: security.recordInitializationFailure ?? (async () => undefined)
    },
    createFieldProjectionWorkspaceEnsureMutation(composition, () => NOW)
  );
}

function withFailingRebuild(
  composition: ReturnType<typeof createDaemonFieldComposition>
): ReturnType<typeof createDaemonFieldComposition> {
  return {
    ...composition,
    projectionLifecycle: {
      ...composition.projectionLifecycle,
      rebuild(): never {
        throw new Error("planted projection rebuild failure");
      }
    }
  };
}

function ensureInput(workspaceId: string) {
  return {
    workspaceId,
    name: workspaceId,
    rootPath: `/tmp/${workspaceId}`
  };
}

function countRows(database: StorageDatabase, table: string): number {
  return (database.connection.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
    readonly n: number;
  }).n;
}

function countActiveGenerations(database: StorageDatabase, workspaceId: string): number {
  return (database.connection.prepare(`
    SELECT COUNT(*) AS n FROM projection_generations
    WHERE workspace_id = ? AND status = 'active'
  `).get(workspaceId) as { readonly n: number }).n;
}

function listCreatedEvents(database: StorageDatabase): readonly unknown[] {
  return database.connection.prepare(`
    SELECT event_id FROM event_log WHERE event_type = ?
  `).all(WorkspaceRunEventType.WORKSPACE_CREATED);
}

function seedLegacyWorkspace(database: StorageDatabase, workspaceId: string): void {
  database.connection.prepare(`
    INSERT INTO workspaces (
      workspace_id, name, root_path, workspace_kind, default_engine_binding,
      workspace_state, created_at, archived_at, default_engine_class
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    workspaceId,
    workspaceId,
    `/tmp/${workspaceId}`,
    WorkspaceKind.LOCAL_REPO,
    null,
    WorkspaceState.ACTIVE,
    CREATED_AT,
    null,
    null
  );
}

function seedEvidence(database: StorageDatabase, workspaceId: string, at: string): void {
  database.connection.prepare(`
    INSERT INTO evidence_capsules (
      object_id, object_kind, schema_version, lifecycle_state, created_at, updated_at,
      created_by, evidence_kind, semantic_anchor, event_anchor, physical_anchor,
      evidence_health_state, gist, excerpt, source_hash, run_id, workspace_id, surface_id
    ) VALUES (?, 'evidence_capsule', 1, 'active', ?, ?, 'system', 'user_statement',
      ?, NULL, NULL, 'verified', 'Ada notes', NULL, NULL, 'run-1', ?, NULL)
  `).run(
    EVIDENCE_ID,
    at,
    at,
    JSON.stringify({ topic: "notes", keywords: ["ada"], summary: "Ada notes" }),
    workspaceId
  );
}

function seedCurrentSource(
  stores: ReturnType<typeof createDaemonFieldComposition>["stores"],
  workspaceId: string,
  at: string
): void {
  const body = "Ada wrote notes.";
  const content_digest = hashContentDigest(body, fieldContractSha256);
  const identity = hashSourceRecordId({
    source_id: "src-1",
    source_version: "1",
    content_digest
  }, fieldContractSha256);
  const record = stores.putRecord({
    ...fieldReceiptContractFields({
      identity,
      producer: SOURCE_SPAN_IDENTITY_OPERATOR_ID,
      consumer: "projection_generation"
    }),
    schema_version: 1,
    workspace_id: workspaceId,
    source_id: "src-1",
    source_version: "1",
    content_digest,
    evidence_object_id: EVIDENCE_ID,
    recorded_at: at,
    event_time: null,
    valid_from: null,
    valid_to: null,
    operator_id: SOURCE_SPAN_IDENTITY_OPERATOR_ID
  }, body);
  const spanIdentity = hashAddressableSourceSpanId({
    record_id: record.identity,
    start_offset: 0,
    end_offset: 16,
    purpose: "sentence",
    producer_version: SOURCE_SPAN_IDENTITY_OPERATOR_ID
  }, fieldContractSha256);
  const span = stores.putSpan({
    ...fieldReceiptContractFields({
      identity: spanIdentity,
      producer: SOURCE_SPAN_IDENTITY_OPERATOR_ID,
      consumer: "factor_incidence"
    }),
    schema_version: 1,
    workspace_id: workspaceId,
    record_id: record.identity,
    start_offset: 0,
    end_offset: 16,
    purpose: "sentence",
    producer_version: SOURCE_SPAN_IDENTITY_OPERATOR_ID,
    recorded_at: at
  });
  const factorIdentity = hashFactorId({
    family: "f1",
    canonical_payload: "ada",
    operator_id: FACTOR_INCIDENCE_OPERATOR_ID
  }, fieldContractSha256);
  stores.putDescriptor({
    ...fieldReceiptContractFields({
      identity: factorIdentity,
      producer: FACTOR_INCIDENCE_OPERATOR_ID,
      consumer: "projection_generation"
    }),
    schema_version: 1,
    workspace_id: workspaceId,
    family: "f1",
    canonical_payload: "ada",
    operator_id: FACTOR_INCIDENCE_OPERATOR_ID,
    recorded_at: at
  });
  const incidenceIdentity = hashIncidenceId({
    span_id: span.identity,
    factor_id: factorIdentity,
    scope: workspaceId,
    operator_id: FACTOR_INCIDENCE_OPERATOR_ID
  }, fieldContractSha256);
  stores.putIncidence({
    ...fieldReceiptContractFields({
      identity: incidenceIdentity,
      producer: FACTOR_INCIDENCE_OPERATOR_ID,
      consumer: "projection_generation"
    }),
    schema_version: 1,
    workspace_id: workspaceId,
    span_id: span.identity,
    factor_id: factorIdentity,
    scope: workspaceId,
    operator_id: FACTOR_INCIDENCE_OPERATOR_ID,
    recorded_at: at
  });
}

function createPropagationError(): EventPublisherPropagationError {
  const entry: EventLogEntry = {
    event_id: "event-1",
    event_type: RuntimeGovernanceEventType.SECURITY_PASSTHROUGH_STATUS_CHANGED,
    entity_type: "workspace",
    entity_id: "workspace-1",
    workspace_id: "workspace-1",
    run_id: null,
    caused_by: "system",
    revision: 0,
    payload_json: {
      workspace_id: "workspace-1",
      posture: "baseline",
      zero_day_active: false,
      active_security_locks: 0,
      reason: "workspace_initialized",
      changed_at: NOW
    },
    created_at: NOW
  };
  return new EventPublisherPropagationError(entry, new Error("broadcast failed"));
}
