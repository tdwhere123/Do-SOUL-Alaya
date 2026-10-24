import { InformationIndexSchema, sharedProductIdentity, productStateKeyFromIndexEntry, indexEntryCacheKey, indexMemoryObjectId, type Continuation, type InformationIndex } from "@do-soul/alaya-protocol";
import type { FieldEngineState } from "../conditional-field/engine/field-engine.js";
import { CoreError } from "../../shared/errors.js";
import {
  bindCommittedDelivery,
  committedProductStatesOf,
  committedRevisionsOf,
  type EmittedProductLedger
} from "../conditional-field/index/product-component-diff.js";
import type { ObserverReaders } from "../conditional-field/observers/observe.js";
import {
  mergeCommittedRevisions,
  bindIssuedDeliveryId,
  type EmittedRevisions,
  issuedDeliveryIdOf,
  evictIssuedDeliveries,
  replayIssuedDelivery,
  rememberIssuedDelivery,
  retainCommittedRevisions,
  sealRetainedContinuation,
  type ProjectionProgress
} from "./index-continuation.js";
import { BoundedIndexPayload } from "./index-payload.js";
import type { ConditionalFieldRecallRequest } from "./recall-service-runner-types.js";
import type { RecallSourceMetadata } from "./recall-service-results.js";
import type { RequestCostLedger } from "./request-cost-ledger.js";

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

export type PreparedIndexCommit = Readonly<{
  readonly index: InformationIndex;
  readonly retained: FieldEngineState;
  readonly retention_bytes: number;
  readonly revisions?: EmittedRevisions;
  readonly products?: EmittedProductLedger;
  readonly pending?: PendingIssuedDelivery;
}>;

/** Assemble the exact page that will be fitted: committed progress, payload
 * continuation, sealed token and hydrated visible spans. Nothing is charged or
 * staged here, so a page that does not fit leaves no committed effect. */
export function prepareIndexCommit(input: Readonly<{
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
}>): PreparedIndexCommit {
  const revisions = committedRevisionsOf(input.projected);
  const products = committedProductStatesOf(input.projected);
  let index = input.index;
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
  assertDeliveryRetention(delivery.bytes, input.payload.remainingMemoryBytes);
  let retained = { ...input.state, projection_progress: delivery.progress };
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
      ...(view.protocol_version === undefined ? {} : { protocol_version: view.protocol_version }),
      ...(view.supported_result_kinds === undefined ? {} : { supported_result_kinds: view.supported_result_kinds }),
      ...(view.cap_contracts === undefined ? {} : { cap_contracts: view.cap_contracts }),
      ...(view.claim_demands === undefined ? {} : { claim_demands: view.claim_demands }),
      emitted_revisions: committed
    } };
  }
  if (input.close_when?.(retained, index)) index = { ...index, continuation: null };
  if (index.continuation !== null) {
    index = { ...index, continuation: sealRetainedContinuation(index.continuation) };
  }
  index = input.payload.applyDeliveredSpans(index);
  return { index, retained, retention_bytes: delivery.bytes, revisions, products,
    ...(index.completeness.logical_index !== "invalidated" && retained.projection_progress === delivery.progress
      ? { pending: { query_key: input.queryKey, request_digest: input.requestDigest,
        request: input.request.continuation } }
      : {}) };
}

/** The progress envelope was fitted before computation. Retain its newly computed
 * field without changing or re-sealing that paid response, and without advancing
 * any membership/component ledger from an unfitted candidate. */
export function prepareFittedProgressCommit(input: Readonly<{
  index: InformationIndex; state: FieldEngineState; progress: ProjectionProgress;
  first_retention: boolean; generation: number; available_bytes: number;
  queryKey: string; requestDigest: string; request: Continuation | null | undefined;
}>): PreparedIndexCommit {
  const delivery = retainCommittedRevisions(input.progress, input.progress.delivered_entries,
    input.first_retention, input.progress.delivered_products);
  assertDeliveryRetention(delivery.bytes, input.available_bytes);
  return { index: input.index, retention_bytes: delivery.bytes,
    retained: { ...input.state, projection_progress: { ...delivery.progress,
      generation: input.generation, revision: `projection-generation:${input.generation}` } },
    pending: { query_key: input.queryKey, request_digest: input.requestDigest, request: input.request } };
}

function assertDeliveryRetention(required: number, available: number): void {
  if (required > available) {
    throw new CoreError("CONFLICT", "Recall delivery retention budget exhausted; page was not committed", {
      details: { outcome: "resource_exhausted", resource: "delivery_retention",
        required_bytes: required, available_bytes: available }
    });
  }
}

/** Commit exactly the fitted page. The caller must pass the page returned by the
 * full-envelope fit; this function never re-expands or re-encodes it. */
export function commitPreparedIndex(input: Readonly<{
  readonly prepared: PreparedIndexCommit;
  readonly index: InformationIndex;
  readonly previews: ReadonlyMap<string, string>;
  readonly payload: BoundedIndexPayload;
  readonly cost: RequestCostLedger;
}>): Readonly<{ readonly index: InformationIndex; readonly retained: FieldEngineState }> {
  const { prepared } = input;
  assertDeliveryRetention(prepared.retention_bytes, input.payload.remainingMemoryBytes);
  if (prepared.revisions !== undefined && prepared.products !== undefined) {
    bindCommittedDelivery(input.index, prepared.revisions, prepared.products);
  }
  input.payload.remainingMemoryBytes -= prepared.retention_bytes;
  input.cost.add("index", { charged_retained_bytes: prepared.retention_bytes });
  if (prepared.pending !== undefined) PENDING_ISSUE.set(input.index, prepared.pending);
  // The fitted previews are exactly what the public surface displays for this page;
  // the payload retains the full hydrated previews so a later page never reuses a
  // shortened preview as complete content.
  attachIndexSurfaces(input.index, input.previews, input.payload.sourceMetadata);
  return { index: input.index, retained: {
    ...prepared.retained,
    preview_cache: Object.fromEntries(input.payload.previews),
    remaining_memory_bytes: input.payload.remainingMemoryBytes
  } };
}
