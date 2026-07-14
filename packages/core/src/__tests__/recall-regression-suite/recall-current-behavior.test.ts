import { describe, expect, it, vi } from "vitest";
import { RecallService } from "../../recall/recall-service.js";
import { selectCandidatesWithinBudgets } from "../../recall/runtime/recall-candidate-builder.js";
import { compareRecallCandidates } from "../../recall/runtime/recall-service-helpers.js";
import { WS, candidate, deps, evidenceCapsule, fineConfig, memory, pathRelation, task, withBudgets } from "./recall-current-behavior-test-fixtures.js";
import {
  RECALL_PHASES,
  createAnswerableSourceWindowScenario,
  createEvidenceFanoutScenario,
  createSourceDeliveryBudgetScenario
} from "./recall-current-behavior-scenarios.js";

describe("recall regression suite", () => {
it.each([
    ["mixed dimensions", ["gold", "peer-1", "peer-2", "peer-3", "peer-4"]],
    ["warm workspace peers", ["gold", "warm-1", "warm-2", "warm-3", "warm-4"]],
    ["constraint peers", ["gold", "constraint-1", "constraint-2", "constraint-3", "constraint-4"]]
  ])("keeps high-lexical gold inside top five under %s", (_name, ids) => {
    const candidates = ids.map((id, index) =>
      candidate(id, id === "gold" ? 0.98 : 0.7 - index * 0.05, id === "gold" ? 0.2 : 0.9)
    );
    const topFive = [...candidates].sort(compareRecallCandidates).slice(0, 5);
    expect(topFive.map((item) => item.object_id)).toContain("gold");
  });

it.each([
    ["simple descending", [0.9, 0.8, 0.7, 0.6]],
    ["tie broken by activation", [0.8, 0.8, 0.7, 0.7]],
    ["long tail", [0.95, 0.9, 0.6, 0.4, 0.2]]
  ])("keeps delivered ordering monotonic for %s", (_name, scores) => {
    const sorted = scores
      .map((score, index) => candidate(`mem-${index}`, score, index % 2 === 0 ? 0.5 : 0.4))
      .sort(compareRecallCandidates);
    expect(sorted.map((item) => item.relevance_score)).toEqual(
      [...scores].sort((left, right) => right - left)
    );
  });

it("drops excess candidates by max_entries", () => {
    const selected = selectCandidatesWithinBudgets(
      [candidate("a", 0.9), candidate("b", 0.8), candidate("c", 0.7)],
      fineConfig({ max_entries: 2, max_total_tokens: 1000 })
    );
    expect(selected.map((item) => item.object_id)).toEqual(["a", "b"]);
  });

it("drops candidates that would exceed token budget", () => {
    const selected = selectCandidatesWithinBudgets(
      [candidate("a", 0.9, 0.5, 8), candidate("b", 0.8, 0.5, 8)],
      fineConfig({ max_entries: 5, max_total_tokens: 10 })
    );
    expect(selected.map((item) => item.object_id)).toEqual(["a"]);
  });

it("keeps winning admission diagnostics aligned to the first specific attribution plane", async () => {
    const mem = memory({ object_id: "lexical-gold", content: "release checklist lexical-gold" });
    const { dependencies } = deps([mem], {
      searchByKeyword: async () => [{ object_id: "lexical-gold", normalized_rank: 1 }]
    });
    const result = await new RecallService(dependencies).recall({
      taskSurface: task("release checklist lexical-gold"),
      workspaceId: WS,
      strategy: "analyze"
    });
    const diag = result.diagnostics?.candidates.find((item) => item.object_id === "lexical-gold");
    expect(diag?.plane_first_admitted).toBe("activation");
    expect(diag?.admission_planes).toContain("lexical");
    expect(diag?.plane_winning_admission).toBe("lexical");
  });

it("emits per-phase latency telemetry on the full recall path", async () => {
    const mem = memory({ object_id: "phase-mem", content: "phase latency probe" });
    const { dependencies } = deps([mem], {
      searchByKeyword: async () => [{ object_id: "phase-mem", normalized_rank: 1 }]
    });
    const result = await new RecallService(dependencies).recall({
      taskSurface: task("phase latency probe"),
      workspaceId: WS,
      strategy: "analyze"
    });
    const latency = result.diagnostics?.phase_latency_ms;
    expect(latency).toBeDefined();
    expect(Object.keys(latency ?? {})).toEqual(RECALL_PHASES);
    for (const value of Object.values(latency ?? {})) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(value)).toBe(true);
    }
  });

