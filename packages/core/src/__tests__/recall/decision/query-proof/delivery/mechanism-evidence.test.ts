import { describe, expect, it } from "vitest";
import { classifyMechanismEvidence } from
  "../../../../../recall/decision/query-proof/delivery/mechanism-evidence.js";

describe("mechanism evidence classification", () => {
  it("forces NOT_REPLAYABLE when the artifact coordinate is missing", () => {
    const row = classifyMechanismEvidence({
      kind: "planted_contract",
      artifact_coordinate: "   "
    });
    expect(row.evidence_class).toBe("not_replayable");
    expect(row.reason).toBe("missing_artifact_coordinate");
  });

  it("does not treat unavailable snapshot sources or KPI classes as mechanism", () => {
    expect(classifyMechanismEvidence({
      kind: "unavailable_snapshot_source",
      artifact_coordinate: "path_graph_generation"
    }).evidence_class).toBe("not_replayable");
    expect(classifyMechanismEvidence({
      kind: "live_provider_cache",
      artifact_coordinate: "provider-cache-root"
    }).evidence_class).toBe("not_replayable");
    expect(classifyMechanismEvidence({
      kind: "production_clock_a",
      artifact_coordinate: "clock-a"
    }).evidence_class).toBe("not_replayable");
    expect(classifyMechanismEvidence({
      kind: "dataset_kpi",
      artifact_coordinate: "100q"
    }).evidence_class).toBe("not_replayable");
  });

  it("keeps planted contracts and matching frozen counterfactuals distinct", () => {
    expect(classifyMechanismEvidence({
      kind: "planted_contract",
      artifact_coordinate: "packages/core/src/recall/query/canonical-query/compilation.ts"
    }).evidence_class).toBe("mechanism");
    expect(classifyMechanismEvidence({
      kind: "frozen_counterfactual",
      artifact_coordinate: "docs/bench-history/latest.json",
      identities_match: true
    }).evidence_class).toBe("fixed_artifact_counterfactual");
    expect(classifyMechanismEvidence({
      kind: "frozen_counterfactual",
      artifact_coordinate: "docs/bench-history/latest.json",
      identities_match: false
    }).evidence_class).toBe("not_replayable");
  });
});
