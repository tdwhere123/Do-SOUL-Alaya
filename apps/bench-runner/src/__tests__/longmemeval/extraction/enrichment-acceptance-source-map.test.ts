import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildOfficialApiSourceCorpus,
  planOfficialApiSemanticWorkset
} from "@do-soul/alaya-soul";
import {
  FrozenPopulationCountError,
  FrozenPopulationMembershipError,
  loadFrozenEnrichmentPopulation,
  type FrozenAssertion
} from "../../../runs/extraction/enrichment-acceptance/frozen-population.js";
import {
  bindFrozenAssertionToCurrentSource,
  bindFrozenPopulation
} from "../../../runs/extraction/enrichment-acceptance/source-binding.js";
import { composeEnrichmentPreparationReport } from "../../../runs/extraction/enrichment-acceptance/preparation-report.js";
import {
  FROZEN_ENRICHMENT_ANNOTATIONS_AVAILABLE,
  FROZEN_ENRICHMENT_CANONICAL_PATH,
  FROZEN_ENRICHMENT_REGRESSION_PATH
} from "./enrichment-frozen-annotation-files.js";
const REGRESSION_REQUIRED = new Set([2, 4, 8, 9, 10, 12, 13, 14, 16]);
const REGRESSION_UNRESOLVED = new Set([5, 15]);
const BERLIN = "I moved to Berlin.";

