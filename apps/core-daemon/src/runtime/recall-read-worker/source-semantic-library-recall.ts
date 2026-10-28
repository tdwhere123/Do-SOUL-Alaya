import {
  SNAPSHOT_PIN_NATIVE_WORK, SourceSemanticFieldLibraryWorkerResultSchema, canonicalJson, sourceGoldRootIdentity, sourceRecallTarget,
  sourceSemanticExecution, sourceSemanticAccessPhases, type SourceEvidenceTarget, type SourceSemanticAcquisitionPhase,
  type SourceSemanticExecution, type SourceSemanticQuery, type SourceSemanticQueryStatus,
  type SourceSemanticResourceLedger, type SourceSemanticWorkerRequest,
  type SourceSemanticWorkerResult
} from "@do-soul/alaya-protocol";
import {
  CoreError, admitSourceSemanticQuery, capableRecallConsumerDeclaration, sourceSemanticQueryStatus,
  fieldContractSha256, continuationCapabilityMatches, sourceSemanticLibraryRequestIdentity,
  snapshotIdFromPin, type ConditionalFieldRecallPortResult, type ObserverReaders, type NativeSourceNomination
} from "@do-soul/alaya-core";
import type { RecallReadWorkerRuntime } from "./runtime.js";
import { executeLibraryField } from "./library-field-execution.js";
import { LibraryFieldObserver } from "./library-field-observation.js";
import type { ConditionalFieldRecallWorkerPayload } from "./protocol.js";
import { workOf, type SourceSemanticWorkerPayload } from "./source-semantic-discovery.js";
import { sourceSemanticAcquisitionOutcome } from "./source-semantic-index-acquisition.js";
import { accessInputIdentity } from "./source-semantic-candidate-access.js";
import type { SourceSemanticReadBudget } from "../field/source-semantic-read-stores.js";
import { readSemanticLease, issueSemanticLease, semanticLeaseExpiry, sourceSemanticLifetimeNow,
  sourceSemanticQueryInputIdentity, sourceSemanticRevision, type SourceSemanticLease } from "./source-semantic-leases.js";
import { createConditionalFieldObserverReaders, NATIVE_SOURCE_NOMINATION_ALLOWANCE,
  nominationFromCaptures, runConditionalFieldWorkerRecall } from "./observer-operations.js";
import { observeSourceQueryProofs, proofSupportFor, type SourceQueryProofObservation } from "./source-query-proof-observation.js";
import { LIBRARY_PAYLOAD_TOKENS, fitFinalLibraryFieldDelivery, libraryFieldDelivery, libraryFitEnvelope, libraryWorkerResult,
  reservedLibraryWork, type LibraryFieldContext } from "./source-semantic-library-field-page.js";

type Request = Extract<SourceSemanticWorkerRequest, { kind: "recall" }>;
type Readers = ReturnType<typeof libraryReaders>;

/** Live library recall. Admission, leases, Q/H/C computation and prepared
 * delivery stay in this owner; membership, ranking and visible text come from
 * the same conditional field producer as ordinary recall.
 */
