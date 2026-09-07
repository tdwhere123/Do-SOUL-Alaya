import { describe, expect, it } from "vitest";
import {
  IndexEntrySchema,
  type IndexEntry
} from "@do-soul/alaya-protocol";
import { enumerateSimplePaths, productKey } from "./enumerate-simple-paths.js";
import {
  QUERY_ID,
  RESULT_VERSION,
  SNAPSHOT_ID,
  defaultBudget,
  defaultView
} from "./finite-worlds.js";
import { CONTRACT_ONLY_UNTIL_REAL_PRODUCERS, productIdentity, projectOracleIndex } from "./oracle-index.js";
import {
  COVERAGE_ROWS,
  coverageById,
  formatCoverageMarkdown,
  requiredIds
} from "./coverage-matrix.js";
import {
  NECESSITY_ROWS,
  admitsSameService,
  andOrWithdrawalForest,
  actualBudgetRepresentsUniverse,
  cheapestRecoverableWitness,
  collidingProductKeys,
  creditFromReport,
  duplicatePathsMintIndependence,
  explanationsComplete,
  finiteExamplesAreLearningGains,
  foldReports,
  intermediateAuthorized,
  interpretationCoverageOf,
  leafDerivation,
  missingReport,
  nodeDerivation,
  outputReport,
  plantedObjectOnlyMerge,
  plantedOutputCreditsEveryWitness,
  plantedProviderBridge,
  plantedUsageMutator,
  resumeDisposition,
  scalarOf,
  unfinishedAfterBudget,
  usageMayMutateStrength,
  witnessReport,
  withdrawLeaf
} from "./upgrade-expected.js";

