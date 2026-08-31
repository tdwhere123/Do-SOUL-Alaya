import { describe, expect, it, vi } from "vitest";
import type { RecallCandidate } from "@do-soul/alaya-protocol";
import { EmbeddingRecallService } from "../../embedding-recall/embedding-recall-service.js";
import type { RecallServiceEmbeddingRecallPort } from
  "../../recall/runtime/recall-service-types.js";
import { RecallService } from "../../recall/recall-service.js";
import {
  createEmbeddingRecord,
  createProvider,
  hashMemoryContent
} from "../embedding-recall/embedding-recall-test-helpers.js";
import {
  createDependencies,
  createMemoryEntry,
  createTaskSurface,
  overridePolicy
} from "./recall-service-test-fixtures.js";

type EmbeddingPath = "legacy" | "snapshot";
type DiagnosticCapture = "answer_features" | "packet_trace" | undefined;
type InvocationSpy = ReturnType<typeof vi.fn>;

type EmbeddingCalls = Readonly<{
  readonly provider: InvocationSpy;
  readonly preparation: InvocationSpy;
  readonly materialization: InvocationSpy;
}>;

describe("RecallService packet trace integration", () => {
  it.each(["legacy", "snapshot"] as const)(
    "emits one support-set trace without changing the %s packet",
    async (path) => {
      const control = await runRecall(path, true, "answer_features");
      const traced = await runRecall(path, true, "packet_trace");
      const trace = traced.result.diagnostics?.packet_plan_trace;
      if (trace === undefined) throw new Error("packet trace was not emitted");
      const baselineKeys = new Set(trace.baseline_candidate_keys);

      expect(control.result.diagnostics?.packet_plan_trace).toBeUndefined();
      expect(trace).toMatchObject({
        schema_version: 3,
        assessment_path: path,
        actual_candidate_keys: packetCandidateKeys(traced.result.candidates),
        decision: { status: "no_op", reason: "select_gamma_identity" }
      });
      expect(trace.added_candidate_keys).toEqual(
        trace.actual_candidate_keys.filter((key) => !baselineKeys.has(key))
      );
      expect(trace.removed_candidate_keys).toEqual(
        trace.baseline_candidate_keys.filter(
          (key) => !trace.actual_candidate_keys.includes(key)
        )
      );
      expect(trace.actual_candidate_keys).toEqual(
        packetCandidateKeys(traced.result.candidates)
      );
      expect(traced.result.candidates).toEqual(control.result.candidates);
      expect(traced.result.diagnostics?.candidates).toEqual(
        control.result.diagnostics?.candidates
      );

      expectEmbeddingCalls(control.calls, 1);
      expectEmbeddingCalls(traced.calls, 1);
      expect(invocationCounts(traced.calls)).toEqual(invocationCounts(control.calls));
    }
  );

  it.each(["legacy", "snapshot"] as const)(
    "is an exact packet no-op when embedding is disabled on the %s path",
    async (path) => {
      const control = await runRecall(path, false, "answer_features");
      const traced = await runRecall(path, false, "packet_trace");
      const trace = traced.result.diagnostics?.packet_plan_trace;

      expect(control.result.diagnostics?.packet_plan_trace).toBeUndefined();
      expect(trace?.decision).toEqual({
        status: "no_op",
        reason: "select_gamma_identity"
      });
      expect(trace?.baseline_candidate_keys).toEqual(trace?.planned_candidate_keys);
      expect(trace?.baseline_candidate_keys).toEqual(trace?.actual_candidate_keys);
      expect(traced.result.candidates).toEqual(control.result.candidates);
      expect(traced.result.diagnostics?.candidates).toEqual(
        control.result.diagnostics?.candidates
      );
      expectEmbeddingCalls(control.calls, 0);
      expectEmbeddingCalls(traced.calls, 0);
    }
  );

  it.each(["legacy", "snapshot"] as const)(
    "omits per-candidate dumps on the %s path when diagnosticCapture is unset",
    async (path) => {
      const production = await runRecall(path, true, undefined);
      const captured = await runRecall(path, true, "answer_features");
      expect(production.result.candidates).toEqual(captured.result.candidates);
      expect(production.result.diagnostics?.candidates).toEqual([]);
      expect(production.result.diagnostics?.fusion_breakdown).toEqual([]);
      expect(production.result.diagnostics?.fine_assessment_pruned_candidates).toEqual([]);
      expect(production.result.diagnostics?.packet_plan_trace).toBeUndefined();
      expect(captured.result.diagnostics?.candidates.length).toBeGreaterThan(0);
      expect(captured.result.diagnostics?.fusion_breakdown.length).toBeGreaterThan(0);
      expect(production.result.diagnostics?.embedding_provider_status)
        .toBe(captured.result.diagnostics?.embedding_provider_status);
    }
  );
});