it("records path_expansion as the winning admission plane for path-only linked candidates", async () => {
    const seed = memory({ object_id: "seed", content: "needle seed" });
    const linked = memory({ object_id: "linked", content: "linked recall target" });
    const relation = pathRelation("seed", "linked");
    const { dependencies } = deps([seed, linked], {
      searchByKeyword: async () => [{ object_id: "seed", normalized_rank: 1 }],
      pathExpansionPort: {
        findByAnchors: vi.fn(async () => [relation])
      }
    });
    const result = await new RecallService(dependencies).recall({
      taskSurface: task("needle seed"),
      workspaceId: WS,
      strategy: "analyze"
    });
    const diag = result.diagnostics?.candidates.find((item) => item.object_id === "linked");
    expect(diag?.admission_planes).toContain("path_expansion");
    expect(diag?.plane_winning_admission).toBe("path_expansion");
    expect(diag?.path_expansion_sources).toEqual([
      {
        path_id: relation.path_id,
        seed_id: "seed",
        seed_kind: "memory",
        target_object_id: "linked",
        source_channel: "path_expansion",
        relation_kind: "co_usage",
        facet_key: null
      }
    ]);
  });

it("uses source proximity as an independent fusion stream for neighboring evidence chunks", async () => {
    const seed = memory({
      object_id: "seed",
      content: "needle source chunk",
      evidence_refs: ["source-a-s1-t3"],
      domain_tags: ["seed-only"],
      run_id: "run-seed"
    });
    const neighbor = memory({
      object_id: "neighbor",
      content: "nearby answer payload",
      evidence_refs: ["source-a-s1-t4"],
      domain_tags: ["neighbor-only"],
      run_id: "run-neighbor",
      activation_score: 0.1
    });
    const { dependencies } = deps([seed, neighbor], {
      searchByKeyword: async () => [{ object_id: "seed", normalized_rank: 1 }]
    });

    const result = await new RecallService(dependencies).recall({
      taskSurface: task("needle source chunk"),
      workspaceId: WS,
      strategy: "analyze"
    });

    const diag = result.diagnostics?.candidates.find((item) => item.object_id === "neighbor");
    expect(diag?.admission_planes).toContain("source_proximity");
    expect(diag?.source_channels).toContain("source_proximity");
    expect(diag?.per_stream_rank.source_proximity).not.toBeNull();
    expect(diag?.fused_rank_contribution_per_stream.source_proximity).toBeGreaterThan(0);
    expect(diag?.structural_score).toBeGreaterThan(0);
    expect(diag?.structural_score).toBeLessThanOrEqual(0.25);
    expect(diag?.per_stream_rank.structural).not.toBeNull();
    expect(diag?.per_stream_rank.evidence_structural_agreement).toBeNull();
    expect(diag?.per_stream_rank.source_evidence_agreement).toBeNull();
  });

it("promotes answerable source-window neighbors without lifting source-only neighbors", async () => {
    const { dependencies, answerableNeighbor, sourceOnlyNeighbor } =
      createAnswerableSourceWindowScenario();
    const service = new RecallService(dependencies);
    const policy = withBudgets(service.buildDefaultPolicy("analyze", task().runtime_id), {
      max_entries: 5,
      max_total_tokens: 1000
    });

    const result = await service.recall({
      taskSurface: task("Where did I buy my new bookshelf?"),
      workspaceId: WS,
      strategy: "analyze",
      policyOverride: policy
    });

    expect(result.candidates.map((item) => item.object_id)).toContain(answerableNeighbor.object_id);
    expect(result.candidates.map((item) => item.object_id)).not.toContain(sourceOnlyNeighbor.object_id);
    expect(result.diagnostics?.query_probes.normalized_query).toBe("Where did I buy my new bookshelf?");
    expect(result.diagnostics?.query_sought_facets).toContain("location_place");
    const answerDiagnostic = result.diagnostics?.candidates.find(
      (item) => item.object_id === answerableNeighbor.object_id
    );
    const sourceOnlyDiagnostic = result.diagnostics?.candidates.find(
      (item) => item.object_id === sourceOnlyNeighbor.object_id
    );
    expect(answerDiagnostic?.per_stream_rank.evidence_fts).not.toBeNull();
    expect(answerDiagnostic?.per_stream_rank.source_proximity).not.toBeNull();
    expect(answerDiagnostic?.per_stream_rank.source_evidence_agreement).not.toBeNull();
    expect(answerDiagnostic?.fused_rank_contribution_per_stream.source_proximity).toBeGreaterThan(0);
    expect(
      (answerDiagnostic?.fused_rank_contribution_per_stream.evidence_fts ?? 0) +
      (answerDiagnostic?.fused_rank_contribution_per_stream.evidence_structural_agreement ?? 0) +
      (answerDiagnostic?.fused_rank_contribution_per_stream.source_evidence_agreement ?? 0)
    ).toBeGreaterThan(0);
    expect(sourceOnlyDiagnostic?.per_stream_rank.source_proximity).not.toBeNull();
    expect(sourceOnlyDiagnostic?.per_stream_rank.source_evidence_agreement).toBeNull();
  });

