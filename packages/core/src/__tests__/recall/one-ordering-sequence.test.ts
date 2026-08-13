import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  selectFineAssessmentCandidates,
  type FineAssessmentCandidate,
  type FineAssessmentSelectionParams,
  type FineAssessmentSelectionResult
} from "../../recall/delivery/fine-assessment-selection.js";
import type { FineAssessmentOrderSequence } from
  "../../recall/delivery/fine-assessment-selection/order-sequence.js";
import { restoreSelectionParams } from
  "../../recall/delivery/selection-boundary/selection-boundary-restore.js";
import {
  reconstructFineAssessmentComposition,
  SELECTION_COMPOSITION_FIDELITY_MISMATCH
} from
  "../../recall/delivery/selection-boundary/selection-boundary-composition.js";
import type { FineAssessmentSelectionBoundaryCase } from
  "../../recall/delivery/selection-boundary/selection-boundary-types.js";
import {
  createConfig,
  createRankedCandidate,
  createSupplementaryData
} from "./fine-assessment-selection-fixtures.js";
import { captureFineAssessmentSelectionBoundary } from
  "./selection-boundary-live-capture-fixture.js";

describe("one ordering sequence", () => {
  it("exposes a unique order sequence over every candidate key", () => {
    const first = createRankedCandidate("first", 1, 0.92);
    const second = createRankedCandidate("second", 2, 0.71);
    const third = createRankedCandidate("third", 3, 0.48);
    const candidates = Object.freeze([second, third, first]);
    const rankByCandidateKey = new Map([
      [second.fusion.candidate_key, 1],
      [third.fusion.candidate_key, 2],
      [first.fusion.candidate_key, 3]
    ]);
    const keys = candidateKeys(candidates);
    const result = selectFineAssessmentCandidates({
      orderedCandidates: candidates,
      config: createConfig(),
      supplementaryData: createSupplementaryData({
        evidenceGistsByMemoryId: {
          first: "shared-gist",
          second: "shared-gist",
          third: "novel-gist"
        },
        answerRelevanceScoresByCandidateKey: new Map([
          [third.fusion.candidate_key, 0.99]
        ])
      }),
      tokenEstimator: { estimate: () => 6 },
      rankByCandidateKey,
      coverageRelevanceByCandidateKey: new Map([
        [first.fusion.candidate_key, 0.2],
        [second.fusion.candidate_key, 0.15],
        [third.fusion.candidate_key, 0.95]
      ])
    });
    const sequence = readOrderSequence(result);
    const keyByObjectId = new Map(candidates.map((candidate) => [
      candidate.entry.object_id,
      candidate.fusion.candidate_key
    ]));

    expectUniquePermutation(sequence.birthOrder, keys);
    expect(sequence.birthOrder).toEqual(keys);
    expectUniquePermutation(sequence.currentOrder, keys);
    for (const ranks of rankMaps(sequence)) expectPermutationRanks(ranks, keys);
    for (const [key, rank] of rankByCandidateKey) {
      expect(sequence.ranks.deepHead.get(key)).toBe(rank);
    }
    for (const [index, candidate] of result.candidates.entries()) {
      expect(sequence.ranks.final.get(keyByObjectId.get(candidate.object_id) ?? ""))
        .toBe(index + 1);
    }
  });

  it("keeps the existing coverage walk without a post-coverage reorder param", () => {
    const dupA = createRankedCandidate("dup-a", 1, 0.99);
    const dupB = createRankedCandidate("dup-b", 2, 0.98);
    const novel = createRankedCandidate("novel", 3, 0.4);
    const candidates = Object.freeze([dupA, dupB, novel]);
    const result = selectFineAssessmentCandidates({
      orderedCandidates: candidates,
      config: {
        ...createConfig(),
        budgets: { ...createConfig().budgets, max_entries: 2 }
      },
      supplementaryData: createSupplementaryData({
        evidenceGistsByMemoryId: {
          "dup-a": "same-gist",
          "dup-b": "same-gist",
          novel: "fresh-gist"
        }
      }),
      tokenEstimator: { estimate: () => 6 },
      rankByCandidateKey: deliveryRanks(candidates),
      finalRelevanceByCandidateKey: new Map([
        [dupA.fusion.candidate_key, 0.99],
        [dupB.fusion.candidate_key, 0.98],
        [novel.fusion.candidate_key, 0.4]
      ]),
      coverageRelevanceByCandidateKey: new Map([
        [dupA.fusion.candidate_key, 0.2],
        [dupB.fusion.candidate_key, 0.15],
        [novel.fusion.candidate_key, 0.95]
      ])
    });

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      "novel",
      "dup-a"
    ]);
    expect(readOrderSequence(result).ranks.coverage.get(novel.fusion.candidate_key))
      .toBe(1);
  });

  it("does not require dead post-coverage params to keep delivered membership", () => {
    const publicA = createRankedCandidate("public-a", 2, 0.99);
    const publicB = createRankedCandidate("public-b", 3, 0.98);
    const headA = createRankedCandidate("head-a", 1, 0.4);
    const candidates = Object.freeze([publicA, publicB, headA]);
    const params = {
      orderedCandidates: candidates,
      config: {
        ...createConfig(),
        budgets: { ...createConfig().budgets, max_entries: 3 }
      },
      supplementaryData: createSupplementaryData(),
      tokenEstimator: { estimate: () => 6 },
      rankByCandidateKey: new Map([
        [headA.fusion.candidate_key, 1],
        [publicA.fusion.candidate_key, 2],
        [publicB.fusion.candidate_key, 3]
      ])
    } satisfies FineAssessmentSelectionParams;

    expect(selectFineAssessmentCandidates(params).candidates.map(
      (candidate) => candidate.object_id
    )).toEqual(["public-a", "public-b", "head-a"]);
  });

  it("consumes leftover order keys on restore without rehydrating them", () => {
    const restored = restoreSelectionParams({
      ...captureLiveBoundary().input,
      final_order_after_coverage: "public_relevance",
      max_head_drop_after_coverage: 1
    });

    expect("finalOrderAfterCoverage" in restored).toBe(false);
    expect("maxHeadDropAfterCoverage" in restored).toBe(false);
  });

  it("reconstructs when leftover order keys disagree with the live branch", () => {
    const captured = captureLiveBoundary();
    const mismatched: FineAssessmentSelectionBoundaryCase = {
      ...captured,
      input: {
        ...captured.input,
        final_order_after_coverage:
          captured.input.final_order_after_coverage === "coverage"
            ? "public_relevance"
            : "coverage",
        max_head_drop_after_coverage:
          (captured.input.max_head_drop_after_coverage ?? 0) + 1
      }
    };

    expect(() => reconstructFineAssessmentComposition(mismatched)).not.toThrow();
  });

  it("fails loud when a captured delivery rank drifts", () => {
    const captured = captureLiveBoundary();
    const [first, ...rest] = captured.input.rank_by_candidate_key;
    const drifted: FineAssessmentSelectionBoundaryCase = {
      ...captured,
      input: {
        ...captured.input,
        rank_by_candidate_key: [[first![0], first![1] + 1], ...rest]
      }
    };

    expect(() => reconstructFineAssessmentComposition(drifted))
      .toThrow(SELECTION_COMPOSITION_FIDELITY_MISMATCH);
  });

  it("omits leftover order keys from a new live capture", () => {
    const captured = captureLiveBoundary();
    expect(captured.input.final_order_after_coverage).toBeUndefined();
    expect(captured.input.max_head_drop_after_coverage).toBeUndefined();
  });

  it("has no production importer of bounded-head displacement", () => {
    const banned = /orderWithBoundedHeadDisplacement|bounded-head-displacement|finalOrderAfterCoverage|maxHeadDropAfterCoverage/u;
    const hits = listProductionSourceFiles(
      fileURLToPath(new URL("../../", import.meta.url))
    ).filter((file) => banned.test(readFileSync(file, "utf8")));
    expect(hits).toEqual([]);
  });
});

