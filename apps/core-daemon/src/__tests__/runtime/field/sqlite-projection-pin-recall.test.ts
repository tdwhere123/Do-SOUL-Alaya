import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ControlPlaneObjectKind,
  FACTOR_INCIDENCE_OPERATOR_ID,
  QUERY_CONDITION_OPERATOR_ID,
  RetentionPolicy,
  SOURCE_SPAN_IDENTITY_OPERATOR_ID,
  fieldReceiptContractFields,
  hashAddressableSourceSpanId,
  hashConditionDigest,
  hashContentDigest,
  hashFactorId,
  hashIncidenceId,
  hashQueryCacheKey,
  hashSourceRecordId,
  verifyQueryConditionReceipt,
  type EventLogEntry,
  type ProjectionPin,
  type TaskObjectSurface
} from "@do-soul/alaya-protocol";
import {
  RecallService,
  fieldContractSha256,
  type RecallServiceDependencies
} from "@do-soul/alaya-core";
import {
  initDatabase,
  SqliteEventLogRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { createDaemonFieldComposition } from
  "../../../runtime/field/field-composition.js";

const CLOCK = "2026-08-16T00:00:00.000Z";
const PAST_AS_OF = "2023-03-15T12:00:00.000Z";
const tracked = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of tracked) database.close();
  tracked.clear();
});

describe("sqlite projection pin recall", () => {
  it("selects with the original pin handle after sqlite renew", () => {
    const { querySession, stores } = openComposition();
    seedProjectionSource(stores);
    const pin = querySession.pinActiveGeneration("workspace-1", CLOCK);
    const renewed = querySession.renew(pin, "2026-08-16T00:01:00.000Z");
    expect(renewed.expires_at).not.toBe(pin.expires_at);
    expect(querySession.selectCandidates(
      sqliteQueryCondition(pin, "2026-08-16T00:01:00.000Z"),
      pin,
      "2026-08-16T00:01:00.000Z"
    ).candidate_keys).toEqual(expect.any(Array));
  });

  it("canonicalizes equivalent operational timestamp spellings", () => {
    const { querySession, stores } = openComposition();
    seedProjectionSource(stores);
    const pin = querySession.pinActiveGeneration("workspace-1", "2026-08-16T00:00:00Z");
    expect(pin.pinned_at).toBe(CLOCK);
    expect(querySession.selectCandidates(
      sqliteQueryCondition(pin, CLOCK),
      pin,
      CLOCK
    ).candidate_keys).toEqual(expect.any(Array));
  });

  it("pins at operational now when recall as-of is historical", async () => {
    const { database, querySession, stores } = openComposition();
    seedProjectionSource(stores);
    let pinnedAt: string | undefined;
    const renew = vi.fn(querySession.renew.bind(querySession));
    const service = createSqliteRecallService({
      fieldQuerySession: {
        ...querySession,
        pinActiveGeneration(workspaceId, recordedAt) {
          pinnedAt = recordedAt;
          return querySession.pinActiveGeneration(workspaceId, recordedAt);
        },
        renew
      },
      now: () => CLOCK
    });

    await expect(service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "build",
      referenceTime: PAST_AS_OF
    })).resolves.toMatchObject({ candidates: expect.any(Array) });
    expect(pinnedAt).toBe(CLOCK);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(database.connection.prepare(`
      SELECT COUNT(*) AS n FROM projection_pins WHERE released_at IS NULL
    `).get()).toMatchObject({ n: 0 });
  });

  it("keeps the sqlite pin live when operational time passes the original expiry", async () => {
    const { database, querySession, stores } = openComposition();
    seedProjectionSource(stores);
    let now = CLOCK;
    let heartbeat: (() => void) | null = null;
    const service = createSqliteRecallService({
      fieldQuerySession: querySession,
      now: () => now,
      projectionPinHeartbeatScheduler: {
        every: (_intervalMs, callback) => {
          heartbeat = callback;
          return () => {
            heartbeat = null;
          };
        }
      },
      onPreparationRead: () => {
        now = "2026-08-16T00:04:00.000Z";
        heartbeat?.();
        now = "2026-08-16T00:06:00.000Z";
      }
    });

    await expect(service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "build"
    })).resolves.toMatchObject({ candidates: expect.any(Array) });
    expect(database.connection.prepare(`
      SELECT COUNT(*) AS n FROM projection_pins WHERE released_at IS NULL
    `).get()).toMatchObject({ n: 0 });
  });
});

