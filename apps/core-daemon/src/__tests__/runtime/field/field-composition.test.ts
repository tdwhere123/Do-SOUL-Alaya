import { afterEach, describe, expect, it } from "vitest";
import {
  FACTOR_INCIDENCE_OPERATOR_ID,
  FieldGenerationEventType,
  MemoryGovernanceEventType,
  SoulEvidenceDeletedPayloadSchema,
  SoulEvidenceHealthChangedPayloadSchema,
  fieldReceiptContractFields,
  hashAddressableSourceSpanId,
  hashCausalUsageId,
  hashContentDigest,
  hashFactorId,
  hashIncidenceId,
  hashSourceRecordId,
  SOURCE_SPAN_IDENTITY_OPERATOR_ID
} from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "@do-soul/alaya-core";
import {
  initDatabase,
  SqliteEventLogRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { createDaemonFieldComposition } from
  "../../../runtime/field/field-composition.js";

const CLOCK = "2026-08-16T00:00:00.000Z";
const tracked = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of tracked) database.close();
  tracked.clear();
});

describe("field composition", () => {
  it("does not rebuild a missing generation from the query path", () => {
    const { database, fieldRepos, querySession } = openComposition();

    expect(() => querySession.pinActiveGeneration("workspace-1", CLOCK))
      .toThrow(/active projection generation is missing/u);
    expect(fieldRepos.generations.readActive("workspace-1")).toBeNull();
    expect(database.connection.prepare(`
      SELECT COUNT(*) AS n FROM projection_generations WHERE workspace_id = ?
    `).get("workspace-1")).toMatchObject({ n: 0 });
    expect(database.connection.prepare(`
      SELECT COUNT(*) AS n FROM event_log
      WHERE workspace_id = ? AND event_type IN (?, ?)
    `).get(
      "workspace-1",
      FieldGenerationEventType.SOUL_FIELD_GENERATION_REBUILD_STARTED,
      FieldGenerationEventType.SOUL_FIELD_GENERATION_ACTIVATED
    )).toMatchObject({ n: 0 });
  });

  it("persists source admission through the SQLite field stores", () => {
    const { stores } = openComposition();
    const record = stores.putRecord(sourceRecord("Ada wrote notes."), "Ada wrote notes.");
    const replay = stores.putRecord(record, "Ada wrote notes.");
    expect(replay.identity).toBe(record.identity);
    expect(stores.getRecord("workspace-1", record.identity)?.content_digest)
      .toBe(record.content_digest);
    expect(stores.listRecords("workspace-1")).toHaveLength(1);
  });

  it("records causal usage at the composition port, not a request-local fallback", () => {
    const { usagePort } = openComposition();
    const first = usagePort.recordUsage(causalReceipt());
    const replay = usagePort.recordUsage({
      ...first.receipt,
      occurred_at: "2026-08-17T00:00:00.000Z"
    });
    expect(first.inserted).toBe(true);
    expect(replay.inserted).toBe(false);
    expect(replay.receipt.occurred_at).toBe(first.receipt.occurred_at);
  });

  it("rebuilds a sealed frontier twice with the same generation and activates the pointer", () => {
    const { database, fieldRepos, querySession, stores } = openComposition();
    seedProjectionSource(stores);
    const first = querySession.pinActiveGeneration("workspace-1", CLOCK);
    const second = querySession.pinActiveGeneration("workspace-1", CLOCK);
    const active = fieldRepos.generations.readActive("workspace-1");
    expect(second.generation_id).toBe(first.generation_id);
    expect(active?.generation_id).toBe(first.generation_id);
    expect(active?.status).toBe("active");
    expect(fieldRepos.generations.readArtifacts("workspace-1", first.generation_id))
      .not.toBeNull();
    const activated = database.connection.prepare(`
      SELECT COUNT(*) AS n FROM event_log WHERE event_type = ? AND workspace_id = ?
    `).get(
      FieldGenerationEventType.SOUL_FIELD_GENERATION_ACTIVATED,
      "workspace-1"
    ) as { readonly n: number };
    expect(activated.n).toBeGreaterThan(0);
  });

  it("replays one sealed frontier byte-identically across query clocks", () => {
    const { database, fieldRepos, projectionLifecycle, querySession, stores } = openComposition();
    seedProjectionSource(stores);
    const first = querySession.pinActiveGeneration("workspace-1", CLOCK);
    const before = fieldRepos.generations.readArtifacts("workspace-1", first.generation_id)!;
    const intervening = stores.putRecord(
      sourceRecord("Ada revised notes."),
      "Ada revised notes."
    );
    const second = querySession.pinActiveGeneration(
      "workspace-1",
      "2026-08-16T00:01:00.000Z"
    );
    expect(second.generation_id).not.toBe(first.generation_id);
    database.connection.prepare(`
      DELETE FROM source_records WHERE workspace_id = ? AND record_id = ?
    `).run("workspace-1", intervening.identity);
    projectionLifecycle.rebuild("workspace-1", "2026-08-16T00:02:00.000Z");

    const replay = querySession.pinActiveGeneration(
      "workspace-1",
      "2026-08-16T00:02:00.000Z"
    );
    const after = fieldRepos.generations.readArtifacts("workspace-1", replay.generation_id)!;
    expect(replay.generation_id).toBe(first.generation_id);
    expect(after.artifact_digest).toBe(before.artifact_digest);
    expect(after.artifacts_json).toBe(before.artifacts_json);
    const pointer = database.connection.prepare(`
      SELECT activated_at FROM projection_generation_pointer WHERE workspace_id = ?
    `).get("workspace-1") as { readonly activated_at: string };
    const activation = database.connection.prepare(`
      SELECT payload_json FROM event_log
      WHERE event_type = ? AND workspace_id = ?
      ORDER BY revision DESC LIMIT 1
    `).get(
      FieldGenerationEventType.SOUL_FIELD_GENERATION_ACTIVATED,
      "workspace-1"
    ) as { readonly payload_json: string };
    expect(JSON.parse(activation.payload_json)).toMatchObject({
      activated_at: pointer.activated_at
    });
  });

  it("rebuilds when authoritative evidence health changes", () => {
    const {
      database, eventLogRepo, fieldRepos, projectionLifecycle, querySession, stores
    } = openComposition();
    seedProjectionSource(stores);
    const first = querySession.pinActiveGeneration("workspace-1", CLOCK);
    eventLogRepo.append({
      event_type: MemoryGovernanceEventType.SOUL_EVIDENCE_HEALTH_CHANGED,
      entity_type: "evidence_capsule",
      entity_id: "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9",
      workspace_id: "workspace-1",
      run_id: "run-1",
      caused_by: "system",
      payload_json: SoulEvidenceHealthChangedPayloadSchema.parse({
        object_id: "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9",
        object_kind: "evidence_capsule",
        workspace_id: "workspace-1",
        run_id: "run-1",
        from_state: "verified",
        to_state: "broken",
        reason_code: "test_transition",
        caused_by: "system",
        evidence_refs: null,
        occurred_at: "2026-08-16T00:01:00.000Z"
      })
    });
    database.connection.prepare(`
      UPDATE evidence_capsules
      SET evidence_health_state = 'broken', updated_at = ?
      WHERE workspace_id = ? AND object_id = ?
    `).run(
      "2026-08-16T00:01:00.000Z",
      "workspace-1",
      "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9"
    );

    const historical = projectionLifecycle.rebuild(
      "workspace-1", "2026-08-16T00:00:30.000Z"
    );
    expect(historical.generation_id).toBe(first.generation_id);
    const next = projectionLifecycle.rebuild(
      "workspace-1", "2026-08-16T00:02:00.000Z"
    );
    const artifacts = JSON.parse(fieldRepos.generations.readArtifacts(
      "workspace-1",
      next.generation_id
    )!.artifacts_json) as { slice_keys: Array<{ source_state: unknown }> };
    expect(next.generation_id).not.toBe(first.generation_id);
    expect(artifacts.slice_keys[0]?.source_state).toMatchObject({
      lifecycle_state: "active",
      governance_state: "ordinary_evidence",
      evidence_transitions: [expect.objectContaining({
        kind: "health",
        to_state: "broken"
      })]
    });
  });

  it("reconstructs evidence lifecycle before and after deletion", () => {
    const {
      database, eventLogRepo, fieldRepos, projectionLifecycle, querySession, stores
    } = openComposition();
    seedProjectionSource(stores);
    const first = querySession.pinActiveGeneration("workspace-1", CLOCK);
    eventLogRepo.append({
      event_type: MemoryGovernanceEventType.SOUL_EVIDENCE_DELETED,
      entity_type: "evidence_capsule",
      entity_id: "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9",
      workspace_id: "workspace-1",
      run_id: "run-1",
      caused_by: "system",
      payload_json: SoulEvidenceDeletedPayloadSchema.parse({
        object_id: "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9",
        object_kind: "evidence_capsule",
        workspace_id: "workspace-1",
        run_id: "run-1",
        from_state: "active",
        to_state: "deleted",
        reason_code: "test_transition",
        caused_by: "system",
        evidence_refs: null,
        occurred_at: "2026-08-16T00:01:00.000Z"
      })
    });
    database.connection.prepare(`
      UPDATE evidence_capsules SET lifecycle_state = 'deleted', updated_at = ?
      WHERE workspace_id = ? AND object_id = ?
    `).run(
      "2026-08-16T00:01:00.000Z",
      "workspace-1",
      "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9"
    );

    const historical = projectionLifecycle.rebuild(
      "workspace-1", "2026-08-16T00:00:30.000Z"
    );
    expect(historical.generation_id).toBe(first.generation_id);
    const current = projectionLifecycle.rebuild(
      "workspace-1", "2026-08-16T00:02:00.000Z"
    );
    const artifacts = JSON.parse(fieldRepos.generations.readArtifacts(
      "workspace-1", current.generation_id
    )!.artifacts_json) as { slice_keys: Array<{ source_state: unknown }> };
    expect(artifacts.slice_keys[0]?.source_state).toMatchObject({
      lifecycle_state: "active",
      evidence_transitions: [expect.objectContaining({
        kind: "lifecycle",
        to_state: "deleted"
      })]
    });
  });

  it("retains a retired generation while its reader lease is renewed", () => {
    const { fieldRepos, querySession, stores } = openComposition();
    seedProjectionSource(stores);
    const first = querySession.pinActiveGeneration("workspace-1", CLOCK);
    const renewed = querySession.renew(first, "2026-08-16T00:04:00.000Z");
    stores.putRecord(sourceRecord("Ada revised notes."), "Ada revised notes.");

    const next = querySession.pinActiveGeneration(
      "workspace-1",
      "2026-08-16T00:06:00.000Z"
    );
    expect(next.generation_id).not.toBe(first.generation_id);
    expect(fieldRepos.generations.readPinned("workspace-1", first.generation_id)).not.toBeNull();

    const released = querySession.release(renewed, "2026-08-16T00:06:01.000Z");
    expect(released).toMatchObject({
      reader_id: first.reader_id,
      released_at: "2026-08-16T00:06:01.000Z"
    });
    expect(fieldRepos.generations.readPinned("workspace-1", first.generation_id)).toBeNull();
  });

  it("fails closed when an expired reader was collected before release", () => {
    const { fieldRepos, querySession, stores } = openComposition();
    seedProjectionSource(stores);
    const first = querySession.pinActiveGeneration("workspace-1", CLOCK);
    stores.putRecord(sourceRecord("Ada revised notes."), "Ada revised notes.");

    querySession.pinActiveGeneration("workspace-1", "2026-08-16T00:06:00.000Z");
    expect(fieldRepos.generations.readPinned("workspace-1", first.generation_id)).toBeNull();
    expect(() => querySession.release(first, "2026-08-16T00:06:01.000Z"))
      .toThrow(/projection pin is missing/u);
  });

  it("retains source and drains the durable rebuild request after restart", () => {
    const { database, eventLogRepo, fieldRepos, stores } = openComposition();
    database.connection.exec(`
      CREATE TRIGGER fail_generation_activation_audit
      BEFORE INSERT ON event_log
      WHEN NEW.event_type = '${FieldGenerationEventType.SOUL_FIELD_GENERATION_ACTIVATED}'
      BEGIN
        SELECT RAISE(ABORT, 'planted activation audit failure');
      END;
    `);

    expect(() => seedProjectionSource(stores))
      .toThrow(/append event log/u);
    expect(fieldRepos.generations.readActive("workspace-1")).toBeNull();
    expect(database.connection.prepare(`
      SELECT COUNT(*) AS n FROM source_records WHERE workspace_id = ?
    `).get("workspace-1")).toMatchObject({ n: 1 });
    expect(database.connection.prepare(`
      SELECT COUNT(*) AS n FROM field_projection_rebuild_requests WHERE workspace_id = ?
    `).get("workspace-1")).toMatchObject({ n: 1 });
    expect(database.connection.prepare(`
      SELECT COUNT(*) AS n FROM projection_generations WHERE workspace_id = ?
    `).get("workspace-1")).toMatchObject({ n: 0 });
    expect(database.connection.prepare(`
      SELECT COUNT(*) AS n FROM projection_pins WHERE workspace_id = ?
    `).get("workspace-1")).toMatchObject({ n: 0 });

    database.connection.exec("DROP TRIGGER fail_generation_activation_audit");
    const restarted = createDaemonFieldComposition({
      database,
      eventLogRepo,
      sha256: fieldContractSha256
    });
    expect(restarted.fieldRepos.generations.readActive("workspace-1")).not.toBeNull();
    expect(database.connection.prepare(`
      SELECT COUNT(*) AS n FROM field_projection_rebuild_requests WHERE workspace_id = ?
    `).get("workspace-1")).toMatchObject({ n: 0 });
  });
});

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
  seedEvidence(database, "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9");
}

