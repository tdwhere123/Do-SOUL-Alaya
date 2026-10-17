import {
  SourceSemanticWorkerResultSchema, SourceSemanticResourceExhausted, SourceReferenceCapacityExceeded,
  buildSourceReferenceCatalog, canonicalJson, sourceSemanticExecution,
  capturePackSourceSemanticPreparationForRequest,
  sourceReferencePreparationCost, type SourceSemanticCoverage, type SourceSemanticExecution,
  type SourceSemanticCompactPreparation, type SourceSemanticQueryPreparation, type SourceSemanticQuery, type SourceSemanticWorkerResult
} from "@do-soul/alaya-protocol";
import { CoreError, admitSourceSemanticCorrespondence, admitSourceSemanticQuery, sourceSemanticQueryStatus, authorizeSemanticScope, authorizedScopesFromAdmission,
  fieldContractSha256, executeSourceSemanticInterpretation, projectSourceDisclosure } from "@do-soul/alaya-core";
import { indexSourceSemanticUnits } from "@do-soul/alaya-soul";
import type { RecallReadWorkerRuntime, SourceSemanticReadRuntime } from "./runtime.js";
import type { WorkerOperationPayload } from "./operation-schemas.js";
import { sourceSemanticReadStores, currentSemanticSource, SourceSemanticReadBudget } from "../field/source-semantic-read-stores.js";
import { issueSemanticLease, issueSemanticLeaseGroup, queryPreparationLease, readSemanticLease, semanticLeaseExpiry, sourceSemanticLifetimeNow,
  sourceSemanticQueryInputIdentity, sourceSemanticRevision, type QueryPreparationLeaseBase, type SourceSemanticLease } from "./source-semantic-leases.js";
import { runSourceSemanticLibraryRecall } from "./source-semantic-library-recall.js";
import { finalizeSourceSemanticReason } from "./source-semantic-reason-finalization.js";
import { IDLE, loadVerified, workOf } from "./source-semantic-discovery.js";
import { accessDescriptorPage, accessInputIdentity, observeSourceSemanticAccess, preparationAccessReceipt } from "./source-semantic-candidate-access.js";

type Payload = WorkerOperationPayload<"conditionalField.sourceSemantics">;

/** The transaction's existing execution cache also owns the request-only capture. */
export interface SourceSemanticRequestExecution {
  (): SourceSemanticExecution;
  (capture: SourceSemanticQueryPreparation, compact: SourceSemanticCompactPreparation): void;
  (expected: SourceSemanticCompactPreparation): SourceSemanticQueryPreparation | undefined;
  (action: "retire_prepare"): void;
}

/** Snapshot-owned source preparation and one-shot reasoning. No cross-run result/coverage cache. */
export function runSourceSemanticWorker(runtime: RecallReadWorkerRuntime, payload: Payload): SourceSemanticWorkerResult {
  const meter = new SourceSemanticReadBudget(payload.request.budget);
  const run = (executionOf: SourceSemanticRequestExecution) => {
    if (payload.prepared_query !== undefined) {
      meter.preparation = capturePackSourceSemanticPreparationForRequest({
        ...payload.prepared_query.receipt, ...(payload.prepared_query.supplemental === undefined ? {} : {
          supplemental: [payload.prepared_query.supplemental.receipt] }) }, meter, executionOf);
      // Keep inference evidence even if charging the received buffers refuses observation.
      executionOf();
      // postMessage clones each distinct backing buffer, even for views; acquisition later
      // captures each measured vector separately. Neither failed nor supplemental work is free.
      meter.charge(1, 80, "worker query vector buffer references");
      const buffers = new Set<ArrayBufferLike>();
      for (const route of [payload.prepared_query, payload.prepared_query.supplemental]) {
        if (route?.vector.status === "available" && !buffers.has(route.vector.embedding.buffer)) {
          meter.charge(1, 32 + route.vector.embedding.buffer.byteLength, "worker received query vector");
          buffers.add(route.vector.embedding.buffer);
        }
      }
    }
    // Capture failure evidence before exploration can exhaust its allowance. Reuse requires unchanged phase owners.
    executionOf();
    const scopes = authorizedScopesFromAdmission(payload.authorized_scopes).authorized_scopes;
    if (scopes === undefined) throw new CoreError("VALIDATION", "source semantics requires explicit scope admission");
    const authorized = scopes === null ? null : [...scopes].sort();
    if (payload.request.kind === "prepare_source" || payload.request.kind === "validate_source") return prepareSource(runtime, payload, authorized, meter);
    if (payload.request.kind === "prepare_query") return prepareQuery(runtime, payload, authorized, meter, executionOf);
    if (payload.request.kind === "recall") return runSourceSemanticLibraryRecall(runtime, payload, authorized, meter);
    return reasonSemantics(runtime, payload, authorized, meter);
  };
  return withSourceSemanticTransaction(runtime, payload, meter, executionOf => {
    // The byte limit applies to the complete native envelope, including actual phase evidence.
    const body = run(executionOf);
    const execution = executionOf();
    // Every operation returns a schema-admitted owned body, including frozen library pages.
    // Attach only owner-computed fields; another full parse would copy all premises again.
    const result: SourceSemanticWorkerResult = Object.freeze({ ...body, execution, work: Object.freeze(workOf(meter)) });
    return result.kind === "reason" && payload.request.kind === "reason"
      ? finalizeSourceSemanticReason(result, payload.request.output_byte_limit) : result;
  });
}

