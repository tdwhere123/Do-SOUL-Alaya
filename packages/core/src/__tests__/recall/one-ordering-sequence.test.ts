import { FIELD_PINS } from "./fine-assessment-selection-fixtures.js";
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
import { buildFineAssessmentOrderLedger } from
  "../../recall/delivery/fine-assessment-selection/order-ledger.js";
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
import { materializeFineAssessmentSelectionBoundary } from
  "../../recall/delivery/selection-boundary/selection-boundary-capture.js";

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
    ...FIELD_PINS,
      orderedCandidates: candidates,
      packetCandidates: Object.freeze([first, second, third]),
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
    expect(sequence.ranks.coarse.get(first.fusion.candidate_key)).toBe(1);
    expect(sequence.ranks.coarse.get(second.fusion.candidate_key)).toBe(2);
    expect(sequence.ranks.coarse.get(third.fusion.candidate_key)).toBe(3);
    for (const ranks of rankMaps(sequence)) expectPermutationRanks(ranks, keys);
    for (const [key, rank] of rankByCandidateKey) {
      expect(sequence.ranks.deepHead.get(key)).toBe(rank);
    }
    for (const [index, candidate] of result.candidates.entries()) {
      expect(sequence.ranks.final.get(keyByObjectId.get(candidate.object_id) ?? ""))
        .toBe(index + 1);
    }
    const ledger = buildFineAssessmentOrderLedger(
      sequence,
      result.candidates.length
    );
    expect(sequence.transitions.map((transition) => transition.owner)).toEqual([
      "coarse",
      "fusion",
      "deep_head",
      "select_gamma",
      "final_budget"
    ]);
    expect(ledger.coarse_identity).toBe("captured");
    expect(ledger.candidates).toHaveLength(candidates.length);
    expect(ledger.candidates.find(
      (candidate) => candidate.candidate_key === first.fusion.candidate_key
    )?.ranks.coarse).toBe(1);
  });

  it("records the Select_Gamma walk as the sole delivery rank owner", () => {
    const dupA = createRankedCandidate("dup-a", 1, 0.99);
    const dupB = createRankedCandidate("dup-b", 2, 0.98);
    const novelBase = createRankedCandidate("novel", 3, 0.4);
    const novel = {
      ...novelBase,
      entry: { ...novelBase.entry, domain_tags: ["location_place"] }
    };
    const candidates = Object.freeze([dupA, dupB, novel]);
    const result = selectFineAssessmentCandidates({
    ...FIELD_PINS,
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
        },
        querySoughtFacets: ["location_place"]
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
    expect(readOrderSequence(result).ranks.selectGamma.get(
      novel.fusion.candidate_key
    ))
      .toBe(1);
  });

  it("rejects duplicate, gapped, and out-of-range stage ranks", () => {
    const first = createRankedCandidate("rank-first", 1, 0.9);
    const second = createRankedCandidate("rank-second", 2, 0.8);
    const result = selectFineAssessmentCandidates({
    ...FIELD_PINS,
      orderedCandidates: [first, second],
      config: createConfig(),
      supplementaryData: createSupplementaryData(),
      tokenEstimator: { estimate: () => 5 },
      rankByCandidateKey: deliveryRanks([first, second])
    });
    const sequence = readOrderSequence(result);
    const keys = sequence.birthOrder;
    for (const invalid of [
      new Map([[keys[0]!, 1], [keys[1]!, 1]]),
      new Map([[keys[0]!, 1], [keys[1]!, 3]]),
      new Map([[keys[0]!, 0], [keys[1]!, 2]])
    ]) {
      expect(() => buildFineAssessmentOrderLedger({
        ...sequence,
        ranks: { ...sequence.ranks, fusion: invalid }
      }, result.candidates.length)).toThrow(/rank permutation mismatch/u);
    }
  });

  it("rejects a membership receipt attributed before Select_Gamma", () => {
    const first = createRankedCandidate("membership-first", 1, 0.9);
    const second = createRankedCandidate("membership-second", 2, 0.8);
    const third = createRankedCandidate("membership-third", 3, 0.7);
    const result = selectFineAssessmentCandidates({
    ...FIELD_PINS,
      orderedCandidates: [first, second, third],
      packetCandidates: [first, second, third],
      config: createConfig(),
      supplementaryData: createSupplementaryData(),
      tokenEstimator: { estimate: () => 5 },
      rankByCandidateKey: deliveryRanks([first, second, third])
    });
    const sequence = readOrderSequence(result);
    const keys = sequence.birthOrder;
    const transitions = sequence.transitions.map((transition, index) => ({
      ...transition,
      memberKeys: index === 0
        ? [keys[0]!, keys[2]!]
        : index === 1
          ? [keys[0]!, keys[1]!]
          : [keys[0]!, keys[2]!]
    }));
    expect(() => buildFineAssessmentOrderLedger(
      { ...sequence, transitions }, 2
    )).toThrow(/non-Gamma membership owner/u);
  });

  it("records Select_Gamma as the sole membership-changing owner", () => {
    const first = createRankedCandidate("multi-owner-first", 1, 0.9);
    const second = createRankedCandidate("multi-owner-second", 2, 0.8);
    const result = selectFineAssessmentCandidates({
    ...FIELD_PINS,
      orderedCandidates: [first, second],
      packetCandidates: [first, second],
      config: createConfig(),
      supplementaryData: createSupplementaryData(),
      tokenEstimator: { estimate: () => 5 },
      rankByCandidateKey: deliveryRanks([first, second])
    });
    const sequence = readOrderSequence(result);
    const key = sequence.birthOrder[1]!;
    const transitions = sequence.transitions.map((transition, index) => ({
      ...transition,
      memberKeys: index < 3
        ? sequence.birthOrder
        : [sequence.birthOrder[0]!]
    }));
    const row = buildFineAssessmentOrderLedger(
      { ...sequence, transitions },
      1
    ).candidates.find((candidate) => candidate.candidate_key === key);

    expect(row?.first_membership_changing_owner).toBe("select_gamma");
    expect(row?.membership_changing_owners).toEqual(["select_gamma"]);
  });

  it("does not require dead post-coverage params to keep delivered membership", () => {
    const publicA = createRankedCandidate("public-a", 2, 0.99);
    const publicB = createRankedCandidate("public-b", 3, 0.98);
    const headA = createRankedCandidate("head-a", 1, 0.4);
    const candidates = Object.freeze([publicA, publicB, headA]);
    const params = {
      ...FIELD_PINS,
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

  it("fails closed when captured compatibility order keys disagree", () => {
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

    expect(() => reconstructFineAssessmentComposition(mismatched))
      .toThrow(SELECTION_COMPOSITION_FIDELITY_MISMATCH);
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

  it("persists the pre-delivery packet order for exact reconstruction", () => {
    const first = createRankedCandidate("packet-first", 1, 0.9);
    const second = createRankedCandidate("packet-second", 2, 0.8);
    const packet = Object.freeze([first, second]);
    const delivery = Object.freeze([second, first]);
    let captured: FineAssessmentSelectionBoundaryCase | undefined;
    selectFineAssessmentCandidates({
    ...FIELD_PINS,
      orderedCandidates: delivery,
      packetCandidates: packet,
      config: createConfig(),
      supplementaryData: createSupplementaryData(),
      tokenEstimator: { estimate: () => 5 },
      rankByCandidateKey: deliveryRanks(delivery),
      capturePacketPlanTrace: true,
      selectionBoundaryObserver: (pending) => {
        captured = materializeFineAssessmentSelectionBoundary(pending);
        return undefined;
      }
    });
    expect(captured).toBeDefined();
    if (captured === undefined) throw new Error("boundary is missing");
    const packetKeys = captured.input.packet_candidate_keys;
    expect(packetKeys).toBeDefined();
    if (packetKeys === undefined) throw new Error("packet order is missing");

    const restored = restoreSelectionParams(captured.input);
    expect(restored.packetCandidates?.map(
      (candidate) => candidate.fusion.candidate_key
    )).toEqual(packetKeys);
    expect(packetKeys).not.toEqual(
      captured.input.ordered_candidates.map(
        (candidate) => candidate.fusion.candidate_key
      )
    );
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
): readonly ReadonlyMap<string, number | null>[] {
  return [
    sequence.ranks.coarse,
    sequence.ranks.fusion,
    sequence.ranks.deepHead,
    sequence.ranks.selectGamma,
    sequence.ranks.final
  ];
}

function expectPermutationRanks(
  ranks: ReadonlyMap<string, number | null>,
  keys: readonly string[]
): void {
  expect([...ranks.keys()].sort()).toEqual([...keys].sort());
  expect([...ranks.values()].sort(
    (left, right) => (left ?? 0) - (right ?? 0)
  )).toEqual(
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
