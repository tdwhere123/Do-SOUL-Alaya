import { vi } from "vitest";
import {
  deps,
  evidenceCapsule,
  memory
} from "./recall-current-behavior-test-fixtures.js";

export const RECALL_PHASES = Object.freeze([
  "coarse",
  "synthesis",
  "embedding",
  "assessment",
  "cross_rerank",
  "delivery",
  "manifestation"
]);

export function createAnswerableSourceWindowScenario() {
  const { seed, answerableNeighbor, sourceOnlyNeighbor, decoys } = sourceWindowMemories();
  const evidenceRanks = new Map([
    ...decoys.map((entry, index) => [
      entry.evidence_refs[0] ?? "",
      1 - index * 0.01
    ] as const),
    ["evidence-answer", 0.95] as const
  ]);
  const { dependencies } = deps([seed, ...decoys, answerableNeighbor, sourceOnlyNeighbor], {
    searchByKeyword: async () => [{ object_id: "seed", normalized_rank: 1 }],
    evidenceSearchPort: {
      searchByKeyword: vi.fn(async () =>
        [...evidenceRanks.entries()].map(([object_id, normalized_rank]) => ({
          object_id,
          normalized_rank
        }))
      )
    }
  });
  return { dependencies, answerableNeighbor, sourceOnlyNeighbor };
}

export function createEvidenceFanoutScenario() {
  const refIds = Array.from({ length: 20 }, (_, index) => `evidence-fanout-${index}`);
  const seed = memory({
    object_id: "fanout-seed",
    content: "needle answer payload",
    evidence_refs: refIds
  });
  const evidenceById = new Map(
    refIds.map((id) => [id, evidenceCapsule(id, `source-${id}`)] as const)
  );
  const findByIds = vi.fn(async (_workspaceId: string, ids: readonly string[]) =>
    ids.flatMap((id) => {
      const evidence = evidenceById.get(id);
      return evidence === undefined ? [] : [evidence];
    })
  );
  const { dependencies } = deps([seed], {
    searchByKeyword: async () => [{ object_id: seed.object_id, normalized_rank: 1 }],
    evidenceSearchPort: {
      searchByKeyword: vi.fn(async () => refIds.map((object_id, index) => ({
        object_id,
        normalized_rank: 1 - index * 0.01
      }))),
      findByIds
    }
  });
  return { dependencies, findByIds, topRankedRef: refIds[0]! };
}

export function createSourceDeliveryBudgetScenario() {
  const { anchor, sibling, outsideRadius, fillers } = sourceDeliveryMemories();
  const { dependencies } = deps([anchor, ...fillers, sibling, outsideRadius], {
    searchByKeyword: async () => [
      { object_id: anchor.object_id, normalized_rank: 1 },
      ...fillers.map((entry, index) => ({
        object_id: entry.object_id,
        normalized_rank: 0.99 - index * 0.01
      }))
    ]
  });
  return {
    dependencies,
    siblingId: sibling.object_id,
    outsideRadiusId: outsideRadius.object_id
  };
}

function sourceWindowMemories() {
  const seed = memory({
    object_id: "seed",
    content: "bookshelf purchase context",
    evidence_refs: ["source-a-s1-t3"],
    activation_score: 0.9
  });
  const answerableNeighbor = memory({
    object_id: "answerable-neighbor",
    content: "I bought my new bookshelf from IKEA after comparing Target shelves.",
    evidence_refs: ["evidence-answer", "source-a-s1-t4"],
    activation_score: 0.05
  });
  const sourceOnlyNeighbor = memory({
    object_id: "source-only-neighbor",
    content: "The same conversation also mentioned room lighting.",
    evidence_refs: ["source-a-s1-t5"],
    activation_score: 0.04
  });
  const decoys = Array.from({ length: 4 }, (_, index) => memory({
    object_id: `evidence-decoy-${index}`,
    content: `Bookshelf store comparison decoy ${index}`,
    evidence_refs: [`evidence-decoy-${index}`, `source-decoy-${index}-s1-t1`],
    activation_score: 0.8 - index * 0.01
  }));
  return { seed, answerableNeighbor, sourceOnlyNeighbor, decoys };
}

function sourceDeliveryMemories() {
  const anchor = memory({
    object_id: "anchor",
    content: "needle answer primary",
    evidence_refs: ["source-a-s1-t3"],
    activation_score: 0.95
  });
  const sibling = memory({
    object_id: "filler-12-sibling",
    content: "same-source sibling detail",
    evidence_refs: ["source-a-s1-t4"],
    activation_score: 0.01
  });
  const outsideRadius = memory({
    object_id: "outside-radius",
    content: "same-source distant detail",
    evidence_refs: ["source-a-s1-t30"],
    activation_score: 0.01
  });
  const fillers = Array.from({ length: 30 }, (_, index) => memory({
    object_id: `filler-${index}`,
    content: `needle distractor ${index}`,
    evidence_refs: [`source-z-s${index}-t1`],
    activation_score: 0.9 - index * 0.01
  }));
  return { anchor, sibling, outsideRadius, fillers };
}
