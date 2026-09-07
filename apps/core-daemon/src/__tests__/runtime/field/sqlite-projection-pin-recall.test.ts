import { afterEach, describe, expect, it } from "vitest";
import {
  FACTOR_INCIDENCE_OPERATOR_ID,
  QUERY_CONDITION_OPERATOR_ID,
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
  type ProjectionPin
} from "@do-soul/alaya-protocol";
import {
  fieldContractSha256
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

  it("keeps operational pin time separate from historical source selection", () => {
    const { database, querySession, stores } = openComposition();
    seedProjectionSource(stores);
    const pin = querySession.pinActiveGeneration("workspace-1", CLOCK);
    expect(pin.pinned_at).toBe(CLOCK);
    expect(querySession.selectCandidates(sqliteQueryCondition(pin, PAST_AS_OF), pin, CLOCK).candidate_keys)
      .toEqual(expect.any(Array));
    querySession.release(pin, CLOCK);
    expect(database.connection.prepare("SELECT COUNT(*) AS n FROM projection_pins WHERE released_at IS NULL").get())
      .toMatchObject({ n: 0 });
  });

  it("renews the native lease past its original expiry and releases it", () => {
    const { database, querySession, stores } = openComposition();
    seedProjectionSource(stores);
    const pin = querySession.pinActiveGeneration("workspace-1", CLOCK);
    const renewed = querySession.renew(pin, "2026-08-16T00:04:00.000Z");
    expect(Date.parse(renewed.expires_at)).toBeGreaterThan(Date.parse(pin.expires_at));
    expect(querySession.selectCandidates(sqliteQueryCondition(pin, "2026-08-16T00:06:00.000Z"),
      pin, "2026-08-16T00:06:00.000Z").candidate_keys).toEqual(expect.any(Array));
    querySession.release(pin, "2026-08-16T00:06:00.000Z");
    expect(database.connection.prepare("SELECT COUNT(*) AS n FROM projection_pins WHERE released_at IS NULL").get())
      .toMatchObject({ n: 0 });
  });
});

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
