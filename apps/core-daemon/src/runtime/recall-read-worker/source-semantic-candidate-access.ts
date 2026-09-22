import {
  SOURCE_SEMANTIC_LIBRARY_INTERPRETATION_PAGE,
  SourceSemanticResourceExhausted, canonicalJson, type SourceRecordIdentity,
  type SourceSemanticAccessReceipt, type SourceSemanticAccessSignal, type SourceSemanticAccessPolicy,
  type SourceSemanticHandleDescriptor, type SourceSemanticQuery, type RequestBudget
} from "@do-soul/alaya-protocol";
import { CoreError, authorizeSemanticScope, createSourceSemanticAccessPolicy, sourceSemanticAccessInputIdentity, fieldContractSha256 } from "@do-soul/alaya-core";
import { RETAINED_SOURCE_READ_RESERVATION, SqliteFieldSourceRecordRepo, SqliteSourceHintReader } from "@do-soul/alaya-storage";
import { listEligibleSemanticSources, sourceSemanticReadStores, SourceSemanticReadBudget } from "../field/source-semantic-read-stores.js";
import { admissionOf, loadVerified, type SourceSemanticWorkerPayload } from "./source-semantic-discovery.js";
import type { RecallReadWorkerRuntime } from "./runtime.js";
import { sourceSemanticRevision } from "./source-semantic-leases.js";

type SourceObservation = SourceSemanticAccessReceipt["source_candidates"][number];
type InterpretationObservation = SourceSemanticAccessReceipt["interpretation_candidates"][number];
type Policy = ReturnType<typeof createSourceSemanticAccessPolicy>;
type Stop = SourceSemanticAccessReceipt["stopping_reasons"][number];
type InterpretationHeader = ReturnType<SqliteSourceHintReader["pageBoundInterpretationHeaders"]>["rows"][number]
  & { identity: string; query_hint?: true };
const UNKNOWN: SourceSemanticAccessSignal = { source_text_score: null, interpretation_reading_score: 0 };

export type SourceSemanticAccessPool = Readonly<{
  sources: readonly SourceRecordIdentity[];
  descriptors: readonly SourceSemanticHandleDescriptor[];
  access: Omit<SourceSemanticAccessReceipt, "trace">;
  sourcePages: number; interpretationPages: number;
}>;

export function accessInputIdentity(original: string, query: SourceSemanticQuery | undefined, budget: RequestBudget,
  policy: SourceSemanticAccessPolicy, sourceId?: string): string {
  return sourceSemanticAccessInputIdentity({ original_query: original, query_semantics: query,
    source_id: sourceId, budget, policy });
}

