import { afterEach, describe, expect, it } from "vitest";
import { createAlayaRuntime } from "../index.js";
import type { EvidenceCapsule, MemoryEntry } from "../index.js";
import {
  projectReadOnlyTopology,
  resolveManifestations,
  validateActivationCandidate,
  validatePathRelation
} from "../structure/index.js";
import type { ActivationCandidate, ManifestationBudgetConfig, PathRelation } from "../structure/index.js";
import { AuditedMutationExecutionError, AlayaValidationError } from "../runtime/audit-types.js";
import { createTempDir, type TempDir } from "./helpers.js";

const now = "2026-04-27T00:00:00.000Z";

describe("structure contracts", () => {
  const tempDirs: TempDir[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((entry) => entry.cleanup()));
  });

  it("requires the full six-group PathRelation constitution", () => {
    const relation = pathRelation("path-1");
    expect(validatePathRelation(relation)).toEqual(relation);

    expect(() => validatePathRelation({
      ...relation,
      legitimacy: {
        evidence_basis: [],
        governance_class: "recall_allowed"
      }
    })).toThrow(AlayaValidationError);
  });

  it("keeps ActivationCandidate as runtime-only validation data", () => {
    const candidate = activationCandidate("candidate-1", "workspace-1", "run-1");
    expect(validateActivationCandidate(candidate)).toEqual(candidate);
    expect(Object.keys(candidate)).not.toContain("created_by");
    expect(Object.keys(candidate)).not.toContain("lifecycle_state");
  });

  it("enforces workspace/run filtering, task coupling, governance ceiling, and budget", () => {
    const decisions = resolveManifestations({
      workspaceId: "workspace-1",
      runId: "run-1",
      taskSurfaceRef: { context_refs: ["object-a"] },
      budgetConfig: budget(),
      candidates: [
        activationCandidate("candidate-lens", "workspace-1", "run-1"),
        {
          ...activationCandidate("candidate-low-governance", "workspace-1", "run-1"),
          governance_ceiling: "hint_only"
        },
        activationCandidate("candidate-other-run", "workspace-1", "run-other")
      ]
    });

    expect(decisions.map((decision) => [decision.candidate_id, decision.assigned_level, decision.reason])).toEqual([
      ["candidate-lens", "lens_entry", "assigned:lens_entry"],
      [
        "candidate-low-governance",
        "dialogue_nudge",
        "assigned:dialogue_nudge; blocked:governance_ceiling"
      ]
    ]);
  });

  it("derives topology from active path relations without mutating input", () => {
    const relation = pathRelation("path-topology");
    const retired = pathRelation("path-retired-topology", "retired");
    const input = [retired, relation];
    const before = JSON.stringify(input);
    const topology = projectReadOnlyTopology(input);

    expect(JSON.stringify(input)).toBe(before);
    expect(topology.derived_from).toBe("active_path_relation");
    expect(topology.nodes.map((node) => node.id)).toEqual(["object:object-a", "object:object-b"]);
    expect(topology.edges).toEqual([
      expect.objectContaining({
        id: "path-topology",
        source_path_id: "path-topology",
        governance_class: "recall_allowed"
      })
    ]);
  });

  it("uses runtime-owned by-id, anchor, and active path lookups for persisted paths", async () => {
    const temp = await createTempDir("alaya-structure-runtime-");
    tempDirs.push(temp);
    const runtime = await createAlayaRuntime({ dataDir: temp.path });
    try {
      await seedOntology(runtime);
      await runtime.createPathRelation({
        relation: pathRelation("path-active", "active"),
        ...audit()
      });
      await runtime.createPathRelation({
        relation: pathRelation("path-retired", "retired"),
        ...audit()
      });

      await expect(runtime.getPathRelation("path-active")).resolves.toMatchObject({ path_id: "path-active" });
      await expect(runtime.listPathRelations("workspace-1")).resolves.toHaveLength(2);
      await expect(runtime.listActivePathRelations("workspace-1")).resolves.toEqual([
        expect.objectContaining({ path_id: "path-active" })
      ]);
      await expect(runtime.listPathRelationsByAnchor("workspace-1", { kind: "object", object_id: "object-a" })).resolves.toHaveLength(2);
      await expect(runtime.projectTopology("workspace-1")).resolves.toMatchObject({
        edges: [expect.objectContaining({ id: "path-active" })]
      });
    } finally {
      await runtime.close();
    }
  });

  it("rejects durable path relations with missing evidence or missing strict governance approval", async () => {
    const temp = await createTempDir("alaya-structure-governed-");
    tempDirs.push(temp);
    const runtime = await createAlayaRuntime({ dataDir: temp.path });
    try {
      await seedOntology(runtime);

      await expectAuditedMutationFailure(runtime.createPathRelation({
        relation: {
          ...pathRelation("path-missing-evidence"),
          legitimacy: {
            evidence_basis: ["missing-evidence"],
            governance_class: "recall_allowed"
          }
        },
        ...audit()
      }), /Evidence reference not found/);

      await expectAuditedMutationFailure(runtime.createPathRelation({
        relation: {
          ...pathRelation("path-missing-anchor"),
          anchors: {
            source_anchor: { kind: "object", object_id: "missing-object" },
            target_anchor: { kind: "object", object_id: "object-b" }
          }
        },
        ...audit()
      }), /Ontology reference not found/);

      await expectAuditedMutationFailure(runtime.createPathRelation({
        relation: {
          ...pathRelation("path-strict"),
          legitimacy: {
            evidence_basis: ["ev-structure"],
            governance_class: "strictly_governed"
          }
        },
        ...audit()
      }), /requires governance approval/);

      await expect(runtime.createPathRelation({
        relation: {
          ...pathRelation("path-strict-approved"),
          legitimacy: {
            evidence_basis: ["ev-structure"],
            governance_class: "strictly_governed"
          }
        },
        governanceReceipt: {
          approved: true,
          actor: "operator",
          reason: "approved governed path",
          decided_at: now
        },
        ...audit()
      })).resolves.toMatchObject({ committed: true });
    } finally {
      await runtime.close();
    }
  });
});

