import {
  SOURCE_SEMANTIC_LIBRARY_INTERPRETATION_PAGE,
  SourceSemanticResourceExhausted, canonicalJson, type SourceRecordIdentity,
  sourceSemanticGenerationTaskSummary, sourceSemanticAcquisitionNotRun, unavailableSourceQueryPreparation,
  captureSourceSemanticQueryPreparation,
  packSourceSemanticQueryPreparation, packSourceSemanticAcquisition,
  sourceSemanticPreparationReason,
  type SourceSemanticAccessReceipt, type SourceSemanticAccessSignal, type SourceSemanticAccessPolicy,
  type SourceSemanticHandleDescriptor, type SourceSemanticQuery, type RequestBudget, type SourceSemanticPreviewExtents,
  type SourceSemanticAcquisitionPhase, type SourceSemanticCompactAcquisition, type PreparedSourceSemanticCanonicalSubtrees
} from "@do-soul/alaya-protocol";
import { CoreError, authorizeSemanticScope, createSourceSemanticAccessPolicy, sourceSemanticAccessInputIdentity, fieldContractSha256,
  projectSourceDisclosure } from "@do-soul/alaya-core";
import { SqliteFieldSourceRecordRepo, SqliteSourceHintReader } from "@do-soul/alaya-storage";
import { listEligibleSemanticSources, sourceSemanticReadStores, SourceSemanticReadBudget, semanticSourceTupleIdentity } from "../field/source-semantic-read-stores.js";
import { admissionOf, loadVerified, type SourceSemanticWorkerPayload } from "./source-semantic-discovery.js";
import type { SourceSemanticReadRuntime } from "./runtime.js";
import type { QueryPreparationLeaseBase } from "./source-semantic-leases.js";
import type { SourceSemanticRequestExecution } from "./source-semantic-reasoning.js";
import { beginCanonicalSourceText, readSourceText } from "./source-semantic-source-observation.js";
import { acquireSourceSemanticIndex } from "./source-semantic-index-acquisition.js";
import { SourceSemanticUnionCompletion } from "./source-semantic-empty-population-budget.js";
import { bindAccessPoolIdentity, sourceSemanticObservationAccounting,
  sourceSemanticAccessReceiptValue, preparationAccessReceiptValue } from "./source-semantic-access-receipts.js";
// Research pool and nominated-library owners still import this entry. Remove this
// forwarding export when those consumers import the receipt owner directly.
export { bindAccessPoolIdentity } from "./source-semantic-access-receipts.js";

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
  accessHint?: string;
  sourcePreviewExtents?: SourceSemanticPreviewExtents;
  sourcePages: number; interpretationPages: number;
}>;
type EmptyCompletion = Readonly<{
  leaseContext: QueryPreparationLeaseBase; suppliedQuerySemantics?: SourceSemanticQuery;
  executionOf?: SourceSemanticRequestExecution }>;

export function accessInputIdentity(original: string, query: SourceSemanticQuery | undefined, budget: RequestBudget,
  policy: SourceSemanticAccessPolicy, sourceId?: string, sourcePreviewExtents?: SourceSemanticPreviewExtents,
  accessHint?: string): string {
  return sourceSemanticAccessInputIdentity({ original_query: original, query_semantics: query,
    source_id: sourceId, budget, policy, contract: "source-semantic-access-v2",
    ...(accessHint === undefined ? {} : { access_hint: accessHint }),
    ...(sourcePreviewExtents === undefined ? {} : { source_preview_extents: sourcePreviewExtents }) });
}

export function previewExtent(record: SourceRecordIdentity,
  extents: readonly Readonly<{ source_id: string; source_version: string; record_id: string; byte_extent: number }>[]): number {
  const bound = extents.find(row => row.source_id === record.source_id);
  if (bound?.source_version !== record.source_version || bound.record_id !== record.identity) {
    throw new CoreError("VALIDATION", "source preview extent is not bound to the current source tuple", { details: { admission: "bound" } });
  }
  return bound.byte_extent;
}