/** Observe once, score once, then order the whole observed pool before any descriptor or correspondence page. */
export function observeSourceSemanticAccess(runtime: RecallReadWorkerRuntime, payload: SourceSemanticWorkerPayload,
  authorized: readonly string[] | null, meter: SourceSemanticReadBudget, original: string,
  query: SourceSemanticQuery | undefined, policyName: SourceSemanticAccessPolicy, budget: RequestBudget,
  sourceId?: string): SourceSemanticAccessPool {
  const policy = createSourceSemanticAccessPolicy(original, query, policyName, meter);
  // Keep output/lease and branch work available after bounded observation. These are portions of the same request ledger.
  const observation = new SourceSemanticReadBudget({ work_units: Math.floor(meter.work / 2), memory_bytes: Math.floor(meter.bytes / 2) });
  const sources = sourceId === undefined ? listEligibleSemanticSources(runtime.database, payload.workspace_id, observation, authorized)
    : restrictedSource(runtime, payload.workspace_id, sourceId, authorized, observation);
  const records = sources.sources;
  meter.charge(records.length, records.length * 16, "access source record lookup");
  const byId = new Map(records.map((record) => [record.identity, record]));
  const sourceRows = new Map<string, SourceObservation>();
  const stops = new Set<Stop>();
  for (const reason of sources.stopping_reasons) stops.add(reason);
  const interpretations = observeInterpretations(runtime, payload, authorized, observation, policy, records, byId, sourceRows, stops, sourceId);
  meter.absorb(observation);
  for (const record of records) if (!sourceRows.has(record.identity)) sourceRows.set(record.identity, {
    source_id: record.source_id, record_id: record.identity, read_bytes: 0, body_bytes: null, complete: false, signal: UNKNOWN
  });
  if ([...sourceRows.values()].some(row => !row.complete)) stops.add("source_tail");
  const reconciled = interpretations.rows.map(row => ({ ...row, signal: { ...row.signal,
    source_text_score: sourceRows.get(row.record_id)?.signal.source_text_score ?? null } }));
  meter.charge(reconciled.length, 0, "access final source signal reconciliation");
  meter.retain(reconciled, "access reconciled interpretation signals");
  const orderedSources = policy.order([...sourceRows.values()].map((row) => ({ ...row, identity: row.record_id })), meter)
    .map(({ identity: _identity, ...row }) => row);
  const orderedInterpretations = policy.order(reconciled.map((row) => ({ ...row, identity: row.interpretation_id })), meter)
    .map(({ identity: _identity, ...row }) => row);
  const inputId = accessInputIdentity(original, query, budget, policyName, sourceId);
  const receipt = {
    contract: "source-semantic-access-v1" as const, policy: policyName, input_id: inputId,
    observed_source_count: orderedSources.length, observed_interpretation_count: orderedInterpretations.length,
    source_candidates: orderedSources, interpretation_candidates: orderedInterpretations,
    unvisited_sources: sources.open || sources.truncated || orderedSources.some((row) => !row.complete),
    unvisited_interpretations: interpretations.open, stopping_reasons: [...stops]
  };
  meter.retain(receipt, "access receipt identity");
  const access = { ...receipt, pool_id: `sha256:${fieldContractSha256(canonicalJson({ receipt,
    workspace: payload.workspace_id, authorized, revision: sourceSemanticRevision(runtime) }))}` };
  return { sources: orderedSources.map((row) => byId.get(row.record_id)!),
    descriptors: orderedInterpretations.map((row) => interpretations.descriptors.get(row.interpretation_id)!),
    access, sourcePages: sources.pages, interpretationPages: interpretations.pages };
}

function restrictedSource(runtime: RecallReadWorkerRuntime, workspace: string, sourceId: string,
  authorized: readonly string[] | null, meter: SourceSemanticReadBudget) {
  const record = sourceSemanticReadStores(runtime.database, workspace, sourceId, meter, authorized).getCurrentRecord(workspace, sourceId);
  if (record !== null) authorizeSemanticScope(record.scope_class, authorized);
  return { sources: record === null ? [] : [record], pages: 1, open: false, truncated: false, stopping_reasons: [] };
}

function readSourceText(runtime: RecallReadWorkerRuntime, record: SourceRecordIdentity, policy: Policy,
  meter: SourceSemanticReadBudget): Pick<SourceObservation, "read_bytes" | "body_bytes" | "complete" | "signal"> {
  const repo = new SqliteFieldSourceRecordRepo(runtime.database, fieldContractSha256);
  let offset = 0, bodyBytes: number | null = null, characters = 0, complete = false;
  const chunks: string[] = [];
  try {
    meter.reserve(5, RETAINED_SOURCE_READ_RESERVATION, "access source extent metadata");
    const extent = repo.findByIdBounded(record.workspace_id, record.identity, 1, 0);
    meter.read(5, extent === null ? 0 : extent.nativeBytes + extent.metadataBytes);
    bodyBytes = extent?.bodyBytes ?? null;
    if (extent?.record?.source_body == null) return { read_bytes: 0, body_bytes: bodyBytes, complete: false, signal: UNKNOWN };
    while (true) {
      const chunkBytes = Math.min(4096, extent.bodyBytes - offset);
      const reserve = policy.sourceCost(characters + chunkBytes);
      meter.reserve(chunkBytes + 5 + reserve.work_units, RETAINED_SOURCE_READ_RESERVATION + 2 * reserve.memory_bytes + 8 * chunkBytes, "access source extent");
      const page = repo.findByIdBounded(record.workspace_id, record.identity, 4096, offset);
      meter.read(5, page === null ? 0 : page.nativeBytes + page.metadataBytes);
      if (page === null) break;
      bodyBytes = page.bodyBytes;
      if (page.record?.source_body == null || page.invalidOffset) break;
      const chunk = page.record.source_body;
      meter.charge(chunk.length, 8 * chunk.length + 32, "access source retention");
      chunks.push(chunk); characters += chunk.length; offset += Buffer.byteLength(chunk);
      if (offset >= bodyBytes) { complete = true; break; }
      if (chunk.length === 0) break;
    }
  } catch (error) { if (!(error instanceof SourceSemanticResourceExhausted)) throw error; }
  meter.charge(0, 4 * characters, "access source assembly");
  const signal = offset === 0 && !complete ? UNKNOWN : policy.source(chunks.join(""), meter);
  return { read_bytes: offset, body_bytes: bodyBytes, complete, signal };
}