export function runSourceSemanticLibraryRecall(
  runtime: RecallReadWorkerRuntime, payload: SourceSemanticWorkerPayload,
  authorized: readonly string[] | null, meter: SourceSemanticReadBudget
): SourceSemanticWorkerResult {
  const request = payload.request;
  if (request.kind !== "recall") throw new CoreError("VALIDATION", "recall kind mismatch");
  meter.retain(request, "library request admission");
  const requestIdentity = fieldContractSha256(canonicalJson({ ...request, continuation: undefined }));
  const continuationLease = request.continuation === undefined ? undefined
    : readSemanticLease(runtime, payload, request.continuation.continuation_id, authorized, "library", meter);
  if (continuationLease !== undefined && (continuationLease.request_identity !== requestIdentity
    || continuationLease.continuation === undefined || !continuationCapabilityMatches(request.continuation!)
    || canonicalJson(continuationLease.continuation) !== canonicalJson(request.continuation))) {
    throw new CoreError("VALIDATION", "library continuation request changed");
  }
  const lease = request.query_handle === undefined ? undefined
    : readSemanticLease(runtime, payload, request.query_handle, authorized, "query", meter);
  if (lease !== undefined && (request.original_query !== undefined && request.original_query !== lease.original_query
    || request.query_semantics !== undefined && sourceSemanticQueryInputIdentity(request.query_semantics) !== lease.query_semantics_input_id
    || request.query_semantics_unavailable !== undefined && (lease.query_semantics_status?.status !== "unavailable"
      || lease.query_semantics_status.reason !== request.query_semantics_unavailable))) {
    throw new CoreError("VALIDATION", "query handle cannot be retargeted", { details: { admission: "bound" } });
  }
  const original = lease?.original_query ?? request.original_query;
  const querySemantics = lease?.query_semantics ?? request.query_semantics;
  if (original === undefined) throw new CoreError("VALIDATION", "recall lacks its original question");
  if (lease !== undefined) {
    meter.retain(lease.query_semantics_status, "leased query semantics status");
    if (querySemantics !== undefined) meter.retain(querySemantics, "leased query semantics admission");
  }
  const admission = admitSourceSemanticQuery(querySemantics, original);
  const queryStatus = sourceSemanticQueryStatus(admission, request.query_semantics_unavailable);
  if (lease !== undefined && canonicalJson(lease.query_semantics_status) !== canonicalJson(queryStatus)
    && request.query_semantics_unavailable === undefined) {
    // The lease may carry a producer failure that has no semantic object to re-admit.
    if (admission.kind !== "absent" || lease.query_semantics_status?.status !== "unavailable") {
      throw new CoreError("VALIDATION", "query handle semantic admission changed", { details: { admission: "bound" } });
    }
  }
  const boundStatus = lease?.query_semantics_status ?? queryStatus;
  // A continuation keeps the interpretation clock frozen by its lease. The public
  // handler supplies its current clock on every call; rebinding it here would make
  // a later page a different query than the one Core resumed.
  const fieldClock = continuationLease?.as_of ?? payload.as_of;
  return recallAdmittedLibrary(runtime, payload, authorized, meter, request, lease, continuationLease,
    admission.kind === "admitted" ? admission.query : undefined, boundStatus, original, requestIdentity, fieldClock,
    semanticLeaseExpiry(sourceSemanticLifetimeNow(payload),
      [payload.expires_at, lease?.expires_at, continuationLease?.expires_at]
        .filter((expiry): expiry is string => expiry !== undefined).sort()[0]));
}

