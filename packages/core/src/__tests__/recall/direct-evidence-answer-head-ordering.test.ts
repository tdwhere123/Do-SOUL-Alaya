import { describe, expect, it } from "vitest";
import {
  selectFineAssessmentCandidates,
  type FineAssessmentCandidate
} from "../../recall/delivery/fine-assessment-selection.js";
import { compileRecallQueryProbes } from "../../recall/query/recall-query-probes.js";
import {
  createCandidate,
  createConfig,
  createRankedCandidate,
  createSupplementaryData,
  rankMap
} from "./fine-assessment-selection-fixtures.js";

const QUERY = "Where did I buy my new bookshelf from?";
const STRONG_EVIDENCE = "I bought my new bookshelf from IKEA after comparing several stores.";
const WEAK_EVIDENCE = "The bookshelf receipt was filed in a cabinet.";

function evidence(
  objectId: string,
  content = STRONG_EVIDENCE,
  fusedRank = 6
): FineAssessmentCandidate {
  const candidate = createCandidate(
    objectId,
    { content, evidence_refs: [objectId] },
    "evidence_capsule"
  );
  return {
    ...candidate,
    fusion: {
      ...candidate.fusion,
      candidate_key: `workspace_local:evidence_capsule:${objectId}`,
      fused_rank: fusedRank,
      fused_score: 0.2,
      per_stream_rank: {
        ...candidate.fusion.per_stream_rank,
        evidence_fts: 25
      }
    }
  };
}

function peers(count = 5): FineAssessmentCandidate[] {
  return Array.from({ length: count }, (_, index) =>
    createRankedCandidate(`peer-${index + 1}`, index + 1, 0.9 - index / 10));
}

function withContent(
  candidate: FineAssessmentCandidate,
  content: string
): FineAssessmentCandidate {
  return { ...candidate, entry: { ...candidate.entry, content } };
}

function select(
  candidates: readonly FineAssessmentCandidate[],
  semantic: FineAssessmentCandidate
) {
  return selectFineAssessmentCandidates({
    orderedCandidates: candidates,
    config: {
      ...createConfig(),
      budgets: {
        ...createConfig().budgets,
        max_entries: 5,
        max_total_tokens: 100
      }
    },
    supplementaryData: createSupplementaryData({
      queryProbes: compileRecallQueryProbes(QUERY),
      evidenceSemanticScoresByCandidateKey: new Map([
        [semantic.fusion.candidate_key, 0.99]
      ])
    }),
    tokenEstimator: { estimate: () => 4 },
    rankByCandidateKey: rankMap(candidates),
    finalOrderAfterCoverage: "public_relevance"
  });
}

function objectIds(result: ReturnType<typeof select>): string[] {
  return result.candidates.map((candidate) => candidate.object_id);
}

describe("direct-evidence semantic ordering", () => {
  it("does not admit a semantic capsule without tail replacement margin", () => {
    const publicPeers = peers();
    publicPeers[4] = withContent(publicPeers[4]!, STRONG_EVIDENCE);
    const candidate = evidence("semantic-no-tail-margin");

    expect(objectIds(select([...publicPeers, candidate], candidate)))
      .toEqual(["peer-1", "peer-2", "peer-3", "peer-4", "peer-5"]);
  });

  it("lets stronger lexical evidence challenge a delivered semantic capsule", () => {
    const incumbent = evidence("semantic-incumbent", WEAK_EVIDENCE, 5);
    const challenger = evidence("lexical-challenger");

    expect(objectIds(select([...peers(4), incumbent, challenger], incumbent)))
      .toEqual(["peer-1", "peer-2", "peer-3", "peer-4", "lexical-challenger"]);
  });

  it("applies the query floor to a semantic-scored capsule", () => {
    const candidate = evidence("semantic-weak-query", "The receipt was archived.");

    expect(objectIds(select([...peers(), candidate], candidate)))
      .toEqual(["peer-1", "peer-2", "peer-3", "peer-4", "peer-5"]);
  });

  it("keeps a delivered semantic capsule in public order without head margin", () => {
    const publicPeers = peers(4);
    publicPeers[0] = withContent(publicPeers[0]!, STRONG_EVIDENCE);
    const incumbent = evidence("delivered-semantic", STRONG_EVIDENCE, 5);

    expect(objectIds(select([...publicPeers, incumbent], incumbent)))
      .toEqual(["peer-1", "peer-2", "peer-3", "peer-4", "delivered-semantic"]);
  });

  it("admits a semantic capsule at the bounded tail without head margin", () => {
    const publicPeers = peers();
    publicPeers[0] = withContent(publicPeers[0]!, STRONG_EVIDENCE);
    const candidate = evidence("bounded-semantic");

    expect(objectIds(select([...publicPeers, candidate], candidate)))
      .toEqual(["peer-1", "peer-2", "peer-3", "peer-4", "bounded-semantic"]);
  });

  it("ranks a semantic capsule first when it clears tail and head margins", () => {
    const candidate = evidence("semantic-head");

    expect(objectIds(select([...peers(), candidate], candidate)))
      .toEqual(["semantic-head", "peer-1", "peer-2", "peer-3", "peer-4"]);
  });
});