describe("conditional-field upgrade oracle (contract-only until real producers bind)", () => {
  it("coverage matrix names every A/B row and inherited finding", () => {
    expect(COVERAGE_ROWS.map((row) => row.id)).toEqual(requiredIds());
    for (const id of requiredIds()) {
      const row = coverageById(id);
      expect(row.expected.length).toBeGreaterThan(8);
      expect(row.planted_failure.length).toBeGreaterThan(8);
      if (row.binding === "incomplete") expect(row.incomplete_reason).toBeDefined();
    }
    expect(formatCoverageMarkdown()).toContain("| B03 | real-producer |");
    expect(CONTRACT_ONLY_UNTIL_REAL_PRODUCERS).toMatch(/contract-only until real producers bind/);
  });

  it("keeps object+program+time as distinct accepting keys", () => {
    const accepting = indexEntry({ object_id: "cfg", program_state: "accepting", time_state: "yesterday" });
    const mid = indexEntry({ object_id: "cfg", program_state: "mid", time_state: "yesterday" });
    expect(collidingProductKeys(accepting, mid)).toBe(false);
    expect(plantedObjectOnlyMerge(accepting, mid)).toBe(true);
    const field = enumerateSimplePaths(
      [
        { state: productKey("cfg", "h0", "requested", "accepting", "yesterday"), milligrades: 850 },
        { state: productKey("cfg", "h0", "requested", "accepting", "as-of"), milligrades: 400 }
      ],
      []
    );
    const index = projectOracleIndex({
      field,
      view: defaultView(),
      query_id: QUERY_ID,
      snapshot_id: SNAPSHOT_ID,
      result_version: RESULT_VERSION,
      budget: defaultBudget(),
      roles: new Map([["cfg", "associated"]])
    });
    expect(index.entries).toHaveLength(2);
    expect(new Set(index.entries.map(productIdentity)).size).toBe(2);
  });

  it("scalar agreement does not complete explanations", () => {
    const a = leafDerivation("a", 800);
    const b = leafDerivation("b", 500);
    const andAb = nodeDerivation("and-ab", "and", [a, b]);
    const forest = new Map([[a.derivation_id, a], [b.derivation_id, b], [andAb.derivation_id, andAb]]);
    const grades = { a: 800, b: 500 };
    expect(scalarOf(forest, "and-ab", grades)).toBe(500);
    expect(explanationsComplete(forest, "and-ab", new Set(["a", "b"]))).toBe(true);
    expect(explanationsComplete(forest, "and-ab", new Set(["a"]))).toBe(false);
    const plantedCompleteBecauseNumeric = scalarOf(forest, "and-ab", grades) === 500;
    expect(plantedCompleteBecauseNumeric && explanationsComplete(forest, "and-ab", new Set(["a"]))).toBe(false);
  });

  it("equal-leaf AND/OR structures remain distinct after withdrawing c", () => {
    const forest = andOrWithdrawalForest();
    const afterOr = withdrawLeaf(forest, "or-left", "c");
    const afterAnd = withdrawLeaf(forest, "and-right", "c");
    expect(afterOr?.kind).toBe("and");
    expect(afterOr?.leaf_ids).toEqual(["a", "b"]);
    expect(afterAnd).toBeUndefined();
    expect(afterOr?.kind === afterAnd?.kind).toBe(false);
  });

  it("same-service binding is not a shared-provider object", () => {
    const query = { service_id: "service-a", provider_id: "shared-provider" };
    const other = { service_id: "service-b", provider_id: "shared-provider" };
    expect(admitsSameService(query, query)).toBe(true);
    expect(admitsSameService(query, other)).toBe(false);
    expect(plantedProviderBridge(query, other)).toBe(true);
    expect(plantedProviderBridge(query, other) && admitsSameService(query, other)).toBe(false);
  });

  it("completing one interpretation does not cover omitted hypotheses", () => {
    const oneDone = interpretationCoverageOf({
      hypotheses: ["h-config", "h-history"],
      completed: ["h-config"],
      holes: []
    });
    expect(oneDone).toBe("open");
    const plantedCertainty = oneDone === "complete";
    expect(plantedCertainty).toBe(false);
    const field = enumerateSimplePaths([{ state: productKey("c"), milligrades: 850 }], []);
    const index = projectOracleIndex({
      field,
      view: defaultView(),
      query_id: QUERY_ID,
      snapshot_id: SNAPSHOT_ID,
      result_version: RESULT_VERSION,
      budget: defaultBudget(),
      roles: new Map([["c", "associated"]]),
      omitted_hypotheses: ["h-history"],
      observer: { outcome: { schema_version: 1, status: "exhausted" }, open_regions: [] }
    });
    expect(index.completeness.observed_coverage).toBe("complete");
    expect(index.completeness.interpretation_coverage).toBe("open");
  });

  it("mixed epoch identities invalidate instead of silently refining", () => {
    const prior = {
      query_id: QUERY_ID,
      snapshot_id: SNAPSHOT_ID,
      interpretation_id: "clock-a",
      as_of: "2026-09-06T00:00:00.000Z",
      continuation_id: "page-2"
    };
    expect(resumeDisposition(prior, prior)).toBe("refine");
    expect(resumeDisposition(prior, { ...prior, interpretation_id: "clock-b" })).toBe("invalidate");
    expect(resumeDisposition(prior, { ...prior, snapshot_id: `sha256:${"c".repeat(64)}` })).toBe("invalidate");
  });

  it("cached grade cannot recover a revoked intermediate", () => {
    const path = ["r", "s", "h"];
    expect(intermediateAuthorized(path, new Set())).toBe(true);
    expect(intermediateAuthorized(path, new Set(["s"]))).toBe(false);
    const plantedBypass = 900 > 0 && intermediateAuthorized(path, new Set(["s"]));
    expect(plantedBypass).toBe(false);
  });

  it("required unfinished regions survive a tight budget", () => {
    const leftover = unfinishedAfterBudget([
      { id: "join", required: true, work: 40 },
      { id: "refine", required: false, work: 10_000 }
    ], 30);
    expect(leftover).toEqual(["join"]);
    expect(leftover.includes("join")).toBe(true);
  });

  it("keeps the cheap complete witness when the scalar winner differs", () => {
    const cheapest = cheapestRecoverableWitness([
      { id: "winner", cost: 1200, complete: true },
      { id: "cheap", cost: 400, complete: true },
      { id: "partial", cost: 50, complete: false }
    ], 800);
    expect(cheapest).toBe("cheap");
    expect(cheapest).not.toBe("winner");
  });

  it("output grain cannot stand in for a witness report", () => {
    const output = outputReport("idx-1");
    const witness = witnessReport("w1");
    const exposed = new Set(["w1"]);
    expect(creditFromReport(output, exposed).credited_ids).toEqual(["idx-1"]);
    expect(creditFromReport(witness, exposed).credited_ids).toEqual(["w1"]);
    expect(plantedOutputCreditsEveryWitness(output, ["w1", "w2"])).toEqual(["w1", "w2"]);
    expect(creditFromReport(output, exposed).credited_ids).not.toEqual(["w1", "w2"]);
    expect(creditFromReport(witnessReport("w1", "nonexposure"), exposed).credited_ids).toEqual([]);
  });

  it("duplicate, missing, nonexposure, and unknown remain distinct", () => {
    const folded = foldReports([
      outputReport("idx-1"),
      outputReport("idx-1"),
      witnessReport("w1", "nonexposure"),
      missingReport("cfg")
    ]);
    expect(folded.unique).toBe(3);
    expect(folded.duplicates).toBe(1);
    expect(folded.nonexposure).toBe(1);
    expect(folded.missing).toBe(1);
    expect(folded.unknown).toBeGreaterThan(0);
    const plantedMissingAsNegative = folded.missing === 0;
    expect(plantedMissingAsNegative).toBe(false);
  });

  it("usage reports do not own PathRelation.strength", () => {
    expect(usageMayMutateStrength()).toBe(false);
    expect(plantedUsageMutator(0.2, true)).toBeGreaterThan(0.2);
    expect(plantedUsageMutator(0.2, true) !== 0.2 && usageMayMutateStrength()).toBe(false);
  });

  it("contract payload keeps index identity fields that results flattening drops", () => {
    const entry = indexEntry({ object_id: "cfg", program_state: "accepting", time_state: "yesterday" });
    const flattened = { object_id: entry.object_id, association_milligrades: entry.association_milligrades };
    expect("program_state" in flattened).toBe(false);
    expect(entry.program_state).toBe("accepting");
    expect(coverageById("B13").binding).toBe("incomplete");
  });

  it("necessity dispositions are closed without claiming finite examples as learning", () => {
    expect(NECESSITY_ROWS).toHaveLength(4);
    expect(new Set(NECESSITY_ROWS.map((row) => row.disposition)))
      .toEqual(new Set(["NOT_REQUIRED", "BENEFIT_NOT_ESTABLISHED"]));
    expect(finiteExamplesAreLearningGains(12)).toBe(false);
    const plantedCompleteLearner = NECESSITY_ROWS.some((row) => row.mechanism === "learner-selected");
    expect(plantedCompleteLearner).toBe(false);
  });

  it("duplicate source sets do not mint independence", () => {
    expect(duplicatePathsMintIndependence([
      { id: "p1", sources: ["src-a"] },
      { id: "p2", sources: ["src-a"] }
    ])).toBe(false);
    expect(duplicatePathsMintIndependence([
      { id: "p1", sources: ["src-a"] },
      { id: "p2", sources: ["src-b"] }
    ])).toBe(true);
  });

  it("a page budget is not a complete universe", () => {
    expect(actualBudgetRepresentsUniverse(1, 5, false)).toBe(false);
    expect(actualBudgetRepresentsUniverse(800, 5, true)).toBe(false);
    expect(actualBudgetRepresentsUniverse(800, 5, false)).toBe(true);
  });

  it("pre-retirement exclusivity is not physical deletion", () => {
    expect(coverageById("A21").binding).toBe("incomplete");
    expect(coverageById("A21").incomplete_reason).toMatch(/D00/);
    expect(coverageById("A21").planted_failure).toMatch(/old decision chain/);
  });

  it("dispositions stay explicit and packaging stays out of U-band", () => {
    expect(coverageById("A22").expected).toMatch(/freeze-live/);
    expect(coverageById("A22").incomplete_reason).toMatch(/D\/T/);
    expect(coverageById("A22").planted_failure).toMatch(/silent reinterpretation/);
  });
});

function indexEntry(input: {
  readonly object_id: string;
  readonly program_state?: string;
  readonly time_state?: string;
}): IndexEntry {
  return IndexEntrySchema.parse({
    schema_version: 1,
    object_id: input.object_id,
    hypothesis_id: "h0",
    output_binding: "requested",
    role: "requested",
    association_milligrades: 850,
    claim: "unknown",
    explanation_ids: [],
    ...(input.program_state === undefined ? {} : { program_state: input.program_state }),
    ...(input.time_state === undefined ? {} : { time_state: input.time_state })
  });
}