function observeInterpretations(runtime: RecallReadWorkerRuntime, payload: SourceSemanticWorkerPayload,
  authorized: readonly string[] | null, meter: SourceSemanticReadBudget, policy: Policy,
  records: SourceRecordIdentity[], byId: Map<string, SourceRecordIdentity>, sources: Map<string, SourceObservation>,
  stops: Set<Stop>, sourceId?: string) {
  const descriptors = new Map<string, SourceSemanticHandleDescriptor>();
  const rows: InterpretationObservation[] = [];
  let pending: InterpretationHeader[] = [];
  const seen = new Set<string>();
  let after: string | null = null, pages = 0, sourceOffset = 0, headersDone = false, open = false;
  try {
    const navigation = readInterpretationNavigation(runtime, payload.workspace_id, meter, policy);
    appendInterpretationHeaders(pending, navigation.rows, seen, meter);
    if (navigation.unavailable) { open = true; stops.add("unavailable"); }
    if (navigation.resourceLimited) { open = true; stops.add("budget"); }
    while (!headersDone || sourceOffset < records.length || pending.length > 0) {
      if (!headersDone) {
        const page = readInterpretationHeaderPage(runtime, payload.workspace_id, meter, after);
        pages++; appendInterpretationHeaders(pending, page.rows, seen, meter);
        if (page.resourceLimited || page.truncated && (page.committedThrough === null || page.committedThrough === after)) {
          headersDone = true; open = true; stops.add("unavailable");
        } else if (!page.truncated) headersDone = true;
        else if (pages === 32) { headersDone = true; open = true; stops.add("interpretation_limit"); }
        after = page.committedThrough;
      }
      const through = Math.min(records.length, sourceOffset + SOURCE_SEMANTIC_LIBRARY_INTERPRETATION_PAGE);
      while (sourceOffset < through) {
        const record = records[sourceOffset++]!;
        meter.charge(1, 0, "access observed source check");
        if (sources.get(record.identity)?.complete === true) continue;
        const observation = readSourceText(runtime, record, policy, meter);
        sources.set(record.identity, { source_id: record.source_id, record_id: record.identity,
          ...observation });
        policy.associateSourceHint(record.content_digest, observation.signal, meter);
      }
      if (pending.length === 0) continue;
      const scheduled = policy.schedule(pending, meter);
      // Let unfinished observation producers progress between priority/exploration pairs.
      const count = headersDone && sourceOffset === records.length ? scheduled.length : Math.min(2, scheduled.length);
      for (const row of scheduled.slice(0, count)) {
        try {
          const verified = observeInterpretation(runtime, payload.workspace_id, row, authorized, meter, policy, records, byId, sources, sourceId);
          if (verified === null) continue;
          descriptors.set(verified.descriptor.interpretation_id, verified.descriptor); rows.push(verified.observation);
        } catch (error) {
          if (error instanceof SourceSemanticResourceExhausted) throw error;
          if (!(error instanceof CoreError)) throw error;
          if (!["filtered", "no_eligible_source"].includes(admissionOf(error) ?? "") && error.code !== "NOT_FOUND") {
            open = true; stops.add("unavailable");
          }
        }
      }
      meter.charge(pending.length, pending.length * 8, "access pending verification retention");
      pending = scheduled.slice(count);
    }
  } catch (error) {
    if (!(error instanceof SourceSemanticResourceExhausted)) throw error;
    stops.add("budget"); open = true;
  }
  return { descriptors, rows, pages, open: open || !headersDone || pending.length > 0 };
}

