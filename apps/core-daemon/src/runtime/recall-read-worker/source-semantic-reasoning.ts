import {
  SourceSemanticWorkerResultSchema, SourceSemanticResourceExhausted, SourceReferenceCapacityExceeded,
  buildSourceReferenceCatalog, canonicalJson,
  sourceReferencePreparationCost, type SourceSemanticCoverage, type SourceSemanticWorkerResult
} from "@do-soul/alaya-protocol";
import { CoreError, admitSourceSemanticCorrespondence, admitSourceSemanticQuery, sourceSemanticQueryStatus, authorizeSemanticScope, authorizedScopesFromAdmission,
  fieldContractSha256, reasonSourceSemanticInterpretation } from "@do-soul/alaya-core";
import { indexSourceSemanticUnits } from "@do-soul/alaya-soul";
import type { RecallReadWorkerRuntime } from "./runtime.js";
import type { WorkerOperationPayload } from "./operation-schemas.js";
import { sourceSemanticReadStores, currentSemanticSource, SourceSemanticReadBudget } from "../field/source-semantic-read-stores.js";
import { issueSemanticLease, readSemanticLease, semanticLeaseExpiry, sourceSemanticLifetimeNow,
  sourceSemanticQueryInputIdentity, sourceSemanticRevision, type SourceSemanticLease } from "./source-semantic-leases.js";
import { runSourceSemanticLibraryRecall } from "./source-semantic-library-recall.js";
import { IDLE, loadVerified, workOf } from "./source-semantic-discovery.js";
import { accessDescriptorPage, accessInputIdentity, observeSourceSemanticAccess, preparationAccessReceipt } from "./source-semantic-candidate-access.js";

type Payload = WorkerOperationPayload<"conditionalField.sourceSemantics">;

/** Snapshot-owned source preparation and one-shot reasoning. No cross-run result/coverage cache. */
export function runSourceSemanticWorker(runtime: RecallReadWorkerRuntime, payload: Payload): SourceSemanticWorkerResult {
  const meter = new SourceSemanticReadBudget(payload.request.budget);
  const run = () => {
    const scopes = authorizedScopesFromAdmission(payload.authorized_scopes).authorized_scopes;
    if (scopes === undefined) throw new CoreError("VALIDATION", "source semantics requires explicit scope admission");
    const authorized = scopes === null ? null : [...scopes].sort();
    if (payload.request.kind === "prepare_source" || payload.request.kind === "validate_source") return prepareSource(runtime, payload, authorized, meter);
    if (payload.request.kind === "prepare_query") return prepareQuery(runtime, payload, authorized, meter);
    if (payload.request.kind === "recall") return runSourceSemanticLibraryRecall(runtime, payload, authorized, meter);
    return reasonSemantics(runtime, payload, authorized, meter);
  };
  try { return runtime.database.connection.inTransaction ? run() : runtime.database.connection.transaction(run)(); }
  catch (error) {
    if (payload.request.kind === "prepare_query" && (error instanceof SourceSemanticResourceExhausted
      || error instanceof CoreError && error.subCode === "RETRYABLE_BACKPRESSURE")) {
      const request = payload.request;
      return SourceSemanticWorkerResultSchema.parse({ kind: "prepare_query",
        query_semantics_status: sourceSemanticQueryStatus(admitSourceSemanticQuery(request.query_semantics, request.original_query),
          request.query_semantics_unavailable),
        outcome: { status: "resource_exhausted" }, candidates: [], truncated: true,
        coverage: IDLE, work: workOf(meter) });
    }
    if (error instanceof SourceReferenceCapacityExceeded) throw new CoreError("VALIDATION", error.message,
      { details: { admission: "unsupported_source", capacity: error.reason, work: workOf(meter) } });
    if (error instanceof SourceSemanticResourceExhausted) throw new CoreError("CONFLICT", error.message, { subCode: "RETRYABLE_BACKPRESSURE", details: { work: workOf(meter) } });
    if (error instanceof CoreError) throw new CoreError(error.code, error.message, { subCode: error.subCode, details: { ...error.details, work: workOf(meter) } });
    throw error;
  }
}

function leaseBase(runtime: RecallReadWorkerRuntime, payload: Payload, authorized: readonly string[] | null) {
  return { workspace_id: payload.workspace_id, principal: payload.principal ?? "", as_of: payload.as_of,
    lifetime_now: sourceSemanticLifetimeNow(payload),
    authorized, expires_at: semanticLeaseExpiry(sourceSemanticLifetimeNow(payload), payload.expires_at), revision: sourceSemanticRevision(runtime) };
}

