import { describe, expect, it, vi } from "vitest";
import { RecallService } from "../../../recall/recall-service.js";
import { buildFineAssessmentAnswerSupportContext } from
  "../../../recall/delivery/answer-support/answer-support-context.js";
import {
  compileRecallAnswerShapePlan,
  recallAnswerShapeSupportsSingleSemanticLeader,
  resolvePreparedAnswerShapePlan
} from "../../../recall/query/recall-answer-shape-plan.js";
import { compileRecallQueryDemand } from
  "../../../recall/query/recall-query-demand.js";
import { compileRecallQueryProbes } from
  "../../../recall/query/recall-query-probes.js";
import { resolveDeepHeadScores } from "../../../recall/rerank/deep-head.js";
import {
  createCandidate,
  createSupplementaryData
} from "../fine-assessment-selection-fixtures.js";
import { emptySupplementary, fusedCandidate } from "../rerank/deep-head-fixtures.js";
import {
  createDependencies,
  createMemoryEntry,
  createTaskSurface
} from "../recall-service-test-fixtures.js";

describe("one policy surface", () => {
  it("compiles query geometry once and reuses a prepared plan", () => {
    const probes = compileRecallQueryProbes("How many different doctors did I visit?");
    const prepared = compileRecallAnswerShapePlan(probes);
    const injected = compileRecallAnswerShapePlan(
      compileRecallQueryProbes("Where did I buy my new bookshelf from?")
    );

    expect(resolvePreparedAnswerShapePlan(probes)).toEqual(prepared);
    expect(resolvePreparedAnswerShapePlan(probes, injected)).toBe(injected);
    expect(recallAnswerShapeSupportsSingleSemanticLeader(prepared)).toBe(false);
    expect(recallAnswerShapeSupportsSingleSemanticLeader(injected)).toBe(true);
  });

  it("does not grow a cardinality demand kind for aggregate or place queries", () => {
    const queries = [
      "How many different doctors did I visit?",
      "How much total money have I spent on bike expenses?",
      "How many places did I visit?",
      "Where did I buy my new bookshelf from?"
    ];
    const kinds = new Set(queries.flatMap((query) =>
      compileRecallQueryDemand(compileRecallQueryProbes(query)).atoms.map(
        (atom) => atom.kind
      )
    ));

    expect(kinds.has("ordering")).toBe(false);
    expect([...kinds].every((kind) =>
      kind === "lexical_term" || kind === "temporal" || kind === "phrase"
    )).toBe(true);
  });

  it("uses the prepared plan for answer-support instead of recompiling probes", () => {
    const probes = compileRecallQueryProbes("How many dogs do I own?");
    const placePlan = compileRecallAnswerShapePlan(
      compileRecallQueryProbes("Where did I buy my new bookshelf from?")
    );
    const candidate = createCandidate("bookshelf", {
      content: "The new bookshelf is from IKEA.",
      evidence_refs: ["evidence-bookshelf"]
    });

    const support = buildFineAssessmentAnswerSupportContext({
      candidates: [candidate],
      supplementaryData: createSupplementaryData({ queryProbes: probes }),
      captureObservations: false,
      plan: placePlan
    }).supportByCandidateKey.get(candidate.fusion.candidate_key);

    expect(support?.shape).toBe("place");
  });

  it("keeps capture-off and capture-on query geometry identical", async () => {
    const memory = createMemoryEntry({
      content: "I take yoga classes at Serenity Yoga."
    });
    const { dependencies } = createDependencies([memory]);
    const service = new RecallService(dependencies);
    const taskSurface = {
      ...createTaskSurface(),
      display_name: "How many different yoga studios do I visit?"
    };

    const ordinary = await service.recall({
      taskSurface,
      workspaceId: "workspace-1",
      strategy: "analyze"
    });
    const selectionBoundaryObserver = vi.fn(() => undefined);
    const captured = await service.recall({
      taskSurface,
      workspaceId: "workspace-1",
      strategy: "analyze",
      selectionBoundaryObserver
    });

    expect(ordinary.diagnostics?.answer_shape_plan).toEqual(
      captured.diagnostics?.answer_shape_plan
    );
    expect(captured.diagnostics?.answer_shape_plan).toMatchObject({
      status: "high_confidence",
      shape: "distinct_entities"
    });
    expect(selectionBoundaryObserver).toHaveBeenCalledOnce();
  });

  it("does not let a dormant cross-encoder map replace lightweight scores", () => {
    const candidates = [
      fusedCandidate({ objectId: "a", fusedScore: 0.9, fusedRank: 1, embedding: 0.1 }),
      fusedCandidate({ objectId: "b", fusedScore: 0.8, fusedRank: 2, embedding: 0.9 })
    ];
    const supplementaryData = emptySupplementary({
      embeddingSimilarityScores: { a: 0.1, b: 0.9 }
    });
    const ceScores = new Map([
      [candidates[0]!.fusion.candidate_key, 0.95],
      [candidates[1]!.fusion.candidate_key, 0.1]
    ]);

    const withCe = resolveDeepHeadScores({
      candidates,
      answerRelevanceScores: ceScores,
      supplementaryData
    });
    const withoutCe = resolveDeepHeadScores({
      candidates,
      answerRelevanceScores: new Map(),
      supplementaryData
    });

    expect(withCe).toEqual(withoutCe);
    expect(withoutCe.get(candidates[1]!.fusion.candidate_key)!)
      .toBeGreaterThan(withoutCe.get(candidates[0]!.fusion.candidate_key)!);
  });
});