function createSqliteRecallService(input: Readonly<{
  readonly fieldQuerySession: NonNullable<
    ConstructorParameters<typeof RecallService>[0]["fieldQuerySession"]
  >;
  readonly now: () => string;
  readonly projectionPinHeartbeatScheduler?: ConstructorParameters<
    typeof RecallService
  >[0]["projectionPinHeartbeatScheduler"];
  readonly onPreparationRead?: () => void;
}>): RecallService {
  return new RecallService({
    ...stubRecallDependencies(input.now, input.onPreparationRead),
    fieldQuerySession: input.fieldQuerySession,
    projectionPinHeartbeatScheduler: input.projectionPinHeartbeatScheduler
  });
}

function stubRecallDependencies(
  now: () => string,
  onPreparationRead?: () => void
): RecallServiceDependencies {
  return {
    now,
    generateRuntimeId: () => "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9",
    memoryRepo: {
      findByWorkspaceId: vi.fn(async () => []),
      findByDimension: vi.fn(async () => []),
      findByScopeClass: vi.fn(async () => []),
      findByEvidenceRefs: vi.fn(async () => [])
    },
    slotRepo: {
      findByWorkspace: vi.fn(async () => {
        onPreparationRead?.();
        return [];
      })
    },
    eventLogRepo: {
      append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => ({
        event_id: "event-1",
        created_at: CLOCK,
        revision: 0,
        ...entry
      })),
      queryByEntity: vi.fn(async () => [])
    },
    graphSupportPort: {
      countInboundSupports: vi.fn(async () => 0),
      countInboundEdgesWeighted: vi.fn(async () => 0),
      countInboundRecalls: vi.fn(async () => 0)
    }
  };
}

function sqliteQueryCondition(pin: ProjectionPin, recordedAt: string) {
  const condition = {
    principal: "workspace-1",
    workspace_id: "workspace-1",
    authorized_scopes: ["workspace-1"],
    explicit_bridges: [] as const,
    workspace_project: "workspace-1",
    effective_as_of: recordedAt,
    query_task_factors: [] as const,
    governance_state: "open" as const,
    activation_budget: 8,
    token_budget: 256
  };
  const identity = hashConditionDigest(condition, fieldContractSha256);
  return verifyQueryConditionReceipt({
    schema_version: 1,
    producer: QUERY_CONDITION_OPERATOR_ID,
    consumer: "attributed_activation",
    identity,
    replay_rule: "idempotent_same_identity",
    failure_disposition: "fail_closed",
    governance_effect: "none",
    deletion_behavior: "rebuildable",
    condition,
    generation_id: pin.generation_id,
    query_operator_id: QUERY_CONDITION_OPERATOR_ID,
    query_cache_key: hashQueryCacheKey({
      generation_id: pin.generation_id,
      condition_digest: identity,
      query_operator_id: QUERY_CONDITION_OPERATOR_ID
    }, fieldContractSha256),
    recorded_at: recordedAt
  }, fieldContractSha256);
}

function createTaskSurface(): TaskObjectSurface {
  return {
    runtime_id: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
    object_kind: ControlPlaneObjectKind.TASK_OBJECT_SURFACE,
    task_surface_ref: null,
    expires_at: "2026-08-16T00:30:00.000Z",
    derived_from: null,
    retention_policy: RetentionPolicy.SESSION_ONLY,
    surface_kind: "build",
    display_name: "Ada",
    context_refs: []
  };
}