function prepareSource(runtime: RecallReadWorkerRuntime, payload: Payload, authorized: readonly string[] | null,
  meter: SourceSemanticReadBudget): SourceSemanticWorkerResult {
  const request = payload.request;
  if (request.kind !== "prepare_source" && request.kind !== "validate_source") throw new CoreError("VALIDATION", "source preparation kind mismatch");
  const lease = request.kind === "validate_source" ? readSemanticLease(runtime, payload, request.source_handle, authorized, "source") : undefined;
  const sourceId = request.kind === "prepare_source" ? request.source_id : lease!.source_id!;
  const stores = sourceSemanticReadStores(runtime.database, payload.workspace_id, sourceId, meter, authorized);
  const stored = currentSemanticSource(stores, payload.workspace_id, sourceId);
  authorizeSemanticScope(stored.record.scope_class, authorized);
  if (lease !== undefined && (lease.source_version !== stored.record.source_version || lease.content_digest !== stored.record.content_digest)) {
    throw new CoreError("VALIDATION", "preparation source is no longer current", { details: { admission: "filtered" } });
  }
  const assertions = stored.content_bytes.length === 0 ? [] : indexSourceSemanticUnits(stored.content_bytes)
    .map((unit) => ({ assertion_id: unit.assertion_id, text: unit.text, source_role: unit.source_role }));
  const cost = sourceReferencePreparationCost(assertions);
  meter.charge(cost.work_units, cost.memory_bytes, "source references");
  const catalog = buildSourceReferenceCatalog(fieldContractSha256(stored.content_bytes), assertions, fieldContractSha256);
  const fields = { source_id: sourceId, source_version: stored.record.source_version, content_digest: stored.record.content_digest, catalog };
  if (request.kind === "validate_source") return SourceSemanticWorkerResultSchema.parse({
    kind: request.kind, ...fields, source: stored.content_bytes, coverage: { ...IDLE, discovery: "complete" }, work: workOf(meter)
  });
  const source_handle = issueSemanticLease(runtime, { ...leaseBase(runtime, payload, authorized), kind: "source",
    source_id: sourceId, source_version: stored.record.source_version, content_digest: stored.record.content_digest }, meter);
  return SourceSemanticWorkerResultSchema.parse({ kind: request.kind, ...fields, source_handle,
    coverage: { ...IDLE, discovery: "complete" }, work: workOf(meter) });
}

