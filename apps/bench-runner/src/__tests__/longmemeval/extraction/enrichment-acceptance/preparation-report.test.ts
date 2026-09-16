import { describe, expect, it } from "vitest";
import type { FrozenAssertion } from "../../../../runs/extraction/enrichment-acceptance/frozen-population.js";
import {
  bindFrozenPopulation,
  type FrozenCatalogUnit
} from "../../../../runs/extraction/enrichment-acceptance/source-binding.js";
import {
  composeEnrichmentPreparationReport,
  type EnrichmentBoundNativeOutcome,
  type EnrichmentSemanticQualityAnnotation
} from "../../../../runs/extraction/enrichment-acceptance/preparation-report.js";

const TEXT = "I moved to Berlin.";

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
    duplicate_of: assertionId === 6 ? 2 : null,
    participants: null,
    source_role: null,
    modality: null,
    conditions: null,
    scope: null,
    time: null,
    event_policy: null
  };
}

function nativeCell(
  assertion: FrozenAssertion,
  overrides: Partial<EnrichmentBoundNativeOutcome> = {}
): EnrichmentBoundNativeOutcome {
  return {
    annotation_pointer: assertion.annotation_pointer,
    request_ordinal: 0,
    candidate_ordinal: 0,
    raw_state: "valid-empty",
    machine_admission: "valid-empty",
    located_outcome: "empty",
    ...overrides
  };
}

function quality(
  assertion: FrozenAssertion,
  overrides: Partial<EnrichmentSemanticQualityAnnotation> = {}
): EnrichmentSemanticQualityAnnotation {
  return {
    annotation_pointer: assertion.annotation_pointer,
    quality_cell: "failed",
    attributed_to: "authored false-promisor annotation",
    ...overrides
  };
}

function twoOccurrenceUnits(): FrozenCatalogUnit[] {
  const locator = { start: 0, end: TEXT.length };
  return [{
    assertionId: 1,
    text: TEXT,
    semanticKey: "aa".repeat(32),
    binding: {
      sourceCorpusIdentity: "bb".repeat(32),
      occurrenceIdentity: "cc".repeat(32),
      locator
    }
  }, {
    assertionId: 1,
    text: TEXT,
    semanticKey: "ee".repeat(32),
    binding: {
      sourceCorpusIdentity: "bb".repeat(32),
      occurrenceIdentity: "dd".repeat(32),
      locator
    }
  }];
}

