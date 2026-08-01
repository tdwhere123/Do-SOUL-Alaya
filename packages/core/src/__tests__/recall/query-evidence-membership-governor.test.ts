import { describe, expect, it } from "vitest";
import { governQueryEvidenceMembership } from
  "../../recall/delivery/final-order/query-evidence-membership-governor.js";
import { compileRecallQueryProbes } from
  "../../recall/query/recall-query-probes.js";
import type { PathInflowEdge } from
  "../../recall/runtime/recall-service-types.js";
import { createCandidate } from "./fine-assessment-selection-fixtures.js";

describe("query-evidence membership governor", () => {
  it("uses each typed-path substitute for at most one protected slot", () => {
    const protectedA = candidate("protected-a", "session-a", { lexical_fts: 2 });
    const protectedB = candidate("protected-b", "session-a", {
      evidence_fts: 2,
      source_proximity: 2
    });
    const substitute = candidate("substitute", "session-a", {
      lexical_fts: 1,
      evidence_fts: 1,
      source_proximity: 1,
      embedding_similarity: 1
    });
    const filler = candidate("filler", "session-b");

    const plan = governQueryEvidenceMembership({
      preProjectionHead: [protectedA, protectedB],
      proposedHead: [substitute, filler],
      sourceCandidates: [protectedA, protectedB, substitute, filler],
      queryProbes: compileRecallQueryProbes("what was recorded?"),
      pathInflowByTarget: reciprocalPath("substitute", "protected-a"),
      behaviorAuthorityEvidenceRefByCandidateKey: new Map(),
      fixedCandidateKeys: new Set()
    });

    expect(plan.head.map((item) => item.candidateKey)).toEqual([
      substitute.candidateKey,
      protectedB.candidateKey
    ]);
    expect(plan.substitutions).toHaveLength(1);
    expect(plan.protectedCandidateKeys).toEqual([
      protectedA.candidateKey,
      protectedB.candidateKey
    ]);
  });

  it("rejects a same-session substitute without a reciprocal receipt", () => {
    const protectedCandidate = candidate("protected", "session-a", {
      lexical_fts: 1
    });
    const substitute = candidate("substitute", "session-a", {
      embedding_similarity: 1
    });
    const source = candidate("source", "session-b");

    const plan = governQueryEvidenceMembership({
      preProjectionHead: [protectedCandidate],
      proposedHead: [substitute],
      sourceCandidates: [protectedCandidate, substitute, source],
      queryProbes: compileRecallQueryProbes("what was recorded?"),
      pathInflowByTarget: {
        substitute: [pathEdge("source", "substitute")]
      },
      behaviorAuthorityEvidenceRefByCandidateKey: new Map(),
      fixedCandidateKeys: new Set()
    });

    expect(plan.head.map((item) => item.candidateKey)).toEqual([
      protectedCandidate.candidateKey
    ]);
    expect(plan.substitutions).toEqual([]);
  });

  it("rejects a reciprocal substitute dominated by the protected direct evidence", () => {
    const protectedCandidate = candidate("protected", "session-a", {
      lexical_fts: 3,
      evidence_fts: 3,
      source_proximity: 4
    });
    const substitute = candidate("substitute", "session-a", {
      lexical_fts: 16,
      evidence_fts: 5,
      source_proximity: 6,
      embedding_similarity: 3
    });
    const fillers = [1, 2, 3, 4].map((index) =>
      candidate(`filler-${index}`, `session-${index}`)
    );

    const plan = governQueryEvidenceMembership({
      preProjectionHead: [protectedCandidate, ...fillers],
      proposedHead: [substitute, ...fillers],
      sourceCandidates: [protectedCandidate, substitute, ...fillers],
      queryProbes: compileRecallQueryProbes("what was recorded?"),
      pathInflowByTarget: reciprocalPath("substitute", "protected"),
      behaviorAuthorityEvidenceRefByCandidateKey: new Map(),
      fixedCandidateKeys: new Set(fillers.map((item) => item.candidateKey))
    });

    expect(plan.head.map((item) => item.candidateKey)).toEqual([
      protectedCandidate.candidateKey,
      ...fillers.map((item) => item.candidateKey)
    ]);
    expect(plan.substitutions).toEqual([]);
  });

  it("does not let an unrelated reciprocal pair satisfy direct evidence", () => {
    const protectedCandidate = candidate("protected", "session-a", {
      lexical_fts: 1
    });
    const substitute = candidate("substitute", "session-a", {
      lexical_fts: 2,
      evidence_fts: 2,
      source_proximity: 2,
      embedding_similarity: 1
    });
    const unrelated = candidate("unrelated", "session-a");

    const plan = governQueryEvidenceMembership({
      preProjectionHead: [protectedCandidate],
      proposedHead: [substitute],
      sourceCandidates: [protectedCandidate, substitute, unrelated],
      queryProbes: compileRecallQueryProbes("what was recorded?"),
      pathInflowByTarget: reciprocalPath("substitute", "unrelated"),
      behaviorAuthorityEvidenceRefByCandidateKey: new Map(),
      fixedCandidateKeys: new Set()
    });

    expect(plan.head.map((item) => item.candidateKey)).toEqual([
      protectedCandidate.candidateKey
    ]);
    expect(plan.substitutions).toEqual([]);
  });

  it("never substitutes a behavior-eligible protected candidate", () => {
    const protectedCandidate = withEvidenceRef(
      candidate("protected", "session-a"),
      "evidence:verified-protected"
    );
    const substitute = candidate("substitute", "session-a", {
      embedding_similarity: 1
    });
    const source = candidate("source", "session-b");

    const plan = governQueryEvidenceMembership({
      preProjectionHead: [protectedCandidate],
      proposedHead: [substitute],
      sourceCandidates: [protectedCandidate, substitute, source],
      queryProbes: compileRecallQueryProbes("what was recorded?"),
      pathInflowByTarget: reciprocalPath("substitute", "source"),
      behaviorAuthorityEvidenceRefByCandidateKey: new Map([[
        protectedCandidate.candidateKey,
        protectedCandidate.sourceCandidate.entry.evidence_refs[0]!
      ]]),
      fixedCandidateKeys: new Set()
    });

    expect(plan.head.map((item) => item.candidateKey)).toEqual([
      protectedCandidate.candidateKey
    ]);
    expect(plan.substitutions).toEqual([]);
  });

  it("binds behavior authorization to the verified evidence ref", () => {
    const fallback = candidate("fallback", "session-a");
    const behavior = withEvidenceRefs(
      candidate("behavior", "session-b"),
      ["evidence:unrelated", "evidence:verified"]
    );

    const plan = governQueryEvidenceMembership({
      preProjectionHead: [fallback],
      proposedHead: [behavior],
      sourceCandidates: [fallback, behavior],
      queryProbes: compileRecallQueryProbes("what value was recorded?"),
      behaviorAuthorityEvidenceRefByCandidateKey: new Map([[
        behavior.candidateKey,
        "evidence:verified"
      ]]),
      fixedCandidateKeys: new Set()
    });

    expect(plan.authorizations).toHaveLength(1);
    expect(plan.authorizations[0]?.witness).toEqual({
      kind: "behavior_identity",
      evidenceRef: "evidence:verified"
    });
  });

  it("fails closed when behavior evidence is not bound to the candidate", () => {
    const fallback = candidate("fallback", "session-a");
    const behavior = withEvidenceRef(
      candidate("behavior", "session-b"),
      "evidence:verified"
    );
    const plan = governQueryEvidenceMembership({
      preProjectionHead: [fallback],
      proposedHead: [behavior],
      sourceCandidates: [fallback, behavior],
      queryProbes: compileRecallQueryProbes("what value was recorded?"),
      behaviorAuthorityEvidenceRefByCandidateKey: new Map([[
        behavior.candidateKey,
        "evidence:unrelated"
      ]]),
      fixedCandidateKeys: new Set()
    });

    expect(plan.feasible).toBe(false);
    expect(plan.head).toEqual([fallback]);
    expect(plan.authorizations).toEqual([]);
  });

  it("does not evict an independent existing protection", () => {
    const protectedCandidate = candidate("protected", "session-a", {
      lexical_fts: 1
    });
    const substitute = candidate("substitute", "session-a", {
      lexical_fts: 1,
      evidence_fts: 1,
      source_proximity: 1,
      embedding_similarity: 1
    });
    const fixed = candidate("fixed", "session-b");

    const plan = governQueryEvidenceMembership({
      preProjectionHead: [protectedCandidate],
      proposedHead: [substitute, fixed],
      sourceCandidates: [protectedCandidate, substitute, fixed],
      queryProbes: compileRecallQueryProbes("what was recorded?"),
      pathInflowByTarget: reciprocalPath("substitute", "protected"),
      behaviorAuthorityEvidenceRefByCandidateKey: new Map(),
      fixedCandidateKeys: new Set([fixed.candidateKey])
    });

    expect(plan.head.map((item) => item.candidateKey)).toEqual([
      substitute.candidateKey,
      fixed.candidateKey
    ]);
  });

  it("allows an embedding consensus introduction alongside protected members", () => {
    const protectedCandidate = candidate("protected", "session-a", {
      lexical_fts: 1
    });
    const incumbent = candidate("incumbent", "session-b");
    const embeddingOnly = candidate("embedding-only", "session-c", {
      embedding_similarity: 1
    });

    const plan = governQueryEvidenceMembership({
      preProjectionHead: [protectedCandidate, incumbent],
      proposedHead: [protectedCandidate, embeddingOnly],
      sourceCandidates: [protectedCandidate, incumbent, embeddingOnly],
      queryProbes: compileRecallQueryProbes("what was recorded?"),
      behaviorAuthorityEvidenceRefByCandidateKey: new Map(),
      fixedCandidateKeys: new Set()
    });

    expect(plan.head.map((item) => item.candidateKey)).toEqual([
      protectedCandidate.candidateKey,
      embeddingOnly.candidateKey
    ]);
    expect(plan.feasible).toBe(true);
    expect(plan.authorizations).toEqual([{
      kind: "selector_consensus",
      authorizedCandidateKey: embeddingOnly.candidateKey,
      satisfiedByCandidateKey: embeddingOnly.candidateKey,
      witness: { kind: "selector_consensus", embeddingRank: 1 }
    }]);
  });

  it("preserves baseline order for an embedding-only permutation", () => {
    const first = candidate("first", "session-a", { embedding_similarity: 2 });
    const second = candidate("second", "session-b", { embedding_similarity: 1 });

    const plan = governQueryEvidenceMembership({
      preProjectionHead: [first, second],
      fallbackHead: [first, second],
      proposedHead: [second, first],
      sourceCandidates: [first, second],
      queryProbes: compileRecallQueryProbes("what was recorded?"),
      behaviorAuthorityEvidenceRefByCandidateKey: new Map(),
      fixedCandidateKeys: new Set()
    });

    expect(plan.head.map((item) => item.candidateKey)).toEqual([
      first.candidateKey,
      second.candidateKey
    ]);
  });

  it("ignores an unauthorized candidate without changing an authorized exchange", () => {
    const baseline = ["a", "b", "c", "d", "e"].map((id, index) =>
      candidate(id, `session-${id}`, { lexical_fts: index + 2 })
    );
    const authorized = candidate("authorized", "session-x", { lexical_fts: 1 });
    const unauthorized = candidate("unauthorized", "session-y", {
      embedding_similarity: 1
    });
    const common = {
      preProjectionHead: baseline,
      fallbackHead: baseline,
      sourceCandidates: [...baseline, authorized, unauthorized],
      queryProbes: compileRecallQueryProbes("what was recorded?"),
      behaviorAuthorityEvidenceRefByCandidateKey: new Map<string, string>(),
      fixedCandidateKeys: new Set<string>()
    } as const;

    const contaminated = governQueryEvidenceMembership({
      ...common,
      proposedHead: [authorized, unauthorized, ...baseline.slice(0, 3)]
    });
    const clean = governQueryEvidenceMembership({
      ...common,
      proposedHead: [authorized, ...baseline.slice(0, 4)]
    });

    expect(contaminated.head.map((item) => item.candidateKey)).toEqual(
      clean.head.map((item) => item.candidateKey)
    );
  });

  it("fails closed when a dominated restore would drop another requirement", () => {
    const retainedA = candidate("retained-a", "session-a", { lexical_fts: 1 });
    const gold = candidate("gold", "session-gold", {
      lexical_fts: 2,
      evidence_fts: 1,
      source_proximity: 1
    });
    const retainedB = candidate("retained-b", "session-b", { lexical_fts: 3 });
    const retainedC = candidate("retained-c", "session-c", { lexical_fts: 4 });
    const retainedD = candidate("retained-d", "session-d", { lexical_fts: 5 });
    const fixed = candidate("fixed", "session-fixed", { embedding_similarity: 1 });
    const introduced = candidate("introduced", "session-new", {
      lexical_fts: 16,
      evidence_fts: 5,
      source_proximity: 6,
      embedding_similarity: 3
    });
    const sourceCandidates = [
      retainedA, gold, retainedB, retainedC, retainedD, fixed, introduced
    ];

    const plan = governQueryEvidenceMembership({
      preProjectionHead: [retainedA, gold, retainedB, retainedC, retainedD],
      proposedHead: [fixed, retainedA, retainedB, introduced, retainedC],
      sourceCandidates,
      queryProbes: compileRecallQueryProbes("what was recorded?"),
      behaviorAuthorityEvidenceRefByCandidateKey: new Map(),
      fixedCandidateKeys: new Set([fixed.candidateKey])
    });

    expect(plan.head.map((item) => item.candidateKey)).toEqual([
      retainedA.candidateKey,
      gold.candidateKey,
      retainedB.candidateKey,
      retainedC.candidateKey,
      retainedD.candidateKey
    ]);
    expect(plan.protectedCandidateKeys).toEqual([
      retainedA.candidateKey,
      gold.candidateKey,
      retainedB.candidateKey,
      retainedC.candidateKey,
      retainedD.candidateKey
    ]);
    expect(plan.feasible).toBe(false);
  });

  it("does not drop other requirements during a dominated-member restore", () => {
    const protectedA = candidate("protected-a", "session-a", {
      lexical_fts: 1,
      evidence_fts: 1,
      source_proximity: 1
    });
    const protectedB = candidate("protected-b", "session-b", {
      evidence_fts: 2,
      source_proximity: 2
    });
    const fixed = candidate("fixed", "session-fixed");
    const introduced = candidate("introduced", "session-new", {
      lexical_fts: 16,
      evidence_fts: 5,
      source_proximity: 6
    });

    const plan = governQueryEvidenceMembership({
      preProjectionHead: [protectedA, protectedB],
      proposedHead: [fixed, introduced],
      sourceCandidates: [protectedA, protectedB, fixed, introduced],
      queryProbes: compileRecallQueryProbes("what was recorded?"),
      behaviorAuthorityEvidenceRefByCandidateKey: new Map(),
      fixedCandidateKeys: new Set([fixed.candidateKey])
    });

    expect(plan.feasible).toBe(false);
    expect(plan.protectedCandidateKeys).toEqual([
      protectedA.candidateKey,
      protectedB.candidateKey
    ]);
    expect(plan.head.map((item) => item.candidateKey)).toEqual([
      protectedA.candidateKey,
      protectedB.candidateKey
    ]);
  });

  it("retains one direct-evidence opportunity from the planned tail", () => {
    const protectedCandidate = candidate("protected", "session-a", {
      lexical_fts: 1
    });
    const directOpportunity = candidate("direct-opportunity", "session-b", {
      lexical_fts: 2,
      source_proximity: 1,
      source_evidence_agreement: 1
    });
    const filler = candidate("filler", "session-c");

    const plan = governQueryEvidenceMembership({
      preProjectionHead: [protectedCandidate, filler],
      proposedHead: [protectedCandidate, filler],
      sourceCandidates: [protectedCandidate, directOpportunity, filler],
      opportunityCandidates: [directOpportunity],
      queryProbes: compileRecallQueryProbes("what was recorded?"),
      behaviorAuthorityEvidenceRefByCandidateKey: new Map(),
      fixedCandidateKeys: new Set()
    });

    expect(plan.head.map((item) => item.candidateKey)).toEqual([
      protectedCandidate.candidateKey,
      directOpportunity.candidateKey
    ]);
  });

  it("retains an M-off graph opportunity with a reciprocal visible source", () => {
    const protectedCandidate = candidate("protected", "session-a", {
      lexical_fts: 1
    });
    const graphOpportunity = candidate("graph-opportunity", "session-b", {
      graph_expansion: 1,
      source_proximity: 1
    });
    const source = candidate("source", "session-c", { lexical_fts: 1 });
    const filler = candidate("filler", "session-d");

    const plan = governQueryEvidenceMembership({
      preProjectionHead: [protectedCandidate, filler],
      proposedHead: [protectedCandidate, filler],
      sourceCandidates: [protectedCandidate, graphOpportunity, source, filler],
      graphOpportunityCandidates: [graphOpportunity],
      visibleCandidateKeys: new Set([
        protectedCandidate.candidateKey,
        source.candidateKey,
        filler.candidateKey
      ]),
      queryProbes: compileRecallQueryProbes("what was recorded?"),
      pathInflowByTarget: reciprocalPath("graph-opportunity", "source"),
      behaviorAuthorityEvidenceRefByCandidateKey: new Map(),
      fixedCandidateKeys: new Set()
    });

    expect(plan.head.map((item) => item.candidateKey)).toEqual([
      protectedCandidate.candidateKey,
      graphOpportunity.candidateKey
    ]);
  });

  it("rejects reciprocal graph edges from different source versions", () => {
    const graphOpportunity = candidate("graph-opportunity", "session-b", {
      graph_expansion: 1,
      source_proximity: 1
    });
    const source = candidate("source", "session-c", { lexical_fts: 1 });
    const filler = candidate("filler", "session-d");
    const path = reciprocalPath("graph-opportunity", "source");

    const plan = governQueryEvidenceMembership({
      preProjectionHead: [source, filler],
      proposedHead: [source, filler],
      sourceCandidates: [graphOpportunity, source, filler],
      graphOpportunityCandidates: [graphOpportunity],
      visibleCandidateKeys: new Set([source.candidateKey, filler.candidateKey]),
      queryProbes: compileRecallQueryProbes("what was recorded?"),
      pathInflowByTarget: {
        "graph-opportunity": path["graph-opportunity"],
        source: path.source?.map((edge) => ({
          ...edge,
          pathSourceVersion: "path-v2"
        })) ?? []
      },
      behaviorAuthorityEvidenceRefByCandidateKey: new Map(),
      fixedCandidateKeys: new Set()
    });

    expect(plan.head.map((item) => item.candidateKey)).toEqual([
      source.candidateKey,
      filler.candidateKey
    ]);
  });

  it("rejects graph edges whose anchors name different objects", () => {
    const graphOpportunity = candidate("graph-opportunity", "session-b", {
      graph_expansion: 1,
      source_proximity: 1
    });
    const source = candidate("source", "session-c", { lexical_fts: 1 });
    const filler = candidate("filler", "session-d");
    const path = reciprocalPath("graph-opportunity", "source");

    const plan = governQueryEvidenceMembership({
      preProjectionHead: [source, filler],
      proposedHead: [source, filler],
      sourceCandidates: [graphOpportunity, source, filler],
      graphOpportunityCandidates: [graphOpportunity],
      visibleCandidateKeys: new Set([source.candidateKey, filler.candidateKey]),
      queryProbes: compileRecallQueryProbes("what was recorded?"),
      pathInflowByTarget: {
        ...path,
        "graph-opportunity": path["graph-opportunity"]?.map((edge) => ({
          ...edge,
          seedAnchor: { kind: "object" as const, object_id: "forged-source" }
        })) ?? []
      },
      behaviorAuthorityEvidenceRefByCandidateKey: new Map(),
      fixedCandidateKeys: new Set()
    });

    expect(plan.head.map((item) => item.candidateKey)).toEqual([
      source.candidateKey,
      filler.candidateKey
    ]);
  });

  it("skips an existing graph member when choosing an opportunity", () => {
    const existing = candidate("existing", "session-a", {
      graph_expansion: 1,
      source_proximity: 1
    });
    const opportunity = candidate("opportunity", "session-b", {
      graph_expansion: 2,
      source_proximity: 2
    });
    const source = candidate("source", "session-c", { lexical_fts: 1 });

    const plan = governQueryEvidenceMembership({
      preProjectionHead: [existing, source],
      proposedHead: [existing, source],
      sourceCandidates: [existing, opportunity, source],
      graphOpportunityCandidates: [existing, opportunity],
      visibleCandidateKeys: new Set([existing.candidateKey, source.candidateKey]),
      queryProbes: compileRecallQueryProbes("what was recorded?"),
      pathInflowByTarget: reciprocalPath("opportunity", "source"),
      behaviorAuthorityEvidenceRefByCandidateKey: new Map(),
      fixedCandidateKeys: new Set()
    });

    expect(plan.head.map((item) => item.candidateKey)).toEqual([
      opportunity.candidateKey,
      source.candidateKey
    ]);
  });

  it("does not use an embedding-backed graph opportunity in M-off mode", () => {
    const protectedCandidate = candidate("protected", "session-a", {
      lexical_fts: 1
    });
    const graphOpportunity = candidate("graph-opportunity", "session-b", {
      graph_expansion: 1,
      source_proximity: 1,
      embedding_similarity: 1
    });
    const source = candidate("source", "session-c", { lexical_fts: 1 });
    const filler = candidate("filler", "session-d");

    const plan = governQueryEvidenceMembership({
      preProjectionHead: [protectedCandidate, filler],
      proposedHead: [protectedCandidate, filler],
      sourceCandidates: [protectedCandidate, graphOpportunity, source, filler],
      graphOpportunityCandidates: [graphOpportunity],
      visibleCandidateKeys: new Set([
        protectedCandidate.candidateKey,
        source.candidateKey,
        filler.candidateKey
      ]),
      queryProbes: compileRecallQueryProbes("what was recorded?"),
      pathInflowByTarget: reciprocalPath("graph-opportunity", "source"),
      behaviorAuthorityEvidenceRefByCandidateKey: new Map(),
      fixedCandidateKeys: new Set()
    });

    expect(plan.head.map((item) => item.candidateKey)).toEqual([
      protectedCandidate.candidateKey,
      filler.candidateKey
    ]);
  });
});