function observeInterpretation(runtime: RecallReadWorkerRuntime, workspace: string, row: InterpretationHeader,
  authorized: readonly string[] | null, meter: SourceSemanticReadBudget, policy: Policy,
  records: SourceRecordIdentity[], byId: Map<string, SourceRecordIdentity>, sources: Map<string, SourceObservation>, sourceId?: string) {
  const checked = loadVerified(runtime, workspace, { evidence_object_id: row.object_id }, authorized, meter);
  if (checked === null) return null;
  const record = checked.stored.record, interpretation = checked.bound.interpretation;
  if (sourceId !== undefined && record.source_id !== sourceId) return null;
  if (!byId.has(record.identity)) {
    meter.retain(record, "access discovered current source");
    meter.charge(1, 24, "access discovered source lookup");
    byId.set(record.identity, record); records.push(record);
  }
  if (sources.get(record.identity)?.complete !== true) {
    meter.charge(checked.stored.content_bytes.length, 0, "access verified source extent");
    const bodyBytes = Buffer.byteLength(checked.stored.content_bytes);
    const source = { source_id: record.source_id, record_id: record.identity,
      read_bytes: bodyBytes, body_bytes: bodyBytes, complete: true, signal: policy.source(checked.stored.content_bytes, meter) };
    meter.retain(source, "access verified source observation");
    sources.set(record.identity, source);
    policy.associateSourceHint(record.content_digest, source.signal, meter);
  }
  const signal = policy.interpretation(sources.get(record.identity)?.signal ?? UNKNOWN, interpretation, meter);
  const descriptor = { interpretation_id: checked.bound.interpretation_id,
    source_id: record.source_id, source_version: record.source_version, content_digest: record.content_digest,
    producer_id: interpretation.producer_id, producer_version: interpretation.producer_version, contract_version: interpretation.contract_version };
  const observation = { interpretation_id: descriptor.interpretation_id, record_id: record.identity, signal };
  meter.retain([descriptor, observation], "access interpretation retention");
  return { descriptor, observation };
}

function appendInterpretationHeaders(pending: InterpretationHeader[], rows: readonly InterpretationHeader[],
  seen: Set<string>, meter: SourceSemanticReadBudget): void {
  for (const row of rows) {
    meter.charge(1, 0, "access header identity check");
    if (seen.has(row.identity)) continue;
    meter.charge(0, row.identity.length * 2 + 48, "access header identity retention");
    seen.add(row.identity); pending.push(row);
  }
}

function readInterpretationNavigation(runtime: RecallReadWorkerRuntime, workspace: string,
  meter: SourceSemanticReadBudget, policy: Policy) {
  const query = policy.navigationQuery(meter);
  if (query === null) return { rows: [], unavailable: false, resourceLimited: false };
  const nativeLimit = Math.min(meter.work, 2 * SOURCE_SEMANTIC_LIBRARY_INTERPRETATION_PAGE + 2);
  const nativeByteLimit = Math.min(Math.floor(meter.bytes / 8), 1_000_000);
  meter.reserve(nativeLimit, nativeByteLimit, "access navigation page");
  const page = new SqliteSourceHintReader(runtime.database.connection).pageInterpretationTextHints({
    workspaceId: workspace, query, limit: SOURCE_SEMANTIC_LIBRARY_INTERPRETATION_PAGE,
    nativeLimit, nativeByteLimit, afterCursor: null
  });
  meter.read(page.nativeVisits, page.bytesRead);
  const rows: InterpretationHeader[] = [];
  for (const row of page.rows) {
    const header = { ...row, identity: row.object_id, query_hint: true as const };
    meter.retain(header, "access lexical header retention"); rows.push(header);
  }
  return { rows, unavailable: page.unavailable, resourceLimited: page.resourceLimited };
}

