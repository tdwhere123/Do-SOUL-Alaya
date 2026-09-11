import { InformationIndexSchema, sharedProductIdentity, productStateKeyFromIndexEntry, indexEntryCacheKey, indexMemoryObjectId, type Continuation, type InformationIndex } from "@do-soul/alaya-protocol";
import type { FieldEngineState } from "../conditional-field/engine/field-engine.js";
import {
  bindCommittedDelivery,
  committedProductStatesOf,
  committedRevisionsOf
} from "../conditional-field/index/product-component-diff.js";
import type { ObserverReaders } from "../conditional-field/observers/observe.js";
import {
  mergeCommittedRevisions,
  bindIssuedDeliveryId,
  issuedDeliveryIdOf,
  evictIssuedDeliveries,
  replayIssuedDelivery,
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
const PENDING_ISSUE = new WeakMap<InformationIndex, PendingIssuedDelivery>();
const PREPARED_FIELD = new WeakMap<InformationIndex, () => void>();
const VALIDATE_SOURCE = new WeakMap<InformationIndex, () => void>();

export function issueRetainedIndex(
  retained: InformationIndex,
  issued?: Readonly<{
    readonly index: InformationIndex;
    readonly previews: ReadonlyMap<string, string>;
    readonly metadata: Readonly<Record<string, RecallSourceMetadata>>;
  }>
): string | undefined {
  VALIDATE_SOURCE.get(retained)?.();
  const alreadyIssued = issuedDeliveryIdOf(retained);
  if (alreadyIssued !== undefined) return alreadyIssued;
  const pending = pendingIssuedDeliveryOf(retained);
  if (pending === undefined) return issuedDeliveryIdOf(issued?.index ?? retained);
  const index = InformationIndexSchema.parse(issued?.index ?? retained);
  const members = (page: InformationIndex) => page.entries.map((entry) => sharedProductIdentity(productStateKeyFromIndexEntry(entry)));
  if (index.query_id !== retained.query_id || index.snapshot_id !== retained.snapshot_id
    || JSON.stringify(members(index)) !== JSON.stringify(members(retained))) {
    throw new Error("Recall envelope changed prepared membership");
  }
  commitIndexField(retained);
  if (pending.request == null) evictIssuedDeliveries(pending.query_key);
  const deliveryId = commitIssuedDelivery({
    ...pending,
    index,
    previews: issued?.previews ?? captureIndexPreviews(retained, {}, ""),
    metadata: issued?.metadata ?? captureIndexSourceMetadata(retained)
  });
  bindIssuedDeliveryId(retained, deliveryId);
  return deliveryId;
}

export function stageIndexSourceValidation(index: InformationIndex, validate: () => void): void {
  VALIDATE_SOURCE.set(index, validate);
}

export function stageIndexField(index: InformationIndex, commit: () => void): void {
  PREPARED_FIELD.set(index, commit);
}

export function commitIndexField(index: InformationIndex): void {
  PREPARED_FIELD.get(index)?.();
}

export type PendingIssuedDelivery = Readonly<{
  readonly query_key: string;
  readonly request_digest: string;
  readonly request?: Continuation | null;
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
  const pagePreviews = new Map<string, string>();
  const pageMetadata: Record<string, RecallSourceMetadata> = {};
  for (const entry of index.entries) {
    const key = indexEntryCacheKey(entry);
    const objectId = indexMemoryObjectId(entry);
    const preview = previews.get(key) ?? (objectId === undefined ? undefined : previews.get(objectId));
    const source = metadata[key] ?? (objectId === undefined ? undefined : metadata[objectId]);
    if (preview !== undefined) pagePreviews.set(key, preview);
    if (source !== undefined) pageMetadata[key] = source;
    if (objectId !== undefined) {
      if (preview !== undefined) pagePreviews.set(objectId, preview);
      if (source !== undefined) pageMetadata[objectId] = source;
    }
  }
  INDEX_PREVIEWS.set(index, pagePreviews);
  INDEX_SOURCE_METADATA.set(index, pageMetadata);
}

export function replayIssuedSurfaces(requestDigest: string): Readonly<{
  readonly previews: ReadonlyMap<string, string>;
  readonly metadata: Readonly<Record<string, RecallSourceMetadata>>;
}> | undefined {
  return replayIssuedDelivery(requestDigest)?.surfaces;
}

export function pendingIssuedDeliveryOf(index: InformationIndex): PendingIssuedDelivery | undefined {
  return PENDING_ISSUE.get(index);
}

export function stageIssuedDelivery(index: InformationIndex, pending: PendingIssuedDelivery): void {
  PENDING_ISSUE.set(index, pending);
}

export function commitIssuedDelivery(input: Readonly<{
  readonly query_key: string;
  readonly request_digest: string;
  readonly index: InformationIndex;
  readonly request?: Continuation | null;
  readonly previews?: ReadonlyMap<string, string>;
  readonly metadata?: Readonly<Record<string, RecallSourceMetadata>>;
}>): string {
  // Selected rows must already have survived encode/preview; retain only stages this.
  const deliveryId = rememberIssuedDelivery({
    query_key: input.query_key,
    request_digest: input.request_digest,
    index: input.index,
    request: input.request,
    surfaces: {
      previews: input.previews ?? INDEX_PREVIEWS.get(input.index) ?? new Map(),
      metadata: input.metadata ?? INDEX_SOURCE_METADATA.get(input.index) ?? {}
    }
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
  readonly close_when?: (state: FieldEngineState, index: InformationIndex) => boolean;
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
    if (index.continuation === null && !invalidated && index.entries.some((entry) => entry.target.kind === "source_evidence")) {
      const view = input.state.interpretation.view;
      index = { ...index, continuation: {
        schema_version: 1, continuation_id: "payload", query_id: index.query_id, snapshot_id: index.snapshot_id,
        result_version: index.result_version, expires_at: input.request.expires_at,
        cursor: `p${delivery.progress.offset}r${delivery.progress.generation}`,
        interpretation_id: index.interpretation_id,
        interpretation_clock: input.request.interpretation_clock,
        authorized_scopes: input.request.authorized_scopes,
        enumeration_policy: view.enumeration_policy, result_kind_view: view.result_kind_view,
        protocol_version: view.protocol_version, supported_result_kinds: view.supported_result_kinds,
        cap_contracts: view.cap_contracts, claim_demands: view.claim_demands,
        emitted_revisions: committed
      } };
    }
  }
  if (input.close_when?.(retained, index)) index = { ...index, continuation: null };
  if (index.continuation !== null) {
    index = { ...index, continuation: sealIssuedContinuation(index.continuation) };
  }
  index = input.payload.applyDeliveredSpans(index);
  if (revisions !== undefined && products !== undefined) {
    bindCommittedDelivery(index, revisions, products);
  }
  attachIndexSurfaces(index, input.payload.previews, input.payload.sourceMetadata);
  if (index.completeness.logical_index !== "invalidated"
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