function pathRelation(pathId: string, lifecycleState: PathRelation["lifecycle"]["state"] = "active"): PathRelation {
  return {
    path_id: pathId,
    workspace_id: "workspace-1",
    anchors: {
      source_anchor: { kind: "object", object_id: "object-a" },
      target_anchor: { kind: "object", object_id: "object-b" }
    },
    constitution: {
      relation_kind: "supports",
      why_this_relation_exists: ["shared task evidence"]
    },
    effect_vector: {
      salience: 0.9,
      recall_bias: 0.8,
      verification_bias: 0.4,
      unfinishedness_bias: 0.2,
      default_manifestation_preference: "lens_entry"
    },
    plasticity_state: {
      strength: 0.8,
      direction_bias: "source_to_target",
      stability_class: "stable",
      support_events_count: 1,
      contradiction_events_count: 0
    },
    lifecycle: {
      state: lifecycleState,
      retirement_rule: "retire when source object is tombstoned"
    },
    legitimacy: {
      evidence_basis: ["ev-structure"],
      governance_class: "recall_allowed"
    },
    created_at: now,
    updated_at: now
  };
}

function audit() {
  return {
    source: {
      kind: "test",
      ref: "structure.test"
    },
    evidence: [
      {
        kind: "test",
        ref: "structure.test"
      }
    ],
    actor: "vitest"
  } as const;
}

async function seedOntology(runtime: Awaited<ReturnType<typeof createAlayaRuntime>>): Promise<void> {
  await runtime.createEvidenceCapsule({
    record: evidence(),
    ...audit()
  });
  await runtime.createMemoryEntry({
    record: memory("object-a"),
    ...audit()
  });
  await runtime.createMemoryEntry({
    record: memory("object-b"),
    ...audit()
  });
}

function evidence(): EvidenceCapsule {
  return {
    object_id: "ev-structure",
    object_kind: "evidence_capsule",
    schema_version: 1,
    created_at: now,
    updated_at: now,
    created_by: "test",
    lifecycle_state: "active",
    evidence_kind: "user_statement",
    semantic_anchor: {
      topic: "structure",
      keywords: ["path"],
      summary: "path evidence"
    },
    event_anchor: null,
    physical_anchor: null,
    evidence_health_state: "verified",
    gist: "path evidence",
    excerpt: null,
    source_hash: "hash-structure",
    run_id: "run-1",
    workspace_id: "workspace-1",
    surface_id: null
  };
}

function memory(objectId: string): MemoryEntry {
  return {
    object_id: objectId,
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
    content: `Memory ${objectId}`,
    domain_tags: ["structure"],
    evidence_refs: ["ev-structure"],
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

function activationCandidate(
  candidateId: string,
  workspaceId: string,
  runId: string
): ActivationCandidate {
  const relation = pathRelation("path-1");
  return {
    candidate_id: candidateId,
    workspace_id: workspaceId,
    run_id: runId,
    source_path_id: relation.path_id,
    source_anchor: relation.anchors.source_anchor,
    target_anchor: relation.anchors.target_anchor,
    why_now: "task mentions the source object",
    effect_vector_snapshot: relation.effect_vector,
    pressure: 0.95,
    confidence: 0.95,
    governance_ceiling: "recall_allowed",
    created_at: now
  };
}

function budget(): ManifestationBudgetConfig {
  return {
    workspace_id: "workspace-1",
    stance_bias_cap: 1,
    dialogue_nudge_cap: 1,
    lens_entry_cap: 1,
    escalation_policy: {
      nudge_min_pressure: 0.5,
      nudge_min_confidence: 0.5,
      lens_min_pressure: 0.8,
      lens_min_confidence: 0.8,
      lens_requires_task_coupling: true,
      lens_requires_governance_ceiling: true
    },
    updated_at: now
  };
}

async function expectAuditedMutationFailure(promise: Promise<unknown>, message: RegExp): Promise<void> {
  const rejection = await promise.catch((error: unknown) => error);
  expect(rejection).toBeInstanceOf(AuditedMutationExecutionError);
  expect((rejection as AuditedMutationExecutionError).failure.message).toMatch(message);
}