function prepareQuery(runtime: RecallReadWorkerRuntime, payload: Payload, authorized: readonly string[] | null,
  meter: SourceSemanticReadBudget): SourceSemanticWorkerResult {
  const request = payload.request;
  if (request.kind !== "prepare_query") throw new CoreError("VALIDATION", "query preparation kind mismatch");
  const source = request.source_handle === undefined ? undefined : readSemanticLease(runtime, payload, request.source_handle, authorized, "source");
  const prior = request.continuation_handle === undefined ? undefined : readSemanticLease(runtime, payload, request.continuation_handle, authorized, "page");
  meter.retain(request.query_semantics, "query semantics admission");
  const admission = admitSourceSemanticQuery(request.query_semantics, request.original_query);
  const queryStatus = sourceSemanticQueryStatus(admission, request.query_semantics_unavailable);
  const querySemanticsId = admission.kind === "admitted" ? admission.query_id : undefined;
  const queryInputId = sourceSemanticQueryInputIdentity(request.query_semantics);
  if (prior !== undefined && (prior.original_query !== request.original_query || prior.query_semantics_id !== querySemanticsId
    || prior.query_semantics_input_id !== queryInputId
    || canonicalJson(prior.query_semantics_status) !== canonicalJson(queryStatus)
    || source !== undefined && prior.source_id !== source.source_id)) {
    throw new CoreError("VALIDATION", "preparation continuation query changed", { details: { admission: "bound" } });
  }
  const scopeLease = prior ?? source;
  if (scopeLease?.source_id !== undefined) {
    const stored = currentSemanticSource(sourceSemanticReadStores(runtime.database, payload.workspace_id, scopeLease.source_id, meter, authorized), payload.workspace_id, scopeLease.source_id);
    if (stored.record.source_version !== scopeLease.source_version || stored.record.content_digest !== scopeLease.content_digest) {
      throw new CoreError("VALIDATION", "preparation source is no longer current", { details: { admission: "filtered" } });
    }
  }
  const query = admission.kind === "admitted" ? admission.query : undefined;
  const policy = request.access_policy ?? prior?.access_pool?.access.policy ?? "query-conditioned-v1";
  const inputId = accessInputIdentity(request.original_query, query, request.budget, policy, scopeLease?.source_id);
  if (prior !== undefined && prior.access_pool?.access.input_id !== inputId) {
    throw new CoreError("VALIDATION", "preparation continuation access policy or budget changed", { details: { admission: "bound" } });
  }
  const pool = prior?.access_pool ?? observeSourceSemanticAccess(runtime, payload, authorized, meter,
    request.original_query, query, policy, request.budget, scopeLease?.source_id);
  if (prior?.access_pool !== undefined) meter.retain(pool, "continued access pool");
  const discovery = accessDescriptorPage(runtime, payload.workspace_id, authorized, meter, pool, prior?.access_offset ?? 0);
  const sourceOffset = prior?.access_source_offset ?? 0;
  const access = preparationAccessReceipt(pool, sourceOffset, prior?.access_offset ?? 0, discovery.candidates.length, meter);
  const nextSourceOffset = sourceOffset + access.source_candidates.length;
  const sourceTraceRemaining = nextSourceOffset < pool.sources.length;
  const open = pool.access.unvisited_sources || pool.access.unvisited_interpretations;
  const coverage: SourceSemanticCoverage = { ...IDLE, discovery: discovery.truncated || open ? "truncated" : "complete",
    source_interpretation: "open", query_semantics: admission.kind === "admitted"
      ? admission.query.gaps.length === 0 ? "complete" : "open" : "unexercised" };
  const base: Omit<SourceSemanticLease, "kind"> = { ...leaseBase(runtime, payload, authorized),
    ...(scopeLease === undefined ? {} : { source_id: scopeLease.source_id, source_version: scopeLease.source_version, content_digest: scopeLease.content_digest }),
    original_query: request.original_query, query_semantics_id: querySemanticsId, query_semantics_input_id: queryInputId,
    query_semantics_status: queryStatus,
    query_semantics: admission.kind === "admitted" ? admission.query : undefined,
    candidates: pool.descriptors.map((row) => row.interpretation_id), truncated: discovery.truncated || open,
    access_pool: pool, access_offset: discovery.offset, access_source_offset: nextSourceOffset };
  const query_handle = issueSemanticLease(runtime, { ...base, kind: "query" }, meter);
  const continuation_handle = (discovery.truncated || sourceTraceRemaining)
    && (discovery.offset > (prior?.access_offset ?? 0) || nextSourceOffset > sourceOffset)
    ? issueSemanticLease(runtime, { ...base, kind: "page" }, meter) : undefined;
  const outcome = admission.kind === "admitted" ? undefined : admission.kind === "absent"
    ? { status: "preparation_required" as const, missing: "query_semantics" as const }
    : { status: "invalid" as const, reason: admission.kind === "unsupported" ? "unsupported_producer" : "malformed_query" };
  return SourceSemanticWorkerResultSchema.parse({ kind: "prepare_query", query_handle, continuation_handle, query_semantics_id: querySemanticsId,
    query_semantics_status: queryStatus,
    access, candidates: discovery.candidates, truncated: discovery.truncated || sourceTraceRemaining || open, outcome, coverage, work: workOf(meter) });
}

