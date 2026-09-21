import {
  SourceSemanticWorkerResultSchema, SourceSemanticResourceExhausted, buildSourceReferenceCatalog, canonicalJson,
  sourceReferencePreparationCost, type SourceSemanticCoverage, type SourceSemanticWorkerResult
} from "@do-soul/alaya-protocol";
import { CoreError, admitSourceSemanticAlignment, admitSourceSemanticQuery, authorizedScopesFromAdmission,
  fieldContractSha256, reasonSourceSemanticInterpretation } from "@do-soul/alaya-core";
import { indexSourceSemanticUnits } from "@do-soul/alaya-soul";
import type { RecallReadWorkerRuntime } from "./runtime.js";
import type { WorkerOperationPayload } from "./operation-schemas.js";
import { sourceSemanticReadStores, currentSemanticSource, authorizeSemanticScope, SourceSemanticReadBudget } from "../field/source-semantic-read-stores.js";
import { issueSemanticLease, readSemanticLease, semanticLeaseExpiry, sourceSemanticLifetimeNow, sourceSemanticRevision, type SourceSemanticLease } from "./source-semantic-leases.js";
import { runSourceSemanticLibraryRecall } from "./source-semantic-library-recall.js";
import { IDLE, discover, loadVerified, workOf } from "./source-semantic-discovery.js";

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
  meter.retain(request.q, "query admission");
  const admission = admitSourceSemanticQuery(request.q, request.original_query);
  const qid = admission.kind === "admitted" ? admission.query_id : undefined;
  if (prior !== undefined && (prior.original_query !== request.original_query || prior.q_id !== qid
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
  const discovery = discover(runtime, payload, authorized, meter, prior?.after_cursor ?? null, scopeLease?.source_id);
  const open = discovery.open || prior?.discovery_open === true;
  const coverage: SourceSemanticCoverage = { ...IDLE, discovery: discovery.truncated || open ? "truncated" : "complete",
    h: "open", q: admission.kind === "admitted" && admission.query.gaps.length === 0 ? "complete" : "open" };
  const base: Omit<SourceSemanticLease, "kind"> = { ...leaseBase(runtime, payload, authorized),
    ...(scopeLease === undefined ? {} : { source_id: scopeLease.source_id, source_version: scopeLease.source_version, content_digest: scopeLease.content_digest }),
    original_query: request.original_query, q_id: qid, q: admission.kind === "admitted" ? admission.query : undefined,
    candidates: discovery.candidates.map((row) => row.interpretation_id), truncated: discovery.truncated || open,
    after_cursor: discovery.cursor, discovery_open: open };
  const query_handle = admission.kind === "admitted" ? issueSemanticLease(runtime, { ...base, kind: "query" }, meter) : undefined;
  const continuation_handle = discovery.truncated && discovery.cursor !== null && discovery.cursor !== (prior?.after_cursor ?? null)
    ? issueSemanticLease(runtime, { ...base, kind: "page" }, meter) : undefined;
  const outcome = admission.kind === "admitted" ? undefined : admission.kind === "absent"
    ? { status: "preparation_required" as const, missing: "q" as const }
    : { status: "invalid" as const, reason: admission.kind === "unsupported" ? "unsupported_producer" : "malformed_query" };
  return SourceSemanticWorkerResultSchema.parse({ kind: "prepare_query", query_handle, continuation_handle, q_id: qid,
    candidates: discovery.candidates, truncated: discovery.truncated || open, outcome, coverage, work: workOf(meter) });
}

function reasonSemantics(runtime: RecallReadWorkerRuntime, payload: Payload, authorized: readonly string[] | null,
  meter: SourceSemanticReadBudget): SourceSemanticWorkerResult {
  const request = payload.request;
  if (request.kind !== "reason") throw new CoreError("VALIDATION", "reason kind mismatch");
  const lease = request.query_handle === undefined ? undefined : readSemanticLease(runtime, payload, request.query_handle, authorized, "query");
  if (lease !== undefined && (request.original_query !== undefined && request.original_query !== lease.original_query
    || request.q !== undefined && canonicalJson(request.q) !== canonicalJson(lease.q))) {
    throw new CoreError("VALIDATION", "query handle cannot be retargeted", { details: { admission: "bound" } });
  }
  const original = lease?.original_query ?? request.original_query, q = lease?.q ?? request.q, a = request.a;
  const hid = request.h_id ?? a?.h_id;
  if (lease !== undefined && (hid === undefined || !lease.candidates?.includes(hid))) {
    throw new CoreError("VALIDATION", "H is outside this preparation's candidates", { details: { admission: "bound" } });
  }
  if (original === undefined || q === undefined || a === undefined || hid === undefined) {
    throw new CoreError("VALIDATION", "reason lacks its prepared H/Q/A");
  }
  const checked = loadVerified(runtime, payload.workspace_id, hid, authorized, meter);
  meter.retain(q, "query admission"); meter.retain(a, "alignment admission");
  const admission = admitSourceSemanticAlignment({ alignment: a, h: checked.bound.interpretation, q, original_query: original });
  const discovery = lease === undefined ? "unexercised" as const : lease.truncated ? "truncated" as const : "complete" as const;
  const qCoverage = q.gaps.length === 0 ? "complete" as const : "open" as const;
  if (admission.kind !== "admitted") {
    return SourceSemanticWorkerResultSchema.parse({
      kind: "reason",
      result: {
        contract: "source-interpretation-reasoning-v3", semantic_status: "unreviewed",
        conclusion_scope: "conditional_on_interpretation", world_claim: "unknown",
        outcome: { status: "invalid", reason: admission.kind === "unsupported" ? "unsupported_producer" : "malformed_alignment" },
        consumed_leaves: []
      },
      coverage: { discovery, h: "open", q: qCoverage, a: "open", computation: "unexercised", payload: "complete" },
      work: workOf(meter)
    });
  }
  const result = reasonSourceSemanticInterpretation({
    request: {
      contract: "source-interpretation-reasoning-v3", accepts_unreviewed_conditional_results: true,
      h_id: admission.interpretation_id, q_id: admission.query_id, a_id: admission.alignment_id,
      original_query: original, budget: { ...request.budget, ...meter.remaining() }, output_byte_limit: request.output_byte_limit
    },
    h: checked.bound, q, a, original_query: original, workspaceId: payload.workspace_id,
    scope: checked.stored.record.scope_class ?? "project", authorizedScopes: authorized,
    asOf: lease?.as_of ?? payload.as_of, sourceValidity: checked.stored.record, source_target: checked.bound.source_target
  });
  if (result.resource_usage !== undefined) meter.charge(result.resource_usage.work_units, result.resource_usage.memory_bytes, "reason computation");
  const coverage = {
    discovery, h: "open" as const, q: qCoverage, a: "open" as const,
    computation: result.outcome.status === "interpreted" ? "complete" as const : "open" as const,
    payload: result.outcome.status === "truncated" ? "truncated" as const : "complete" as const
  };
  const packages = { interpretation: admission.interpretation, query: admission.query,
    alignment: admission.alignment, context: admission.context };
  const full = SourceSemanticWorkerResultSchema.parse({ kind: "reason", result, ...packages, coverage, work: workOf(meter) });
  if (Buffer.byteLength(JSON.stringify(full)) <= request.output_byte_limit) return full;
  const limited = SourceSemanticWorkerResultSchema.parse({ kind: "reason",
    result: { contract: result.contract, c_id: result.c_id, h_id: result.h_id, q_id: result.q_id, a_id: result.a_id,
      semantic_status: result.semantic_status, conclusion_scope: result.conclusion_scope, world_claim: result.world_claim,
      outcome: { status: "truncated" }, consumed_leaves: [] },
    coverage: { ...coverage, payload: "truncated" }, work: workOf(meter) });
  if (Buffer.byteLength(JSON.stringify(limited)) > request.output_byte_limit) throw new CoreError("VALIDATION", "output budget cannot retain interpretation qualifiers");
  return limited;
}