function recallAdmittedLibrary(runtime: RecallReadWorkerRuntime, payload: SourceSemanticWorkerPayload,
  authorized: readonly string[] | null, meter: SourceSemanticReadBudget,
  request: Request, lease: ReturnType<typeof readSemanticLease> | undefined,
  continuationLease: SourceSemanticLease | undefined,
  query: SourceSemanticQuery | undefined, boundStatus: SourceSemanticQueryStatus, original: string,
  requestIdentity: string, fieldClock: string, expiresAt: string): SourceSemanticWorkerResult {
  const boundPool = lease?.access_pool ?? continuationLease?.access_pool;
  const policy = request.access_policy ?? (boundPool?.access.contract === "source-semantic-access-v2"
    ? boundPool.access.policy : "query-conditioned-v1");
  const publicRequestIdentity = sourceSemanticLibraryRequestIdentity({
    workspace_id: payload.workspace_id, as_of: fieldClock, authorized_scopes: authorized,
    original_query: original, query_semantics: query, query_semantics_status: boundStatus,
    source_id: lease?.source_id,
    ...(boundPool?.accessHint === undefined ? {} : { access_hint: boundPool.accessHint }),
    semantic_correspondences: request.semantic_correspondences ?? [], budget: request.budget,
    output_byte_limit: request.output_byte_limit, access_policy: policy
  });
  const inputId = accessInputIdentity(original, query, request.budget, policy, lease?.source_id,
    boundPool?.sourcePreviewExtents, boundPool?.accessHint);
  if (boundPool !== undefined && boundPool.access.input_id !== inputId) {
    throw new CoreError("VALIDATION", "library access policy or budget changed", { details: { admission: "bound" } });
  }
  if (boundPool !== undefined) {
    meter.retain(boundPool, "leased access pool");
    meter.observer?.event("pool_reuse", meter.phase, () => ({ pool_id: boundPool.access.pool_id,
      discovery: "not_observed_this_request" }));
  }
  const observation = observeSourceQueryProofs(runtime, payload, authorized, meter, request, query, original,
    fieldClock, lease?.candidates);
  const observer = new LibraryFieldObserver(meter.observer,
    [...observation.proofs, ...observation.unproved].map(row => row.source_record));
  if (boundPool !== undefined || continuationLease?.field_page !== undefined) {
    observer.pool(continuationLease?.field_page?.nomination, boundPool, "reused");
  }
  const readers = libraryReaders(runtime, payload, observation, meter, boundPool, observer,
    continuationLease?.field_page?.nomination);
  let execution: SourceSemanticExecution | undefined;
  let executionAcquisition: ReturnType<Readers["acquisition"]>;
  const context: LibraryFieldContext = {
    request_identity: publicRequestIdentity, query_semantics_status: boundStatus,
    query_complete: (query?.gaps.length ?? 0) === 0, observation,
    requested_interpretations: interpretationIds(request), nominated: readers.nominated,
    request_budget: request.budget, output_byte_limit: request.output_byte_limit, as_of: fieldClock, meter,
    native_complete: readers.nativeComplete,
    native_truncated: readers.nativeTruncated,
    pool_open: boundPool === undefined ? undefined
      : boundPool.access.unvisited_sources || boundPool.access.unvisited_interpretations,
    execution: owner => {
      const acquisition = readers.acquisition();
      // A pre-observation control codec must not cache successful absence for
      // the later, actually executed native acquisition on this request.
      if (execution === undefined || acquisition !== executionAcquisition) {
        execution = libraryExecution(payload, owner, readers);
        executionAcquisition = acquisition;
      }
      return execution;
    }
  };
  return executeLibraryField(runtime, meter, request.budget, () => readers.acquisition()?.resources.work ?? 0,
    captureBudgetWork => runConditionalFieldWorkerRecall(runtime,
      libraryFieldPayload(runtime, payload, meter, request, original, fieldClock, expiresAt, lease?.source_id, boundPool,
        publicRequestIdentity), {
        readers: readers.adapter,
        capture_budget_work: captureBudgetWork,
        observe_page_fit: fit => observer.fit(fit),
        ...(meter.observer === undefined ? {} : { observe_navigation: capture => meter.observer?.event("field_access_order", "index", capture) }),
        encode_page: (index, previews, metadata, owner) => libraryFitEnvelope(libraryFieldDelivery(
          { index, previews, metadata }, { ...context, meter: owner }, reservedLibraryWork(request.budget), false))
      }), executed => {
      const fieldPage = continuationLease?.field_page ?? { index: executed.index, nomination: readers.nomination() ?? null };
      observer.plan(fieldPage, boundPool);
      return deliverLibraryPage(runtime, payload, authorized, meter, request, executed, context, requestIdentity, fieldClock,
        observer, fieldPage, boundPool);
    });
}

/** Root-anchored reader frame: the query lease's prepared pool is the membership
 * contract. A prepared hint/scope already narrowed that pool; native nominations
 * order it, and admitted Q/H/C roots are added as side support, never as a second
 * selector. Core's acquisition remains the cost owner.
 */
function libraryReaders(runtime: RecallReadWorkerRuntime, payload: SourceSemanticWorkerPayload,
  observation: SourceQueryProofObservation, meter: SourceSemanticReadBudget,
  boundPool: SourceSemanticLease["access_pool"], observer: LibraryFieldObserver,
  retainedNomination?: NativeSourceNomination | null) {
  meter.observer?.queryVector(payload.prepared_query?.vector);
  const base = createConditionalFieldObserverReaders(runtime.database, [],
    payload.prepared_query?.vector ?? { status: "unavailable", reason: "embedding_preparation_unwired" }, meter.observer, "request");
  const capture: { roots: readonly SourceEvidenceTarget[];
    nomination?: NativeSourceNomination | null;
    result?: NonNullable<SourceSemanticAcquisitionPhase["result"]> } = {
      roots: retainedNomination?.admitted_roots ?? retainedNomination?.result?.nominations.map(row => row.source.target) ?? [],
      nomination: retainedNomination };
  const adapter: ObserverReaders = {
    ...base,
    nominateSources: input => {
      const reused = reusedNomination(boundPool, input.sourceId, meter);
      const nomination = reused ?? base.nominateSources!(input);
      if (nomination.result !== null && reused === undefined) capture.result = nomination.result;
      const native = nomination.result?.nominations.map(row => row.source.target) ?? [];
      if (boundPool === undefined && observation.admitted_roots.length === 0) {
        capture.roots = dedupeRoots(native);
        capture.nomination = nomination;
        observer.nomination(nomination, boundPool, reused !== undefined);
        return nomination;
      }
      const admitted = dedupeRoots([...(boundPool === undefined ? [] : poolRoots(boundPool)),
        ...(boundPool === undefined ? native : []), ...observation.admitted_roots]);
      capture.roots = admitted;
      meter.charge(1, admitted.length * 8, "library admitted root pool");
      const captured = { ...nomination, admitted_roots: admitted,
        ...(boundPool?.catalogPositions === undefined ? {}
          : { catalog_positions: Object.fromEntries(boundPool.catalogPositions) }) };
      capture.nomination = captured;
      observer.nomination(captured, boundPool, reused !== undefined);
      return captured;
    },
    sourceRoot: input => {
      const page = base.sourceRoot!(input);
      observer.sourceRead(input, page);
      return page;
    },
    sourceRootPayloadRange: target => {
      const rows = proofSupportFor(observation.support, sourceGoldRootIdentity(target)).filter(row => row.complete);
      if (rows.length === 0) return undefined;
      return { start_byte: Math.min(...rows.map(row => row.start_byte)),
        end_byte: Math.max(...rows.map(row => row.end_byte)) };
    }
  };
  return { adapter, nominated: () => capture.roots, nomination: () => capture.nomination,
    acquisition: () => capture.result,
    nativeComplete: () => capture.nomination !== undefined
      ? capture.nomination?.result !== null && capture.nomination?.result !== undefined
        && capture.nomination.result.completion !== "unavailable" : undefined,
    nativeTruncated: () => capture.nomination !== undefined
      ? capture.nomination?.result?.completion === "partial" : undefined };
}

