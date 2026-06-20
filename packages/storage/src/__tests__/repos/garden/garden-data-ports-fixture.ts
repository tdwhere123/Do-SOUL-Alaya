import { initDatabase, type StorageDatabase } from "../../../sqlite/db.js";
import { createGardenBackgroundDataPorts } from "../../../repos/garden/garden-data-ports.js";

export const trackedDatabases = new Set<StorageDatabase>();

export async function createFixture(): Promise<{
  readonly database: StorageDatabase;
  readonly ports: ReturnType<typeof createGardenBackgroundDataPorts>;
}> {
  const database = initDatabase({ filename: ":memory:" });
  trackedDatabases.add(database);
  seedWorkspace(database, { workspaceId: "workspace-1" });
  seedWorkspace(database, { workspaceId: "workspace-2" });
  seedRun(database, { workspaceId: "workspace-1", runId: "run-1" });
  seedRun(database, { workspaceId: "workspace-2", runId: "run-2" });

  return {
    database,
    ports: createGardenBackgroundDataPorts(database, {
      now: () => "2026-04-15T00:00:00.000Z"
    })
  };
}

export function seedWorkspace(
  database: StorageDatabase,
  params: {
    readonly workspaceId: string;
  }
): void {
  database.connection
    .prepare(
      `INSERT INTO workspaces (
        workspace_id,
        name,
        root_path,
        workspace_kind,
        default_engine_binding,
        workspace_state,
        created_at,
        archived_at,
        default_engine_class
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      params.workspaceId,
      `${params.workspaceId} name`,
      `/tmp/${params.workspaceId}`,
      "local_repo",
      null,
      "active",
      "2026-04-15T00:00:00.000Z",
      null,
      null
    );
}

export function seedRun(
  database: StorageDatabase,
  params: {
    readonly workspaceId: string;
    readonly runId: string;
  }
): void {
  database.connection
    .prepare(
      `INSERT INTO runs (
        run_id,
        workspace_id,
        title,
        goal,
        run_mode,
        engine_binding_id,
        run_state,
        current_surface_id,
        created_at,
        last_active_at,
        engine_class
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      params.runId,
      params.workspaceId,
      `${params.runId} title`,
      null,
      "chat",
      null,
      "idle",
      null,
      "2026-04-15T00:00:00.000Z",
      "2026-04-15T00:00:00.000Z",
      null
    );
}

export function seedMemoryEntry(
  database: StorageDatabase,
  params: {
    readonly objectId: string;
    readonly workspaceId: string;
    readonly runId: string;
    readonly dimension?: string;
    readonly content?: string;
    readonly evidenceRefs?: readonly string[];
    readonly activationScore?: number;
    readonly lastHitAt?: string | null;
    readonly lifecycleState?: string;
    readonly storageTier?: string;
  }
): void {
  database.connection
    .prepare(
      `INSERT INTO memory_entries (
        object_id,
        object_kind,
        schema_version,
        lifecycle_state,
        created_at,
        updated_at,
        created_by,
        dimension,
        source_kind,
        formation_kind,
        scope_class,
        content,
        domain_tags,
        evidence_refs,
        workspace_id,
        run_id,
        surface_id,
        storage_tier,
        activation_score,
        retention_score,
        manifestation_state,
        retention_state,
        decay_profile,
        confidence,
        last_used_at,
        last_hit_at,
        reinforcement_count,
        contradiction_count,
        superseded_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      params.objectId,
      "memory_entry",
      1,
      params.lifecycleState ?? "active",
      "2026-04-15T00:00:00.000Z",
      "2026-04-15T00:00:00.000Z",
      "user",
      params.dimension ?? "fact",
      "user",
      "explicit",
      "project",
      params.content ?? params.objectId,
      "[]",
      JSON.stringify(params.evidenceRefs ?? []),
      params.workspaceId,
      params.runId,
      null,
      params.storageTier ?? "hot",
      params.activationScore ?? 0.5,
      0.5,
      "hint",
      "working",
      "normal",
      0.5,
      null,
      params.lastHitAt ?? "2026-04-15T00:00:00.000Z",
      0,
      0,
      null
    );
}

export function seedEvidenceCapsule(
  database: StorageDatabase,
  params: {
    readonly objectId: string;
    readonly workspaceId: string;
    readonly runId: string;
    readonly evidenceHealthState?: string;
    readonly semanticAnchor?: Record<string, unknown>;
  }
): void {
  database.connection
    .prepare(
      `INSERT INTO evidence_capsules (
        object_id,
        object_kind,
        schema_version,
        lifecycle_state,
        created_at,
        updated_at,
        created_by,
        evidence_kind,
        semantic_anchor,
        event_anchor,
        physical_anchor,
        evidence_health_state,
        gist,
        excerpt,
        source_hash,
        run_id,
        workspace_id,
        surface_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      params.objectId,
      "evidence_capsule",
      1,
      "active",
      "2026-04-15T00:00:00.000Z",
      "2026-04-15T00:00:00.000Z",
      "user",
      "observation",
      JSON.stringify(params.semanticAnchor ?? { subject: params.objectId }),
      null,
      null,
      params.evidenceHealthState ?? "verified",
      params.objectId,
      null,
      null,
      params.runId,
      params.workspaceId,
      null
    );
}

export function seedSynthesisCapsule(
  database: StorageDatabase,
  params: {
    readonly objectId: string;
    readonly workspaceId: string;
    readonly runId: string;
    readonly topicKey?: string;
    readonly evidenceRefs?: readonly string[];
    readonly sourceMemoryRefs?: readonly string[];
  }
): void {
  database.connection
    .prepare(
      `INSERT INTO synthesis_capsules (
        object_id,
        object_kind,
        schema_version,
        lifecycle_state,
        created_at,
        updated_at,
        created_by,
        topic_key,
        synthesis_type,
        summary,
        evidence_refs,
        source_memory_refs,
        workspace_id,
        run_id,
        synthesis_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      params.objectId,
      "synthesis_capsule",
      1,
      "active",
      "2026-04-15T00:00:00.000Z",
      "2026-04-15T00:00:00.000Z",
      "user",
      params.topicKey ?? `${params.objectId}.topic`,
      "phase_synthesis",
      params.objectId,
      JSON.stringify(params.evidenceRefs ?? []),
      JSON.stringify(params.sourceMemoryRefs ?? []),
      params.workspaceId,
      params.runId,
      "working"
    );
}

export function seedClaimForm(
  database: StorageDatabase,
  params: {
    readonly objectId: string;
    readonly workspaceId: string;
    readonly evidenceRefs: readonly string[];
    readonly sourceObjectRefs: readonly string[];
    readonly canonicalKey?: string;
    readonly lifecycleState?: string;
    readonly claimStatus?: string;
  }
): void {
  database.connection
    .prepare(
      `INSERT INTO claim_forms (
        object_id,
        object_kind,
        schema_version,
        lifecycle_state,
        created_at,
        updated_at,
        created_by,
        governance_subject,
        claim_kind,
        scope_class,
        enforcement_level,
        origin_tier,
        precedence_basis,
        proposition_digest,
        evidence_refs,
        source_object_refs,
        workspace_id,
        claim_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      params.objectId,
      "claim_form",
      1,
      params.lifecycleState ?? "active",
      "2026-04-15T00:00:00.000Z",
      "2026-04-15T00:00:00.000Z",
      "user",
      JSON.stringify({ canonical_key: params.canonicalKey ?? params.objectId }),
      "constraint",
      "project",
      "strict",
      "user_explicit",
      "authority",
      params.objectId,
      JSON.stringify(params.evidenceRefs),
      JSON.stringify(params.sourceObjectRefs),
      params.workspaceId,
      params.claimStatus ?? "draft"
    );
}

export function seedGreenStatus(
  database: StorageDatabase,
  params: {
    readonly objectId: string;
    readonly workspaceId: string;
    readonly targetObjectId: string;
    readonly verificationBasis?: string;
    readonly greenState?: string;
    readonly validUntil: string | null;
  }
): void {
  database.connection
    .prepare(
      `INSERT INTO green_statuses (
        object_id,
        object_kind,
        schema_version,
        lifecycle_state,
        created_at,
        updated_at,
        created_by,
        target_object_id,
        target_object_kind,
        green_state,
        verification_basis,
        verified_by,
        verified_at,
        valid_until,
        bound_surfaces,
        bound_scope_class,
        revoke_reason,
        last_transition_at,
        workspace_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      params.objectId,
      "green_status",
      1,
      "active",
      "2026-04-15T00:00:00.000Z",
      "2026-04-15T00:00:00.000Z",
      "system",
      params.targetObjectId,
      "memory_entry",
      params.greenState ?? "eligible",
      params.verificationBasis ?? "active_verification",
      "auditor",
      "2026-04-15T00:00:00.000Z",
      params.validUntil,
      "[]",
      "project",
      "none",
      "2026-04-15T00:00:00.000Z",
      params.workspaceId
    );
}

export function seedRecallsPath(
  database: StorageDatabase,
  params: {
    readonly pathId: string;
    readonly workspaceId: string;
    readonly sourceObjectId: string;
    readonly targetObjectId: string;
  }
): void {
  database.connection
    .prepare(
      `INSERT INTO path_relations (
        path_id,
        workspace_id,
        anchors_json,
        constitution_json,
        effect_vector_json,
        plasticity_state_json,
        lifecycle_json,
        legitimacy_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      params.pathId,
      params.workspaceId,
      JSON.stringify({
        source_anchor: { kind: "object", object_id: params.sourceObjectId },
        target_anchor: { kind: "object", object_id: params.targetObjectId }
      }),
      JSON.stringify({
        relation_kind: "recalls",
        why_this_relation_exists: ["co_recall"]
      }),
      JSON.stringify({
        salience: 0.3,
        recall_bias: 0.3,
        verification_bias: 0,
        unfinishedness_bias: 0,
        default_manifestation_preference: "stance_bias"
      }),
      JSON.stringify({
        strength: 0.3,
        direction_bias: "source_to_target",
        stability_class: "volatile",
        support_events_count: 1,
        contradiction_events_count: 0
      }),
      JSON.stringify({
        status: "active",
        retirement_rule: "retire_after_cooldown"
      }),
      JSON.stringify({
        evidence_basis: ["evidence-1"],
        governance_class: "hint_only"
      }),
      "2026-04-15T00:00:00.000Z",
      "2026-04-15T00:00:00.000Z"
    );
}
