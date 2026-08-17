import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GovernanceResolutionPayloadSchema,
  canonicalGovernanceSubject,
  type ClaimForm,
  type ContextDeliveryRecord,
  type EffectDecisionReceipt,
  type MemoryEntry
} from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "@do-soul/alaya-core";
import {
  initDatabase,
  SqliteEventLogRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { createDaemonFieldComposition } from
  "../../../runtime/field/field-composition.js";
import { createResolutionEffectAuthority } from
  "../../../runtime/recall-materialization/resolution-effect-authority.js";
import { resolveDeliveredTargetSources } from
  "../../../mcp-memory/tool/resolution-delivery-scope.js";

const WORKSPACE_ID = "workspace-1";
const CLAIM_ID = "590b6f34-7ea5-4f9b-ae74-fe8d4f5af96a";
const MEMORY_ID = "11111111-1111-4111-8111-111111111111";
const EVIDENCE_ID = "evidence-1";
const DELIVERED_AT = "2026-08-16T00:00:00.000Z";
const tracked = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of tracked) database.close();
  tracked.clear();
});

describe("resolution effect authority", () => {
  it("derives an idempotent request-local decision from delivery and grounded source truth", async () => {
    const fixture = openAuthority();
    const first = await fixture.authority.effectAuthority.decide(proofInput());
    const replay = await fixture.authority.effectAuthority.decide(proofInput());
    expect(first).toMatchObject({
      decision: "allow",
      workspace_id: WORKSPACE_ID,
      actor_id: "codex",
      delivery_id: "delivery-1"
    });
    expect(replay).toEqual(first);
    expect(first.supporting_proof_witnesses.map((witness) => witness.kind)).toEqual([
      "actor_authority",
      "source_grounding",
      "governance_snapshot"
    ]);
  });

  it("fails closed for mismatched caller authority and erased source grounding", async () => {
    const fixture = openAuthority();
    await expect(fixture.authority.deliveryAuthority.authorize({
      workspaceId: WORKSPACE_ID,
      actorId: "other-agent",
      runId: "run-1",
      deliveryId: "delivery-1",
      targetObjectId: CLAIM_ID
    })).resolves.toBeNull();

    fixture.field.fieldRepos.erase.apply({
      barrier_id: "erase-source-1",
      workspace_id: WORKSPACE_ID,
      generation_id: null,
      subject_kind: "source_record",
      subject_id: "source-record-1",
      erased_at: DELIVERED_AT
    });
    const decision = await fixture.authority.effectAuthority.decide(proofInput());
    expect(decision.supporting_proof_witnesses.map((witness) => witness.kind))
      .toEqual(["actor_authority", "governance_snapshot"]);
    expect(decision.decision).toBe("deny");
  });

  it("rejects a commit when competing governance facts change after decision", async () => {
    const fixture = openAuthority();
    const decision = await fixture.authority.effectAuthority.decide({
      ...proofInput(),
      effectiveAsOf: "2026-08-17T00:00:00.000Z"
    });
    expect(decision.recorded_at).toBe("2026-08-17T00:00:00.000Z");

    fixture.database.connection.prepare(`
      INSERT INTO claim_forms (
        object_id, object_kind, schema_version, lifecycle_state, created_at, updated_at,
        created_by, governance_subject, claim_kind, scope_class, enforcement_level,
        origin_tier, precedence_basis, proposition_digest, evidence_refs,
        source_object_refs, workspace_id, claim_status
      ) SELECT ?, object_kind, schema_version, lifecycle_state, ?, ?, created_by,
        governance_subject, claim_kind, scope_class, enforcement_level, origin_tier,
        precedence_basis, ?, evidence_refs, source_object_refs, workspace_id, claim_status
      FROM claim_forms WHERE object_id = ?
    `).run(
      "competing-claim", "2026-08-16T12:00:00.000Z", "2026-08-16T12:00:00.000Z",
      "Competing proposition.", CLAIM_ID
    );

    expect(() => fixture.field.fieldRepos.effects.insert(effectRow(decision)))
      .toThrow(/snapshot is stale/u);
  });

  it("rejects a commit when the delivery authority facts do not match", async () => {
    const fixture = openAuthority();
    const decision = await fixture.authority.effectAuthority.decide(proofInput());
    fixture.database.connection.prepare(`
      UPDATE event_log SET caused_by = ? WHERE event_id = ?
    `).run("other-agent", "delivery-audit-1");

    expect(() => fixture.field.fieldRepos.effects.insert(effectRow(decision)))
      .toThrow(/authority event is stale/u);
  });

  it("persists correction predecessor and successor receipts against the audit payload", async () => {
    const fixture = openAuthority();
    const correction = "Use the workspace package manager.";
    const decision = await fixture.authority.effectAuthority.decide({
      ...proofInput(),
      action: "correct",
      correction,
      effectiveAsOf: "2026-08-17T00:00:00.000Z"
    });
    const predecessor = decision.supporting_proof_witnesses.find(
      (witness) => witness.kind === "predecessor"
    );
    const successor = decision.supporting_proof_witnesses.find(
      (witness) => witness.kind === "successor"
    );
    expect(decision.decision).toBe("allow");
    expect(predecessor).toBeDefined();
    expect(successor).toBeDefined();
    fixture.database.connection.prepare(`
      INSERT INTO event_log (
        event_id, event_type, entity_type, entity_id, workspace_id, run_id,
        caused_by, revision, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "correct-audit-1", "soul.resolution.correct_applied", "soul_resolution",
      CLAIM_ID, WORKSPACE_ID, "run-1", "codex", 0,
      JSON.stringify(GovernanceResolutionPayloadSchema.parse({
        target_object_id: CLAIM_ID,
        resolution: "correct",
        workspace_id: WORKSPACE_ID,
        run_id: "run-1",
        agent_target: "codex",
        delivery_id: "delivery-1",
        policy: null,
        policy_classification: null,
        reason: null,
        correction,
        obligation_id: null,
        activated_claim_id: null,
        predecessor_receipt_id: predecessor!.receipt_id,
        successor_receipt_id: successor!.receipt_id,
        occurred_at: "2026-08-17T00:00:00.000Z"
      })),
      "2026-08-17T00:00:00.000Z"
    );

    const effect = effectRow(decision);
    const stored = fixture.field.fieldRepos.effects.insert(effect);
    expect(JSON.parse(stored.supporting_proof_witnesses_json)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "predecessor" }),
        expect.objectContaining({ kind: "successor" })
      ])
    );
    fixture.database.connection.prepare(`
      UPDATE claim_forms SET updated_at = ? WHERE object_id = ?
    `).run("2026-08-18T00:00:00.000Z", CLAIM_ID);
    expect(fixture.field.fieldRepos.effects.insert(effect)).toEqual(stored);
  });

  it("keeps direct memory correction on the same durable effect path", async () => {
    const fixture = openAuthority();
    const correction = "Use the corrected build command.";
    const decision = await fixture.authority.effectAuthority.decide({
      ...proofInput(),
      targetObjectId: MEMORY_ID,
      action: "correct",
      correction,
      effectiveAsOf: "2026-08-17T00:00:00.000Z"
    });
    const predecessor = decision.supporting_proof_witnesses.find(
      (witness) => witness.kind === "predecessor"
    )!;
    const successor = decision.supporting_proof_witnesses.find(
      (witness) => witness.kind === "successor"
    )!;
    insertCorrectionAudit(
      fixture.database,
      MEMORY_ID,
      correction,
      predecessor.receipt_id,
      successor.receipt_id
    );

    expect(decision.decision).toBe("allow");
    expect(fixture.field.fieldRepos.effects.insert(effectRow(decision)).action).toBe("correct");
  });

  it("limits legacy id-only scope to memories and rejects typed kind collisions", () => {
    const legacy = { delivered_object_ids: [CLAIM_ID], agent_target: "codex",
      workspace_id: WORKSPACE_ID, run_id: "run-1" };
    expect(resolveDeliveredTargetSources(legacy, CLAIM_ID, [])).toBeNull();
    expect(resolveDeliveredTargetSources(legacy, CLAIM_ID, null)).toEqual([CLAIM_ID]);

    expect(resolveDeliveredTargetSources({
      ...legacy,
      delivered_objects: [{ object_id: CLAIM_ID, object_kind: "memory_entry" }]
    }, CLAIM_ID, [MEMORY_ID])).toBeNull();
  });
});

function openAuthority() {
  const database = initDatabase({ filename: ":memory:" });
  tracked.add(database);
  seedWorkspaceAndSource(database);
  const field = createDaemonFieldComposition({
    database,
    eventLogRepo: new SqliteEventLogRepo(database),
    sha256: fieldContractSha256
  });
  const claim = claimForm();
  const authority = createResolutionEffectAuthority({
    database,
    fieldComposition: field,
    claimRepo: {
      findById: vi.fn(async (id) => id === CLAIM_ID ? claim : null),
      findByCanonicalKey: vi.fn(async () => [claim])
    },
    memoryRepo: {
      findByIds: vi.fn(async (_workspaceId, ids) =>
        ids.includes(MEMORY_ID) ? [memoryEntry()] : [])
    },
    deliveryReader: {
      findDeliveryById: vi.fn(async (id) => id === "delivery-1" ? delivery() : null)
    }
  });
  return { authority, database, field };
}

function seedWorkspaceAndSource(database: StorageDatabase): void {
  database.connection.prepare(`
    INSERT INTO workspaces (
      workspace_id, name, root_path, workspace_kind, default_engine_binding,
      workspace_state, created_at, archived_at, default_engine_class
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(WORKSPACE_ID, "Workspace", "/tmp/workspace-1", "local_repo",
    null, "active", "2026-08-15T00:00:00.000Z", null, null);
  const claim = claimForm();
  database.connection.prepare(`
    INSERT INTO claim_forms (
      object_id, object_kind, schema_version, lifecycle_state, created_at, updated_at,
      created_by, governance_subject, claim_kind, scope_class, enforcement_level,
      origin_tier, precedence_basis, proposition_digest, evidence_refs,
      source_object_refs, workspace_id, claim_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    claim.object_id, claim.object_kind, claim.schema_version, claim.lifecycle_state,
    claim.created_at, claim.updated_at, claim.created_by, JSON.stringify(claim.governance_subject),
    claim.claim_kind, claim.scope_class, claim.enforcement_level, claim.origin_tier,
    claim.precedence_basis, claim.proposition_digest, JSON.stringify(claim.evidence_refs),
    JSON.stringify(claim.source_object_refs), claim.workspace_id, claim.claim_status
  );
  const memory = memoryEntry();
  database.connection.prepare(`
    INSERT INTO memory_entries (
      object_id, object_kind, schema_version, lifecycle_state, created_at, updated_at,
      created_by, dimension, source_kind, formation_kind, scope_class, content,
      domain_tags, evidence_refs, workspace_id, run_id, surface_id, storage_tier
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    memory.object_id, memory.object_kind, memory.schema_version, memory.lifecycle_state,
    memory.created_at, memory.updated_at, memory.created_by, memory.dimension,
    memory.source_kind, memory.formation_kind, memory.scope_class, memory.content,
    JSON.stringify(memory.domain_tags), JSON.stringify(memory.evidence_refs),
    memory.workspace_id, memory.run_id, memory.surface_id, memory.storage_tier
  );
  database.connection.prepare(`
    INSERT INTO event_log (
      event_id, event_type, entity_type, entity_id, workspace_id, run_id,
      caused_by, revision, payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "delivery-audit-1", "memory.delivered", "trust_context_delivery", "delivery-1",
    WORKSPACE_ID, "run-1", "codex", 0, JSON.stringify({
      delivery_id: "delivery-1",
      agent_target: "codex",
      delivered_object_ids: [CLAIM_ID, MEMORY_ID],
      delivered_at: DELIVERED_AT,
      recorded_at: DELIVERED_AT
    }), DELIVERED_AT
  );
  database.connection.prepare(`
    INSERT INTO source_records (
      workspace_id, record_id, source_id, source_version, content_digest,
      evidence_object_id, recorded_at, event_time, valid_from, valid_to,
      operator_id, source_body
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    WORKSPACE_ID, "source-record-1", "turn-1", "v1", "digest-1",
    EVIDENCE_ID, "2026-08-15T01:00:00.000Z", "2026-08-15T00:30:00.000Z",
    "2026-08-15T00:30:00.000Z", null, "source.capture.v1", "grounded"
  );
  database.connection.prepare(`
    INSERT INTO source_record_evidence_refs (workspace_id, record_id, evidence_object_id)
    VALUES (?, ?, ?)
  `).run(WORKSPACE_ID, "source-record-1", EVIDENCE_ID);
}

function memoryEntry(): MemoryEntry {
  return {
    object_id: MEMORY_ID,
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-08-15T00:00:00.000Z",
    updated_at: "2026-08-15T00:00:00.000Z",
    created_by: "user",
    dimension: "procedure",
    source_kind: "user",
    formation_kind: "explicit",
    scope_class: "project",
    content: "Use npm.",
    domain_tags: [],
    evidence_refs: [EVIDENCE_ID],
    workspace_id: WORKSPACE_ID,
    run_id: "run-1",
    surface_id: null,
    storage_tier: "hot",
    activation_score: 0.5,
    retention_score: 0.5,
    manifestation_state: "excerpt",
    retention_state: "working",
    decay_profile: "stable",
    confidence: 0.9,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: 0,
    contradiction_count: 0,
    superseded_by: null
  };
}

function insertCorrectionAudit(
  database: StorageDatabase,
  target: string,
  correction: string,
  predecessorReceiptId: string,
  successorReceiptId: string
): void {
  database.connection.prepare(`
    INSERT INTO event_log (
      event_id, event_type, entity_type, entity_id, workspace_id, run_id,
      caused_by, revision, payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `correct-audit-${target}`, "soul.resolution.correct_applied", "soul_resolution",
    target, WORKSPACE_ID, "run-1", "codex", 0,
    JSON.stringify(GovernanceResolutionPayloadSchema.parse({
      target_object_id: target,
      resolution: "correct",
      workspace_id: WORKSPACE_ID,
      run_id: "run-1",
      agent_target: "codex",
      delivery_id: "delivery-1",
      policy: null,
      policy_classification: null,
      reason: null,
      correction,
      obligation_id: null,
      activated_claim_id: null,
      predecessor_receipt_id: predecessorReceiptId,
      successor_receipt_id: successorReceiptId,
      occurred_at: "2026-08-17T00:00:00.000Z"
    })),
    "2026-08-17T00:00:00.000Z"
  );
}

function effectRow(receipt: EffectDecisionReceipt) {
  return {
    schema_version: receipt.schema_version,
    request_digest: receipt.request_digest,
    workspace_id: receipt.workspace_id,
    actor_id: receipt.actor_id,
    run_id: receipt.run_id,
    delivery_id: receipt.delivery_id,
    action: receipt.action,
    target: receipt.target,
    scope: receipt.scope,
    effective_as_of: receipt.effective_as_of,
    decision: receipt.decision,
    supporting_receipt_ids_json: JSON.stringify(receipt.supporting_receipt_ids),
    supporting_proof_witnesses_json: JSON.stringify(receipt.supporting_proof_witnesses),
    governance_frontier: receipt.governance_frontier,
    policy_operator_id: receipt.policy_operator_id,
    policy_operator_version: receipt.policy_operator_version,
    recorded_at: receipt.recorded_at
  };
}

function claimForm(): ClaimForm {
  return {
    object_id: CLAIM_ID,
    object_kind: "claim_form",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-08-15T00:00:00.000Z",
    updated_at: "2026-08-15T00:00:00.000Z",
    created_by: "user",
    governance_subject: canonicalGovernanceSubject("tooling", { manager: "pnpm" }),
    claim_kind: "constraint",
    scope_class: "project",
    enforcement_level: "strict",
    origin_tier: "user_explicit",
    precedence_basis: "authority",
    proposition_digest: "Use pnpm.",
    evidence_refs: [EVIDENCE_ID],
    source_object_refs: [MEMORY_ID],
    workspace_id: WORKSPACE_ID,
    claim_status: "draft"
  };
}

function delivery(): ContextDeliveryRecord {
  return {
    delivery_id: "delivery-1",
    agent_target: "codex",
    workspace_id: WORKSPACE_ID,
    run_id: "run-1",
    delivered_object_ids: [CLAIM_ID, MEMORY_ID],
    delivered_objects: [
      { object_id: CLAIM_ID, object_kind: "claim_form" },
      { object_id: MEMORY_ID, object_kind: "memory_entry" }
    ],
    delivered_at: DELIVERED_AT,
    audit_event_id: "delivery-audit-1"
  };
}

function proofInput() {
  return {
    workspaceId: WORKSPACE_ID,
    actorId: "codex",
    runId: "run-1",
    deliveryId: "delivery-1",
    targetObjectId: CLAIM_ID,
    scope: WORKSPACE_ID,
    effectiveAsOf: DELIVERED_AT,
    action: "activate" as const
  };
}
