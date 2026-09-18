import { randomUUID } from "node:crypto";
import {
  SOURCE_SEMANTIC_PUBLISHED_CONTRACT, SourceSemanticPublishedInterpretationSchema,
  SourceSemanticWorkerResultSchema, buildSourceReferenceCatalog, canonicalJson,
  sourceReferencePreparationCost, type SourceRecordIdentity, type SourceSemanticCoverage,
  type SourceSemanticHandleDescriptor, type SourceSemanticQuery,
  type SourceSemanticWorkerResult
} from "@do-soul/alaya-protocol";
import {
  CoreError, admitSourceSemanticAlignment, admitSourceSemanticQuery, authorizedScopesFromAdmission,
  fieldContractSha256, reasonSourceSemanticInterpretation, semanticInterpretationEvidenceId,
  verifyPublishedSourceSemanticInterpretation, type FieldFormationStores
} from "@do-soul/alaya-core";
import {
  RETAINED_SOURCE_READ_RESERVATION, SqliteFieldSourceRecordRepo, SqliteSourceHintReader,
  sourceRecordFromRow, type StorageDatabase
} from "@do-soul/alaya-storage";
import type { RecallReadWorkerRuntime } from "./runtime.js";
import type { WorkerOperationPayload } from "./operation-schemas.js";

type Payload = WorkerOperationPayload<"conditionalField.sourceSemantics">;
type Lease = Readonly<{
  workspace_id: string; principal: string; as_of: string;
  authorized: readonly string[] | null; expires_at: string | null;
  source_id?: string; source_version?: string; content_digest?: string;
  original_query?: string; q?: SourceSemanticQuery; q_id?: string;
  q_producer?: string; q_contract?: string;
  candidates?: readonly SourceSemanticHandleDescriptor[]; truncated?: boolean;
}>;
type CacheRow = Readonly<{ key: string; result: SourceSemanticWorkerResult; h_id: string }>;

const LEASES = new WeakMap<RecallReadWorkerRuntime, Map<string, Lease>>();
const CACHE = new WeakMap<RecallReadWorkerRuntime, Map<string, CacheRow>>();
const IDLE: SourceSemanticCoverage = {
  discovery: "unexercised", h: "unexercised", q: "unexercised",
  a: "unexercised", computation: "unexercised", payload: "complete"
};

/** Snapshot-local open-semantics preparation and one-shot reason. Live v2 interpretation is unchanged. */
export function runSourceSemanticWorker(runtime: RecallReadWorkerRuntime, payload: Payload) {
  const run = () => runWithinSnapshot(runtime, payload);
  return runtime.database.connection.inTransaction ? run() : runtime.database.connection.transaction(run)();
}

function runWithinSnapshot(runtime: RecallReadWorkerRuntime, payload: Payload): SourceSemanticWorkerResult {
  const authorized = scopes(payload);
  const meter = new SourceReadBudget(payload.request.budget);
  if (payload.request.kind === "prepare_source") {
    return prepareSource(runtime, payload, authorized, meter);
  }
  if (payload.request.kind === "prepare_query") {
    return prepareQuery(runtime, payload, authorized, meter);
  }
  return reasonSemantics(runtime, payload, authorized, meter);
}

function prepareSource(
  runtime: RecallReadWorkerRuntime, payload: Payload, authorized: readonly string[] | null, meter: SourceReadBudget
): SourceSemanticWorkerResult {
  const request = payload.request;
  if (request.kind !== "prepare_source") throw new CoreError("VALIDATION", "prepare_source kind mismatch");
  meter.reserve(1, 16);
  const stores = boundedSourceStores(runtime.database, payload.workspace_id, request.source_id, meter, authorized);
  const stored = currentStored(stores, payload.workspace_id, request.source_id);
  authorizeScope(stored.record.scope_class, authorized);
  const assertions = [{ assertion_id: 1, text: stored.content_bytes }];
  const preparation = sourceReferencePreparationCost(assertions);
  meter.reserve(preparation.work_units, preparation.memory_bytes, "source reference preparation");
  meter.charge(preparation.work_units, 0);
  meter.bytes -= preparation.memory_bytes;
  const catalog = buildSourceReferenceCatalog(fieldContractSha256(stored.content_bytes), assertions, fieldContractSha256);
  meter.bytes += preparation.memory_bytes;
  const handle = issueLease(runtime, {
    workspace_id: payload.workspace_id, principal: principalOf(payload), as_of: payload.as_of,
    authorized, expires_at: payload.expires_at ?? null, source_id: stored.record.source_id,
    source_version: stored.record.source_version, content_digest: stored.record.content_digest
  });
  return SourceSemanticWorkerResultSchema.parse({
    kind: "prepare_source", source_handle: handle, source_id: stored.record.source_id,
    source_version: stored.record.source_version, content_digest: stored.record.content_digest,
    catalog, coverage: { ...IDLE, discovery: "complete" }, work: workOf(meter)
  });
}

