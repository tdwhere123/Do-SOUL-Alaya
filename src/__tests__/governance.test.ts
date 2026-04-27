import { afterEach, describe, expect, it } from "vitest";
import { createAlayaRuntime } from "../index.js";
import type { EvidenceCapsule, MemoryEntry } from "../index.js";
import { AuditedMutationExecutionError } from "../runtime/audit-types.js";
import {
  detectGovernanceBypass,
  evaluateGovernanceAction,
  evaluatePromotionGate
} from "../governance/index.js";
import type { PromotionCandidate, PromotionGate } from "../governance/index.js";
import { SqliteAlayaStorage } from "../storage/sqlite.js";
import { createTempDir, type TempDir } from "./helpers.js";

const now = "2026-04-27T00:00:00.000Z";

describe("governance and promotion policy", () => {
  const tempDirs: TempDir[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((entry) => entry.cleanup()));
  });

  it("promotes preferences only when source, evidence, and gate conditions are satisfied", () => {
    expect(evaluatePromotionGate(candidate("preference"), gate())).toMatchObject({
      outcome: "durable",
      lifecycle_state: "durable",
      reason: "gate_satisfied"
    });

    expect(evaluatePromotionGate({
      ...candidate("fact"),
      stability_duration_ms: 0
    }, gate())).toMatchObject({
      outcome: "candidate",
      lifecycle_state: "candidate",
      reason: "gate_unmet:min_stability_duration"
    });
  });

  it("keeps hazards and high-risk candidates pending review unless HITL approved", () => {
    expect(evaluatePromotionGate(candidate("hazard"), gate())).toMatchObject({
      outcome: "pending_review",
      hitl_required: true
    });

    expect(evaluatePromotionGate({
      ...candidate("hazard"),
      governance_receipt: {
        approved: true,
        actor: "operator",
        reason: "confirmed safety memory",
        decided_at: now
      }
    }, gate())).toMatchObject({
      outcome: "durable"
    });
  });

  it("requires operator reason and HITL for risky governance actions", () => {
    expect(evaluateGovernanceAction({
      action_class: "global",
      source_refs: ["operator"],
      evidence_refs: ["ev-1"]
    })).toMatchObject({
      outcome: "pending_review",
      reason: "operator_reason_required",
      operator_reason_required: true
    });

    expect(evaluateGovernanceAction({
      action_class: "global",
      source_refs: ["operator"],
      evidence_refs: ["ev-1"],
      operator_reason: "global rule is intentional",
      governance_receipt: {
        approved: true,
        actor: "operator",
        reason: "approved global rule",
        decided_at: now
      }
    })).toMatchObject({
      outcome: "durable",
      reason: "governance_approved"
    });
  });

  it("classifies bypass attempts as blocking fail-closed audit signals", () => {
    expect(detectGovernanceBypass({
      attempted_mutation: "direct-storage-write",
      actor: "test"
    })).toEqual({
      outcome: "not_promoted",
      severity: "blocking",
      reason: "governance_bypass:direct-storage-write",
      recoverable: false
    });
  });

  it("runtime governance decisions resolve source/evidence refs and persist HITL proof", async () => {
    const temp = await createTempDir("alaya-governance-runtime-");
    tempDirs.push(temp);
    const runtime = await createAlayaRuntime({ dataDir: temp.path });
    try {
      await seedOntology(runtime, "verified");
      await runtime.createEvidenceCapsule({
        record: evidence("verified", "ev-governance-2"),
        ...audit()
      });
      const result = await runtime.decidePromotion({
        candidate: {
          ...candidate("hazard"),
          source_refs: ["source-governance"],
          evidence_refs: ["ev-governance", "ev-governance-2"],
          governance_receipt: {
            approved: true,
            actor: "operator",
            reason: "approved hazard memory",
            decided_at: now
          }
        },
        gate: gate(),
        ...audit()
      });

      expect(result.result.outcome).toBe("durable");
    } finally {
      await runtime.close();
    }

    const storage = await SqliteAlayaStorage.open({ dataDir: temp.path });
    try {
      const records = storage.listGovernanceRecords("workspace-1");
      expect(records).toHaveLength(1);
      expect(records[0]?.payload).toMatchObject({
        decision: {
          outcome: "durable"
        },
        candidate: {
          source_refs: ["source-governance"],
          evidence_refs: ["ev-governance", "ev-governance-2"]
        },
        governance_receipt: {
          actor: "operator",
          reason: "approved hazard memory"
        }
      });
    } finally {
      storage.close();
    }
  });

  it("runtime governance actions reject missing and broken evidence refs", async () => {
    const temp = await createTempDir("alaya-governance-evidence-gate-");
    tempDirs.push(temp);
    const runtime = await createAlayaRuntime({ dataDir: temp.path });
    try {
      await seedOntology(runtime, "verified");
      await runtime.createEvidenceCapsule({
        record: evidence("broken", "ev-governance-broken"),
        ...audit()
      });

      await expectAuditedMutationFailure(runtime.evaluateGovernanceAction({
        workspaceId: "workspace-1",
        request: {
          action_class: "global",
          source_refs: ["source-governance"],
          evidence_refs: ["missing-evidence"],
          operator_reason: "global change",
          governance_receipt: {
            approved: true,
            actor: "operator",
            reason: "approved global change",
            decided_at: now
          }
        },
        ...audit()
      }), /Evidence reference not found/);

      await expectAuditedMutationFailure(runtime.evaluateGovernanceAction({
        workspaceId: "workspace-1",
        request: {
          action_class: "global",
          source_refs: ["source-governance"],
          evidence_refs: ["ev-governance-broken"],
          operator_reason: "global change",
          governance_receipt: {
            approved: true,
            actor: "operator",
            reason: "approved global change",
            decided_at: now
          }
        },
        ...audit()
      }), /broken/);
    } finally {
      await runtime.close();
    }
  });
});

