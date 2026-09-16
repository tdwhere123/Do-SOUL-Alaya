import { describe, expect, it } from "vitest";
import type { FrozenAssertion } from "../../../../runs/extraction/enrichment-acceptance/frozen-population.js";
import { bindFrozenPopulation } from "../../../../runs/extraction/enrichment-acceptance/source-binding.js";
import { composeEnrichmentPreparationReport } from "../../../../runs/extraction/enrichment-acceptance/preparation-report.js";

function row(
  assertionId: number,
  classification: FrozenAssertion["classification"],
  requiredGroupId: string | null,
  firstStage = true
): FrozenAssertion {
  return {
    population: "regression",
    annotation_pointer: {
      file: "regression-source-review.json",
      assertion_id: assertionId,
      request_key: "aa".repeat(32),
      canonical_index: null
    },
    original_ordinal: assertionId,
    exact_text: `User: fact ${assertionId}.`,
    original_source: { exact_text: `fact ${assertionId}.` },
    occurrence: {
      source_message_ids: ["msg"],
      source_locator: null,
      source_occurrence_identity: null,
      occurrence_bindings: []
    },
    classification,
    required_group_id: requiredGroupId,
    first_stage_subset: firstStage,
    obligations: ["keep"],
    forbidden: ["invent"],
    duplicate_of: assertionId === 6 ? 2 : null
  };
}

describe("enrichment preparation report", () => {
  it("separates evidence layers and keeps human verdicts unreviewed", () => {
    const population = { rows: [
      row(1, "optional", null),
      row(2, "required", "aspiration"),
      row(4, "required", "capability"),
      row(6, "optional", "aspiration"),
      row(8, "required", "release"),
      row(9, "required", "regression:9", false)
    ] };
    const bindings = bindFrozenPopulation(population.rows, {
      catalogUnits: [],
      requests: []
    });
    const report = composeEnrichmentPreparationReport({
      population,
      bindings,
      preflight: null,
      fixtureOutcomes: [{
        name: "public consumer retained",
        kind: "public_consumption",
        result: "not_run"
      }]
    });
    expect(report.source_fidelity.denominator).toBe(6);
    expect(report.source_fidelity.denominator).not.toBe(bindings.packing.request_count);
    expect(report.source_fidelity.first_stage_required_groups).toBe(3);
    expect(report.source_fidelity.full_required_groups).toBe(15);
    expect(report.source_fidelity.required_group_ids.first_stage)
      .toEqual(["aspiration", "capability", "release"]);
    expect(report.source_fidelity.required_group_ids.full)
      .toEqual(["aspiration", "capability", "release", "regression:9"]);
    expect(report.source_fidelity.human_verdicts).toBe("unreviewed");
    expect(report.source_fidelity.rows.every((item) => item.human_verdict === "unreviewed")).toBe(true);
    expect(report.source_fidelity.rows.every((item) => item.raw_state === "missing")).toBe(true);
    expect(report.source_fidelity.fixture_outcomes).toEqual([]);
    expect(report.transport_parse.attempted_fetches).toBeNull();
    expect(report.native_formation_publication.human_verdict).toBe("unreviewed");
    expect(report.native_formation_publication.status).toBe("missing");
    expect(report.public_consumption.status).toBe("not_exercised");
    expect(report.source_fidelity.packing?.request_count).toBe(0);
  });

  it("does not treat fixture mechanism evidence as a model-quality observation", () => {
    const population = { rows: [row(2, "required", "aspiration")] };
    const bindings = bindFrozenPopulation(population.rows, { catalogUnits: [] });
    const report = composeEnrichmentPreparationReport({
      population,
      bindings,
      preflight: null,
      fixtureOutcomes: [{
        name: "ordinary sqlite publication",
        kind: "native_formation_publication",
        result: "passed",
        cell_state: "unreviewed"
      }]
    });
    expect(report.source_fidelity.rows[0]?.human_verdict).toBe("unreviewed");
    expect(report.native_formation_publication.note).toMatch(/mechanism evidence only/u);
    expect(report.public_consumption.status).toBe("not_exercised");
  });
});