function prepareQuery(
  runtime: RecallReadWorkerRuntime, payload: Payload, authorized: readonly string[] | null, meter: SourceReadBudget
): SourceSemanticWorkerResult {
  const request = payload.request;
  if (request.kind !== "prepare_query") throw new CoreError("VALIDATION", "prepare_query kind mismatch");
  const sourceLease = request.source_handle === undefined ? undefined : readLease(runtime, payload, request.source_handle);
  const admission = admitSourceSemanticQuery(request.q, request.original_query);
  const discovered = discoverDescriptors(runtime.database, payload.workspace_id, meter, sourceLease?.source_id);
  if (admission.kind !== "admitted") {
    return SourceSemanticWorkerResultSchema.parse({
      kind: "prepare_query", candidates: discovered.candidates, truncated: discovered.truncated,
      outcome: admission.kind === "absent"
        ? { status: "preparation_required", missing: "q" }
        : { status: "invalid", reason: admission.kind === "unsupported" ? "unsupported_producer" : "malformed_query" },
      coverage: {
        ...IDLE, discovery: discovered.truncated ? "truncated" : "complete",
        q: admission.kind === "absent" ? "open" : "complete", payload: "complete"
      },
      work: workOf(meter)
    });
  }
  const handle = issueLease(runtime, {
    workspace_id: payload.workspace_id, principal: principalOf(payload), as_of: payload.as_of,
    authorized, expires_at: payload.expires_at ?? null, source_id: sourceLease?.source_id,
    source_version: sourceLease?.source_version, content_digest: sourceLease?.content_digest,
    original_query: request.original_query, q: admission.query, q_id: admission.query_id,
    q_producer: admission.query.producer_id, q_contract: admission.query.contract_version,
    candidates: discovered.candidates, truncated: discovered.truncated
  });
  return SourceSemanticWorkerResultSchema.parse({
    kind: "prepare_query", query_handle: handle, q_id: admission.query_id,
    candidates: discovered.candidates, truncated: discovered.truncated,
    coverage: {
      ...IDLE, discovery: discovered.truncated ? "truncated" : "complete",
      q: "complete", h: discovered.truncated ? "open" : "complete"
    },
    work: workOf(meter)
  });
}

