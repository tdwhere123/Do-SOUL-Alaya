import { describe, expect, it } from "vitest";
import {
  buildOfficialApiSourceCorpus,
  planOfficialApiSemanticWorkset
} from "@do-soul/alaya-soul";
import type { FrozenAssertion } from "../../../../runs/extraction/enrichment-acceptance/frozen-population.js";
import {
  bindFrozenAssertionToCurrentSource,
  bindFrozenPopulation
} from "../../../../runs/extraction/enrichment-acceptance/source-binding.js";

const text = "I moved to Berlin.";

function row(overrides: Partial<FrozenAssertion> = {}): FrozenAssertion {
  return {
    population: "regression",
    annotation_pointer: {
      file: "regression-source-review.json",
      assertion_id: 1,
      request_key: "aa".repeat(32),
      canonical_index: null
    },
    original_ordinal: 1,
    exact_text: `User: ${text}`,
    original_source: { exact_text: text },
    occurrence: {
      source_message_ids: ["msg-1"],
      source_locator: null,
      source_occurrence_identity: null,
      occurrence_bindings: []
    },
    classification: "optional",
    required_group_id: null,
    first_stage_subset: true,
    obligations: ["keep slogan"],
    forbidden: ["invent ownership"],
    duplicate_of: null,
    ...overrides
  };
}

describe("frozen source binding", () => {
  it("binds exact catalog text after stripping a single leading role marker", () => {
    const workset = planOfficialApiSemanticWorkset(text, [{ role: "user", content: text }]);
    const unit = workset.units[0];
    expect(unit).toBeDefined();
    const binding = bindFrozenAssertionToCurrentSource(row(), {
      sourceCorpus: unit!.sourceCorpus,
      catalogUnits: workset.units,
      requests: [{
        key: "request-1",
        source_assertions: [{ assertion_id: unit!.assertionId, text: unit!.text }],
        source_corpus_identity: unit!.binding.sourceCorpusIdentity
      }]
    });
    expect(binding.status).toBe("bound");
    expect(binding.current?.assertion_id).toBe(unit!.assertionId);
    expect(binding.current?.semanticKey).toBe(unit!.semanticKey);
    expect(binding.current?.request_keys).toEqual(["request-1"]);
    expect(binding.current?.occurrenceIdentity).toEqual(unit!.binding.occurrenceIdentity);
  });

  it("records unbound when the exact text is absent", () => {
    const workset = planOfficialApiSemanticWorkset(text, [{ role: "user", content: text }]);
    const binding = bindFrozenAssertionToCurrentSource(row({
      exact_text: "User: A missing source sentence."
    }), {
      sourceCorpus: workset.units[0]!.sourceCorpus,
      catalogUnits: workset.units
    });
    expect(binding.status).toBe("unbound");
    expect(binding.current).toBeNull();
  });

  it("records ineligible when the text remains in the corpus but not the catalog", () => {
    const user = "Hello there.";
    const assistant = "I recommend Shadow Drive.";
    const workset = planOfficialApiSemanticWorkset(user, [
      { role: "user", content: user },
      { role: "assistant", content: assistant }
    ]);
    const sourceCorpus = buildOfficialApiSourceCorpus(user, [
      { role: "user", content: user },
      { role: "assistant", content: assistant }
    ]);
    const binding = bindFrozenAssertionToCurrentSource(row({
      exact_text: `Assistant: ${assistant}`
    }), { sourceCorpus, catalogUnits: workset.units });
    expect(binding.status).toBe("ineligible");
    expect(binding.current).toBeNull();
  });

  it("records ambiguous when catalog text matches more than one unit", () => {
    const workset = planOfficialApiSemanticWorkset(text, [{ role: "user", content: text }]);
    const unit = workset.units[0]!;
    const binding = bindFrozenAssertionToCurrentSource(row(), {
      sourceCorpus: unit.sourceCorpus,
      catalogUnits: [unit, { ...unit, assertionId: unit.assertionId + 1, semanticKey: "ff".repeat(32) }]
    });
    expect(binding.status).toBe("ambiguous");
    expect(binding.current).toBeNull();
  });

  it("binds a repeated catalog phrase using frozen occurrence identity", () => {
    const workset = planOfficialApiSemanticWorkset(text, [{ role: "user", content: text }]);
    const unit = workset.units[0]!;
    const distractor = {
      ...unit,
      assertionId: unit.assertionId + 1,
      semanticKey: "ff".repeat(32),
      binding: {
        ...unit.binding,
        sourceCorpusIdentity: "11".repeat(32),
        occurrenceIdentity: "22".repeat(32)
      }
    };
    const binding = bindFrozenAssertionToCurrentSource(row({
      occurrence: {
        source_message_ids: ["msg-1"],
        source_locator: null,
        source_occurrence_identity: unit.binding.occurrenceIdentity,
        occurrence_bindings: [{
          occurrenceIdentity: unit.binding.occurrenceIdentity,
          sourceCorpusIdentity: unit.binding.sourceCorpusIdentity
        }]
      }
    }), {
      sourceCorpus: unit.sourceCorpus,
      catalogUnits: [unit, distractor],
      requests: [{
        key: "request-intended",
        source_assertions: [{ assertion_id: unit.assertionId, text: unit.text }],
        source_corpus_identity: unit.binding.sourceCorpusIdentity
      }, {
        key: "request-distractor",
        source_assertions: [{ assertion_id: distractor.assertionId, text: distractor.text }],
        source_corpus_identity: distractor.binding.sourceCorpusIdentity
      }]
    });
    expect(binding.status).toBe("bound");
    expect(binding.current?.semanticKey).toBe(unit.semanticKey);
    expect(binding.current?.occurrenceIdentity).toBe(unit.binding.occurrenceIdentity);
    expect(binding.current?.request_keys).toEqual(["request-intended"]);
  });

  it("maps every original row and reports packing independently of group counts", () => {
    const workset = planOfficialApiSemanticWorkset(text, [{ role: "user", content: text }]);
    const rows = [row(), row({ original_ordinal: 2, exact_text: "User: absent." })];
    const mapped = bindFrozenPopulation(rows, {
      sourceCorpus: workset.units[0]!.sourceCorpus,
      catalogUnits: workset.units,
      requests: [{
        key: "request-1",
        source_assertions: workset.units.map((unit) => ({
          assertion_id: unit.assertionId,
          text: unit.text
        }))
      }],
      packs: [{
        pack_id: "pack-1",
        policy_kind: "reference_batch_8",
        assertion_ids: [1, 2],
        semantic_keys: ["a", "b"]
      }]
    });
    expect(mapped.bindings).toHaveLength(2);
    expect(mapped.bindings.map((item) => item.status)).toEqual(["bound", "unbound"]);
    expect(mapped.packing.request_count).toBe(1);
    expect(mapped.packing.pack_count).toBe(1);
    expect(mapped.packing.pack_cardinalities).toEqual([2]);
    expect(mapped.packing.unit_count).toBe(workset.units.length);
  });
});
