import {
  SOURCE_SEMANTIC_PUBLISHED_CONTRACT, SOURCE_SEMANTIC_K_VERSION, SourceSemanticPublishedInterpretationSchema,
  SourceSemanticWorkerResultSchema, SourceSemanticResourceExhausted, buildSourceReferenceCatalog, canonicalJson,
  sourceReferencePreparationCost, type SourceSemanticCoverage, type SourceSemanticHandleDescriptor,
  type SourceSemanticWorkerResult
} from "@do-soul/alaya-protocol";
import { CoreError, admitSourceSemanticAlignment, admitSourceSemanticQuery, authorizedScopesFromAdmission,
  fieldContractSha256, reasonSourceSemanticInterpretation, semanticInterpretationEvidenceId,
  verifyPublishedSourceSemanticInterpretation } from "@do-soul/alaya-core";
import { SqliteSourceHintReader } from "@do-soul/alaya-storage";
import type { RecallReadWorkerRuntime } from "./runtime.js";
import type { WorkerOperationPayload } from "./operation-schemas.js";
import { sourceSemanticReadStores, currentSemanticSource, authorizeSemanticScope, SourceSemanticReadBudget } from "../field/source-semantic-read-stores.js";
import { issueSemanticLease, readSemanticLease, semanticLeaseExpiry, sourceSemanticRevision, type SourceSemanticLease } from "./source-semantic-leases.js";

type Payload = WorkerOperationPayload<"conditionalField.sourceSemantics">;
const IDLE: SourceSemanticCoverage = { discovery: "unexercised", h: "unexercised", q: "unexercised", a: "unexercised", computation: "unexercised", payload: "complete" };

