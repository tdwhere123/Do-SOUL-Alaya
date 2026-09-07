import { describe, expect, it } from "vitest";
import {
  CAUSAL_USAGE_OPERATOR_ID,
  CausalUsageReceiptSchema,
  hashCausalUsageId,
  UsageReportSchema,
  type CausalUsageReceipt,
  type PathRelation,
  type UsageReport
} from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "../../shared/field-hash.js";
import {
  attributeCausalUsageOntoPaths,
  attributeUsageReports,
  projectCausalUsageOntoPaths
} from "../../relations/path-plasticity/causal-usage-projection.js";

const AS_OF = "2026-08-17T00:00:00.000Z";

describe("causal usage temporal path projection", () => {
  it("keeps stored PathRelation.strength while unique receipts stay attributable", () => {
    const stored = path("path-1", 0.2);
    const used = receipt("outcome-1", "memory-2", "2026-08-16T00:00:00.000Z");

    const [projected] = projectCausalUsageOntoPaths(
      [stored],
      [used, used],
      AS_OF,
      0
    );
    const attributed = attributeCausalUsageOntoPaths([stored], [used, used], AS_OF);

    expect(projected?.plasticity_state.strength).toBe(0.2);
    expect(projected?.plasticity_state.support_events_count).toBe(0);
    expect(stored.plasticity_state.strength).toBe(0.2);
    expect(attributed).toEqual([
      {
        path_id: "path-1",
        receipt_identities: [used.identity],
        writes_path_relation: false
      }
    ]);
  });

  it("preserves existing support history instead of composing usage into strength", () => {
    const stored = {
      ...path("path-1", 0.75),
      plasticity_state: {
        ...path("path-1", 0.75).plasticity_state,
        support_events_count: 4,
        last_reinforced_at: "2026-08-10T00:00:00.000Z"
      }
    } satisfies PathRelation;

    const [projected] = projectCausalUsageOntoPaths(
      [stored],
      [receipt("outcome-1", "memory-2", "2026-08-16T00:00:00.000Z")],
      AS_OF,
      0
    );

    expect(projected?.plasticity_state.strength).toBe(0.75);
    expect(projected?.plasticity_state.support_events_count).toBe(4);
    expect(projected?.plasticity_state.last_reinforced_at).toBe("2026-08-10T00:00:00.000Z");
  });

  it("does not credit unrelated or future causal usage", () => {
    const stored = path("path-1", 0.2);
    const projected = projectCausalUsageOntoPaths(
      [stored],
      [
        receipt("unrelated", "memory-3", "2026-08-16T00:00:00.000Z"),
        receipt("future", "memory-2", "2026-08-18T00:00:00.000Z")
      ],
      AS_OF,
      0
    );

    expect(projected[0]?.plasticity_state.strength).toBe(0.2);
    expect(projected[0]?.plasticity_state.support_events_count).toBe(0);
    expect(attributeCausalUsageOntoPaths(
      [stored],
      [
        receipt("unrelated", "memory-3", "2026-08-16T00:00:00.000Z"),
        receipt("future", "memory-2", "2026-08-18T00:00:00.000Z")
      ],
      AS_OF
    )).toEqual([]);
  });

  it("keeps output-only reports at output grain and does not credit paths or edges", () => {
    const outputUsed = usageReport({
      grain: "output",
      exposure: "exposed",
      reported_use: "used",
      output_id: "idx-1"
    });
    const duplicate = usageReport({
      grain: "output",
      exposure: "exposed",
      reported_use: "used",
      output_id: "idx-1"
    });
    const [attributed] = attributeUsageReports([outputUsed, duplicate]);

    expect(attributed?.grain).toBe("output");
    expect(attributed?.output_id).toBe("idx-1");
    expect(attributed?.witness_id).toBeUndefined();
    expect(attributed?.path_credit).toBe("none");
    expect(attributed?.witness_credit).toBe("none");
    expect(attributeUsageReports([outputUsed, duplicate])).toHaveLength(1);
  });

  it("retains witness identity and leaves unknown, missing, and nonexposure distinct", () => {
    const claimed = usageReport({
      grain: "witness",
      exposure: "exposed",
      reported_use: "used",
      witness_id: "w1",
      object_id: "cfg"
    });
    const unknown = usageReport({
      grain: "witness",
      exposure: "unknown",
      reported_use: "unknown",
      witness_id: "w-unknown"
    });
    const missing = usageReport({
      grain: "witness",
      exposure: "exposed",
      reported_use: "missing",
      witness_id: "w-missing"
    });
    const nonexposure = usageReport({
      grain: "witness",
      exposure: "nonexposure",
      reported_use: "unused",
      witness_id: "w-hidden"
    });

    const attributed = attributeUsageReports([claimed, unknown, missing, nonexposure], [claimed]);
    expect(attributed.map((row) => row.witness_credit)).toEqual([
      "claimed",
      "unknown",
      "none",
      "none"
    ]);
    expect(attributed[0]).toMatchObject({
      grain: "witness",
      witness_id: "w1",
      object_id: "cfg",
      query_id: "q1",
      snapshot_id: SNAPSHOT,
      path_credit: "none"
    });
    expect(new Set(attributed.map((row) => `${row.exposure}:${row.reported_use}`))).toEqual(
      new Set(["exposed:used", "unknown:unknown", "exposed:missing", "nonexposure:unused"])
    );
  });
});

const SNAPSHOT = `sha256:${"b".repeat(64)}`;

function usageReport(overrides: Partial<UsageReport> & Pick<
  UsageReport,
  "grain" | "exposure" | "reported_use"
>): UsageReport {
  return UsageReportSchema.parse({
    schema_version: 1,
    query_id: "q1",
    snapshot_id: SNAPSHOT,
    interpretation_id: "clock-1",
    as_of: "2026-09-07T00:00:00.000Z",
    ...overrides
  });
}

function receipt(causalKey: string, downstreamRef: string, occurredAt: string): CausalUsageReceipt {
  return CausalUsageReceiptSchema.parse({
    schema_version: 1,
    producer: CAUSAL_USAGE_OPERATOR_ID,
    consumer: "path_projection",
    identity: hashCausalUsageId({
      causal_key: causalKey,
      downstream_ref: downstreamRef,
      scope: "workspace-1",
      operator_id: CAUSAL_USAGE_OPERATOR_ID
    }, fieldContractSha256),
    replay_rule: "idempotent_same_identity",
    failure_disposition: "fail_closed",
    governance_effect: "none",
    deletion_behavior: "retain_identity",
    workspace_id: "workspace-1",
    causal_key: causalKey,
    occurred_at: occurredAt,
    downstream_ref: downstreamRef,
    weight: 1,
    scope: "workspace-1",
    usage_kind: "causal",
    operator_id: CAUSAL_USAGE_OPERATOR_ID,
    recorded_at: occurredAt
  });
}

function path(pathId: string, strength: number): PathRelation {
  return {
    path_id: pathId,
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
      strength,
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