describe("enrichment acceptance source map", () => {
  let root: string | undefined;
  const previousFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = async () => {
      throw new Error("provider forbidden in enrichment acceptance source map");
    };
  });
  afterEach(() => {
    globalThis.fetch = previousFetch;
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  });

  it("loads miniature annotation-shaped JSON as 38/15/21/2 with first-eight groups counted once", () => {
    root = writeMiniaturePopulation(validMiniaturePopulation());
    const loaded = loadFrozenEnrichmentPopulation({
      regressionPath: join(root, "regression-source-review.json"),
      canonicalPath: join(root, "canonical-source-review.json")
    });
    expect(loaded.counts).toEqual({ total: 38, required: 15, optional: 21, unresolved: 2 });
    const regression = loaded.rows.filter((row) => row.population === "regression");
    expect(regression.filter((row) => row.first_stage_subset).map((row) => row.original_ordinal))
      .toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(regression.find((row) => row.original_ordinal === 2)?.required_group_id).toBe("aspiration");
    expect(regression.find((row) => row.original_ordinal === 6)).toMatchObject({
      required_group_id: "aspiration",
      duplicate_of: 2,
      classification: "optional"
    });
    expect(regression.find((row) => row.original_ordinal === 4)?.required_group_id).toBe("capability");
    expect(regression.find((row) => row.original_ordinal === 8)?.required_group_id).toBe("release");
    const firstStageGroups = new Set(
      regression.filter((row) => row.first_stage_subset && row.required_group_id !== null)
        .map((row) => row.required_group_id)
    );
    expect(firstStageGroups).toEqual(new Set(["aspiration", "capability", "release"]));
    expect(loaded.rows.find((row) => row.original_ordinal === 1 && row.population === "regression")?.obligations)
      .toEqual(["keep slogan"]);
    expect(loaded.rows.filter((row) => row.population === "canonical")).toHaveLength(22);
    expect(new Set(regression.map((row) => row.annotation_pointer.assertion_id)))
      .toEqual(new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]));
    expect(new Set(
      loaded.rows.filter((row) => row.classification === "required").map((row) => row.required_group_id)
    ).size).toBe(15);
  });

  it("rejects replaced regression membership even when classification totals still match 38/15/21/2", () => {
    const population = validMiniaturePopulation();
    population.regression.assertions[3] = structuredClone(population.regression.assertions[1]!);
    root = writeMiniaturePopulation(population);
    let thrown: unknown;
    try {
      loadFrozenEnrichmentPopulation({
        regressionPath: join(root!, "regression-source-review.json"),
        canonicalPath: join(root!, "canonical-source-review.json")
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(FrozenPopulationMembershipError);
    expect(thrown).not.toBeInstanceOf(FrozenPopulationCountError);
    expect((thrown as Error).name).toBe("FrozenPopulationMembershipError");
  });

  it.skipIf(!FROZEN_ENRICHMENT_ANNOTATIONS_AVAILABLE)(
    "loads frozen annotations as 38/15/21/2 with first-eight membership and canonical 12/2 review dimensions",
    () => {
      const loaded = loadFrozenEnrichmentPopulation({
        regressionPath: FROZEN_ENRICHMENT_REGRESSION_PATH,
        canonicalPath: FROZEN_ENRICHMENT_CANONICAL_PATH
      });
      expect(loaded.counts).toEqual({ total: 38, required: 15, optional: 21, unresolved: 2 });
      expect(loaded.rows).toHaveLength(38);
      expect(loaded.rows.filter((row) => row.first_stage_subset).map((row) => row.annotation_pointer.assertion_id))
        .toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(new Set(
        loaded.rows.filter((row) => row.classification === "required").map((row) => row.required_group_id)
      ).size).toBe(15);
      const aspiration = loaded.rows.filter((row) => row.required_group_id === "aspiration");
      expect(aspiration.map((row) => row.original_ordinal).sort((a, b) => a - b)).toEqual([2, 6]);
      expect(aspiration.filter((row) => row.classification === "required")).toHaveLength(1);
      const canonical12_2 = loaded.rows.find((row) => (
        row.annotation_pointer.canonical_index === 12 && row.annotation_pointer.assertion_id === 2
      ));
      expect(canonical12_2?.participants).toEqual([
        "First-person monitor and person seeking safety",
        "The speaker's blood sugar levels",
        "Potential low-blood-sugar episode while swimming"
      ]);
      expect(canonical12_2?.source_role).toBe("user");
      expect(canonical12_2?.modality).toEqual(expect.stringContaining("Have been monitoring"));
      expect(canonical12_2?.conditions).toEqual(expect.stringContaining("Since introduces"));
      expect(canonical12_2?.time).toEqual(expect.stringContaining("Twice a day"));
      expect(canonical12_2?.event_policy).toEqual(expect.stringContaining("Ongoing monitoring practice"));
    }
  );

  it("throws a named count error instead of claiming a zero population", () => {
    const population = validMiniaturePopulation();
    population.regression.assertions[1]!.classification = "legitimate_abstention_candidate";
    root = writeMiniaturePopulation(population);
    expect(() => loadFrozenEnrichmentPopulation({
      regressionPath: join(root!, "regression-source-review.json"),
      canonicalPath: join(root!, "canonical-source-review.json")
    })).toThrow(FrozenPopulationCountError);
  });

  it("keeps the original row with unbound, ineligible or ambiguous cause when the catalogue differs", () => {
    const workset = planOfficialApiSemanticWorkset(BERLIN, [{ role: "user", content: BERLIN }]);
    const unit = workset.units[0]!;
    const bound = bindFrozenAssertionToCurrentSource(frozenRow(`User: ${BERLIN}`), {
      sourceCorpus: unit.sourceCorpus,
      catalogUnits: workset.units
    });
    expect(bound.status).toBe("bound");
    expect(bound.row.exact_text).toBe(`User: ${BERLIN}`);
    expect(bound.current[0]?.semanticKey).toBe(unit.semanticKey);

    const unbound = bindFrozenAssertionToCurrentSource(frozenRow("User: A missing source sentence."), {
      sourceCorpus: unit.sourceCorpus,
      catalogUnits: workset.units
    });
    expect(unbound.status).toBe("unbound");
    expect(unbound.current).toEqual([]);
    expect(unbound.reason.length).toBeGreaterThan(0);
    expect(unbound.row.exact_text).toBe("User: A missing source sentence.");

    const assistant = "I recommend Shadow Drive.";
    const ineligibleCorpus = buildOfficialApiSourceCorpus("Hello there.", [
      { role: "user", content: "Hello there." },
      { role: "assistant", content: assistant }
    ]);
    const ineligibleWorkset = planOfficialApiSemanticWorkset("Hello there.", [
      { role: "user", content: "Hello there." },
      { role: "assistant", content: assistant }
    ]);
    const ineligible = bindFrozenAssertionToCurrentSource(frozenRow(`Assistant: ${assistant}`), {
      sourceCorpus: ineligibleCorpus,
      catalogUnits: ineligibleWorkset.units
    });
    expect(ineligible.status).toBe("ineligible");
    expect(ineligible.current).toEqual([]);
    expect(ineligible.row.exact_text).toBe(`Assistant: ${assistant}`);

    const ambiguous = bindFrozenAssertionToCurrentSource(frozenRow(`User: ${BERLIN}`), {
      sourceCorpus: unit.sourceCorpus,
      catalogUnits: [unit, { ...unit, assertionId: unit.assertionId + 1, semanticKey: "ff".repeat(32) }]
    });
    expect(ambiguous.status).toBe("ambiguous");
    expect(ambiguous.current).toEqual([]);
    expect(ambiguous.row.annotation_pointer.assertion_id).toBe(1);
  });

  it("reports occurrence and packing cardinalities independently of assertion and group counts", () => {
    const workset = planOfficialApiSemanticWorkset(BERLIN, [{ role: "user", content: BERLIN }]);
    const rows = [
      frozenRow(`User: ${BERLIN}`, { original_ordinal: 2, classification: "required", required_group_id: "aspiration" }),
      frozenRow("User: absent.", { original_ordinal: 6, classification: "optional", required_group_id: "aspiration", duplicate_of: 2 }),
      frozenRow("User: still absent.", { original_ordinal: 4, classification: "required", required_group_id: "capability" })
    ];
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
        assertion_ids: [1, 2, 3],
        semantic_keys: ["a", "b", "c"]
      }]
    });
    expect(mapped.bindings).toHaveLength(3);
    expect(mapped.bindings.map((item) => item.status)).toEqual(["bound", "unbound", "unbound"]);
    expect(mapped.bindings.every((item) => item.row.original_ordinal > 0)).toBe(true);
    expect(mapped.packing.request_count).toBe(1);
    expect(mapped.packing.pack_count).toBe(1);
    expect(mapped.packing.pack_cardinalities).toEqual([3]);
    expect(mapped.packing.unit_count).toBe(workset.units.length);
    const report = composeEnrichmentPreparationReport({
      population: { rows },
      bindings: mapped,
      preflight: null
    });
    expect(report.source_fidelity.denominator).toBe(3);
    expect(report.source_fidelity.denominator).not.toBe(mapped.packing.request_count);
    expect(report.source_fidelity.dropped_rows).toBe(0);
    expect(report.source_fidelity.required_group_ids.first_stage)
      .toEqual(["aspiration", "capability"]);
  });
});