/** Snapshot-owned source preparation and one-shot reasoning. No cross-run result/coverage cache. */
export function runSourceSemanticWorker(runtime: RecallReadWorkerRuntime, payload: Payload): SourceSemanticWorkerResult {
  const meter = new SourceSemanticReadBudget(payload.request.budget);
  const run = () => {
    const scopes = authorizedScopesFromAdmission(payload.authorized_scopes).authorized_scopes;
    if (scopes === undefined) throw new CoreError("VALIDATION", "source semantics requires explicit scope admission");
    const authorized = scopes === null ? null : [...scopes].sort();
    if (payload.request.kind === "prepare_source" || payload.request.kind === "validate_source") return prepareSource(runtime, payload, authorized, meter);
    if (payload.request.kind === "prepare_query") return prepareQuery(runtime, payload, authorized, meter);
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
    authorized, expires_at: semanticLeaseExpiry(payload.as_of, payload.expires_at), revision: sourceSemanticRevision(runtime) };
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
  const assertions = stored.content_bytes.length === 0 ? [] : [{ assertion_id: 1, text: stored.content_bytes }];
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

function discover(runtime: RecallReadWorkerRuntime, payload: Payload, authorized: readonly string[] | null,
  meter: SourceSemanticReadBudget, after: string | null, sourceId?: string) {
  const page = new SqliteSourceHintReader(runtime.database.connection).pageBoundInterpretations({
    workspaceId: payload.workspace_id, limit: 16, nativeLimit: Math.min(32, meter.work), afterCursor: after,
    nativeByteLimit: Math.min(meter.bytes, 1_000_000), maxGistBytes: 1_000_000, activeOnly: true,
    matches: (gist) => { try {
      const contract = JSON.parse(gist)?.contract;
      return contract === SOURCE_SEMANTIC_PUBLISHED_CONTRACT || contract === "published-source-interpretation-v3";
    } catch { return false; } }
  });
  meter.read(page.nativeVisits, page.bytesRead);
  const candidates: SourceSemanticHandleDescriptor[] = [];
  let open = page.unavailable || page.resourceLimited === true, cursor = after, outputBytes = 0, stopped = false;
  for (const row of page.rows) {
    const parsed = SourceSemanticPublishedInterpretationSchema.safeParse(JSON.parse(row.gist));
    if (!parsed.success) { open = true; cursor = row.cursor; continue; }
    if (sourceId !== undefined && parsed.data.interpretation.source.source_id !== sourceId) { cursor = row.cursor; continue; }
    try {
      const checked = loadVerified(runtime, payload.workspace_id, parsed.data.interpretation_id, authorized, meter);
      if (checked.bound.interpretation.k_version !== SOURCE_SEMANTIC_K_VERSION) { open = true; cursor = row.cursor; continue; }
      const h = checked.bound.interpretation;
      const candidate: SourceSemanticHandleDescriptor = { interpretation_id: checked.bound.interpretation_id,
        source_id: h.source.source_id, source_version: h.source.source_version, content_digest: h.source.content_digest,
        producer_id: h.producer_id, producer_version: h.producer_version, contract_version: h.contract_version, interpretation: h };
      const size = Buffer.byteLength(JSON.stringify(candidate));
      if (outputBytes + size > 800_000) { stopped = true; break; }
      meter.retain(candidate, "descriptor delivery"); candidates.push(candidate); outputBytes += size; cursor = row.cursor;
    } catch (error) {
      if (!(error instanceof CoreError)) throw error;
      const admission = admissionOf(error);
      if (admission !== "filtered" && admission !== "no_eligible_source" && error.code !== "NOT_FOUND") open = true;
      cursor = row.cursor;
    }
  }
  if (!stopped) cursor = page.committedThrough;
  return { candidates, open, cursor, truncated: stopped || page.truncated };
}

function loadVerified(runtime: RecallReadWorkerRuntime, workspace: string, hId: string,
  authorized: readonly string[] | null, meter: SourceSemanticReadBudget) {
  meter.reserve(1, 16);
  const capsule = new SqliteSourceHintReader(runtime.database.connection).readBoundInterpretation(
    workspace, semanticInterpretationEvidenceId(hId, fieldContractSha256), meter.bytes);
  meter.read(capsule.nativeVisits, capsule.bytesRead);
  if (capsule.status !== "complete" || capsule.gist === null) {
    throw new CoreError("CONFLICT", `source semantic interpretation read is ${capsule.status}`, { details: { admission: "unavailable", unavailable: capsule.status } });
  }
  meter.charge(1, capsule.bytesRead * 4, "interpretation decoding");
  let raw: unknown;
  try { raw = JSON.parse(capsule.gist); } catch {
    throw new CoreError("VALIDATION", "stored interpretation is malformed", { details: { admission: "invalid" } });
  }
  const parsed = SourceSemanticPublishedInterpretationSchema.safeParse(raw);
  if (!parsed.success) {
    const contract = typeof raw === "object" && raw !== null && "contract" in raw ? raw.contract : undefined;
    throw new CoreError("VALIDATION", contract === "published-source-interpretation-v3"
      ? "stored interpretation requires explicit preparation under the current structural contract" : "stored interpretation is malformed",
    { details: { admission: "invalid", reason: contract === "published-source-interpretation-v3" ? "unsupported_structural_contract" : "malformed_interpretation" } });
  }
  const bound = parsed.data;
  if (bound.interpretation_id !== hId) throw new CoreError("VALIDATION", "interpretation identity mismatch");
  const stores = sourceSemanticReadStores(runtime.database, workspace, bound.interpretation.source.source_id, meter, authorized);
  meter.retain(bound, "interpretation verification");
  return verifyPublishedSourceSemanticInterpretation({ stores, sha256: fieldContractSha256, meter }, bound, workspace);
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

function workOf(meter: SourceSemanticReadBudget) {
  return { native_work: meter.nativeWork, logical_work: meter.spentWork, native_bytes: meter.nativeBytes,
    logical_memory_bytes: meter.spentBytes, rss_bytes: process.memoryUsage().rss };
}
function admissionOf(error: CoreError): string | undefined {
  const value = error.details?.admission;
  return typeof value === "string" ? value : undefined;
}