function seedEvidence(database: StorageDatabase, evidenceId: string): void {
  database.connection.prepare(`
    INSERT INTO evidence_capsules (
      object_id, object_kind, schema_version, lifecycle_state, created_at, updated_at,
      created_by, evidence_kind, semantic_anchor, event_anchor, physical_anchor,
      evidence_health_state, gist, excerpt, source_hash, run_id, workspace_id, surface_id
    ) VALUES (?, 'evidence_capsule', 1, 'active', ?, ?, 'system', 'user_statement',
      ?, NULL, NULL, 'verified', 'Ada notes', NULL, NULL, 'run-1', 'workspace-1', NULL)
  `).run(
    evidenceId,
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

function causalReceipt() {
  const causal_key = "delivery_1:mem1";
  const downstream_ref = "mem1";
  const scope = "workspace-1";
  return {
    schema_version: 1 as const,
    producer: "causal_usage_v1",
    consumer: "path_projection",
    identity: hashCausalUsageId({
      causal_key,
      downstream_ref,
      scope,
      operator_id: "causal_usage_v1"
    }, fieldContractSha256),
    replay_rule: "idempotent_same_identity" as const,
    failure_disposition: "fail_closed" as const,
    governance_effect: "none" as const,
    deletion_behavior: "rebuildable" as const,
    workspace_id: "workspace-1",
    causal_key,
    occurred_at: CLOCK,
    downstream_ref,
    weight: 1,
    scope,
    usage_kind: "causal" as const,
    operator_id: "causal_usage_v1",
    recorded_at: CLOCK
  };
}
