import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FrozenPopulationCountError,
  FrozenPopulationMembershipError,
  loadFrozenEnrichmentPopulation
} from "../../../../runs/extraction/enrichment-acceptance/frozen-population.js";
import {
  FROZEN_ENRICHMENT_ANNOTATIONS_AVAILABLE,
  FROZEN_ENRICHMENT_CANONICAL_PATH,
  FROZEN_ENRICHMENT_REGRESSION_PATH
} from "../enrichment-frozen-annotation-files.js";

const REGRESSION_REQUIRED = new Set([2, 4, 8, 9, 10, 12, 13, 14, 16]);
const REGRESSION_UNRESOLVED = new Set([5, 15]);

describe("frozen enrichment population", () => {
  let root: string;
  afterEach(() => {
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  });

  it("emits 38 rows with 15 required, 21 optional, 2 unresolved and preserves first-eight groups", () => {
    root = writePopulation(validPopulation());
    const loaded = loadFrozenEnrichmentPopulation({
      regressionPath: join(root, "regression-source-review.json"),
      canonicalPath: join(root, "canonical-source-review.json")
    });
    expect(loaded.counts).toEqual({ total: 38, required: 15, optional: 21, unresolved: 2 });
    expect(loaded.rows).toHaveLength(38);
    const regression = loaded.rows.filter((row) => row.population === "regression");
    expect(regression).toHaveLength(16);
    expect(regression.filter((row) => row.first_stage_subset).map((row) => row.original_ordinal))
      .toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(new Set(regression.map((row) => row.annotation_pointer.assertion_id)))
      .toEqual(new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]));
    expect(regression.find((row) => row.original_ordinal === 2)?.required_group_id).toBe("aspiration");
    expect(regression.find((row) => row.original_ordinal === 6)?.required_group_id).toBe("aspiration");
    expect(regression.find((row) => row.original_ordinal === 6)?.duplicate_of).toBe(2);
    expect(regression.find((row) => row.original_ordinal === 6)?.classification).toBe("optional");
    expect(regression.find((row) => row.original_ordinal === 4)?.required_group_id).toBe("capability");
    expect(regression.find((row) => row.original_ordinal === 8)?.required_group_id).toBe("release");
    expect(regression.find((row) => row.original_ordinal === 1)?.obligations).toEqual(["keep slogan"]);
    expect(regression.find((row) => row.original_ordinal === 1)?.forbidden).toEqual(["invent ownership"]);
    expect(new Set(
      loaded.rows.filter((row) => row.classification === "required").map((row) => row.required_group_id)
    ).size).toBe(15);
    const canonical = loaded.rows.filter((row) => row.population === "canonical");
    expect(canonical).toHaveLength(22);
    expect(canonical.filter((row) => row.classification === "required")).toHaveLength(6);
    expect(canonical[0]?.annotation_pointer.canonical_index).toBe(1);
    expect(canonical[0]?.obligations).toEqual(["retain roots"]);
    expect(canonical[0]?.forbidden).toEqual(["invent citizenship"]);
    const canonicalLocalIds = canonical.map((row) => (
      `${row.annotation_pointer.canonical_index}:${row.annotation_pointer.assertion_id}`
    ));
    expect(new Set(canonicalLocalIds).size).toBe(canonicalLocalIds.length);
  });

  it("throws a named count error when the files do not yield 38/15/21/2", () => {
    const population = validPopulation();
    population.regression.assertions[1]!.classification = "legitimate_abstention_candidate";
    root = writePopulation(population);
    expect(() => loadFrozenEnrichmentPopulation({
      regressionPath: join(root, "regression-source-review.json"),
      canonicalPath: join(root, "canonical-source-review.json")
    })).toThrow(FrozenPopulationCountError);
  });

  it("rejects replaced regression membership even when classification totals still match 38/15/21/2", () => {
    const population = validPopulation();
    population.regression.assertions[3] = structuredClone(population.regression.assertions[1]!);
    root = writePopulation(population);
    let thrown: unknown;
    try {
      loadFrozenEnrichmentPopulation({
        regressionPath: join(root, "regression-source-review.json"),
        canonicalPath: join(root, "canonical-source-review.json")
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(FrozenPopulationMembershipError);
    expect(thrown).not.toBeInstanceOf(FrozenPopulationCountError);
    expect((thrown as Error).name).toBe("FrozenPopulationMembershipError");
  });

  it("rejects replaced canonical index 16 with 99 even when classification totals still match 38/15/21/2", () => {
    const population = validPopulation();
    population.canonical.requests[15]!.canonical_index = 99;
    root = writePopulation(population);
    let thrown: unknown;
    try {
      loadFrozenEnrichmentPopulation({
        regressionPath: join(root, "regression-source-review.json"),
        canonicalPath: join(root, "canonical-source-review.json")
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(FrozenPopulationMembershipError);
    expect(thrown).not.toBeInstanceOf(FrozenPopulationCountError);
    expect((thrown as Error).name).toBe("FrozenPopulationMembershipError");
  });

  it("rejects swapped canonical_index values even when keys and local membership stay 1-16", () => {
    const population = validPopulation();
    const left = population.canonical.requests[2]! as { canonical_index: number };
    const right = population.canonical.requests[4]! as { canonical_index: number };
    left.canonical_index = 5;
    right.canonical_index = 3;
    root = writePopulation(population);
    let thrown: unknown;
    try {
      loadFrozenEnrichmentPopulation({
        regressionPath: join(root, "regression-source-review.json"),
        canonicalPath: join(root, "canonical-source-review.json")
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(FrozenPopulationMembershipError);
    expect(thrown).not.toBeInstanceOf(FrozenPopulationCountError);
    expect((thrown as Error).message).toMatch(/canonical_index/u);
  });

  it("rejects swapped canonical request keys even when indexes and local membership stay 1-16", () => {
    const population = validPopulation();
    const left = population.canonical.requests[2]! as {
      key: string;
      assertion_reviews: { key: string }[];
    };
    const right = population.canonical.requests[3]! as {
      key: string;
      assertion_reviews: { key: string }[];
    };
    const leftKey = left.key;
    const rightKey = right.key;
    left.key = rightKey;
    for (const review of left.assertion_reviews) review.key = rightKey;
    right.key = leftKey;
    for (const review of right.assertion_reviews) review.key = leftKey;
    root = writePopulation(population);
    let thrown: unknown;
    try {
      loadFrozenEnrichmentPopulation({
        regressionPath: join(root, "regression-source-review.json"),
        canonicalPath: join(root, "canonical-source-review.json")
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(FrozenPopulationMembershipError);
    expect(thrown).not.toBeInstanceOf(FrozenPopulationCountError);
    expect((thrown as Error).message).toMatch(/canonical_sample_keys/u);
  });

  it("rejects canonical request 3 replaced by a clone of request 2 even when classification totals still match 38/15/21/2", () => {
    const population = validPopulation();
    const clone = structuredClone(population.canonical.requests[1]!) as {
      assertion_reviews: { assertion_id: number }[];
    };
    clone.assertion_reviews[0]!.assertion_id = 2;
    population.canonical.requests[2] = clone;
    root = writePopulation(population);
    let thrown: unknown;
    try {
      loadFrozenEnrichmentPopulation({
        regressionPath: join(root, "regression-source-review.json"),
        canonicalPath: join(root, "canonical-source-review.json")
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(FrozenPopulationMembershipError);
    expect(thrown).not.toBeInstanceOf(FrozenPopulationCountError);
    expect((thrown as Error).name).toBe("FrozenPopulationMembershipError");
  });

  it.skipIf(!FROZEN_ENRICHMENT_ANNOTATIONS_AVAILABLE)(
    "loads frozen annotations with unique 1-16 membership, first-eight IDs, and canonical 12/2 review dimensions",
    () => {
      const loaded = loadFrozenEnrichmentPopulation({
        regressionPath: FROZEN_ENRICHMENT_REGRESSION_PATH,
        canonicalPath: FROZEN_ENRICHMENT_CANONICAL_PATH
      });
      expect(loaded.counts).toEqual({ total: 38, required: 15, optional: 21, unresolved: 2 });
      expect(loaded.rows).toHaveLength(38);
      expect(loaded.rows.every((row) => row.exact_text.length > 0)).toBe(true);
      const regression = loaded.rows.filter((row) => row.population === "regression");
      expect(new Set(regression.map((row) => row.annotation_pointer.assertion_id)))
        .toEqual(new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]));
      expect(
        regression.filter((row) => row.first_stage_subset).map((row) => row.annotation_pointer.assertion_id)
      ).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(new Set(
        loaded.rows.filter((row) => row.classification === "required").map((row) => row.required_group_id)
      ).size).toBe(15);
      const alias = regression.find((row) => row.annotation_pointer.assertion_id === 6);
      expect(alias).toMatchObject({
        classification: "optional",
        duplicate_of: 2,
        required_group_id: "aspiration"
      });
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
});

function validPopulation(): {
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

function writePopulation(population: ReturnType<typeof validPopulation>): string {
  const directory = mkdtempSync(join(tmpdir(), "frozen-population-"));
  writeFileSync(join(directory, "regression-source-review.json"), JSON.stringify(population.regression));
  writeFileSync(join(directory, "canonical-source-review.json"), JSON.stringify(population.canonical));
  return directory;
}