/** The retained pool already paid for both prepared routes. Reusing it preserves the
 * hint lane and source scope without a second acquisition or a post-hoc selector.
 */
function reusedNomination(pool: SourceSemanticLease["access_pool"] | undefined,
  sourceId: string | undefined, meter: SourceSemanticReadBudget) {
  if (pool === undefined || pool.access.contract !== "source-semantic-access-v2") return undefined;
  // Compact phases and the full occurrence witness are the retained authorities.
  // Decode their captured results rather than keeping a second expanded result
  // graph in every preparation lease. This is reuse, never fresh acquisition.
  const { acquisition } = sourceSemanticAccessPhases(pool.access, meter);
  const supplemental = acquisition.supplemental ?? [];
  const rows = [acquisition, ...supplemental].flatMap((phase, index) =>
    phase.result === null ? [] : [{ result: phase.result,
      witness: (pool.retainedWitness ?? []).filter(row => row.view === (index === 0 ? "original" : "hint")) }]);
  if (rows.length === 0) return undefined;
  return nominationFromCaptures(rows, sourceId, {
    ...(pool?.catalogPositions === undefined ? {} : { catalog_positions: Object.fromEntries(pool.catalogPositions) }),
    charged_by_caller: true
  });
}

/** Prepared pool roots are the frozen membership the query handle authorized. */
function poolRoots(pool: NonNullable<SourceSemanticLease["access_pool"]>): readonly SourceEvidenceTarget[] {
  return dedupeRoots(pool.sources.map(record => sourceRecallTarget({
    workspace_id: record.workspace_id, root_kind: "source_record", root_id: record.identity,
    source_version: record.source_version, content_digest: record.content_digest,
    evidence_object_id: record.evidence_object_id
  })));
}

function libraryFieldPayload(runtime: RecallReadWorkerRuntime, payload: SourceSemanticWorkerPayload,
  meter: SourceSemanticReadBudget, request: Request, original: string, fieldClock: string, expiresAt: string,
  sourceId: string | undefined, boundPool: SourceSemanticLease["access_pool"], deliveryContext: string): ConditionalFieldRecallWorkerPayload {
  meter.read(SNAPSHOT_PIN_NATIVE_WORK, 0, "library snapshot pin");
  const pin = createConditionalFieldObserverReaders(runtime.database).snapshotPin?.(payload.workspace_id);
  if (pin === undefined) throw new CoreError("CONFLICT", "library recall requires a source index generation",
    { details: { admission: "unavailable", unavailable: "source_index_generation" } });
  return {
    workspace_id: payload.workspace_id,
    query_text: original,
    delivery_context: deliveryContext,
    ...(payload.prepared_query === undefined ? {} : { prepared_query: payload.prepared_query }),
    delivery_budget: { max_total_tokens: LIBRARY_PAYLOAD_TOKENS, max_encoded_bytes: request.output_byte_limit },
    budget: { ...request.budget, ...meter.remaining() },
    requested_budget: request.budget,
    ...(sourceId === undefined ? {} : { source_id: sourceId }),
    ...(boundPool?.accessHint === undefined ? {} : { access_hint: boundPool.accessHint }),
    snapshot_id: snapshotIdFromPin(payload.workspace_id, pin),
    interpretation_clock: fieldClock,
    as_of: fieldClock,
    // A derived capability cannot outlive the query handle it must revalidate.
    expires_at: expiresAt,
    lifetime_now: sourceSemanticLifetimeNow(payload),
    continuation: request.continuation ?? null,
    ...(payload.authorized_scopes === undefined ? {} : { authorized_scopes: payload.authorized_scopes }),
    ...capableRecallConsumerDeclaration()
  };
}