function candidate(
  objectId: string,
  sessionId: string,
  ranks: Readonly<Record<string, number>> = {}
) {
  const base = createCandidate(objectId, { surface_id: sessionId });
  const sourceCandidate = {
    ...base,
    fusion: {
      ...base.fusion,
      per_stream_rank: { ...base.fusion.per_stream_rank, ...ranks }
    }
  };
  return Object.freeze({
    candidateKey: sourceCandidate.fusion.candidate_key,
    rawEmbeddingRank: sourceCandidate.fusion.per_stream_rank.embedding_similarity ?? undefined,
    sourceCandidate
  });
}

function withEvidenceRef<T extends ReturnType<typeof candidate>>(
  value: T,
  evidenceRef: string
): T {
  return withEvidenceRefs(value, [evidenceRef]);
}

function withEvidenceRefs<T extends ReturnType<typeof candidate>>(
  value: T,
  evidenceRefs: readonly string[]
): T {
  return Object.freeze({
    ...value,
    sourceCandidate: Object.freeze({
      ...value.sourceCandidate,
      entry: Object.freeze({
        ...value.sourceCandidate.entry,
        evidence_refs: Object.freeze([...evidenceRefs])
      })
    })
  }) as T;
}

function reciprocalPath(
  targetObjectId: string,
  sourceObjectId: string
): Readonly<Record<string, readonly PathInflowEdge[]>> {
  return {
    [targetObjectId]: [pathEdge(sourceObjectId, targetObjectId)],
    [sourceObjectId]: [pathEdge(targetObjectId, sourceObjectId)]
  };
}

function pathEdge(seedObjectId: string, targetObjectId: string): PathInflowEdge {
  return {
    pathId: "path-reciprocal",
    relationKind: "answers_with",
    seedObjectId,
    targetObjectId,
    seedAnchor: { kind: "object", object_id: seedObjectId },
    targetAnchor: { kind: "object", object_id: targetObjectId },
    pathSourceVersion: "path-v1",
    weight: 0.7
  };
}