async function runRecall(
  path: EmbeddingPath,
  embeddingEnabled: boolean,
  diagnosticCapture: DiagnosticCapture
) {
  const memories = createFixedMemories();
  const { dependencies } = createDependencies(memories);
  const embedTexts = vi.fn(async () => [new Float32Array([1, 0])]);
  const embeddingService = new EmbeddingRecallService({
    embeddingRepo: {
      listByObjectIds: vi.fn(async (_workspaceId, objectIds) =>
        createEmbeddingRecords(memories).filter((record) =>
          objectIds.includes(record.object_id)
        )
      )
    },
    provider: createProvider({ embedTexts }),
    eventLogRepo: dependencies.eventLogRepo,
    generateQueryId: () => `${path}-packet-trace-query`
  });
  const fixture = createEmbeddingPort(path, embeddingService, embedTexts);
  const service = new RecallService({
    ...dependencies,
    embeddingRecallService: fixture.port,
    testOnlyAllowInMemoryFieldQuerySession: true
  });
  const taskSurface = {
    ...createTaskSurface(),
    display_name: "Packet trace semantic procedure"
  };
  const basePolicy = service.buildDefaultPolicy("analyze", taskSurface.runtime_id);
  const policyOverride = overridePolicy(basePolicy, {
    coarse_filter: {
      ...basePolicy.coarse_filter,
      precomputed_rank: {
        ...basePolicy.coarse_filter.precomputed_rank,
        max_candidates: memories.length,
        min_activation_score: null
      },
      semantic_supplement: {
        ...basePolicy.coarse_filter.semantic_supplement,
        enabled: true,
        embedding_enabled: embeddingEnabled,
        max_supplement: memories.length,
        injection_cap: 0
      }
    },
    fine_assessment: {
      ...basePolicy.fine_assessment,
      budgets: {
        max_entries: 3,
        max_total_tokens: 1_000,
        per_dimension_limits: null
      }
    }
  });
  const result = await service.recall({
    taskSurface,
    workspaceId: "workspace-1",
    strategy: "analyze",
    policyOverride,
    diagnosticCapture
  });

  return { result, calls: fixture.calls };
}

function createEmbeddingPort(
  path: EmbeddingPath,
  service: EmbeddingRecallService,
  provider: InvocationSpy
): Readonly<{
  readonly port: RecallServiceEmbeddingRecallPort;
  readonly calls: EmbeddingCalls;
}> {
  if (path === "snapshot") {
    const preparation = vi.fn((
      params: Parameters<EmbeddingRecallService["prepareRecallEmbeddingSnapshot"]>[0]
    ) => service.prepareRecallEmbeddingSnapshot(params));
    const materialization = vi.fn((
      params: Parameters<
        EmbeddingRecallService["materializeEmbeddingSupplementFromSnapshot"]
      >[0]
    ) => service.materializeEmbeddingSupplementFromSnapshot(params));
    return {
      port: {
        prepareRecallEmbeddingSnapshot: preparation,
        materializeEmbeddingSupplementFromSnapshot: materialization,
        querySupplement: (params) => service.querySupplement(params)
      },
      calls: { provider, preparation, materialization }
    };
  }

  const preparation = vi.fn((
    params: Parameters<EmbeddingRecallService["prepareQuerySupplement"]>[0]
  ) => service.prepareQuerySupplement(params));
  const materialization = vi.fn((
    params: Parameters<EmbeddingRecallService["querySupplementIfReady"]>[0]
  ) => service.querySupplementIfReady(params));
  return {
    port: {
      prepareQuerySupplement: preparation,
      querySupplementIfReady: materialization,
      querySupplement: (params) => service.querySupplement(params)
    },
    calls: { provider, preparation, materialization }
  };
}

function createFixedMemories() {
  return Object.freeze([
    createMemoryEntry({
      object_id: "packet-baseline-a",
      content: "Packet trace semantic procedure primary step",
      activation_score: 0.9
    }),
    createMemoryEntry({
      object_id: "packet-baseline-b",
      content: "Packet trace semantic procedure secondary step",
      activation_score: 0.8
    }),
    createMemoryEntry({
      object_id: "packet-tail",
      content: "Packet trace semantic procedure final step",
      activation_score: 0.7
    }),
    createMemoryEntry({
      object_id: "packet-embedding",
      content: "Unrelated semantic alternative",
      activation_score: 0.01
    })
  ]);
}

function createEmbeddingRecords(
  memories: ReturnType<typeof createFixedMemories>
) {
  const embedded = memories.filter((candidate) =>
    ["packet-baseline-a", "packet-embedding"].includes(candidate.object_id)
  );
  if (embedded.length !== 2) throw new Error("embedding fixture memories missing");
  return embedded.map((memory) => createEmbeddingRecord({
    object_id: memory.object_id,
    content_hash: hashMemoryContent(memory.content),
    embedding: new Float32Array([0.2, Math.sqrt(0.96)])
  }));
}

function packetCandidateKeys(
  candidates: readonly Readonly<RecallCandidate>[]
): readonly string[] {
  return candidates.map((candidate) =>
    `${candidate.origin_plane ?? "workspace_local"}:${candidate.object_kind}:${candidate.object_id}`
  );
}


function expectEmbeddingCalls(calls: EmbeddingCalls, expected: number): void {
  expect(calls.provider).toHaveBeenCalledTimes(expected);
  expect(calls.preparation).toHaveBeenCalledTimes(expected);
  expect(calls.materialization).toHaveBeenCalledTimes(expected);
}

function invocationCounts(calls: EmbeddingCalls): readonly number[] {
  return [
    calls.provider.mock.calls.length,
    calls.preparation.mock.calls.length,
    calls.materialization.mock.calls.length
  ];
}