/** Bench-only source nomination; preserve the ordinary prepare-query lease and budget path. */
export function runResearchNominatedSourcePreparation(runtime: SourceSemanticReadRuntime, payload: Payload,
  preferredSourceIds: readonly string[]): SourceSemanticWorkerResult {
  if (payload.request.kind !== "prepare_query") {
    throw new CoreError("VALIDATION", "research source nomination requires raw prepare-query access");
  }
  const request = payload.request;
  if (request.query_semantics !== undefined || request.source_handle !== undefined || request.access_hint !== undefined ||
      request.source_preview_extents !== undefined ||
      request.continuation_handle !== undefined && preferredSourceIds.length > 0) {
    throw new CoreError("VALIDATION", "research source nomination requires raw prepare-query access");
  }
  const meter = new SourceSemanticReadBudget(request.budget);
  const run = (executionOf: SourceSemanticRequestExecution) => {
    executionOf();
    if (request.continuation_handle === undefined) meter.read(1 + preferredSourceIds.length,
      preferredSourceIds.reduce((bytes, id) => bytes + Buffer.byteLength(id, "utf8"), 0),
      "research source index query output");
    const scopes = authorizedScopesFromAdmission(payload.authorized_scopes).authorized_scopes;
    if (scopes === undefined) throw new CoreError("VALIDATION", "source semantics requires explicit scope admission");
    const authorized = scopes === null ? null : [...scopes].sort();
    return prepareQuery(runtime, payload, authorized, meter, executionOf, preferredSourceIds);
  };
  return withSourceSemanticTransaction(runtime, payload, meter, run);
}