function reasonSemantics(runtime: RecallReadWorkerRuntime, payload: Payload, authorized: readonly string[] | null,
  meter: SourceSemanticReadBudget): SourceSemanticWorkerResult {
  const request = payload.request;
  if (request.kind !== "reason") throw new CoreError("VALIDATION", "reason kind mismatch");
  const lease = request.query_handle === undefined ? undefined : readSemanticLease(runtime, payload, request.query_handle, authorized, "query");
  if (lease !== undefined && (request.original_query !== undefined && request.original_query !== lease.original_query
    || request.query_semantics !== undefined && canonicalJson(request.query_semantics) !== canonicalJson(lease.query_semantics))) {
    throw new CoreError("VALIDATION", "query handle cannot be retargeted", { details: { admission: "bound" } });
  }
  const original = lease?.original_query ?? request.original_query;
  const querySemantics = lease?.query_semantics ?? request.query_semantics;
  const correspondence = request.semantic_correspondence;
  const sourceInterpretationId = request.source_interpretation_id ?? correspondence?.source_interpretation_id;
  if (lease !== undefined && (sourceInterpretationId === undefined || !lease.candidates?.includes(sourceInterpretationId))) {
    throw new CoreError("VALIDATION", "source interpretation is outside this preparation's candidates", { details: { admission: "bound" } });
  }
  if (original === undefined || querySemantics === undefined || correspondence === undefined || sourceInterpretationId === undefined) {
    throw new CoreError("VALIDATION", "reason lacks its prepared source interpretation, query semantics, and semantic correspondence");
  }
  const checked = loadVerified(runtime, payload.workspace_id, sourceInterpretationId, authorized, meter);
  meter.retain(querySemantics, "query semantics admission");
  meter.retain(correspondence, "semantic correspondence admission");
  const admission = admitSourceSemanticCorrespondence({
    semantic_correspondence: correspondence, source_interpretation: checked.bound.interpretation,
    query_semantics: querySemantics, original_query: original
  });
  const discovery = lease === undefined ? "unexercised" as const : lease.truncated ? "truncated" as const : "complete" as const;
  const queryCoverage = querySemantics.gaps.length === 0 ? "complete" as const : "open" as const;
  if (admission.kind !== "admitted") {
    return SourceSemanticWorkerResultSchema.parse({
      kind: "reason",
      result: {
        contract: "source-interpretation-reasoning-v5", semantic_status: "unreviewed",
        conclusion_scope: "conditional_on_interpretation", world_claim: "unknown",
        outcome: { status: "invalid", reason: admission.kind === "unsupported" ? "unsupported_producer" : "malformed_correspondence" },
        consumed_leaves: []
      },
      coverage: { discovery, source_interpretation: "open", query_semantics: queryCoverage, semantic_correspondence: "open", conditional_computation: "unexercised", payload: "complete" },
      work: workOf(meter)
    });
  }
  const result = reasonSourceSemanticInterpretation({
    request: {
      contract: "source-interpretation-reasoning-v5", accepts_unreviewed_conditional_results: true,
      source_interpretation_id: admission.interpretation_id, query_semantics_id: admission.query_id, semantic_correspondence_id: admission.semantic_correspondence_id,
      original_query: original, budget: { ...request.budget, ...meter.remaining() }, output_byte_limit: request.output_byte_limit
    },
    source_interpretation: checked.bound, query_semantics: querySemantics, semantic_correspondence: correspondence, original_query: original, workspaceId: payload.workspace_id,
    scope: checked.stored.record.scope_class!, authorizedScopes: authorized,
    asOf: lease?.as_of ?? payload.as_of, sourceValidity: checked.stored.record, source_target: checked.bound.source_target
  });
  if (result.resource_usage !== undefined) meter.charge(result.resource_usage.work_units, result.resource_usage.memory_bytes, "reason computation");
  const coverage = {
    discovery, source_interpretation: "open" as const, query_semantics: queryCoverage, semantic_correspondence: "open" as const,
    conditional_computation: result.outcome.status === "interpreted" ? "complete" as const : "open" as const,
    payload: result.outcome.status === "truncated" ? "truncated" as const : "complete" as const
  };
  const packages = { interpretation: admission.interpretation, query: admission.query,
    semantic_correspondence: admission.semantic_correspondence, context: admission.context };
  const full = SourceSemanticWorkerResultSchema.parse({ kind: "reason", result, ...packages, coverage, work: workOf(meter) });
  if (Buffer.byteLength(JSON.stringify(full)) <= request.output_byte_limit) return full;
  const limited = SourceSemanticWorkerResultSchema.parse({ kind: "reason",
    result: { contract: result.contract, conditional_computation_id: result.conditional_computation_id, source_interpretation_id: result.source_interpretation_id, query_semantics_id: result.query_semantics_id, semantic_correspondence_id: result.semantic_correspondence_id,
      semantic_status: result.semantic_status, conclusion_scope: result.conclusion_scope, world_claim: result.world_claim,
      outcome: { status: "truncated" }, consumed_leaves: [] },
    coverage: { ...coverage, payload: "truncated" }, work: workOf(meter) });
  if (Buffer.byteLength(JSON.stringify(limited)) > request.output_byte_limit) throw new CoreError("VALIDATION", "output budget cannot retain interpretation qualifiers");
  return limited;
}