function reasonSemantics(
  runtime: RecallReadWorkerRuntime, payload: Payload, authorized: readonly string[] | null, meter: SourceReadBudget
): SourceSemanticWorkerResult {
  const request = payload.request;
  if (request.kind !== "reason") throw new CoreError("VALIDATION", "reason kind mismatch");
  const lease = request.query_handle === undefined ? undefined : readLease(runtime, payload, request.query_handle);
  const original = request.original_query ?? lease?.original_query;
  const q = request.q ?? lease?.q;
  const a = request.a;
  if (original === undefined || q === undefined || a === undefined) {
    return qualifyReason({
      result: reasonSourceSemanticInterpretation({
        h: {}, q, a, original_query: original, workspaceId: payload.workspace_id,
        scope: "project", authorizedScopes: authorized, asOf: payload.as_of
      }),
      coverage: { ...IDLE, q: q === undefined ? "open" : "complete", a: a === undefined ? "open" : "unexercised" },
      meter, outputLimit: request.output_byte_limit
    });
  }
  const hid = request.h_id ?? a.h_id;
  const checked = loadVerified(runtime.database, payload.workspace_id, hid, authorized, meter);
  authorizeScope(checked.stored.record.scope_class, authorized);
  const admission = admitSourceSemanticAlignment({ alignment: a, h: checked.bound.interpretation, q, original_query: original });
  meter.charge(1, Buffer.byteLength(JSON.stringify([q, a])));
  const cacheKey = canonicalJson({
    c: admission.kind === "admitted" ? admission.context_id : hid,
    workspace: payload.workspace_id, principal: principalOf(payload), scopes: authorized,
    as_of: payload.as_of, source: checked.bound.interpretation.source, limit: request.output_byte_limit,
    work_units: request.budget.work_units, memory_bytes: request.budget.memory_bytes,
    page_budget: request.budget.page_budget
  });
  const cached = CACHE.get(runtime)?.get(cacheKey);
  if (cached !== undefined && cached.h_id === hid) {
    meter.charge(1, 0);
    return withWork(cached.result, meter);
  }
  const remaining = {
    ...request.budget, work_units: meter.work, memory_bytes: meter.bytes
  };
  const result = reasonSourceSemanticInterpretation({
    request: admission.kind === "admitted" ? {
      contract: "source-interpretation-reasoning-v2", accepts_unreviewed_conditional_results: true,
      h_id: admission.interpretation_id, q_id: admission.query_id, a_id: admission.alignment_id,
      original_query: original, budget: remaining, output_byte_limit: request.output_byte_limit
    } : undefined,
    h: checked.bound, q, a, original_query: original, workspaceId: payload.workspace_id,
    scope: checked.stored.record.scope_class ?? "project", authorizedScopes: authorized,
    asOf: payload.as_of, sourceValidity: checked.stored.record, source_target: checked.bound.source_target
  });
  const coverage: SourceSemanticCoverage = {
    discovery: lease?.truncated === true ? "truncated" : "complete",
    h: "complete", q: "complete",
    a: admission.kind === "admitted" ? "complete" : "open",
    computation: computationCoverage(result.outcome.status),
    payload: result.outcome.status === "truncated" ? "truncated" : "complete"
  };
  const packages = admission.kind === "admitted" ? {
    interpretation: admission.interpretation, query: admission.query,
    alignment: admission.alignment, context: admission.context
  } : {};
  const delivered = qualifyReason({ result, packages, coverage, meter, outputLimit: request.output_byte_limit });
  remember(runtime, cacheKey, hid, delivered);
  return delivered;
}

function loadVerified(
  database: StorageDatabase, workspace: string, hId: string,
  authorized: readonly string[] | null, meter: SourceReadBudget
) {
  meter.reserve(1, 16);
  const capsule = new SqliteSourceHintReader(database.connection).readBoundInterpretation(
    workspace, semanticInterpretationEvidenceId(hId, fieldContractSha256), meter.bytes);
  meter.charge(capsule.nativeVisits, capsule.bytesRead);
  if (capsule.status !== "complete" || capsule.gist === null) {
    throw new CoreError("CONFLICT", `source semantic interpretation read is ${capsule.status}`);
  }
  const bound = SourceSemanticPublishedInterpretationSchema.parse(JSON.parse(capsule.gist));
  const artifact = bound.interpretation.source.source_id;
  const stores = boundedSourceStores(database, workspace, artifact, meter, authorized);
  const reference = sourceReferencePreparationCost([{ assertion_id: 1, text: "" }]);
  meter.reserve(bound.interpretation.mentions.length + 1, 0);
  meter.charge(bound.interpretation.mentions.length + 1, 0);
  meter.reserve(reference.work_units, 0, "source reference preparation");
  return verifyPublishedSourceSemanticInterpretation({ stores, sha256: fieldContractSha256 }, bound, workspace);
}

function discoverDescriptors(
  database: StorageDatabase, workspace: string, meter: SourceReadBudget, sourceId: string | undefined
): { candidates: SourceSemanticHandleDescriptor[]; truncated: boolean } {
  const reader = new SqliteSourceHintReader(database.connection);
  const page = reader.pageBoundInterpretations({
    workspaceId: workspace, limit: 16, nativeLimit: Math.max(1, Math.min(32, meter.work)),
    afterCursor: null, nativeByteLimit: meter.bytes,
    matches: (gist) => {
      try { return JSON.parse(gist)?.contract === SOURCE_SEMANTIC_PUBLISHED_CONTRACT; }
      catch { return false; }
    }
  });
  meter.charge(page.nativeVisits, page.bytesRead);
  const candidates: SourceSemanticHandleDescriptor[] = [];
  for (const row of page.rows) {
    const parsed = SourceSemanticPublishedInterpretationSchema.safeParse(JSON.parse(row.gist));
    if (!parsed.success) continue;
    const source = parsed.data.interpretation.source;
    if (sourceId !== undefined && source.source_id !== sourceId) continue;
    candidates.push({
      interpretation_id: parsed.data.interpretation_id, source_id: source.source_id,
      source_version: source.source_version, content_digest: source.content_digest,
      producer_id: parsed.data.interpretation.producer_id,
      producer_version: parsed.data.interpretation.producer_version,
      contract_version: parsed.data.interpretation.contract_version
    });
  }
  return { candidates, truncated: page.truncated === true };
}

