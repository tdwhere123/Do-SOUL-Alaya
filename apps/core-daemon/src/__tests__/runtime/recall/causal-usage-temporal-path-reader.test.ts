import { describe, expect, it } from "vitest";
import {
  CAUSAL_USAGE_OPERATOR_ID,
  hashCausalUsageId,
  type PathRelation
} from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "@do-soul/alaya-core";
import { initDatabase, SqliteFieldCausalUsageRepo } from "@do-soul/alaya-storage";
import { createCausalUsageTemporalPathReader } from
  "../../../runtime/recall/causal-usage-temporal-path-reader.js";

const AS_OF = "2026-08-17T00:00:00.000Z";

describe("causal usage temporal path reader", () => {
  it("replays the same canonical projection after reader restart", async () => {
    const database = initDatabase({ filename: ":memory:" });
    try {
      seedWorkspace(database);
      const usageRepo = new SqliteFieldCausalUsageRepo(database, fieldContractSha256);
      usageRepo.insert(usageRow());
      const base = baseReader(path());

      const first = await createCausalUsageTemporalPathReader({ base, usageRepo })
        .findByWorkspace("workspace-1", { asOf: AS_OF });
      const restarted = await createCausalUsageTemporalPathReader({ base, usageRepo })
        .findByWorkspace("workspace-1", { asOf: AS_OF });

      expect(first[0]?.plasticity_state.strength).toBeCloseTo(1 - Math.exp(-1), 10);
      expect(restarted).toEqual(first);
    } finally {
      database.close();
    }
  });
});

function baseReader(relation: PathRelation) {
  return {
    findByWorkspace: async () => [relation],
    findByAnchors: async () => [relation],
    findByTimeConcernWindowDigests: async () => [relation]
  };
}

function usageRow() {
  const identity = hashCausalUsageId({
    causal_key: "resolution-event-1",
    downstream_ref: "memory-2",
    scope: "workspace-1",
    operator_id: CAUSAL_USAGE_OPERATOR_ID
  }, fieldContractSha256);
  return {
    identity,
    workspace_id: "workspace-1",
    causal_key: "resolution-event-1",
    occurred_at: AS_OF,
    downstream_ref: "memory-2",
    weight: 1,
    scope: "workspace-1",
    usage_kind: "causal" as const,
    operator_id: CAUSAL_USAGE_OPERATOR_ID,
    recorded_at: AS_OF
  };
}

function path(): PathRelation {
  return {
    path_id: "path-1",
    workspace_id: "workspace-1",
    anchors: {
      source_anchor: { kind: "object", object_id: "memory-1" },
      target_anchor: { kind: "object", object_id: "memory-2" }
    },
    constitution: { relation_kind: "supports", why_this_relation_exists: ["evidence"] },
    effect_vector: {
      salience: 0.5,
      recall_bias: 0.5,
      verification_bias: 0,
      unfinishedness_bias: 0,
      default_manifestation_preference: "stance_bias"
    },
    plasticity_state: {
      strength: 0.2,
      direction_bias: "source_to_target",
      stability_class: "normal",
      support_events_count: 0,
      contradiction_events_count: 0
    },
    lifecycle: { status: "active", retirement_rule: "default" },
    legitimacy: { evidence_basis: ["evidence-1"], governance_class: "attention_only" },
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z"
  };
}

function seedWorkspace(database: ReturnType<typeof initDatabase>): void {
  database.connection.prepare(`
    INSERT INTO workspaces (
      workspace_id, name, root_path, workspace_kind, default_engine_binding,
      workspace_state, created_at, archived_at, default_engine_class
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "workspace-1", "Workspace", "/tmp/workspace-1", "local_repo", null,
    "active", AS_OF, null, null
  );
}