it("uses subject alignment only for self-referential personal-memory queries", async () => {
    const genericAdvice = memory({
      object_id: "generic-advice",
      content: "You can buy a new bookshelf from several stores, including Target and IKEA.",
      activation_score: 0.9
    });
    const personalFact = memory({
      object_id: "personal-fact",
      content: "I bought my new bookshelf from IKEA after checking Target first.",
      activation_score: 0.1
    });
    const { dependencies } = deps([genericAdvice, personalFact], {
      searchByKeyword: async () => [
        { object_id: "generic-advice", normalized_rank: 1 },
        { object_id: "personal-fact", normalized_rank: 0.99 }
      ]
    });
    const service = new RecallService(dependencies);
    const policy = withBudgets(service.buildDefaultPolicy("analyze", task().runtime_id), {
      max_entries: 1,
      max_total_tokens: 1000
    });

    const personalResult = await service.recall({
      taskSurface: task("Where did I buy my new bookshelf?"),
      workspaceId: WS,
      strategy: "analyze",
      policyOverride: policy
    });

    expect(personalResult.candidates.map((item) => item.object_id)).toEqual(["personal-fact"]);
    const personalDiagnostic = personalResult.diagnostics?.candidates.find((item) => item.object_id === "personal-fact");
    const adviceDiagnostic = personalResult.diagnostics?.candidates.find((item) => item.object_id === "generic-advice");
    expect(personalDiagnostic?.per_stream_rank.subject_alignment).toBe(1);
    expect(adviceDiagnostic?.per_stream_rank.subject_alignment).toBeNull();

    const thirdPersonResult = await service.recall({
      taskSurface: task("Where did Alex buy the new bookshelf?"),
      workspaceId: WS,
      strategy: "analyze",
      policyOverride: policy
    });
    const thirdPersonPersonalDiagnostic = thirdPersonResult.diagnostics?.candidates.find(
      (item) => item.object_id === "personal-fact"
    );
    expect(thirdPersonPersonalDiagnostic?.per_stream_rank.subject_alignment).toBeNull();
  });

it("uses evidence capsule artifact refs for source proximity when memory refs are capsule ids", async () => {
    const seed = memory({
      object_id: "seed",
      content: "needle source chunk",
      evidence_refs: ["evidence-seed"]
    });
    const neighbor = memory({
      object_id: "neighbor",
      content: "nearby answer payload",
      evidence_refs: ["evidence-neighbor"],
      activation_score: 0.1
    });
    const evidenceById = new Map([
      ["evidence-seed", evidenceCapsule("evidence-seed", "source-a-s1-t3")],
      ["evidence-neighbor", evidenceCapsule("evidence-neighbor", "source-a-s1-t4")]
    ]);
    const findByIds = vi.fn(async (_workspaceId: string, ids: readonly string[]) =>
      ids.flatMap((id) => {
        const evidence = evidenceById.get(id);
        return evidence === undefined ? [] : [evidence];
      })
    );
    const { dependencies } = deps([seed, neighbor], {
      searchByKeyword: async () => [{ object_id: "seed", normalized_rank: 1 }],
      evidenceSearchPort: {
        searchByKeyword: vi.fn(async () => []),
        findByIds
      }
    });

    const result = await new RecallService(dependencies).recall({
      taskSurface: task("needle source chunk"),
      workspaceId: WS,
      strategy: "analyze"
    });

    expect(findByIds).toHaveBeenCalled();
    const diag = result.diagnostics?.candidates.find((item) => item.object_id === "neighbor");
    expect(diag?.admission_planes).toContain("source_proximity");
    expect(diag?.per_stream_rank.source_proximity).not.toBeNull();
    expect(diag?.fused_rank_contribution_per_stream.source_proximity).toBeGreaterThan(0);
  });

