import type { Continuation, InformationIndex } from "@do-soul/alaya-protocol";
import type { FieldEngineState } from "../conditional-field/engine/field-engine.js";
import {
  bindCommittedDelivery,
  committedProductStatesOf,
  committedRevisionsOf
} from "../conditional-field/index/product-component-diff.js";
import type { ObserverReaders } from "../conditional-field/observers/observe.js";
import {
  mergeCommittedRevisions,
  rememberIssuedDelivery,
  retainCommittedRevisions,
  sealIssuedContinuation,
  type ProjectionProgress
} from "./index-continuation.js";
import { BoundedIndexPayload } from "./index-payload.js";
import type { ConditionalFieldRecallRequest } from "./recall-service-runner-types.js";
import type { RecallSourceMetadata } from "./recall-service-results.js";

const INDEX_PREVIEWS = new WeakMap<InformationIndex, ReadonlyMap<string, string>>();
const INDEX_SOURCE_METADATA = new WeakMap<InformationIndex, Readonly<Record<string, RecallSourceMetadata>>>();
const ISSUED_SURFACES = new Map<string, Readonly<{
  readonly previews: ReadonlyMap<string, string>;
  readonly metadata: Readonly<Record<string, RecallSourceMetadata>>;
}>>();
const PENDING_ISSUE = new WeakMap<InformationIndex, PendingIssuedDelivery>();

export type PendingIssuedDelivery = Readonly<{
  readonly query_key: string;
  readonly request_digest: string;
  readonly request: Continuation;
}>;

export function captureIndexPreviews(
  index: InformationIndex,
  _readers: ObserverReaders,
  _workspaceId: string
): Map<string, string> {
  return new Map(INDEX_PREVIEWS.get(index) ?? []);
}

export function captureIndexSourceMetadata(
  index: InformationIndex
): Readonly<Record<string, RecallSourceMetadata>> {
  return INDEX_SOURCE_METADATA.get(index) ?? {};
}

export function attachIndexSurfaces(
  index: InformationIndex,
  previews: ReadonlyMap<string, string>,
  metadata: Readonly<Record<string, RecallSourceMetadata>>
): void {
  INDEX_PREVIEWS.set(index, previews);
  INDEX_SOURCE_METADATA.set(index, metadata);
}

export function replayIssuedSurfaces(requestDigest: string): Readonly<{
  readonly previews: ReadonlyMap<string, string>;
  readonly metadata: Readonly<Record<string, RecallSourceMetadata>>;
}> | undefined {
  return ISSUED_SURFACES.get(requestDigest);
}

export function evictIssuedSurfaces(digests: readonly string[]): void {
  for (const digest of digests) ISSUED_SURFACES.delete(digest);
}

export function pendingIssuedDeliveryOf(index: InformationIndex): PendingIssuedDelivery | undefined {
  return PENDING_ISSUE.get(index);
}

export function commitIssuedDelivery(input: Readonly<{
  readonly query_key: string;
  readonly request_digest: string;
  readonly index: InformationIndex;
  readonly request: Continuation;
  readonly previews?: ReadonlyMap<string, string>;
  readonly metadata?: Readonly<Record<string, RecallSourceMetadata>>;
}>): string {
  // Selected rows must already have survived encode/preview; retain only stages this.
  const deliveryId = rememberIssuedDelivery({
    query_key: input.query_key,
    request_digest: input.request_digest,
    index: input.index,
    request: input.request
  });
  ISSUED_SURFACES.set(input.request_digest, {
    previews: input.previews ?? INDEX_PREVIEWS.get(input.index) ?? new Map(),
    metadata: input.metadata ?? INDEX_SOURCE_METADATA.get(input.index) ?? {}
  });
  return deliveryId;
}

export function retainAndIssueIndex(input: Readonly<{
  readonly index: InformationIndex;
  readonly projected: InformationIndex;
  readonly projectionProgress: ProjectionProgress;
  readonly state: FieldEngineState;
  readonly first_retention: boolean;
  readonly payload: BoundedIndexPayload;
  readonly request: ConditionalFieldRecallRequest;
  readonly queryKey: string;
  readonly requestDigest: string;
}>): Readonly<{
  readonly index: InformationIndex;
  readonly retained: FieldEngineState;
}> {
  const revisions = committedRevisionsOf(input.projected);
  const products = committedProductStatesOf(input.projected);
  let index = input.index;
  if (revisions !== undefined && products !== undefined) {
    bindCommittedDelivery(index, revisions, products);
  }
  const invalidated = index.completeness.logical_index === "invalidated";
  const committed = invalidated
    ? input.projectionProgress.delivered_entries
    : revisions ?? mergeCommittedRevisions(input.projectionProgress.delivered_entries, index.entries);
  const delivery = retainCommittedRevisions(
    input.projectionProgress,
    committed,
    input.first_retention,
    invalidated ? input.projectionProgress.delivered_products : products
  );
  let retained = input.state;
  if (delivery.bytes > input.payload.remainingMemoryBytes) {
    index = { ...index, continuation: null };
  } else {
    input.payload.remainingMemoryBytes -= delivery.bytes;
    retained = { ...retained, projection_progress: delivery.progress };
  }
  if (index.continuation !== null) {
    index = { ...index, continuation: sealIssuedContinuation(index.continuation) };
  }
  index = input.payload.applyDeliveredSpans(index);
  if (revisions !== undefined && products !== undefined) {
    bindCommittedDelivery(index, revisions, products);
  }
  attachIndexSurfaces(index, input.payload.previews, input.payload.sourceMetadata);
  if (input.request.continuation != null && index.completeness.logical_index !== "invalidated"
    && retained.projection_progress === delivery.progress) {
    PENDING_ISSUE.set(index, {
      query_key: input.queryKey,
      request_digest: input.requestDigest,
      request: input.request.continuation
    });
  }
  retained = {
    ...retained,
    preview_cache: Object.fromEntries(input.payload.previews),
    remaining_memory_bytes: input.payload.remainingMemoryBytes
  };
  return { index, retained };
}