function qualifyReason(input: {
  result: ReturnType<typeof reasonSourceSemanticInterpretation>;
  packages?: {
    interpretation?: unknown; query?: unknown; alignment?: unknown; context?: unknown;
  };
  coverage: SourceSemanticCoverage; meter: SourceReadBudget; outputLimit: number;
}): SourceSemanticWorkerResult {
  const full = SourceSemanticWorkerResultSchema.parse({
    kind: "reason", result: input.result, coverage: input.coverage, work: workOf(input.meter),
    ...input.packages
  });
  if (Buffer.byteLength(JSON.stringify(full)) <= input.outputLimit) return full;
  const limited = SourceSemanticWorkerResultSchema.parse({
    kind: "reason",
    result: { ...input.result, outcome: { status: "truncated" }, consumed_leaves: [] },
    coverage: { ...input.coverage, payload: "truncated" }, work: workOf(input.meter)
  });
  if (Buffer.byteLength(JSON.stringify(limited)) > input.outputLimit) {
    throw new CoreError("VALIDATION", "output budget cannot retain mandatory interpretation qualifier");
  }
  return limited;
}

function boundedSourceStores(
  database: StorageDatabase, workspace: string, artifact: string,
  meter: SourceReadBudget, authorized: readonly string[] | null
): Pick<FieldFormationStores, "listRecords" | "getStoredRecord"> {
  const repo = new SqliteFieldSourceRecordRepo(database, fieldContractSha256);
  let records: SourceRecordIdentity[] | undefined;
  const stored = new Map<string, NonNullable<ReturnType<FieldFormationStores["getStoredRecord"]>>>();
  return {
    listRecords: (workspaceId) => {
      if (workspaceId !== workspace) throw new CoreError("VALIDATION", "source workspace mismatch");
      if (records !== undefined) return records;
      records = [];
      let afterRecordedAt = "";
      let afterRecordId = "";
      while (true) {
        meter.reserve(5, RETAINED_SOURCE_READ_RESERVATION);
        const page = repo.listPageBounded(workspace, { limit: 1, afterRecordedAt, afterRecordId }, 1);
        meter.charge(5, page.rows.reduce((sum, row) => sum + row.nativeBytes + row.metadataBytes, 0));
        if (page.unavailable) throw new CoreError("CONFLICT", "source catalog is unavailable");
        const row = page.rows[0]?.record;
        if (row == null) {
          if (page.rows.length !== 0) throw new CoreError("CONFLICT", "source metadata is unavailable");
          break;
        }
        if (row.source_id === artifact) records.push(sourceRecordFromRow(row));
        afterRecordedAt = row.recorded_at; afterRecordId = row.record_id;
        if (!page.truncated) break;
      }
      return records;
    },
    getStoredRecord: (workspaceId, id) => {
      if (workspaceId !== workspace) throw new CoreError("VALIDATION", "source workspace mismatch");
      const cached = stored.get(id);
      if (cached !== undefined) return cached;
      let offset = 0;
      const chunks: string[] = [];
      let record: SourceRecordIdentity | undefined;
      while (true) {
        meter.reserve(5, RETAINED_SOURCE_READ_RESERVATION);
        const page = repo.findByIdBounded(workspace, id, 4096, offset);
        meter.charge(5, page === null ? 0 : page.nativeBytes + page.metadataBytes);
        if (page?.record == null || page.record.source_body === null || page.invalidOffset) return null;
        record = sourceRecordFromRow(page.record);
        authorizeScope(record.scope_class, authorized);
        const content = page.record.source_body;
        const bytes = Buffer.byteLength(content);
        chunks.push(content); offset += bytes;
        if (offset >= page.bodyBytes) break;
        if (bytes === 0) throw new CoreError("CONFLICT", "source chunk did not advance");
      }
      const result = { record, content_bytes: chunks.join("") };
      stored.set(id, result);
      return result;
    }
  };
}