/** Observe once, score once, then order the whole observed pool before any descriptor or correspondence page. */
export function observeSourceSemanticAccess(runtime: SourceSemanticReadRuntime, payload: SourceSemanticWorkerPayload,
  authorized: readonly string[] | null, meter: SourceSemanticReadBudget, original: string,
  query: SourceSemanticQuery | undefined, policyName: SourceSemanticAccessPolicy, budget: RequestBudget,
  sourceId?: string, completion?: EmptyCompletion, sourcePreviewExtents?: SourceSemanticPreviewExtents,
  preferredSourceIds?: readonly string[], accessHint?: string): SourceSemanticAccessPool {
  if (sourceId !== undefined && preferredSourceIds !== undefined) {
    throw new CoreError("VALIDATION", "source-scoped access cannot use source nomination");
  }
  if (sourceId !== undefined && accessHint !== undefined) {
    throw new CoreError("VALIDATION", "source-scoped access cannot use an access hint");
  }
  // Only the request owner's actual fused capture proves the public ownership entry was omitted.
  // Keep the exact pre-child allowance: no new tuple, borrower closure or eligibility scan here.
  if (meter.preparation !== undefined && completion?.executionOf?.(meter.preparation) !== undefined) meter.charge(1, 16, "source phase request ownership bridge");
  let identity: PreparedSourceSemanticCanonicalSubtrees | undefined;
  const policy = createSourceSemanticAccessPolicy(original, query, policyName, meter, accessHint);
  // Keep output/lease and branch work available after bounded observation. These are portions of the same request ledger.
  const observation = new SourceSemanticReadBudget({ work_units: Math.floor(meter.work / 2), memory_bytes: Math.floor(meter.bytes / 2) });
  const unionCompletion = new SourceSemanticUnionCompletion(meter, observation, policy.orderCost);
  const retainedTuples = new Set<string>();
  const beforeRetain = (record: SourceRecordIdentity, tuple = semanticSourceTupleIdentity(record, observation)) => {
    if (retainedTuples.has(tuple)) return;
    unionCompletion.source(record); retainedTuples.add(tuple);
  };
  const controlled = sourceId !== undefined || sourcePreviewExtents !== undefined || preferredSourceIds !== undefined || policyName === "canonical-v1";
  const prepare = meter.preparation ?? packSourceSemanticQueryPreparation(captureSourceSemanticQueryPreparation(
    payload.prepared_query?.receipt ?? unavailableSourceQueryPreparation(
      controlled ? "controlled_or_scoped_access" : "preparation_scope_unavailable", controlled ? "not_requested" : "unavailable"), meter), meter);
  if (payload.prepared_query !== undefined) meter.preparation = prepare;
  let acquisition: SourceSemanticCompactAcquisition | SourceSemanticAcquisitionPhase | undefined = packSourceSemanticAcquisition(
    sourceSemanticAcquisitionNotRun(controlled ? "controlled_or_scoped_access" : "observation_allowance"), meter);
  let absorbed = false;
  let releaseCanonical: () => void = () => undefined;
  let canonicalRecord: SourceRecordIdentity | undefined;
  let canonicalRead: ReturnType<typeof beginCanonicalSourceText> | undefined;
  let sourceReader: SqliteFieldSourceRecordRepo | undefined;
  try {
  // Quote actual shared metadata before any producer can retain a new union member.
  if (completion === undefined) unionCompletion.metadata({ preparation: prepare });
  else unionCompletion.preparationBase({ runtime, parent: meter, child: observation, records: [], sourcePages: 0,
    policy: policyName, budget, orderCost: policy.orderCost, leaseContext: completion.leaseContext,
    suppliedQuerySemantics: completion.suppliedQuerySemantics, accessHint, sourcePreviewExtents,
    phases: { preparation: prepare, acquisition: acquisition as SourceSemanticCompactAcquisition } });
  const sources = sourceId === undefined ? listEligibleSemanticSources(runtime.database, payload.workspace_id, observation, authorized,
    preferredSourceIds, { nominations: [], beforeRetain,
      ...(sourcePreviewExtents !== undefined || preferredSourceIds !== undefined || policyName === "canonical-v1" ? {} : {
        acquire: (next: SourceRecordIdentity | null, bodyBytes: number) => {
          const observed = acquireSourceSemanticIndex({ runtime, workspace: payload.workspace_id,
            navigation: original, authorized, meter: observation, metadataMeter: meter,
            vector: payload.prepared_query?.vector ?? { status: "unavailable", reason: sourceSemanticPreparationReason(prepare, meter) ?? "preparation_unavailable" },
            ...(accessHint === undefined || accessHint === original ? {} : { supplemental: { navigation: accessHint,
              vector: payload.prepared_query?.supplemental?.vector ?? { status: "unavailable", reason: "hint_preparation_unavailable" } } }),
            canonicalBytes: next === null ? 0 : bodyBytes, sourceCost: policy.sourceCost });
          releaseCanonical = observed.releaseCanonical;
          acquisition = observed.phase;
          if (next !== null) {
            // Execute only the guaranteed first native extent before admitting acquisition metadata.
            // Its read state and deferred allowance survive the catalog and resume at the census seam.
            releaseCanonical();
            sourceReader ??= new SqliteFieldSourceRecordRepo(runtime.database, fieldContractSha256);
            canonicalRead = beginCanonicalSourceText(sourceReader, next, policy, observation, meter, bodyBytes);
            if (canonicalRead !== undefined) {
              canonicalRecord = next;
              releaseCanonical = canonicalRead.release;
            }
          }
          unionCompletion.metadata(observation.acquisition!);
          return observed.nominations;
        }
      }) })
    : restrictedSource(runtime, payload.workspace_id, sourceId, authorized, observation);
  if (sourceId !== undefined) for (const record of sources.sources) beforeRetain(record);
  const records = sources.sources;
  if (canonicalRead !== undefined && records[0] !== canonicalRecord) {
    throw new CoreError("CONFLICT", "canonical source observation no longer matches the admitted catalog");
  }
  if (sourcePreviewExtents !== undefined) {
    if (sourcePreviewExtents.length !== records.length) {
      throw new CoreError("VALIDATION", "source preview extents do not cover the native source population", { details: { admission: "bound" } });
    }
    for (const record of records) previewExtent(record, sourcePreviewExtents);
  }
  const lookup = SourceSemanticReadBudget.tupleLookupCost("catalog", records.length);
  meter.charge(lookup.work_units, lookup.memory_bytes, "access source record lookup");
  const byId = new Map(records.map((record) => [record.identity, record]));
  const sourceRows = new Map<string, SourceObservation>();
  const stops = new Set<Stop>();
  for (const reason of sources.stopping_reasons) stops.add(reason);
  let interpretations: ReturnType<typeof observeInterpretations>;
  try {
    interpretations = observeInterpretations(runtime, payload, authorized, observation, policy, records, byId, sourceRows, stops,
      sourceId, completion === undefined ? undefined : () => {
        releaseCanonical();
        identity = unionCompletion.emptyCompletion({
          runtime, parent: meter, child: observation, records, sourcePages: sources.pages,
          policy: policyName, budget, orderCost: policy.orderCost, leaseContext: completion.leaseContext,
          suppliedQuerySemantics: completion.suppliedQuerySemantics, accessHint, sourcePreviewExtents,
          phases: { preparation: prepare, acquisition: observation.acquisition ?? acquisition as SourceSemanticCompactAcquisition },
          borrowPreparation: completion.executionOf,
          acquisitionCapture: Array.isArray(acquisition) ? undefined : acquisition as SourceSemanticAcquisitionPhase | undefined
        }); }, sourcePreviewExtents, beforeRetain, unionCompletion,
      () => { if (canonicalRead === undefined) releaseCanonical(); }, canonicalRead?.resume, sourceReader);
  } finally {
    // The navigation/header child already ran even when completion planning fails.
    canonicalRead?.close(); releaseCanonical(); unionCompletion.release();
    absorbed = true; meter.absorb(observation);
  }
  return finalizeObservedSourceAccess(runtime, payload.workspace_id, authorized, meter, policy, policyName, records, sources, interpretations,
    sourceRows, byId, stops, original, query, budget, sourceId,
    prepare, observation.acquisition ?? acquisition as SourceSemanticCompactAcquisition, observation,
    sourcePreviewExtents, accessHint, identity);
  } finally {
    // The prepared identity survives completion-hold release but never the request.
    identity?.close(); identity = undefined; acquisition = undefined;
    completion?.executionOf?.("retire_prepare");
    canonicalRead?.close(); releaseCanonical(); unionCompletion.release();
    if (!absorbed) meter.absorb(observation);
  }
}

