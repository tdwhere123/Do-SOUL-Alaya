import {
  SOURCE_SEMANTIC_PUBLISHED_CONTRACT, SOURCE_SEMANTIC_LIBRARY_INTERPRETATION_PAGE,
  SourceSemanticResourceExhausted, canonicalJson, type SourceRecordIdentity,
  type SourceSemanticAccessReceipt, type SourceSemanticAccessSignal, type SourceSemanticAccessPolicy,
  type SourceSemanticHandleDescriptor, type SourceSemanticQuery, type RequestBudget
} from "@do-soul/alaya-protocol";
import { CoreError, createSourceSemanticAccessPolicy, sourceSemanticAccessInputIdentity, fieldContractSha256 } from "@do-soul/alaya-core";
import { RETAINED_SOURCE_READ_RESERVATION, SqliteFieldSourceRecordRepo, SqliteSourceHintReader } from "@do-soul/alaya-storage";
import { authorizeSemanticScope, listEligibleSemanticSources, sourceSemanticReadStores, SourceSemanticReadBudget } from "../field/source-semantic-read-stores.js";
import { admissionOf, loadVerified, type SourceSemanticWorkerPayload } from "./source-semantic-discovery.js";
import type { RecallReadWorkerRuntime } from "./runtime.js";
import { sourceSemanticRevision } from "./source-semantic-leases.js";

type SourceObservation = SourceSemanticAccessReceipt["source_candidates"][number];
type InterpretationObservation = SourceSemanticAccessReceipt["interpretation_candidates"][number];
type Policy = ReturnType<typeof createSourceSemanticAccessPolicy>;
type Stop = SourceSemanticAccessReceipt["stopping_reasons"][number];
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
  const sourceMeter = new SourceSemanticReadBudget({ work_units: Math.floor(observation.work / 2), memory_bytes: Math.floor(observation.bytes / 2) });
  const sources = sourceId === undefined ? listEligibleSemanticSources(runtime.database, payload.workspace_id, sourceMeter, authorized)
    : restrictedSource(runtime, payload.workspace_id, sourceId, authorized, sourceMeter);
  const records = sources.sources;
  const sourceRows = new Map<string, SourceObservation>();
  const stops = new Set<Stop>();
  for (const reason of sources.stopping_reasons) stops.add(reason);
  for (const record of records) {
    const read = readSourceText(runtime, record, policy, sourceMeter);
    if (!read.complete) stops.add("source_tail");
    sourceRows.set(record.identity, { source_id: record.source_id, record_id: record.identity,
      ...read });
  }
  observation.absorb(sourceMeter);
  const interpretations = observeInterpretations(runtime, payload, authorized, observation, policy, sourceRows, stops, sourceId);
  meter.absorb(observation);
  const orderedSources = policy.order([...sourceRows.values()].map((row) => ({ ...row, identity: row.record_id })), meter)
    .map(({ identity: _identity, ...row }) => row);
  const orderedInterpretations = policy.order(interpretations.rows.map((row) => ({ ...row, identity: row.interpretation_id })), meter)
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
  const byId = new Map(records.map((row) => [row.identity, row]));
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
  sources: Map<string, SourceObservation>, stops: Set<Stop>, sourceId?: string) {
  const descriptors = new Map<string, SourceSemanticHandleDescriptor>();
  const rows: InterpretationObservation[] = [];
  let after: string | null = null, pages = 0, open = false;
  while (pages < 32) {
    const result = observeInterpretationPage(runtime, payload, authorized, meter, policy, sources, stops, after, sourceId);
    pages += result.visited ? 1 : 0;
    for (const row of result.rows) {
      if (descriptors.has(row.descriptor.interpretation_id)) continue;
      descriptors.set(row.descriptor.interpretation_id, row.descriptor);
      rows.push(row.observation);
    }
    open ||= result.open;
    if (!result.truncated || result.budgetStopped) return { descriptors, rows, pages, open };
    if (result.cursor === null || result.cursor === after) return { descriptors, rows, pages, open: true };
    after = result.cursor;
  }
  stops.add("interpretation_limit");
  return { descriptors, rows, pages, open: true };
}

function observeInterpretationPage(runtime: RecallReadWorkerRuntime, payload: SourceSemanticWorkerPayload,
  authorized: readonly string[] | null, meter: SourceSemanticReadBudget, policy: Policy,
  sources: Map<string, SourceObservation>, stops: Set<Stop>, after: string | null, sourceId?: string) {
  const rows: { descriptor: SourceSemanticHandleDescriptor; observation: InterpretationObservation }[] = [];
  let cursor = after, open = false, visited = false;
  try {
    meter.reserve(1, 16, "interpretation access page");
    const page = new SqliteSourceHintReader(runtime.database.connection).pageBoundInterpretations({
      workspaceId: payload.workspace_id, limit: SOURCE_SEMANTIC_LIBRARY_INTERPRETATION_PAGE,
      nativeLimit: Math.min(32, meter.work), afterCursor: after,
      nativeByteLimit: Math.min(Math.floor(meter.bytes / 8), 1_000_000), maxGistBytes: 1_000_000,
      activeOnly: true, matches: () => true
    });
    visited = true;
    meter.read(page.nativeVisits, page.bytesRead);
    open = page.unavailable || page.resourceLimited === true;
    if (open) stops.add("unavailable");
    for (const row of page.rows) {
      meter.charge(row.gist.length + 1, row.gist.length * 4, "interpretation access metadata decoding");
      let raw: unknown;
      try { raw = JSON.parse(row.gist); } catch { open = true; stops.add("unavailable"); cursor = row.cursor; continue; }
      if (typeof raw !== "object" || raw === null || !("contract" in raw) || raw.contract !== SOURCE_SEMANTIC_PUBLISHED_CONTRACT) {
        cursor = row.cursor; continue;
      }
      if (!("interpretation_id" in raw) || typeof raw.interpretation_id !== "string") {
        open = true; stops.add("unavailable"); cursor = row.cursor; continue;
      }
      try {
        const checked = loadVerified(runtime, payload.workspace_id, raw.interpretation_id, authorized, meter);
        const record = checked.stored.record, interpretation = checked.bound.interpretation;
        if (sourceId !== undefined && record.source_id !== sourceId) { cursor = row.cursor; continue; }
        const sourceSignal = sources.get(record.identity)?.signal ?? UNKNOWN;
        const signal = policy.interpretation(sourceSignal, interpretation, meter);
        const descriptor = { interpretation_id: checked.bound.interpretation_id,
          source_id: record.source_id, source_version: record.source_version, content_digest: record.content_digest,
          producer_id: interpretation.producer_id, producer_version: interpretation.producer_version, contract_version: interpretation.contract_version };
        const observation = { interpretation_id: descriptor.interpretation_id, record_id: record.identity, signal };
        meter.retain([descriptor, observation], "access interpretation retention");
        rows.push({ descriptor, observation });
      } catch (error) {
        if (error instanceof SourceSemanticResourceExhausted) throw error;
        if (!(error instanceof CoreError)) throw error;
        if (!["filtered", "no_eligible_source"].includes(admissionOf(error) ?? "") && error.code !== "NOT_FOUND") {
          open = true; stops.add("unavailable");
        }
      }
      cursor = row.cursor;
    }
    return { rows, cursor: page.committedThrough, open, truncated: page.truncated, visited, budgetStopped: false };
  } catch (error) {
    if (!(error instanceof SourceSemanticResourceExhausted)) throw error;
    stops.add("budget");
    return { rows, cursor, open: true, truncated: true, visited, budgetStopped: true };
  }
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
