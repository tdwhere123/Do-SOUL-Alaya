import type { MemoryEntry } from "@do-soul/alaya-protocol";

import type {
  EmbeddingNeighborHit,
  EmbeddingProviderPort,
  EmbeddingVectorRecord,
  EmbeddingWorkspaceNeighborResult
} from "../../embedding-recall/types.js";
import { hashMemoryContent } from "../../embedding-recall/helpers.js";
import { buildRecallCandidateDedupeKey } from
  "../runtime/recall-service-helpers.js";
import {
  createRecallFiniteFieldChannelCapture,
  type RecallFiniteFieldChannelCapture,
  type RecallRetrievalFieldChannelId
} from "./finite-field-capture.js";
import { digestRecallFieldIdentity } from "./field-identity.js";

export interface ObjectEmbeddingFieldWorkspaceSnapshot {
  readonly records: readonly Readonly<EmbeddingVectorRecord>[];
  readonly cap: number;
  readonly returned: number;
  readonly truncated: boolean;
  readonly attempted: boolean;
  readonly failed: boolean;
}

export function buildObjectEmbeddingFieldCaptures(params: Readonly<{
  readonly workspaceId: string;
  readonly runId: string | null;
  readonly queryText: string;
  readonly poolMemories: readonly Readonly<MemoryEntry>[];
  readonly maxNeighbors: number;
  readonly provider: Readonly<EmbeddingProviderPort>;
  readonly queryStatus: NonNullable<
    EmbeddingWorkspaceNeighborResult["query_embedding_status"]
  >;
  readonly queryEmbedding: Float32Array | null;
  readonly scan: Readonly<ObjectEmbeddingFieldWorkspaceSnapshot>;
  readonly exactLookupFailed: boolean;
  readonly poolScores: Readonly<Record<string, number>>;
  readonly workspaceHits: readonly Readonly<EmbeddingNeighborHit>[];
  readonly seedNeighborCount: number;
  readonly seedNeighborLimit: number;
}>): readonly RecallFiniteFieldChannelCapture[] {
  const sourceSnapshotDigest = buildSourceSnapshotDigest(params);
  return Object.freeze([
    createRecallFiniteFieldChannelCapture({
      source_snapshot_digest: sourceSnapshotDigest,
      channel: buildPoolChannel(params)
    }),
    createRecallFiniteFieldChannelCapture({
      source_snapshot_digest: sourceSnapshotDigest,
      channel: buildWorkspaceChannel(params)
    })
  ]);
}

function buildPoolChannel(
  params: Parameters<typeof buildObjectEmbeddingFieldCaptures>[0]
) {
  const channelId = "object_embedding_pool" as const;
  if (params.poolMemories.length === 0) return emptyChannel(channelId, "ineligible", null);
  if (!queryReturned(params) || params.exactLookupFailed) {
    return emptyChannel(channelId, "unavailable", null);
  }
  return completeChannel(channelId, scoreHits(params.poolScores));
}

function buildWorkspaceChannel(
  params: Parameters<typeof buildObjectEmbeddingFieldCaptures>[0]
) {
  const channelId = "object_embedding_workspace" as const;
  if (params.maxNeighbors <= 0) return emptyChannel(channelId, "ineligible", null);
  if (!params.scan.attempted || params.scan.failed || !queryReturned(params)) {
    return emptyChannel(channelId, "unavailable", null);
  }
  if (params.scan.truncated) return emptyChannel(channelId, "truncated", 1);
  if (params.seedNeighborCount > params.seedNeighborLimit) {
    return emptyChannel(channelId, "truncated", 1);
  }
  return completeChannel(channelId, params.workspaceHits);
}

function completeChannel(
  channelId: RecallRetrievalFieldChannelId,
  hits: readonly Readonly<EmbeddingNeighborHit>[]
) {
  const observations = Object.freeze(hits.map((hit, index) => Object.freeze({
    observation_id: `${channelId}:${hit.object_id}:${hit.content_hash ?? "no_content_hash"}`,
    candidate_key: buildRecallCandidateDedupeKey({
      entry: { object_id: hit.object_id }
    }),
    rank: index + 1
  })));
  return Object.freeze({
    channel_id: channelId,
    status: "complete" as const,
    depth: observations.length,
    observations,
    unseen_upper_bound: 0
  });
}

function emptyChannel(
  channelId: RecallRetrievalFieldChannelId,
  status: "truncated" | "unavailable" | "ineligible",
  unseenUpperBound: number | null
) {
  return Object.freeze({
    channel_id: channelId,
    status,
    depth: 0,
    observations: Object.freeze([]),
    unseen_upper_bound: unseenUpperBound
  });
}

function scoreHits(
  scores: Readonly<Record<string, number>>
): readonly Readonly<EmbeddingNeighborHit>[] {
  return Object.freeze(Object.entries(scores)
    .flatMap(([objectId, score]) => Number.isFinite(score) && score > 0
      ? [Object.freeze({ object_id: objectId, normalized_similarity: score })]
      : [])
    .sort(compareHits));
}

function queryReturned(
  params: Parameters<typeof buildObjectEmbeddingFieldCaptures>[0]
): boolean {
  return params.queryStatus === "provider_returned" &&
    params.queryEmbedding !== null;
}

function buildSourceSnapshotDigest(
  params: Parameters<typeof buildObjectEmbeddingFieldCaptures>[0]
) {
  return digestRecallFieldIdentity({
    workspace_id: params.workspaceId,
    run_id: params.runId,
    query_text: params.queryText,
    query_embedding: params.queryEmbedding === null
      ? null
      : Array.from(params.queryEmbedding),
    query_status: params.queryStatus,
    provider: {
      kind: params.provider.providerKind,
      model: params.provider.modelId,
      schema_version: params.provider.schemaVersion
    },
    pool: params.poolMemories.map((memory) => Object.freeze({
      object_id: memory.object_id,
      content_hash: hashMemoryContent(memory.content)
    })).sort((left, right) => left.object_id.localeCompare(right.object_id)),
    workspace_scan: {
      cap: params.scan.cap,
      returned: params.scan.returned,
      truncated: params.scan.truncated,
      attempted: params.scan.attempted,
      failed: params.scan.failed,
      records: params.scan.records.map(recordIdentity),
      seed_neighbor_count: params.seedNeighborCount,
      seed_neighbor_limit: params.seedNeighborLimit
    },
    exact_lookup_failed: params.exactLookupFailed
  });
}

function recordIdentity(record: Readonly<EmbeddingVectorRecord>) {
  return Object.freeze({
    object_id: record.object_id,
    content_hash: record.content_hash,
    provider_kind: record.provider_kind,
    model_id: record.model_id,
    schema_version: record.schema_version,
    dimensions: record.dimensions,
    updated_at: record.updated_at
  });
}

function compareHits(
  left: Readonly<EmbeddingNeighborHit>,
  right: Readonly<EmbeddingNeighborHit>
): number {
  return right.normalized_similarity - left.normalized_similarity ||
    left.object_id.localeCompare(right.object_id);
}