/** Observation is complete and absorbed before ordering/identity publication begins.
 * Keep this finalization phase separate without allocating a request-context copy. */
function finalizeObservedSourceAccess(runtime: SourceSemanticReadRuntime, workspace: string, authorized: readonly string[] | null,
  meter: SourceSemanticReadBudget, policy: Policy, policyName: SourceSemanticAccessPolicy, records: readonly SourceRecordIdentity[],
  sources: { open: boolean; truncated: boolean; pages: number }, interpretations: ReturnType<typeof observeInterpretations>,
  sourceRows: Map<string, SourceObservation>, byId: Map<string, SourceRecordIdentity>, stops: Set<Stop>,
  original: string, query: SourceSemanticQuery | undefined, budget: RequestBudget, sourceId: string | undefined,
  preparation: SourceSemanticAccessReceipt["phases"][1], acquisition: SourceSemanticCompactAcquisition,
  observation: SourceSemanticReadBudget, sourcePreviewExtents?: SourceSemanticPreviewExtents, accessHint?: string,
  identity?: PreparedSourceSemanticCanonicalSubtrees): SourceSemanticAccessPool {
  for (const record of records) if (!sourceRows.has(record.identity)) sourceRows.set(record.identity, {
    source_id: record.source_id, record_id: record.identity, read_bytes: 0, body_bytes: null, complete: false, signal: UNKNOWN
  });
  if ([...sourceRows.values()].some(row => !row.complete)) stops.add("source_tail");
  // Fixed result arrays preserve the original map allocations without adding a
  // second captured request environment at this finalization boundary.
  const reconciled = new Array<InterpretationObservation>(interpretations.rows.length);
  for (let index = 0; index < reconciled.length; index++) {
    const row = interpretations.rows[index]!;
    reconciled[index] = { ...row, signal: { ...row.signal,
      source_text_score: sourceRows.get(row.record_id)?.signal.source_text_score ?? null } };
  }
  const reconciliation = SourceSemanticReadBudget.signalReconciliationCost(reconciled.length);
  meter.charge(reconciliation.work_units, reconciliation.memory_bytes, "access final source signal reconciliation");
  meter.retain(reconciled, "access reconciled interpretation signals");
  const orderedSources = policy.order([...sourceRows.values()].map((row) => ({ ...row, identity: row.record_id })), meter)
    .map(({ identity: _identity, ...row }) => row);
  const orderedInterpretations = policy.order(reconciled.map((row) => ({ ...row, identity: row.interpretation_id })), meter)
    .map(({ identity: _identity, ...row }) => row);
  const inputId = accessInputIdentity(original, query, budget, policyName, sourceId, sourcePreviewExtents, accessHint);
  const accounting = sourceSemanticObservationAccounting(acquisition, observation, meter);
  const receipt = sourceSemanticAccessReceiptValue(meter, policyName, inputId, orderedSources, orderedInterpretations,
    sources.open || sources.truncated || orderedSources.some((row) => !row.complete), interpretations.open, [...stops],
    sourcePreviewExtents, { preparation, acquisition, observation: accounting });
  meter.retain(receipt, "access receipt identity", "borrow");
  const access = bindAccessPoolIdentity(runtime, workspace, authorized, receipt, meter, identity);
  const selectedSources = new Array<SourceRecordIdentity>(orderedSources.length);
  for (let index = 0; index < selectedSources.length; index++) selectedSources[index] = byId.get(orderedSources[index]!.record_id)!;
  const descriptors = new Array<SourceSemanticHandleDescriptor>(orderedInterpretations.length);
  for (let index = 0; index < descriptors.length; index++) descriptors[index] = interpretations.descriptors.get(orderedInterpretations[index]!.interpretation_id)!;
  return { sources: selectedSources, descriptors,
    access, ...(accessHint === undefined ? {} : { accessHint }),
    ...(sourcePreviewExtents === undefined ? {} : { sourcePreviewExtents }),
    sourcePages: sources.pages, interpretationPages: interpretations.pages };
}