function openComposition() {
  const database = initDatabase({ filename: ":memory:" });
  tracked.add(database);
  seedWorkspace(database);
  const eventLogRepo = new SqliteEventLogRepo(database);
  return {
    database,
    eventLogRepo,
    ...createDaemonFieldComposition({
      database,
      eventLogRepo,
      sha256: fieldContractSha256
    })
  };
}

function seedProjectionSource(
  stores: ReturnType<typeof openComposition>["stores"]
): void {
  const record = stores.putRecord(sourceRecord("Ada wrote notes."), "Ada wrote notes.");
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
    workspace_id: "workspace-1",
    record_id: record.identity,
    start_offset: 0,
    end_offset: 16,
    purpose: "sentence",
    producer_version: SOURCE_SPAN_IDENTITY_OPERATOR_ID,
    recorded_at: CLOCK
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
    workspace_id: "workspace-1",
    family: "f1",
    canonical_payload: "ada",
    operator_id: FACTOR_INCIDENCE_OPERATOR_ID,
    recorded_at: CLOCK
  });
  const incidenceIdentity = hashIncidenceId({
    span_id: span.identity,
    factor_id: factorIdentity,
    scope: "workspace-1",
    operator_id: FACTOR_INCIDENCE_OPERATOR_ID
  }, fieldContractSha256);
  stores.putIncidence({
    ...fieldReceiptContractFields({
      identity: incidenceIdentity,
      producer: FACTOR_INCIDENCE_OPERATOR_ID,
      consumer: "projection_generation"
    }),
    schema_version: 1,
    workspace_id: "workspace-1",
    span_id: span.identity,
    factor_id: factorIdentity,
    scope: "workspace-1",
    operator_id: FACTOR_INCIDENCE_OPERATOR_ID,
    recorded_at: CLOCK
  });
}

function seedWorkspace(database: StorageDatabase): void {
  database.connection.prepare(`
    INSERT INTO workspaces (
      workspace_id, name, root_path, workspace_kind, default_engine_binding,
      workspace_state, created_at, archived_at, default_engine_class
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "workspace-1",
    "Field workspace",
    "/tmp/workspace-1",
    "local_repo",
    null,
    "active",
    CLOCK,
    null,
    null
  );
  database.connection.prepare(`
    INSERT INTO evidence_capsules (
      object_id, object_kind, schema_version, lifecycle_state, created_at, updated_at,
      created_by, evidence_kind, semantic_anchor, event_anchor, physical_anchor,
      evidence_health_state, gist, excerpt, source_hash, run_id, workspace_id, surface_id
    ) VALUES (?, 'evidence_capsule', 1, 'active', ?, ?, 'system', 'user_statement',
      ?, NULL, NULL, 'verified', 'Ada notes', NULL, NULL, 'run-1', 'workspace-1', NULL)
  `).run(
    "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9",
    CLOCK,
    CLOCK,
    JSON.stringify({ topic: "notes", keywords: ["ada"], summary: "Ada notes" })
  );
}

function sourceRecord(body: string) {
  const content_digest = hashContentDigest(body, fieldContractSha256);
  const identity = hashSourceRecordId({
    source_id: "src-1",
    source_version: "1",
    content_digest
  }, fieldContractSha256);
  return {
    schema_version: 1 as const,
    producer: SOURCE_SPAN_IDENTITY_OPERATOR_ID,
    consumer: "projection_generation",
    identity,
    replay_rule: "idempotent_same_identity" as const,
    failure_disposition: "fail_closed" as const,
    governance_effect: "none" as const,
    deletion_behavior: "retain_identity" as const,
    workspace_id: "workspace-1",
    source_id: "src-1",
    source_version: "1",
    content_digest,
    evidence_object_id: "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9",
    recorded_at: CLOCK,
    event_time: null,
    valid_from: null,
    valid_to: null,
    operator_id: SOURCE_SPAN_IDENTITY_OPERATOR_ID
  };
}