function captureLiveBoundary(): FineAssessmentSelectionBoundaryCase {
  return captureFineAssessmentSelectionBoundary("surface-one-ordering-sequence");
}

function readOrderSequence(
  result: FineAssessmentSelectionResult
): FineAssessmentOrderSequence {
  const sequence = Reflect.get(result, "orderSequence") as
    FineAssessmentOrderSequence | undefined;
  expect(sequence).toBeDefined();
  if (sequence === undefined) throw new Error("orderSequence is missing");
  return sequence;
}

function rankMaps(
  sequence: FineAssessmentOrderSequence
): readonly ReadonlyMap<string, number>[] {
  return [
    sequence.ranks.coarse,
    sequence.ranks.fusion,
    sequence.ranks.deepHead,
    sequence.ranks.coverage,
    sequence.ranks.consensus,
    sequence.ranks.final
  ];
}

function expectPermutationRanks(
  ranks: ReadonlyMap<string, number>,
  keys: readonly string[]
): void {
  expect([...ranks.keys()].sort()).toEqual([...keys].sort());
  expect([...ranks.values()].sort((left, right) => left - right)).toEqual(
    keys.map((_key, index) => index + 1)
  );
}

function expectUniquePermutation(
  actual: readonly string[],
  keys: readonly string[]
): void {
  expect(actual).toHaveLength(keys.length);
  expect(new Set(actual).size).toBe(keys.length);
  expect(new Set(actual)).toEqual(new Set(keys));
}

function deliveryRanks(
  candidates: readonly FineAssessmentCandidate[]
): ReadonlyMap<string, number> {
  return new Map(candidates.map((candidate, index) => [
    candidate.fusion.candidate_key,
    index + 1
  ]));
}

function candidateKeys(
  candidates: readonly FineAssessmentCandidate[]
): readonly string[] {
  return candidates.map((candidate) => candidate.fusion.candidate_key);
}

function listProductionSourceFiles(root: string): readonly string[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (
        entry.name === "__tests__" ||
        entry.name === "node_modules" ||
        entry.name === "dist"
      ) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
        files.push(path);
      }
    }
  };
  walk(root);
  return files;
}