function restrictedSource(runtime: SourceSemanticReadRuntime, workspace: string, sourceId: string,
  authorized: readonly string[] | null, meter: SourceSemanticReadBudget) {
  const record = sourceSemanticReadStores(runtime.database, workspace, sourceId, meter, authorized).getCurrentRecord(workspace, sourceId);
  if (record !== null) authorizeSemanticScope(record.scope_class, authorized);
  return { sources: record === null ? [] : [record], pages: 1, open: false, truncated: false, stopping_reasons: [] };
}

function observeInterpretations(runtime: SourceSemanticReadRuntime, payload: SourceSemanticWorkerPayload,
  authorized: readonly string[] | null, meter: SourceSemanticReadBudget, policy: Policy,
  records: SourceRecordIdentity[], byId: Map<string, SourceRecordIdentity>, sources: Map<string, SourceObservation>,
  stops: Set<Stop>, sourceId?: string, onConclusiveEmpty?: () => void, sourcePreviewExtents?: SourceSemanticPreviewExtents,
  beforeRetain?: (record: SourceRecordIdentity) => void, completion?: SourceSemanticUnionCompletion,
  beginCanonicalObservation?: () => void, initialSourceRead?: NonNullable<ReturnType<typeof beginCanonicalSourceText>>["resume"],
  sourceReader?: SqliteFieldSourceRecordRepo) {
  const descriptors = new Map<string, SourceSemanticHandleDescriptor>();
  const rows: InterpretationObservation[] = [];
  let pending: InterpretationHeader[] = [], exploration: InterpretationHeader[] = [];
  // A retained header is still pending; null records a consumed identity across both producers.
  const seen = new Map<string, InterpretationHeader | null>();
  let after: string | null = null, pages = 0, sourceOffset = 0, headersDone = false, open = false;
  let readingInitialCensus = false;
  const observeSource = (record: SourceRecordIdentity, afterExtent?: () => void) => {
    meter.charge(1, 0, "access observed source check");
    if (sources.get(record.identity)?.complete === true) return;
    const extent = sourcePreviewExtents === undefined ? undefined : previewExtent(record, sourcePreviewExtents);
    let result: ReturnType<typeof readSourceText>;
    if (record === records[0] && initialSourceRead !== undefined) {
      const resume = initialSourceRead; initialSourceRead = undefined;
      result = resume(afterExtent);
    } else {
      sourceReader ??= new SqliteFieldSourceRecordRepo(runtime.database, fieldContractSha256);
      result = readSourceText(sourceReader, record, policy, meter, extent, afterExtent);
    }
    const { resourceLimited, ...observation } = result;
    if (resourceLimited) stops.add("budget");
    sources.set(record.identity, { source_id: record.source_id, record_id: record.identity, ...observation });
    policy.associateSourceHint(record.content_digest, observation.signal, meter);
  };
  try {
    // Only a conclusive raw census can promote the body allowance or avoid lazy navigation.
    const readFirstPage = () => {
      readingInitialCensus = true;
      const page = readInterpretationHeaderPage(runtime, payload.workspace_id, meter, after);
      pages++;
      if (page.rawEmpty) {
        try { onConclusiveEmpty?.(); }
        catch (error) {
          if (error instanceof SourceSemanticResourceExhausted) throw new SourceSemanticResourceExhausted("empty interpretation completion");
          throw error;
        }
      }
      readingInitialCensus = false;
      return page;
    };
    let firstPage: ReturnType<typeof readInterpretationHeaderPage> | undefined;
    // Start the canonical extent before census; finish its body once any promotion is known.
    if (records.length > 0) {
      beginCanonicalObservation?.();
      observeSource(records[sourceOffset++]!, () => { firstPage = readFirstPage(); });
    }
    firstPage ??= readFirstPage();
    // null means navigation was not run, not that FTS successfully observed an empty result.
    const navigation = firstPage.rawEmpty ? null : readInterpretationNavigation(runtime, payload.workspace_id, meter, policy);
    if (navigation !== null) {
      appendInterpretationHeaders(pending, navigation.rows, seen, meter);
      if (navigation.unavailable) { open = true; stops.add("unavailable"); }
      if (navigation.resourceLimited) { open = true; stops.add("budget"); }
    }
    while (!headersDone || sourceOffset < records.length || pending.length > 0) {
      if (!headersDone) {
        const page: ReturnType<typeof readInterpretationHeaderPage> =
          firstPage ?? readInterpretationHeaderPage(runtime, payload.workspace_id, meter, after);
        if (firstPage === undefined) pages++;
        firstPage = undefined;
        appendInterpretationHeaders(pending, page.rows, seen, meter, exploration);
        if (page.resourceLimited || page.truncated && (page.committedThrough === null || page.committedThrough === after)) {
          headersDone = true; open = true; stops.add("unavailable");
        } else if (!page.truncated) headersDone = true;
        else if (pages === 32) { headersDone = true; open = true; stops.add("interpretation_limit"); }
        after = page.committedThrough;
      }
      const through = Math.min(records.length, sourceOffset + SOURCE_SEMANTIC_LIBRARY_INTERPRETATION_PAGE);
      while (sourceOffset < through) {
        observeSource(records[sourceOffset++]!);
      }
      if (pending.length === 0) continue;
      const scheduled = policy.schedule(pending, exploration, meter);
      // Let unfinished observation producers progress between priority/exploration pairs.
      const count = headersDone && sourceOffset === records.length ? scheduled.length : Math.min(2, scheduled.length);
      meter.charge(2 * count, count * 8, "access selected verification references");
      for (const row of scheduled.slice(0, count)) {
        seen.set(row.identity, null);
        try {
          const verified = observeInterpretation(runtime, payload.workspace_id, row, authorized, meter, policy, records, byId, sources, sourceId,
            sourcePreviewExtents, () => { open = true; stops.add("unavailable"); }, beforeRetain, completion);
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
      meter.charge(pending.length + exploration.length, (pending.length + exploration.length) * 8, "access pending verification retention");
      pending = pending.filter(row => seen.get(row.identity) !== null);
      exploration = exploration.filter(row => seen.get(row.identity) !== null);
    }
  } catch (error) {
    // A failed census is not a partial source-body observation, even after its extent was read.
    if (readingInitialCensus || !(error instanceof SourceSemanticResourceExhausted)) throw error;
    stops.add("budget"); open = true;
  }
  return { descriptors, rows, pages, open: open || !headersDone || pending.length > 0 };
}

function observeInterpretation(runtime: SourceSemanticReadRuntime, workspace: string, row: InterpretationHeader,
  authorized: readonly string[] | null, meter: SourceSemanticReadBudget, policy: Policy,
  records: SourceRecordIdentity[], byId: Map<string, SourceRecordIdentity>, sources: Map<string, SourceObservation>, sourceId?: string,
  sourcePreviewExtents?: SourceSemanticPreviewExtents, onDeferred?: () => void,
  beforeRetain?: (record: SourceRecordIdentity) => void, completion?: SourceSemanticUnionCompletion) {
  const checked = loadVerified(runtime, workspace, { evidence_object_id: row.object_id }, authorized, meter,
    sourceId === undefined && sourcePreviewExtents === undefined ? undefined : bound => {
      if (sourceId !== undefined) {
        meter.charge(1, 0, "access interpretation source membership");
        if (bound.interpretation.source.source_id !== sourceId) return false;
      }
      if (sourcePreviewExtents === undefined) return true;
      let current: SourceRecordIdentity | undefined;
      for (const record of records) {
        meter.charge(1, 0, "access preview verification tuple");
        if (record.source_id === bound.interpretation.source.source_id) { current = record; break; }
      }
      if (current !== undefined && sources.get(current.identity)?.complete === true) return true;
      onDeferred?.();
      return false;
    });
  if (checked === null) return null;
  const record = checked.stored.record, interpretation = checked.bound.interpretation;
  if (sourcePreviewExtents !== undefined) previewExtent(record, sourcePreviewExtents);
  if (!byId.has(record.identity)) {
    beforeRetain?.(record);
    meter.retain(record, "access discovered current source");
    const lookup = SourceSemanticReadBudget.tupleLookupCost("discovered", 1);
    meter.charge(lookup.work_units, lookup.memory_bytes, "access discovered source lookup");
    byId.set(record.identity, record); records.push(record);
  }
  if (sourcePreviewExtents === undefined && sources.get(record.identity)?.complete !== true) {
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
    producer_id: interpretation.producer_id, producer_version: interpretation.producer_version, contract_version: interpretation.contract_version,
    ...(interpretation.generation_task === undefined ? {} : { generation_task: sourceSemanticGenerationTaskSummary(interpretation.generation_task) }) };
  const observation = { interpretation_id: descriptor.interpretation_id, record_id: record.identity, signal };
  completion?.interpretation(descriptor, observation);
  meter.retain([descriptor, observation], "access interpretation retention");
  return { descriptor, observation };
}

function appendInterpretationHeaders(pending: InterpretationHeader[], rows: readonly InterpretationHeader[],
  seen: Map<string, InterpretationHeader | null>, meter: SourceSemanticReadBudget, exploration?: InterpretationHeader[]): void {
  for (const row of rows) {
    meter.charge(1, 0, "access header identity check");
    const existing = seen.get(row.identity);
    if (existing === null) continue;
    if (existing === undefined) {
      meter.charge(0, row.identity.length * 2 + 56, "access header identity retention");
      seen.set(row.identity, row); pending.push(row);
    }
    if (exploration !== undefined) {
      meter.charge(0, 8, "access cursor reference retention");
      exploration.push(existing ?? row);
    }
  }
}

function readInterpretationNavigation(runtime: SourceSemanticReadRuntime, workspace: string,
  meter: SourceSemanticReadBudget, policy: Policy) {
  const rows: InterpretationHeader[] = [];
  let nativeRemaining = 2 * SOURCE_SEMANTIC_LIBRARY_INTERPRETATION_PAGE + 2;
  let unavailable = false, resourceLimited = false;
  try {
    for (const route of ["original", "hint"] as const) {
      if (nativeRemaining === 0 || rows.length === SOURCE_SEMANTIC_LIBRARY_INTERPRETATION_PAGE) break;
      const query = policy.navigationQuery(meter, route);
      if (query === null) continue;
      const nativeLimit = Math.min(meter.work, nativeRemaining);
      const nativeByteLimit = Math.min(Math.floor(meter.bytes / 8), 1_000_000);
      meter.reserve(nativeLimit, nativeByteLimit, "access navigation page");
      const page = new SqliteSourceHintReader(runtime.database.connection).pageInterpretationTextHints({
        workspaceId: workspace, query, limit: SOURCE_SEMANTIC_LIBRARY_INTERPRETATION_PAGE - rows.length,
        nativeLimit, nativeByteLimit, afterCursor: null
      });
      meter.read(page.nativeVisits, page.bytesRead); nativeRemaining -= page.nativeVisits;
      unavailable ||= page.unavailable; resourceLimited ||= page.resourceLimited;
      for (const row of page.rows) {
        const header = { ...row, identity: row.object_id, query_hint: true as const };
        meter.retain(header, "access lexical header retention"); rows.push(header);
      }
    }
  } catch (error) {
    if (!(error instanceof SourceSemanticResourceExhausted)) throw error;
    resourceLimited = true;
  }
  return { rows, unavailable, resourceLimited };
}

function readInterpretationHeaderPage(runtime: SourceSemanticReadRuntime, workspace: string,
  meter: SourceSemanticReadBudget, after: string | null) {
  const reader = new SqliteSourceHintReader(runtime.database.connection);
  meter.reserve(1, 784, "interpretation access header page");
  const page = reader.pageBoundInterpretationHeaders({ workspaceId: workspace,
    limit: Math.min(SOURCE_SEMANTIC_LIBRARY_INTERPRETATION_PAGE, meter.work),
    afterCursor: after, nativeByteLimit: Math.min(Math.floor(meter.bytes / 8), 1_000_000) });
  meter.read(page.nativeVisits, page.bytesRead);
  const rawEmpty = after === null && page.rows.length === 0 && !page.truncated && !page.resourceLimited;
  const rows: InterpretationHeader[] = [];
  for (const row of page.rows) {
    meter.charge(1, 0, "access capsule lifecycle check");
    if (row.lifecycle_state !== "active") continue;
    const header = { ...row, identity: row.object_id };
    meter.retain(header, "access interpretation header retention"); rows.push(header);
  }
  return { ...page, rows, rawEmpty };
}

export function accessDescriptorPage(runtime: SourceSemanticReadRuntime, workspace: string, asOf: string, authorized: readonly string[] | null,
  meter: SourceSemanticReadBudget, pool: SourceSemanticAccessPool, offset: number) {
  const delivery = new SourceSemanticReadBudget({ work_units: Math.floor(meter.work / 2), memory_bytes: Math.floor(meter.bytes / 2) });
  const candidates: SourceSemanticHandleDescriptor[] = [];
  let outputBytes = 0;
  try {
    for (const descriptor of pool.descriptors.slice(offset, offset + SOURCE_SEMANTIC_LIBRARY_INTERPRETATION_PAGE)) {
      const checked = loadVerified(runtime, workspace, descriptor.interpretation_id, authorized, delivery);
      const candidate = { ...descriptor, interpretation: checked.bound.interpretation,
        source_disclosure: projectSourceDisclosure({ material_kind: "interpretation", evaluated_as_of: asOf,
          source: checked.stored.record }) };
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
  const receipt = preparationAccessReceiptValue(pool, sourceOffset, interpretationOffset, interpretationCount);
  meter.retain(receipt, "access trace delivery", "borrow");
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
  meter.retain(receipt, "access trace delivery", "borrow");
  return receipt;
}