function twoOccurrenceRow(units: FrozenCatalogUnit[]): FrozenAssertion {
  return {
    ...row(1, "optional", null),
    exact_text: `User: ${TEXT}`,
    original_source: { exact_text: TEXT },
    occurrence: {
      source_message_ids: ["msg-1"],
      source_locator: null,
      source_occurrence_identity: units[0]!.binding.occurrenceIdentity ?? null,
      occurrence_bindings: units.map((unit) => unit.binding)
    }
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
    expect(report.source_fidelity.full_required_groups).toBe(4);
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

  it("derives required group counts from the supplied population identities", () => {
    const population = { rows: [
      row(2, "required", "aspiration"),
      row(4, "required", "capability")
    ] };
    const report = composeEnrichmentPreparationReport({
      population,
      bindings: bindFrozenPopulation(population.rows, { catalogUnits: [] }),
      preflight: null
    });
    expect(report.source_fidelity.first_stage_required_groups).toBe(2);
    expect(report.source_fidelity.full_required_groups).toBe(2);
    expect(report.source_fidelity.full_required_groups).not.toBe(15);
    expect(report.source_fidelity.required_group_ids.full).toEqual(["aspiration", "capability"]);
  });

  it("counts dropped rows from missing original pointers not array length", () => {
    const population = { rows: [row(2, "required", "aspiration"), row(4, "required", "capability")] };
    const bindings = bindFrozenPopulation(population.rows, { catalogUnits: [] });
    const duplicated = {
      ...bindings,
      bindings: [bindings.bindings[0]!, bindings.bindings[0]!]
    };
    const report = composeEnrichmentPreparationReport({
      population,
      bindings: duplicated,
      preflight: null
    });
    expect(duplicated.bindings.length).toBe(population.rows.length);
    expect(report.source_fidelity.dropped_rows).toBe(1);
    expect(report.source_fidelity.rows[1]?.binding_reason).toBe("source map row has no binding result");
  });

  it("surfaces every bound current source and a partial fidelity count", () => {
    const units = twoOccurrenceUnits();
    const frozen = twoOccurrenceRow(units);
    const bound = bindFrozenPopulation([frozen], { catalogUnits: units });
    const partial = bindFrozenPopulation([frozen], { catalogUnits: [units[0]!] });
    const boundReport = composeEnrichmentPreparationReport({
      population: { rows: [frozen] },
      bindings: bound,
      preflight: null
    });
    expect(boundReport.source_fidelity.rows[0]?.current).toHaveLength(2);
    expect(boundReport.source_fidelity.rows[0]?.current.map((item) => item.occurrenceIdentity))
      .toEqual([units[0]!.binding.occurrenceIdentity, units[1]!.binding.occurrenceIdentity]);
    expect(boundReport.source_fidelity.rows[0]?.current_assertion_id).toBeNull();
    expect(boundReport.source_fidelity.partial).toBe(0);
    const partialReport = composeEnrichmentPreparationReport({
      population: { rows: [frozen] },
      bindings: partial,
      preflight: null
    });
    expect(partialReport.source_fidelity.partial).toBe(1);
    expect(partialReport.source_fidelity.bound).toBe(0);
    expect(partialReport.source_fidelity.rows[0]?.current).toHaveLength(1);
    expect(partialReport.source_fidelity.rows[0]?.occurrences).toHaveLength(2);
    expect(partialReport.source_fidelity.rows[0]?.occurrences[1]?.status).toBe("lost");
  });

  it("records machine admission partial when a passing fixture has cell_state partial", () => {
    const population = { rows: [row(2, "required", "aspiration")] };
    const report = composeEnrichmentPreparationReport({
      population,
      bindings: bindFrozenPopulation(population.rows, { catalogUnits: [] }),
      preflight: null,
      fixtureOutcomes: [{
        name: "partial accepted siblings",
        kind: "native_formation_publication",
        result: "passed",
        cell_state: "partial"
      }]
    });
    expect(report.native_formation_publication.status).toBe("partial");
    expect(report.native_formation_publication.machine_admission).toBe("partial");
    expect(report.native_formation_publication.machine_admission).not.toBe("unreviewed");
  });

  it("records domain rejected when a passing fixture has cell_state rejected", () => {
    const population = { rows: [row(2, "required", "aspiration")] };
    const report = composeEnrichmentPreparationReport({
      population,
      bindings: bindFrozenPopulation(population.rows, { catalogUnits: [] }),
      preflight: null,
      fixtureOutcomes: [{
        name: "native rejection expected",
        kind: "native_formation_publication",
        result: "passed",
        cell_state: "rejected"
      }]
    });
    expect(report.native_formation_publication.status).toBe("rejected");
    expect(report.native_formation_publication.machine_admission).toBe("rejected");
    expect(report.native_formation_publication.status).not.toBe("unreviewed");
  });

  it("does not treat mixed public pass and fail as exercised success", () => {
    const population = { rows: [row(2, "required", "aspiration")] };
    const report = composeEnrichmentPreparationReport({
      population,
      bindings: bindFrozenPopulation(population.rows, { catalogUnits: [] }),
      preflight: null,
      fixtureOutcomes: [
        { name: "public success", kind: "public_consumption", result: "passed" },
        { name: "public failure", kind: "public_consumption", result: "failed" }
      ]
    });
    expect(report.public_consumption.status).toBe("not_verified");
    expect(report.public_consumption.status).not.toBe("exercised");
  });

  it("binds valid-empty raw state to the identity-matched row", () => {
    const optional = row(1, "optional", null);
    const required = row(2, "required", "aspiration");
    const report = composeEnrichmentPreparationReport({
      population: { rows: [optional, required] },
      bindings: bindFrozenPopulation([optional, required], { catalogUnits: [] }),
      preflight: null,
      nativeOutcomes: [nativeCell(optional), nativeCell(required)]
    });
    expect(report.source_fidelity.rows.map((item) => item.raw_state))
      .toEqual(["valid-empty", "valid-empty"]);
    expect(report.source_fidelity.rows.map((item) => item.machine_admission))
      .toEqual(["valid-empty", "valid-empty"]);
    expect(report.native_formation_publication.status).toBe("valid-empty");
    expect(report.native_formation_publication.machine_admission).toBe("valid-empty");
  });

  it("preserves request and candidate ordinals with rejected siblings", () => {
    const required = row(4, "required", "capability");
    const report = composeEnrichmentPreparationReport({
      population: { rows: [required] },
      bindings: bindFrozenPopulation([required], { catalogUnits: [] }),
      preflight: null,
      nativeOutcomes: [nativeCell(required, {
        request_ordinal: 2,
        candidate_ordinal: 0,
        raw_state: "partial",
        machine_admission: "partial",
        located_outcome: "candidates",
        rejected_siblings: [{ candidate_ordinal: 1, reason: "invalid_candidate" }],
        unmet_obligations: ["keep"]
      })]
    });
    const prepared = report.source_fidelity.rows[0];
    expect(prepared?.raw_state).toBe("partial");
    expect(prepared?.machine_admission).toBe("partial");
    expect(prepared?.request_ordinal).toBe(2);
    expect(prepared?.candidate_ordinal).toBe(0);
    expect(prepared?.rejected_siblings).toEqual([{ candidate_ordinal: 1, reason: "invalid_candidate" }]);
    expect(prepared?.unmet_obligations).toEqual(["keep"]);
  });

  it("does not bind a foreign native cell to a population row", () => {
    const required = row(2, "required", "aspiration");
    const foreignPointer = {
      file: "regression-source-review.json",
      assertion_id: 99,
      request_key: "ff".repeat(32),
      canonical_index: null
    };
    const report = composeEnrichmentPreparationReport({
      population: { rows: [required] },
      bindings: bindFrozenPopulation([required], { catalogUnits: [] }),
      preflight: null,
      nativeOutcomes: [{
        annotation_pointer: foreignPointer,
        request_ordinal: 0,
        candidate_ordinal: 0,
        raw_state: "rejected",
        machine_admission: "rejected",
        located_outcome: "failed"
      }]
    });
    expect(report.source_fidelity.rows[0]?.raw_state).toBe("missing");
    expect(report.source_fidelity.rows[0]?.machine_admission).toBe("missing");
    expect(report.native_formation_publication.unmatched_native_outcomes).toHaveLength(1);
    expect(report.native_formation_publication.unmatched_native_outcomes[0]?.annotation_pointer)
      .toEqual(foreignPointer);
  });

  it("attributes an authored false-promisor quality cell without judging language", () => {
    const required = row(8, "required", "release");
    const report = composeEnrichmentPreparationReport({
      population: { rows: [required] },
      bindings: bindFrozenPopulation([required], { catalogUnits: [] }),
      preflight: null,
      nativeOutcomes: [nativeCell(required, {
        raw_state: "unreviewed",
        machine_admission: "unreviewed",
        located_outcome: "candidates"
      })],
      semanticAnnotations: [quality(required, {
        quality_cell: "hold",
        detail: "product assigned as promisor"
      })]
    });
    expect(report.source_fidelity.rows[0]?.raw_state).toBe("unreviewed");
    expect(report.source_fidelity.rows[0]?.quality_cell).toBe("hold");
    expect(report.source_fidelity.rows[0]?.quality_attribution)
      .toBe("authored false-promisor annotation");
    expect(report.source_fidelity.rows[0]?.human_verdict).toBe("unreviewed");
    expect(report.native_formation_publication.human_verdict).toBe("unreviewed");
  });

  it("does not treat a faithful required assertion and its false duplicate as two required groups", () => {
    const faithful = row(2, "required", "aspiration");
    const duplicate = row(6, "optional", "aspiration");
    const report = composeEnrichmentPreparationReport({
      population: { rows: [faithful, duplicate] },
      bindings: bindFrozenPopulation([faithful, duplicate], { catalogUnits: [] }),
      preflight: null,
      nativeOutcomes: [
        nativeCell(faithful, {
          raw_state: "unreviewed",
          machine_admission: "unreviewed",
          located_outcome: "candidates"
        }),
        nativeCell(duplicate, {
          raw_state: "unreviewed",
          machine_admission: "unreviewed",
          located_outcome: "candidates"
        })
      ],
      semanticAnnotations: [quality(duplicate, {
        quality_cell: "failed",
        attributed_to: "authored false duplicate annotation"
      })]
    });
    expect(report.source_fidelity.full_required_groups).toBe(1);
    expect(report.source_fidelity.required_group_ids.full).toEqual(["aspiration"]);
    expect(report.source_fidelity.rows[0]?.quality_cell).toBe("unreviewed");
    expect(report.source_fidelity.rows[0]?.duplicate_of).toBeNull();
    expect(report.source_fidelity.rows[1]?.duplicate_of).toBe(2);
    expect(report.source_fidelity.rows[1]?.quality_cell).toBe("failed");
    expect(report.source_fidelity.rows[1]?.quality_attribution)
      .toBe("authored false duplicate annotation");
    expect(report.source_fidelity.rows.every((item) => item.human_verdict === "unreviewed")).toBe(true);
  });

  it("joins a native outcome through current request membership", () => {
    const units = twoOccurrenceUnits();
    const frozen = twoOccurrenceRow([units[0]!]);
    const bindings = bindFrozenPopulation([frozen], {
      catalogUnits: [units[0]!],
      requests: [{
        key: "correct-request",
        source_corpus_identity: units[0]!.binding.sourceCorpusIdentity,
        source_assertions: [{ assertion_id: units[0]!.assertionId, text: units[0]!.text }]
      }]
    });
    const report = composeEnrichmentPreparationReport({
      population: { rows: [frozen] },
      bindings,
      preflight: null,
      nativeOutcomes: [{
        request_key: "correct-request",
        current_assertion_id: units[0]!.assertionId,
        request_ordinal: 3,
        candidate_ordinal: 1,
        raw_state: "partial",
        machine_admission: "partial",
        located_outcome: "failed"
      }]
    });
    expect(report.source_fidelity.rows[0]?.raw_state).toBe("partial");
    expect(report.source_fidelity.rows[0]?.request_ordinal).toBe(3);
    expect(report.source_fidelity.rows[0]?.candidate_ordinal).toBe(1);
    expect(report.source_fidelity.rows[0]?.current_request_keys).toEqual(["correct-request"]);
  });

  it("does not join a pointerless native outcome by catalog assertion id alone", () => {
    const units = twoOccurrenceUnits();
    const frozen = twoOccurrenceRow([units[0]!]);
    const bindings = bindFrozenPopulation([frozen], {
      catalogUnits: [units[0]!],
      requests: [{
        key: "req-a",
        source_corpus_identity: units[0]!.binding.sourceCorpusIdentity,
        source_assertions: [{ assertion_id: units[0]!.assertionId, text: units[0]!.text }]
      }]
    });
    expect(bindings.bindings[0]?.status).toBe("bound");
    const report = composeEnrichmentPreparationReport({
      population: { rows: [frozen] },
      bindings,
      preflight: null,
      nativeOutcomes: [{
        current_assertion_id: units[0]!.assertionId,
        request_ordinal: 1,
        candidate_ordinal: 0,
        raw_state: "rejected",
        machine_admission: "rejected"
      }]
    });
    expect(report.source_fidelity.rows[0]?.raw_state).toBe("missing");
    expect(report.native_formation_publication.unmatched_native_outcomes).toHaveLength(1);
  });
});