function withSourceSemanticTransaction(runtime: SourceSemanticReadRuntime, payload: Payload,
  meter: SourceSemanticReadBudget, run: (executionOf: SourceSemanticRequestExecution) => SourceSemanticWorkerResult): SourceSemanticWorkerResult {
  let execution: SourceSemanticExecution | undefined;
  let preparation: typeof meter.preparation | SourceSemanticQueryPreparation, acquisition: typeof meter.acquisition;
  function executionOf(): SourceSemanticExecution;
  function executionOf(capture: SourceSemanticQueryPreparation, compact: SourceSemanticCompactPreparation): void;
  function executionOf(expected: SourceSemanticCompactPreparation): SourceSemanticQueryPreparation | undefined;
  function executionOf(action: "retire_prepare"): void;
  function executionOf(value?: SourceSemanticQueryPreparation | SourceSemanticCompactPreparation | "retire_prepare",
    compact?: SourceSemanticCompactPreparation): SourceSemanticExecution | SourceSemanticQueryPreparation | undefined {
    if (compact !== undefined) {
      preparation = value as SourceSemanticQueryPreparation; meter.preparation = compact;
      execution = undefined; return;
    }
    if (value === "retire_prepare") { preparation = meter.preparation; return; }
    if (value !== undefined) {
      return execution !== undefined && execution !== "native_reasoning_only" && execution[1] === value &&
        meter.preparation === value && preparation !== undefined && !Array.isArray(preparation)
        ? preparation as SourceSemanticQueryPreparation : undefined;
    }
    if (execution === undefined || (execution === "native_reasoning_only"
      ? preparation !== meter.preparation : execution[1] !== meter.preparation) || acquisition !== meter.acquisition) {
      if (execution !== undefined && (execution === "native_reasoning_only" || execution[1] !== meter.preparation)) {
        preparation = meter.preparation;
      }
      execution = sourceSemanticExecution(meter.preparation, meter.acquisition, meter);
      if (execution === "native_reasoning_only" || preparation === undefined) preparation = meter.preparation;
      acquisition = meter.acquisition;
    }
    return execution;
  }
  const execute = () => run(executionOf);
  try { return runtime.database.connection.inTransaction ? execute() : runtime.database.connection.transaction(execute)(); }
  catch (error) {
    // Failed capture/packing cannot be reported as native-only or successful absence of phase evidence.
    if (error instanceof SourceSemanticResourceExhausted && error.phase.startsWith("source phase")) {
      throw new CoreError("CONFLICT", error.message, { subCode: "RETRYABLE_BACKPRESSURE", details: { work: workOf(meter) } });
    }
    if (!(error instanceof SourceReferenceCapacityExceeded || error instanceof SourceSemanticResourceExhausted || error instanceof CoreError)) throw error;
    // Failure handling cannot reconstruct metered execution; a later observation can leave <33 work or <24 bytes.
    const current = execution !== undefined && (execution === "native_reasoning_only"
      ? preparation === meter.preparation : execution[1] === meter.preparation) && acquisition === meter.acquisition
      ? execution : undefined;
    if (current !== undefined && payload.request.kind === "prepare_query" && (error instanceof SourceSemanticResourceExhausted
      || error instanceof CoreError && error.subCode === "RETRYABLE_BACKPRESSURE")) {
      const request = payload.request;
      return SourceSemanticWorkerResultSchema.parse({ kind: "prepare_query",
        execution: current,
        query_semantics_status: sourceSemanticQueryStatus(admitSourceSemanticQuery(request.query_semantics, request.original_query),
          request.query_semantics_unavailable),
        outcome: { status: "resource_exhausted" }, candidates: [], truncated: true,
        coverage: IDLE, work: workOf(meter) });
    }
    const work = workOf(meter);
    if (error instanceof SourceReferenceCapacityExceeded) throw new CoreError("VALIDATION", error.message,
      { details: { admission: "unsupported_source", capacity: error.reason, work,
        ...(current === undefined ? {} : { execution: current }) } });
    if (error instanceof SourceSemanticResourceExhausted) throw new CoreError("CONFLICT", error.message, { subCode: "RETRYABLE_BACKPRESSURE", details: { work, ...(current === undefined ? {} : { execution: current }) } });
    if (error instanceof CoreError) throw new CoreError(error.code, error.message, { subCode: error.subCode, details: { ...error.details, work, ...(current === undefined ? {} : { execution: current }) } });
    throw error;
  } finally { executionOf("retire_prepare"); }
}

function leaseBase(runtime: SourceSemanticReadRuntime, payload: Payload, authorized: readonly string[] | null) {
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
  const attribution = stored.record.attribution_context;
  if (attribution === undefined || attribution === null) throw new CoreError("CONFLICT", "source attribution is unavailable", {
    details: { admission: "unavailable", unavailable: "attribution_context" }
  });
  if (lease !== undefined && (lease.source_version !== stored.record.source_version || lease.content_digest !== stored.record.content_digest
    || canonicalJson(lease.attribution_context) !== canonicalJson(attribution))) {
    throw new CoreError("VALIDATION", "preparation source is no longer current", { details: { admission: "filtered" } });
  }
  const units = stored.content_bytes.length === 0 ? [] : indexSourceSemanticUnits(stored.content_bytes);
  const assertions = units.map((unit) => ({ assertion_id: unit.assertion_id, text: unit.text }));
  const cost = sourceReferencePreparationCost(assertions);
  meter.charge(cost.work_units, cost.memory_bytes, "source references");
  const catalog = buildSourceReferenceCatalog(fieldContractSha256(stored.content_bytes), assertions, fieldContractSha256);
  const fields = { source_id: sourceId, source_version: stored.record.source_version, content_digest: stored.record.content_digest,
    attribution_context: attribution, catalog,
    source_disclosure: projectSourceDisclosure({ material_kind: "original_body", evaluated_as_of: payload.as_of,
      source: stored.record }) };
  if (request.kind === "validate_source") return SourceSemanticWorkerResultSchema.parse({
    kind: request.kind, ...fields, source: stored.content_bytes,
    assertion_locations: units.map((unit) => ({ assertion_id: unit.assertion_id,
      source_utf8_span: [Buffer.byteLength(stored.content_bytes.slice(0, unit.start)), Buffer.byteLength(stored.content_bytes.slice(0, unit.end))] })),
    coverage: { ...IDLE, discovery: "complete" }, work: workOf(meter)
  });
  const source_handle = issueSemanticLease(runtime, { ...leaseBase(runtime, payload, authorized), kind: "source",
    source_id: sourceId, source_version: stored.record.source_version, content_digest: stored.record.content_digest,
    attribution_context: attribution }, meter);
  return SourceSemanticWorkerResultSchema.parse({ kind: request.kind, ...fields, source_handle,
    coverage: { ...IDLE, discovery: "complete" }, work: workOf(meter) });
}