function readInterpretationHeaderPage(runtime: RecallReadWorkerRuntime, workspace: string,
  meter: SourceSemanticReadBudget, after: string | null) {
  const reader = new SqliteSourceHintReader(runtime.database.connection);
  meter.reserve(1, 784, "interpretation access header page");
  const page = reader.pageBoundInterpretationHeaders({ workspaceId: workspace,
    limit: Math.min(SOURCE_SEMANTIC_LIBRARY_INTERPRETATION_PAGE, meter.work),
    afterCursor: after, nativeByteLimit: Math.min(Math.floor(meter.bytes / 8), 1_000_000) });
  meter.read(page.nativeVisits, page.bytesRead);
  const rows: InterpretationHeader[] = [];
  for (const row of page.rows) {
    meter.charge(1, 0, "access capsule lifecycle check");
    if (row.lifecycle_state !== "active") continue;
    const header = { ...row, identity: row.object_id };
    meter.retain(header, "access interpretation header retention"); rows.push(header);
  }
  return { ...page, rows };
}

export function accessDescriptorPage(runtime: RecallReadWorkerRuntime, workspace: string, authorized: readonly string[] | null,
  meter: SourceSemanticReadBudget, pool: SourceSemanticAccessPool, offset: number) {
  const delivery = new SourceSemanticReadBudget({ work_units: Math.floor(meter.work / 2), memory_bytes: Math.floor(meter.bytes / 2) });
  const candidates: SourceSemanticHandleDescriptor[] = [];
  let outputBytes = 0;
  try {
    for (const descriptor of pool.descriptors.slice(offset, offset + SOURCE_SEMANTIC_LIBRARY_INTERPRETATION_PAGE)) {
      const checked = loadVerified(runtime, workspace, descriptor.interpretation_id, authorized, delivery);
      const candidate = { ...descriptor, interpretation: checked.bound.interpretation };
      delivery.retain(candidate, "access descriptor delivery");
      const size = Buffer.byteLength(JSON.stringify(candidate));
      if (outputBytes + size > 800_000) break;
      candidates.push(candidate); outputBytes += size;
    }
  } catch (error) { if (!(error instanceof SourceSemanticResourceExhausted)) throw error; }
  meter.absorb(delivery);
  return { candidates, offset: offset + candidates.length, truncated: offset + candidates.length < pool.descriptors.length };
}

/** Project a frozen pool without re-reading, rescoring, or claiming that unshown rows were unvisited. */
export function preparationAccessReceipt(pool: SourceSemanticAccessPool, sourceOffset: number,
  interpretationOffset: number, interpretationCount: number, meter: SourceSemanticReadBudget): SourceSemanticAccessReceipt {
  const sourceRows = pool.access.source_candidates.slice(sourceOffset, sourceOffset + SOURCE_SEMANTIC_LIBRARY_INTERPRETATION_PAGE);
  const interpretationRows = pool.access.interpretation_candidates.slice(interpretationOffset, interpretationOffset + interpretationCount);
  const receipt: SourceSemanticAccessReceipt = { ...pool.access, source_candidates: sourceRows, interpretation_candidates: interpretationRows,
    trace: { kind: "preparation_page", source_offset: sourceOffset, interpretation_offset: interpretationOffset,
      omitted_source_count: pool.access.observed_source_count - sourceRows.length,
      omitted_interpretation_count: pool.access.observed_interpretation_count - interpretationRows.length } };
  meter.retain(receipt, "access trace delivery");
  return receipt;
}

export function libraryAccessReceipt(pool: SourceSemanticAccessPool, examined: readonly string[], returnedRecords: readonly string[],
  meter: SourceSemanticReadBudget): SourceSemanticAccessReceipt {
  meter.charge(pool.access.observed_source_count + pool.access.observed_interpretation_count, 0, "access trace selection");
  const selected = new Set(examined), records = new Set(returnedRecords);
  const interpretationRows = pool.access.interpretation_candidates.filter((row) => selected.has(row.interpretation_id));
  for (const row of interpretationRows) records.add(row.record_id);
  const sourceRows = pool.access.source_candidates.filter((row) => records.has(row.record_id));
  const receipt: SourceSemanticAccessReceipt = { ...pool.access, source_candidates: sourceRows, interpretation_candidates: interpretationRows,
    trace: { kind: "library_selection", omitted_source_count: pool.access.observed_source_count - sourceRows.length,
      omitted_interpretation_count: pool.access.observed_interpretation_count - interpretationRows.length } };
  meter.retain(receipt, "access trace delivery");
  return receipt;
}