/** One declared execution report: query preparation as received, and the
 * captured native nomination this request actually consumed.
 */
function libraryExecution(payload: SourceSemanticWorkerPayload, meter: SourceSemanticResourceLedger,
  readers: Readers): SourceSemanticExecution {
  const result = readers.acquisition();
  if (result === undefined) return sourceSemanticExecution(payload.prepared_query?.receipt, undefined, meter);
  const acquisition: SourceSemanticAcquisitionPhase = {
    policy: "source-index-interleaved-prefix.v1",
    ...sourceSemanticAcquisitionOutcome(result),
    allowance: NATIVE_SOURCE_NOMINATION_ALLOWANCE,
    // Native acquisition reports its own cost; reused pool captures were paid by the
    // preparing request and are not a second charge to this request's semantic meter.
    budget: { work_units: result.resources.work, memory_bytes: result.resources.memory_bytes },
    result
  };
  return sourceSemanticExecution(payload.prepared_query?.receipt, acquisition, meter);
}

function deliverLibraryPage(runtime: RecallReadWorkerRuntime, payload: SourceSemanticWorkerPayload,
  authorized: readonly string[] | null, meter: SourceSemanticReadBudget, request: Request,
  executed: ConditionalFieldRecallPortResult, context: LibraryFieldContext,
  requestIdentity: string, fieldClock: string, observer: LibraryFieldObserver,
  fieldPage: NonNullable<SourceSemanticLease["field_page"]>, boundPool: SourceSemanticLease["access_pool"]): SourceSemanticWorkerResult {
  const previews = new Map(Object.entries(executed.previews));
  // This surface never requests payload expansion, so Core's payload cursor cannot
  // progress here; delivering it would hand the caller a dead continuation.
  const index = executed.index.continuation?.continuation_id === "payload"
    ? { ...executed.index, continuation: null } : executed.index;
  const delivery = fitFinalLibraryFieldDelivery({ index, previews,
    metadata: executed.source_metadata ?? {} }, context);
  const admitted = SourceSemanticFieldLibraryWorkerResultSchema.parse(libraryWorkerResult(
    delivery, previews, executed.preparation_id, executed.execution_receipt));
  if (admitted.index.continuation !== null) {
    issueSemanticLease(runtime, { kind: "library", workspace_id: payload.workspace_id,
      lifetime_now: sourceSemanticLifetimeNow(payload), principal: payload.principal ?? "", as_of: fieldClock,
      authorized, expires_at: admitted.index.continuation.expires_at,
      revision: sourceSemanticRevision(runtime), continuation: admitted.index.continuation,
      request_identity: requestIdentity, field_page: fieldPage,
      ...(boundPool === undefined ? {} : { access_pool: boundPool }) }, meter, admitted.index.continuation.continuation_id);
  }
  observer.delivered(admitted.index, previews);
  meter.observer?.event("delivered_membership", meter.phase, () => ({
    targets: admitted.index.entries.map(row => row.target),
    continuation: admitted.index.continuation !== null }));
  // Final fitting, qualification and lease publication are paid before reporting
  // work. The fitted width quote covers both native-accounting states.
  return { ...admitted, work: workOf(meter) };
}

function interpretationIds(request: Request): readonly string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const row of request.semantic_correspondences ?? []) {
    if (seen.has(row.source_interpretation_id)) continue;
    seen.add(row.source_interpretation_id);
    ids.push(row.source_interpretation_id);
  }
  return ids;
}

function dedupeRoots(targets: readonly SourceEvidenceTarget[]): readonly SourceEvidenceTarget[] {
  const seen = new Set<string>();
  const roots: SourceEvidenceTarget[] = [];
  for (const target of targets) {
    const key = sourceGoldRootIdentity(target);
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(target);
  }
  return roots;
}