function candidate(dimension: PromotionCandidate["dimension"]): PromotionCandidate {
  return {
    target_id: "workspace-1:target-1",
    dimension,
    evidence_refs: ["ev-1", "ev-2"],
    source_refs: ["source-1"],
    stability_duration_ms: 1000,
    active_contradictions: 0,
    scope_determined: true,
    governance_subject_compilable: true,
    high_risk: false
  };
}

function gate(): PromotionGate {
  return {
    conditions: [
      {
        condition_kind: "min_evidence_count",
        threshold: 2,
        required: true
      },
      {
        condition_kind: "min_stability_duration",
        threshold: 1000,
        required: true
      },
      {
        condition_kind: "no_active_contradictions",
        threshold: null,
        required: true
      },
      {
        condition_kind: "scope_determined",
        threshold: null,
        required: true
      },
      {
        condition_kind: "governance_subject_compilable",
        threshold: null,
        required: true
      }
    ]
  };
}

function audit() {
  return {
    source: {
      kind: "test",
      ref: "governance.test"
    },
    evidence: [
      {
        kind: "test",
        ref: "governance.test"
      }
    ],
    actor: "vitest"
  } as const;
}

async function seedOntology(
  runtime: Awaited<ReturnType<typeof createAlayaRuntime>>,
  evidenceHealth: EvidenceCapsule["evidence_health_state"]
): Promise<void> {
  await runtime.createEvidenceCapsule({
    record: evidence(evidenceHealth),
    ...audit()
  });
  await runtime.createMemoryEntry({
    record: memory(),
    ...audit()
  });
}

function evidence(
  health: EvidenceCapsule["evidence_health_state"],
  objectId = "ev-governance"
): EvidenceCapsule {
  return {
    object_id: objectId,
    object_kind: "evidence_capsule",
    schema_version: 1,
    created_at: now,
    updated_at: now,
    created_by: "test",
    lifecycle_state: "active",
    evidence_kind: "user_statement",
    semantic_anchor: {
      topic: "governance",
      keywords: ["promotion"],
      summary: "governance evidence"
    },
    event_anchor: null,
    physical_anchor: null,
    evidence_health_state: health,
    gist: "governance evidence",
    excerpt: null,
    source_hash: "hash-governance",
    run_id: "run-1",
    workspace_id: "workspace-1",
    surface_id: null
  };
}

async function expectAuditedMutationFailure(promise: Promise<unknown>, message: RegExp): Promise<void> {
  const rejection = await promise.catch((error: unknown) => error);
  expect(rejection).toBeInstanceOf(AuditedMutationExecutionError);
  expect((rejection as AuditedMutationExecutionError).failure.message).toMatch(message);
}

function memory(): MemoryEntry {
  return {
    object_id: "source-governance",
    object_kind: "memory_entry",
    schema_version: 1,
    created_at: now,
    updated_at: now,
    created_by: "test",
    lifecycle_state: "active",
    dimension: "fact",
    source_kind: "user",
    formation_kind: "explicit",
    scope_class: "project",
    content: "Governance source memory.",
    domain_tags: ["governance"],
    evidence_refs: ["ev-governance"],
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    storage_tier: "hot",
    activation_score: null,
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
  };
}
