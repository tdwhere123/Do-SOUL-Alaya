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
type DiagnosticCapture = "answer_features" | "packet_trace";
type InvocationSpy = ReturnType<typeof vi.fn>;

type EmbeddingCalls = Readonly<{
  readonly provider: InvocationSpy;
  readonly preparation: InvocationSpy;
  readonly materialization: InvocationSpy;
}>;

describe("RecallService packet trace integration", () => {
  it.each(["legacy", "snapshot"] as const)(
    "observes the independent no-embedding packet without changing the %s packet",
    async (path) => {
      const baseline = await runRecall(path, false, "answer_features");
      const control = await runRecall(path, true, "answer_features");
      const traced = await runRecall(path, true, "packet_trace");
      const trace = traced.result.diagnostics?.packet_plan_trace;

      expect(trace).toMatchObject({
        schema_version: 1,
        assessment_path: path,
        planned_candidate_keys: null,
        decision: {
          status: "not_attempted",
          challenger_candidate_key: null,
          victim_candidate_key: null,
          reason: null
        }
      });
      expect(trace?.baseline_candidate_keys).toEqual(
        packetCandidateKeys(baseline.result.candidates)
      );
      expect(trace?.actual_candidate_keys).toEqual(
        packetCandidateKeys(traced.result.candidates)
      );
      expect(traced.result.candidates).toEqual(control.result.candidates);
      expect(traced.result.diagnostics?.candidates).toEqual(
        control.result.diagnostics?.candidates
      );

      expectEmbeddingCalls(baseline.calls, 0);
      expectEmbeddingCalls(control.calls, 1);
      expectEmbeddingCalls(traced.calls, 1);
      expect(invocationCounts(traced.calls)).toEqual(invocationCounts(control.calls));
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
    embeddingRecallService: fixture.port
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
        max_entries: 1,
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
      object_id: "packet-baseline",
      content: "Packet trace primary procedure",
      activation_score: 0.2
    }),
    createMemoryEntry({
      object_id: "packet-embedding",
      content: "Packet trace semantic alternative",
      activation_score: 0.19
    })
  ]);
}

function createEmbeddingRecords(
  memories: ReturnType<typeof createFixedMemories>
) {
  return memories.map((memory, index) => createEmbeddingRecord({
    object_id: memory.object_id,
    content_hash: hashMemoryContent(memory.content),
    embedding: index === 0
      ? new Float32Array([0, 1])
      : new Float32Array([1, 0])
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
