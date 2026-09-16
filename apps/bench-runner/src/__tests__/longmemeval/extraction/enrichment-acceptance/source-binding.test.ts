import { describe, expect, it } from "vitest";
import {
  buildOfficialApiSourceCorpus,
  planOfficialApiSemanticWorkset
} from "@do-soul/alaya-soul";
import type { FrozenAssertion } from "../../../../runs/extraction/enrichment-acceptance/frozen-population.js";
import {
  bindFrozenAssertionToCurrentSource,
  bindFrozenPopulation,
  type FrozenCatalogUnit
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
    participants: null,
    source_role: null,
    modality: null,
    conditions: null,
    scope: null,
    time: null,
    event_policy: null,
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
    expect(binding.current).toHaveLength(1);
    expect(binding.current[0]?.assertion_id).toBe(unit!.assertionId);
    expect(binding.current[0]?.semanticKey).toBe(unit!.semanticKey);
    expect(binding.current[0]?.request_keys).toEqual(["request-1"]);
    expect(binding.current[0]?.occurrenceIdentity).toEqual(unit!.binding.occurrenceIdentity);
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
    expect(binding.current).toEqual([]);
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
    expect(binding.current).toEqual([]);
  });

  it("records ambiguous when catalog text matches more than one unit", () => {
    const workset = planOfficialApiSemanticWorkset(text, [{ role: "user", content: text }]);
    const unit = workset.units[0]!;
    const binding = bindFrozenAssertionToCurrentSource(row(), {
      sourceCorpus: unit.sourceCorpus,
      catalogUnits: [unit, { ...unit, assertionId: unit.assertionId + 1, semanticKey: "ff".repeat(32) }]
    });
    expect(binding.status).toBe("ambiguous");
    expect(binding.current).toEqual([]);
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
    expect(binding.current).toHaveLength(1);
    expect(binding.current[0]?.semanticKey).toBe(unit.semanticKey);
    expect(binding.current[0]?.occurrenceIdentity).toBe(unit.binding.occurrenceIdentity);
    expect(binding.current[0]?.request_keys).toEqual(["request-intended"]);
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

  it("retains two authorized frozen occurrences without treating them as ambiguous", () => {
    const units = twoOccurrenceUnits();
    const binding = bindFrozenAssertionToCurrentSource(twoOccurrenceRow(units), {
      catalogUnits: units
    });
    expect(binding.status).toBe("bound");
    expect(binding.status).not.toBe("ambiguous");
    expect(binding.occurrences).toHaveLength(2);
    expect(binding.occurrences.map((item) => item.status)).toEqual(["bound", "bound"]);
    expect(binding.current.map((item) => item.occurrenceIdentity)).toEqual([
      units[0]!.binding.occurrenceIdentity,
      units[1]!.binding.occurrenceIdentity
    ]);
  });

  it("does not report a clean bound when one of two frozen occurrences is missing", () => {
    const units = twoOccurrenceUnits();
    const binding = bindFrozenAssertionToCurrentSource(twoOccurrenceRow(units), {
      catalogUnits: [units[0]!]
    });
    expect(binding.status).toBe("partial");
    expect(binding.status).not.toBe("bound");
    expect(binding.occurrences).toHaveLength(2);
    expect(binding.occurrences[0]).toMatchObject({
      status: "bound",
      current: expect.objectContaining({ occurrenceIdentity: units[0]!.binding.occurrenceIdentity })
    });
    expect(binding.occurrences[1]).toMatchObject({
      status: "lost",
      current: null,
      frozen: expect.objectContaining({ occurrenceIdentity: units[1]!.binding.occurrenceIdentity })
    });
    expect(binding.current).toHaveLength(1);
    expect(binding.current[0]?.occurrenceIdentity).toBe(units[0]!.binding.occurrenceIdentity);
  });

  it("does not bind a foreign corpus that only shares exact text", () => {
    const units = twoOccurrenceUnits();
    const foreign = {
      ...units[0]!,
      binding: {
        ...units[0]!.binding,
        occurrenceIdentity: "foreign-occurrence",
        sourceCorpusIdentity: "foreign-corpus"
      }
    };
    const binding = bindFrozenAssertionToCurrentSource(twoOccurrenceRow(units), {
      catalogUnits: [foreign]
    });
    expect(binding.status).not.toBe("bound");
    expect(binding.current).toEqual([]);
    expect(binding.occurrences.every((item) => item.status === "lost")).toBe(true);
    expect(binding.occurrences.some((item) => item.current?.sourceCorpusIdentity === "foreign-corpus"))
      .toBe(false);
  });

  it("joins requests by assertion identity rather than shared text", () => {
    const units = twoOccurrenceUnits();
    const intended = units[0]!;
    const single = row({
      occurrence: {
        source_message_ids: ["msg-1"],
        source_locator: null,
        source_occurrence_identity: intended.binding.occurrenceIdentity ?? null,
        occurrence_bindings: [intended.binding]
      }
    });
    const binding = bindFrozenAssertionToCurrentSource(single, {
      catalogUnits: [intended],
      requests: [{
        key: "correct-request",
        source_corpus_identity: intended.binding.sourceCorpusIdentity,
        source_assertions: [{ assertion_id: intended.assertionId, text: intended.text }]
      }, {
        key: "different-assertion-same-text",
        source_corpus_identity: intended.binding.sourceCorpusIdentity,
        source_assertions: [{ assertion_id: 999, text: intended.text }]
      }]
    });
    expect(binding.status).toBe("bound");
    expect(binding.current[0]?.request_keys).toEqual(["correct-request"]);
    expect(binding.current[0]?.request_keys).not.toContain("different-assertion-same-text");
  });

  it("assigns two stale-identity occurrences 1:1 instead of marking both ambiguous", () => {
    const units = twoOccurrenceUnits();
    const stale = twoOccurrenceRow(units);
    const rotated = units.map((unit, index) => ({
      ...unit,
      binding: {
        ...unit.binding,
        occurrenceIdentity: `99${index}`.padEnd(64, "0")
      }
    }));
    const binding = bindFrozenAssertionToCurrentSource(stale, {
      catalogUnits: rotated,
      requests: [{
        key: "request-local",
        source_corpus_identity: units[0]!.binding.sourceCorpusIdentity,
        message_ids: ["msg-1"],
        source_assertions: units.map((unit) => ({
          assertion_id: unit.assertionId,
          text: unit.text
        }))
      }]
    });
    expect(binding.status).toBe("bound");
    expect(binding.status).not.toBe("ambiguous");
    expect(binding.occurrences.map((item) => item.status)).toEqual(["bound", "bound"]);
    expect(binding.current).toHaveLength(2);
    expect(new Set(binding.current.map((item) => item.occurrenceIdentity)).size).toBe(2);
  });

  it("does not claim current when two stale identities match three same-text units", () => {
    const units = twoOccurrenceUnits();
    const extra = {
      ...units[0]!,
      assertionId: 3,
      semanticKey: "ee".repeat(32),
      binding: {
        ...units[0]!.binding,
        occurrenceIdentity: "33".padEnd(64, "0")
      }
    };
    const stale = twoOccurrenceRow(units);
    const rotated = [...units, extra].map((unit, index) => ({
      ...unit,
      binding: {
        ...unit.binding,
        occurrenceIdentity: `99${index}`.padEnd(64, "0")
      }
    }));
    const binding = bindFrozenAssertionToCurrentSource(stale, {
      catalogUnits: rotated,
      requests: [{
        key: "request-local",
        source_corpus_identity: units[0]!.binding.sourceCorpusIdentity,
        message_ids: ["msg-1"],
        source_assertions: rotated.map((unit) => ({
          assertion_id: unit.assertionId,
          text: unit.text
        }))
      }]
    });
    expect(binding.status).toBe("ambiguous");
    expect(binding.current).toEqual([]);
    expect(binding.occurrences.every((item) => item.status === "ambiguous")).toBe(true);
  });

  it("does not 1:1-bind a mixed-locator surplus using unrelated empty slots", () => {
    const units = twoOccurrenceUnits();
    const locatorB = { start: 99, end: 120 };
    const stale = row({
      occurrence: {
        source_message_ids: ["msg-1"],
        source_locator: null,
        source_occurrence_identity: units[0]!.binding.occurrenceIdentity ?? null,
        occurrence_bindings: [
          units[0]!.binding,
          {
            ...units[1]!.binding,
            occurrenceIdentity: "old2".padEnd(64, "0"),
            locator: locatorB
          }
        ]
      }
    });
    const rotated = units.map((unit, index) => ({
      ...unit,
      assertionId: index + 1,
      semanticKey: `${index}`.padEnd(64, "a"),
      binding: {
        ...unit.binding,
        occurrenceIdentity: `99${index}`.padEnd(64, "0")
      }
    }));
    const binding = bindFrozenAssertionToCurrentSource(stale, {
      catalogUnits: rotated,
      requests: [{
        key: "request-local",
        source_corpus_identity: units[0]!.binding.sourceCorpusIdentity,
        message_ids: ["msg-1"],
        source_assertions: rotated.map((unit) => ({
          assertion_id: unit.assertionId,
          text: unit.text
        }))
      }]
    });
    expect(binding.status).toBe("ambiguous");
    expect(binding.current).toEqual([]);
    expect(binding.occurrences[0]?.status).toBe("ambiguous");
    expect(binding.occurrences[1]?.status).toBe("lost");
  });

  it("does not claim current when two stale identities match one unit", () => {
    const units = twoOccurrenceUnits();
    const stale = twoOccurrenceRow(units);
    const rotated = [{
      ...units[0]!,
      binding: {
        ...units[0]!.binding,
        occurrenceIdentity: "99".padEnd(64, "0")
      }
    }];
    const binding = bindFrozenAssertionToCurrentSource(stale, {
      catalogUnits: rotated,
      requests: [{
        key: "request-local",
        source_corpus_identity: units[0]!.binding.sourceCorpusIdentity,
        message_ids: ["msg-1"],
        source_assertions: [{
          assertion_id: rotated[0]!.assertionId,
          text: rotated[0]!.text
        }]
      }]
    });
    expect(binding.status).toBe("ambiguous");
    expect(binding.current).toEqual([]);
    expect(binding.occurrences.every((item) => item.current === null)).toBe(true);
  });

  it("clears nested occurrence current when pass-1 bind meets pass-2 surplus", () => {
    const units = twoOccurrenceUnits();
    const extra = {
      ...units[0]!,
      assertionId: 3,
      semanticKey: "ee".repeat(32),
      binding: {
        ...units[0]!.binding,
        occurrenceIdentity: "33".padEnd(64, "0")
      }
    };
    const mixed = row({
      occurrence: {
        source_message_ids: ["msg-1"],
        source_locator: null,
        source_occurrence_identity: units[0]!.binding.occurrenceIdentity ?? null,
        occurrence_bindings: [
          units[0]!.binding,
          {
            ...units[1]!.binding,
            occurrenceIdentity: "old2".padEnd(64, "0")
          }
        ]
      }
    });
    const catalog = [units[0]!, {
      ...units[1]!,
      binding: {
        ...units[1]!.binding,
        occurrenceIdentity: "n2".padEnd(64, "0")
      }
    }, extra];
    const binding = bindFrozenAssertionToCurrentSource(mixed, {
      catalogUnits: catalog,
      requests: [{
        key: "request-local",
        source_corpus_identity: units[0]!.binding.sourceCorpusIdentity,
        message_ids: ["msg-1"],
        source_assertions: catalog.map((unit) => ({
          assertion_id: unit.assertionId,
          text: unit.text
        }))
      }]
    });
    expect(binding.status).toBe("ambiguous");
    expect(binding.current).toEqual([]);
    expect(binding.occurrences.every((item) => item.current === null)).toBe(true);
  });

  it("does not bind when two corpora claim the same message and locator", () => {
    const units = twoOccurrenceUnits();
    const foreign = {
      ...units[0]!,
      assertionId: 7,
      semanticKey: "ee".repeat(32),
      binding: {
        ...units[0]!.binding,
        occurrenceIdentity: "foreign-occurrence",
        sourceCorpusIdentity: "foreign-corpus"
      }
    };
    const migrated = {
      ...units[0]!,
      binding: {
        ...units[0]!.binding,
        occurrenceIdentity: "migrated-occurrence",
        sourceCorpusIdentity: "migrated-corpus"
      }
    };
    const binding = bindFrozenAssertionToCurrentSource(twoOccurrenceRow(units), {
      catalogUnits: [migrated, foreign],
      requests: [{
        key: "migrated-request",
        source_corpus_identity: "migrated-corpus",
        message_ids: ["msg-1"],
        source_assertions: [{ assertion_id: migrated.assertionId, text: migrated.text }]
      }, {
        key: "foreign-request",
        source_corpus_identity: "foreign-corpus",
        message_ids: ["msg-1"],
        source_assertions: [{ assertion_id: 7, text: foreign.text }]
      }]
    });
    expect(binding.status).toBe("ambiguous");
    expect(binding.status).not.toBe("bound");
    expect(binding.status).not.toBe("partial");
    expect(binding.current).toEqual([]);
  });

  it("migrates a stale occurrence identity through message-local exact text", () => {
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
        source_message_ids: ["msg-intended"],
        source_locator: null,
        source_occurrence_identity: "ee".repeat(32),
        occurrence_bindings: [{
          occurrenceIdentity: "ee".repeat(32),
          sourceCorpusIdentity: "00".repeat(32)
        }]
      }
    }), {
      catalogUnits: [unit, distractor],
      requests: [{
        key: "request-intended",
        source_corpus_identity: unit.binding.sourceCorpusIdentity,
        message_ids: ["msg-intended"],
        source_assertions: [{ assertion_id: unit.assertionId, text: unit.text }]
      }, {
        key: "request-distractor",
        source_corpus_identity: distractor.binding.sourceCorpusIdentity,
        message_ids: ["msg-other"],
        source_assertions: [{ assertion_id: distractor.assertionId, text: distractor.text }]
      }]
    });
    expect(binding.status).toBe("bound");
    expect(binding.current).toHaveLength(1);
    expect(binding.current[0]?.semanticKey).toBe(unit.semanticKey);
    expect(binding.current[0]?.request_keys).toEqual(["request-intended"]);
    expect(binding.occurrences[0]?.reason).toMatch(/migrated through native source identity/u);
  });

  it("does not widen to same-text when a frozen locator restriction has zero hits", () => {
    const workset = planOfficialApiSemanticWorkset(text, [{ role: "user", content: text }]);
    const unit = workset.units[0]!;
    const binding = bindFrozenAssertionToCurrentSource(row({
      occurrence: {
        source_message_ids: ["msg-1"],
        source_locator: { start: 99, end: 120 },
        source_occurrence_identity: null,
        occurrence_bindings: []
      }
    }), {
      sourceCorpus: unit.sourceCorpus,
      catalogUnits: workset.units
    });
    expect(binding.status).not.toBe("bound");
    expect(binding.occurrences[0]?.status).toBe("lost");
    expect(binding.current).toEqual([]);
  });

  it("distinguishes omitted request membership from present requests without a member", () => {
    const workset = planOfficialApiSemanticWorkset(text, [{ role: "user", content: text }]);
    const unit = workset.units[0]!;
    const omitted = bindFrozenAssertionToCurrentSource(row(), {
      sourceCorpus: unit.sourceCorpus,
      catalogUnits: workset.units
    });
    expect(omitted.current[0]?.request_keys).toBeNull();
    const unavailable = bindFrozenAssertionToCurrentSource(row(), {
      sourceCorpus: unit.sourceCorpus,
      catalogUnits: workset.units,
      requests: [{
        key: "foreign-assertion",
        source_corpus_identity: unit.binding.sourceCorpusIdentity,
        source_assertions: [{ assertion_id: unit.assertionId + 99, text: unit.text }]
      }]
    });
    expect(unavailable.current[0]?.request_keys).toEqual([]);
  });
});

function twoOccurrenceUnits(): FrozenCatalogUnit[] {
  const locator = { start: 0, end: text.length };
  return [{
    assertionId: 1,
    text,
    semanticKey: "aa".repeat(32),
    binding: {
      sourceCorpusIdentity: "bb".repeat(32),
      occurrenceIdentity: "cc".repeat(32),
      locator
    }
  }, {
    assertionId: 1,
    text,
    semanticKey: "aa".repeat(32),
    binding: {
      sourceCorpusIdentity: "bb".repeat(32),
      occurrenceIdentity: "dd".repeat(32),
      locator
    }
  }];
}

function twoOccurrenceRow(units: FrozenCatalogUnit[]): FrozenAssertion {
  return row({
    occurrence: {
      source_message_ids: ["msg-1"],
      source_locator: null,
      source_occurrence_identity: units[0]!.binding.occurrenceIdentity ?? null,
      occurrence_bindings: units.map((unit) => unit.binding)
    }
  });
}