it("caps per-memory evidence_refs forwarded to findByIds for the gist collector at 8", async () => {
    const { dependencies, findByIds, topRankedRef } = createEvidenceFanoutScenario();

    await new RecallService(dependencies).recall({
      taskSurface: task("needle answer payload"),
      workspaceId: WS,
      strategy: "analyze",
      diagnosticCapture: "answer_features"
    });

    expect(findByIds).toHaveBeenCalled();
    const callsUnderCap = findByIds.mock.calls
      .map((call) => call[1] as readonly string[])
      .filter((ids) => ids.length <= 8);
    expect(callsUnderCap.length).toBeGreaterThan(0);
    const cappedCall = callsUnderCap[0]!;
    expect(cappedCall.length).toBeLessThanOrEqual(8);
    expect(cappedCall).toContain(topRankedRef);
  });

it("keeps final delivery budget filled after source proximity admission", async () => {
    const { dependencies, siblingId, outsideRadiusId } = createSourceDeliveryBudgetScenario();
    const service = new RecallService(dependencies);
    const policy = withBudgets(service.buildDefaultPolicy("analyze", task().runtime_id), {
      max_entries: 10,
      max_total_tokens: 1000
    });

    const result = await service.recall({
      taskSurface: task("needle answer primary"),
      workspaceId: WS,
      strategy: "analyze",
      policyOverride: policy
    });

    expect(result.candidates).toHaveLength(10);
    const siblingDiagnostic = result.diagnostics?.candidates.find(
      (item) => item.object_id === siblingId
    );
    expect(siblingDiagnostic?.admission_planes).toEqual(["source_proximity"]);
    expect(siblingDiagnostic?.per_stream_rank.source_proximity).not.toBeNull();
    const diagnostics = result.diagnostics?.candidates ?? [];
    const deliveredDiagnostics = diagnostics.filter((item) => item.final_rank !== null);
    expect(deliveredDiagnostics).toHaveLength(10);
    // Deep-head reorder + coverage packing may deliver past fused top-K; admission
    // still fills the budget and excludes out-of-radius neighbors.
    expect(deliveredDiagnostics.every((item) => item.dropped_reason === null)).toBe(true);
    const outsideDiagnostic = diagnostics.find(
      (item) => item.object_id === outsideRadiusId
    );
    expect(outsideDiagnostic).toBeUndefined();
  });

it("bounds source-proximity admission by the delivery budget", async () => {
    const seeds = Array.from({ length: 12 }, (_, index) =>
      memory({
        object_id: `source-seed-${index}`,
        content: `source proximity seed ${index}`,
        evidence_refs: [`source-wide-s1-t${index * 20 + 10}`],
        activation_score: 0.95 - index * 0.01
      })
    );
    const neighbors = seeds.flatMap((seed, seedIndex) =>
      Array.from({ length: 6 }, (_, neighborIndex) =>
        memory({
          object_id: `${seed.object_id}-neighbor-${neighborIndex}`,
          content: `nearby source-only neighbor ${seedIndex}-${neighborIndex}`,
          evidence_refs: [`source-wide-s1-t${seedIndex * 20 + 11 + neighborIndex}`],
          activation_score: 0.01
        })
      )
    );
    const { dependencies } = deps([...seeds, ...neighbors], {
      searchByKeyword: async () =>
        seeds.map((entry, index) => ({
          object_id: entry.object_id,
          normalized_rank: 1 - index * 0.01
        }))
    });
    const service = new RecallService(dependencies);
    const policy = withBudgets(service.buildDefaultPolicy("analyze", task().runtime_id), {
      max_entries: 5,
      max_total_tokens: 1000
    });

    const result = await service.recall({
      taskSurface: task("source proximity seed"),
      workspaceId: WS,
      strategy: "analyze",
      policyOverride: policy
    });

    const sourceOnlyDiagnostics = (result.diagnostics?.candidates ?? [])
      .filter((item) => item.admission_planes.includes("source_proximity"))
      .filter((item) => !item.admission_planes.includes("lexical"));
    expect(sourceOnlyDiagnostics.length).toBeLessThanOrEqual(20);
  });
});