function currentStored(
  stores: Pick<FieldFormationStores, "listRecords" | "getStoredRecord">, workspace: string, sourceId: string
) {
  const matched = stores.listRecords(workspace).filter((row) => row.source_id === sourceId);
  if (matched.length === 0) throw new CoreError("VALIDATION", "source is not currently admitted");
  const current = matched.reduce((best, row) =>
    row.recorded_at > best.recorded_at || (row.recorded_at === best.recorded_at && row.identity > best.identity)
      ? row : best);
  const stored = stores.getStoredRecord(workspace, current.identity);
  if (stored === null) throw new CoreError("VALIDATION", "current source body is not available");
  return stored;
}

function issueLease(runtime: RecallReadWorkerRuntime, lease: Lease): string {
  let table = LEASES.get(runtime);
  if (table === undefined) { table = new Map(); LEASES.set(runtime, table); }
  const id = randomUUID();
  table.set(id, lease);
  while (table.size > 32) table.delete(table.keys().next().value!);
  return id;
}

function readLease(runtime: RecallReadWorkerRuntime, payload: Payload, id: string): Lease {
  const lease = LEASES.get(runtime)?.get(id);
  if (lease === undefined) throw new CoreError("VALIDATION", "source semantic preparation handle expired");
  if (lease.workspace_id !== payload.workspace_id || lease.principal !== principalOf(payload)) {
    throw new CoreError("VALIDATION", "source semantic preparation handle is bound to another principal");
  }
  if (lease.expires_at !== null && payload.as_of >= lease.expires_at) {
    LEASES.get(runtime)?.delete(id);
    throw new CoreError("VALIDATION", "source semantic preparation handle expired");
  }
  return lease;
}

function remember(runtime: RecallReadWorkerRuntime, key: string, hId: string, result: SourceSemanticWorkerResult): void {
  if (result.kind !== "reason") return;
  const status = result.result.outcome.status;
  if (status === "resource_exhausted" || status === "truncated") return;
  let table = CACHE.get(runtime);
  if (table === undefined) { table = new Map(); CACHE.set(runtime, table); }
  table.set(key, { key, result, h_id: hId });
  while (table.size > 16) table.delete(table.keys().next().value!);
}

function withWork(result: SourceSemanticWorkerResult, meter: SourceReadBudget): SourceSemanticWorkerResult {
  return SourceSemanticWorkerResultSchema.parse({ ...result, work: workOf(meter) });
}

function scopes(payload: Payload): readonly string[] | null {
  const admitted = authorizedScopesFromAdmission(payload.authorized_scopes);
  if (admitted.authorized_scopes === undefined) {
    throw new CoreError("VALIDATION", "source semantics requires explicit scope admission");
  }
  return admitted.authorized_scopes;
}

function authorizeScope(scope: string | null | undefined, authorized: readonly string[] | null): void {
  if (scope == null) throw new CoreError("VALIDATION", "source semantic source has no governed scope");
  if (authorized !== null && !authorized.includes(scope)) {
    throw new CoreError("VALIDATION", "source semantic source is outside authorized scopes");
  }
}

function principalOf(payload: Payload): string {
  return payload.principal ?? "";
}

function computationCoverage(status: string): SourceSemanticCoverage["computation"] {
  if (status === "interpreted") return "complete";
  if (status === "resource_exhausted" || status === "truncated") return "open";
  if (status === "preparation_required" || status === "unexercised") return "unexercised";
  return "open";
}

function workOf(meter: SourceReadBudget) {
  return {
    native_work: meter.spentWork, native_bytes: meter.spentBytes,
    logical_memory_bytes: meter.spentBytes, rss_bytes: process.memoryUsage().rss
  };
}

class SourceReadBudget {
  public work: number;
  public bytes: number;
  public spentWork = 0;
  public spentBytes = 0;
  public constructor(budget: Readonly<{ work_units: number; memory_bytes: number }>) {
    this.work = budget.work_units; this.bytes = budget.memory_bytes;
  }
  public reserve(work: number, bytes: number, operation = "source read"): void {
    if (work > this.work || bytes > this.bytes) {
      throw new CoreError("CONFLICT", `source semantic ${operation} budget exhausted`,
        { subCode: "RETRYABLE_BACKPRESSURE" });
    }
  }
  public charge(work: number, bytes: number): void {
    this.reserve(work, bytes);
    this.work -= work; this.bytes -= bytes; this.spentWork += work; this.spentBytes += bytes;
  }
}
