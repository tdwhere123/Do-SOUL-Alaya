import type {
  MemorySearchResult,
  SoulMemorySearchDegradationReason
} from "@do-soul/alaya-protocol";
import type {
  BenchContextUsageObject,
  BenchEmbeddingProviderKind,
  BenchEmbeddingWarmupSummary,
  BenchQueryEmbeddingWarmupSummary,
  BenchReportContextUsageInput
} from "./daemon-types.js";
import { formatEmbeddingWarmupNotReadyError } from "./embedding-warmup.js";

const BENCH_EDGE_PLANE_ENV = "ALAYA_BENCH_RUN_EDGE_PLANE";
const DEFAULT_LOCAL_ONNX_EMBEDDING_MODEL =
  "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
const DEFAULT_BENCH_EMBEDDING_MODEL = "text-embedding-3-small";

export function buildReportContextUsageArgs(
  input: BenchReportContextUsageInput
): Record<string, unknown> {
  return {
    delivery_id: input.deliveryId,
    usage_state: input.usageState,
    ...(input.usedObjectIds === undefined
      ? {}
      : { used_object_ids: [...input.usedObjectIds] }),
    ...(input.deliveredObjects === undefined
      ? {}
      : {
          delivered_objects: input.deliveredObjects.map(toReportedDeliveredObject)
        }),
    ...(input.turnIndex === undefined ? {} : { turn_index: input.turnIndex }),
    ...(input.turnDigest === undefined
      ? {}
      : {
          turn_digest: {
            last_messages: input.turnDigest.lastMessages.map((message) => ({
              role: message.role,
              content_excerpt: message.contentExcerpt
            }))
          }
        }),
    ...(input.reason === undefined ? {} : { reason: input.reason })
  };
}

function toReportedDeliveredObject(object: BenchContextUsageObject) {
  return {
    object_id: object.objectId,
    ...(object.objectKind === undefined ? {} : { object_kind: object.objectKind }),
    usage_status: object.usageStatus
  };
}

export function notRequestedEmbeddingWarmupSummary(
  objectIds: readonly string[]
): BenchEmbeddingWarmupSummary {
  return {
    status: "not_requested",
    expected_count: objectIds.length,
    ready_count: 0,
    ready_rate: 0,
    pass_count: 0,
    missing_object_ids: [...objectIds],
    provider_kind: null,
    model_id: null
  };
}

export function resolveBenchEmbeddingModelId(
  providerKind: BenchEmbeddingProviderKind,
  env: Partial<Record<string, string | undefined>>
): { readonly providerKind: string; readonly modelId: string } {
  if (providerKind === "local_onnx") {
    return {
      providerKind,
      modelId:
        env.ALAYA_LOCAL_EMBEDDING_MODEL?.trim() ||
        DEFAULT_LOCAL_ONNX_EMBEDDING_MODEL
    };
  }
  return {
    providerKind,
    modelId: env.OPENAI_EMBEDDING_MODEL?.trim() || DEFAULT_BENCH_EMBEDDING_MODEL
  };
}

export function assertWarmEmbeddingReady(
  summary: BenchEmbeddingWarmupSummary,
  lastPassError: string | null
): void {
  if (summary.ready_count >= summary.expected_count) {
    return;
  }
  throw new Error(formatEmbeddingWarmupNotReadyError(summary, lastPassError));
}

export function notRequestedQueryEmbeddingWarmupSummary(
  queryCount: number
): BenchQueryEmbeddingWarmupSummary {
  return {
    status: "not_requested",
    requested_count: queryCount,
    ready_count: 0,
    cache_hit_count: 0,
    provider_requested_count: 0,
    missing_count: queryCount,
    provider_kind: null,
    model_id: null
  };
}

export function resolveBenchRecallDegradationReason(
  results: readonly MemorySearchResult[],
  degradationReason: SoulMemorySearchDegradationReason | null
): SoulMemorySearchDegradationReason | null {
  if (degradationReason !== null) {
    return degradationReason;
  }
  return results.some(hasPartialExplainability)
    ? "recall_explainability_partial"
    : null;
}

function hasPartialExplainability(result: Readonly<MemorySearchResult>): boolean {
  return (
    result.selection_reason === undefined ||
    result.source_channels === undefined ||
    result.score_factors === undefined ||
    result.budget_state === undefined
  );
}

export function dedupeDeliveredObjects(
  objects: readonly {
    readonly object_id: string;
    readonly object_kind: string;
  }[]
): readonly {
  readonly object_id: string;
  readonly object_kind: string;
}[] {
  const seen = new Set<string>();
  const deduped = [];
  for (const object of objects) {
    const key = `${object.object_id}\u0000${object.object_kind}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(object);
  }
  return deduped;
}

export function shouldRunBenchEdgePlane(): boolean {
  const raw = process.env[BENCH_EDGE_PLANE_ENV]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}