function prepareQuery(runtime: SourceSemanticReadRuntime, payload: Payload, authorized: readonly string[] | null,
  meter: SourceSemanticReadBudget, executionOf: SourceSemanticRequestExecution,
  preferredSourceIds?: readonly string[]): SourceSemanticWorkerResult {
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
  const accessHint = request.access_hint ?? prior?.access_pool?.accessHint;
  if (accessHint !== undefined && (scopeLease?.source_id !== undefined || policy === "canonical-v1")) {
    throw new CoreError("VALIDATION", "access hint requires query-conditioned preparation without a source handle");
  }
  const inputId = accessInputIdentity(request.original_query, query, request.budget, policy,
    scopeLease?.source_id, request.source_preview_extents, accessHint);
  if (prior !== undefined && prior.access_pool?.access.input_id !== inputId) {
    throw new CoreError("VALIDATION", "preparation continuation access policy or budget changed", { details: { admission: "bound" } });
  }
  const queryLeaseContext: QueryPreparationLeaseBase = { ...leaseBase(runtime, payload, authorized),
    ...(scopeLease === undefined ? {} : { source_id: scopeLease.source_id, source_version: scopeLease.source_version, content_digest: scopeLease.content_digest }),
    original_query: request.original_query, query_semantics_id: querySemanticsId, query_semantics_input_id: queryInputId,
    query_semantics_status: queryStatus, query_semantics: query };
  const pool = prior?.access_pool ?? observeSourceSemanticAccess(runtime, payload, authorized, meter,
    request.original_query, query, policy, request.budget, scopeLease?.source_id,
    { leaseContext: queryLeaseContext, suppliedQuerySemantics: request.query_semantics, executionOf },
    request.source_preview_extents, preferredSourceIds, accessHint);
  if (prior?.access_pool !== undefined) meter.retain(pool, "continued access pool");
  const discovery = accessDescriptorPage(runtime, payload.workspace_id, payload.as_of, authorized, meter, pool, prior?.access_offset ?? 0);
  const sourceOffset = prior?.access_source_offset ?? 0;
  const access = preparationAccessReceipt(pool, sourceOffset, prior?.access_offset ?? 0, discovery.candidates.length, meter);
  const nextSourceOffset = sourceOffset + access.source_candidates.length;
  const sourceTraceRemaining = nextSourceOffset < pool.sources.length;
  const open = pool.access.unvisited_sources || pool.access.unvisited_interpretations;
  const coverage: SourceSemanticCoverage = { ...IDLE, discovery: discovery.truncated || open ? "truncated" : "complete",
    source_interpretation: "open", query_semantics: querySemanticsCoverage(query) };
  const base = queryPreparationLease(queryLeaseContext, pool, discovery.offset, nextSourceOffset, discovery.truncated || open);
  const needsContinuation = (discovery.truncated || sourceTraceRemaining)
    && (discovery.offset > (prior?.access_offset ?? 0) || nextSourceOffset > sourceOffset);
  // Phase ownership is settled before lease publication can fail. Failure handling may reuse,
  // but must never allocate or reconstruct, this already-charged execution evidence.
  executionOf();
  const [query_handle, continuation_handle] = issueSemanticLeaseGroup(runtime, [
    { lease: { ...base, kind: "query" } },
    ...(needsContinuation ? [{ lease: { ...base, kind: "page" as const } }] : [])
  ], meter);
  const outcome = admission.kind === "admitted" ? undefined : admission.kind === "absent"
    ? { status: "preparation_required" as const, missing: "query_semantics" as const }
    : { status: "invalid" as const, reason: admission.kind === "unsupported" ? "unsupported_producer" : "malformed_query" };
  return SourceSemanticWorkerResultSchema.parse({ kind: "prepare_query", query_handle, continuation_handle, query_semantics_id: querySemanticsId,
    query_semantics_status: queryStatus,
    access, candidates: discovery.candidates, truncated: discovery.truncated || sourceTraceRemaining || open, outcome, coverage, work: workOf(meter) });
}