function frozenRow(exactText: string, overrides: Partial<FrozenAssertion> = {}): FrozenAssertion {
  return {
    population: "regression",
    annotation_pointer: {
      file: "regression-source-review.json",
      assertion_id: overrides.original_ordinal ?? 1,
      request_key: "aa".repeat(32),
      canonical_index: null
    },
    original_ordinal: 1,
    exact_text: exactText,
    original_source: { exact_text: exactText.replace(/^(?:User|Assistant): /u, "") },
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

function validMiniaturePopulation(): {
  regression: { assertions: Record<string, unknown>[] };
  canonical: { canonical_sample_keys: string[]; requests: Record<string, unknown>[] };
} {
  const regressionAssertions = Array.from({ length: 16 }, (_, index) => {
    const assertionId = index + 1;
    const classification = REGRESSION_REQUIRED.has(assertionId)
      ? "in_scope_durable_proposition"
      : REGRESSION_UNRESOLVED.has(assertionId)
        ? "unsupported_unresolved_interpretation"
        : "legitimate_abstention_candidate";
    return {
      key: "aa".repeat(32),
      assertion_id: assertionId,
      exact_text: `User: regression fact ${assertionId}.`,
      source_message_id: "msg-1",
      source_locator: { assertion_id: assertionId },
      source_occurrence_identity: "bb".repeat(32),
      original_source: {
        exact_text: `regression fact ${assertionId}.`,
        utf8_start: 0,
        utf8_end: 10,
        normalization: "none"
      },
      classification,
      obligations: ["keep slogan"],
      prohibited_inferences: ["invent ownership"]
    };
  });
  const dual = new Set([1, 8, 10, 12, 14, 16]);
  const requiredCanonical = new Set(["1:1", "5:1", "10:2", "11:1", "12:2", "16:2"]);
  const requests = Array.from({ length: 16 }, (_, index) => {
    const canonicalIndex = index + 1;
    const assertionCount = dual.has(canonicalIndex) ? 2 : 1;
    return {
      canonical_index: canonicalIndex,
      key: canonicalIndex.toString(16).padStart(64, "0"),
      assertion_reviews: Array.from({ length: assertionCount }, (__, assertionOffset) => {
        const assertionId = assertionOffset + 1;
        const classification = requiredCanonical.has(`${canonicalIndex}:${assertionId}`)
          ? "in_scope_durable_proposition"
          : "legitimate_abstention_candidate";
        return {
          key: canonicalIndex.toString(16).padStart(64, "0"),
          assertion_id: assertionId,
          exact_text: `canonical ${canonicalIndex} ${assertionId}.`,
          source_message_ids: ["canonical-msg"],
          occurrence_bindings: [{ occurrenceIdentity: "cc".repeat(32) }],
          classification,
          coverage: ["retain roots"],
          forbidden: ["invent citizenship"]
        };
      })
    };
  });
  return {
    regression: { assertions: regressionAssertions },
    canonical: {
      canonical_sample_keys: requests.map((request) => request.key),
      requests
    }
  };
}

function writeMiniaturePopulation(population: ReturnType<typeof validMiniaturePopulation>): string {
  const directory = mkdtempSync(join(tmpdir(), "enrichment-source-map-"));
  writeFileSync(join(directory, "regression-source-review.json"), JSON.stringify(population.regression));
  writeFileSync(join(directory, "canonical-source-review.json"), JSON.stringify(population.canonical));
  return directory;
}