function querySemanticsCoverage(query: SourceSemanticQuery | undefined): SourceSemanticCoverage["query_semantics"] {
  return query === undefined ? "unexercised" : query.gaps.length === 0 ? "complete" : "open";
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
  if (original === undefined || sourceInterpretationId === undefined) {
    throw new CoreError("VALIDATION", "reason lacks its prepared source interpretation, query semantics, and semantic correspondence");
  }
  const checked = loadVerified(runtime, payload.workspace_id, sourceInterpretationId, authorized, meter);
  const source_disclosure = projectSourceDisclosure({ material_kind: "interpretation",
    evaluated_as_of: lease?.as_of ?? payload.as_of, source: checked.stored.record });
  const discovery = lease === undefined ? "unexercised" as const : lease.truncated ? "truncated" as const : "complete" as const;
  if (querySemantics === undefined || correspondence === undefined) {
    const missing = querySemantics === undefined
      ? correspondence === undefined ? "query_semantics_and_correspondence" as const : "query_semantics" as const
      : "semantic_correspondence" as const;
    const queryAdmission = admitSourceSemanticQuery(querySemantics, original);
    if (querySemantics !== undefined) meter.retain(querySemantics, "reason available query admission");
    const result = {
      contract: "source-interpretation-reasoning-v5" as const, semantic_status: "unreviewed" as const,
      conclusion_scope: "conditional_on_interpretation" as const, world_claim: "unknown" as const,
      outcome: { status: "preparation_required" as const, missing }, consumed_leaves: [],
      source_interpretation_id: sourceInterpretationId,
      ...(queryAdmission.kind === "admitted" ? { query_semantics_id: queryAdmission.query_id } : {}),
      source_target: checked.bound.source_target,
      attention: { contract: "source-semantic-attention-v1" as const, kind: "preparation" as const,
        source_interpretation_id: sourceInterpretationId,
        ...(queryAdmission.kind === "admitted" ? { query_semantics_id: queryAdmission.query_id } : {}),
        source_id: checked.stored.record.source_id, source_version: checked.stored.record.source_version,
        content_digest: checked.stored.record.content_digest, missing, observation: "not_executed" as const }
    };
    return SourceSemanticWorkerResultSchema.parse({ kind: "reason", result,
      interpretation: checked.bound.interpretation,
      ...(queryAdmission.kind === "admitted" ? { query: queryAdmission.query } : {}),
      source_disclosure,
      coverage: { ...IDLE, discovery, source_interpretation: "open",
        query_semantics: querySemanticsCoverage(queryAdmission.kind === "admitted" ? queryAdmission.query : undefined) },
      work: workOf(meter) });
  }
  meter.retain(querySemantics, "query semantics admission");
  meter.retain(correspondence, "semantic correspondence admission");
  const admission = admitSourceSemanticCorrespondence({
    semantic_correspondence: correspondence, source_interpretation: checked.bound.interpretation,
    query_semantics: querySemantics, original_query: original
  });
  const queryCoverage = querySemanticsCoverage(querySemantics);
  if (admission.kind !== "admitted") {
    return SourceSemanticWorkerResultSchema.parse({
      kind: "reason",
      result: {
        contract: "source-interpretation-reasoning-v5", semantic_status: "unreviewed",
        conclusion_scope: "conditional_on_interpretation", world_claim: "unknown",
        outcome: { status: "invalid", reason: admission.kind === "unsupported" ? "unsupported_producer" : "malformed_correspondence" },
        consumed_leaves: []
      },
      source_disclosure,
      coverage: { discovery, source_interpretation: "open", query_semantics: queryCoverage, semantic_correspondence: "open", conditional_computation: "unexercised", payload: "complete" },
      work: workOf(meter)
    });
  }
  const { result } = executeSourceSemanticInterpretation({
    // Only the final envelope owner applies the caller's physical UTF-8 delivery cap.
    computation: {
      contract: "source-interpretation-reasoning-v5", accepts_unreviewed_conditional_results: true,
      source_interpretation_id: admission.interpretation_id, query_semantics_id: admission.query_id, semantic_correspondence_id: admission.semantic_correspondence_id,
      original_query: original, budget: { ...request.budget, ...meter.remaining() }
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
  const full = SourceSemanticWorkerResultSchema.parse({ kind: "reason", result, ...packages,
    source_disclosure: result.binding_results?.length
      ? projectSourceDisclosure({ material_kind: "interpretation", evaluated_as_of: lease?.as_of ?? payload.as_of,
        source: checked.stored.record, proof_use: "conditional_support" }) : source_disclosure,
    coverage, work: workOf(meter) });
  return full;
}
