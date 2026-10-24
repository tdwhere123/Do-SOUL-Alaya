import {
  SOURCE_SEMANTIC_LIBRARY_INTERPRETATION_PAGE,
  SourceSemanticResourceExhausted, type SourceRecordIdentity,
  sourceSemanticGenerationTaskSummary, sourceSemanticAcquisitionNotRun, unavailableSourceQueryPreparation,
  captureSourceSemanticQueryPreparation,
  packSourceSemanticQueryPreparation, packSourceSemanticAcquisition,
  sourceSemanticPreparationReason,
  type SourceSemanticProfiledAccessReceipt, type SourceSemanticReadableAccessReceipt,
  type SourceSemanticReadableAcquisition, type SourceSemanticRetainedNominationWitness, type SourceSemanticReadableAccessPhases,
  type SourceSemanticReadableExecution,
  type SourceSemanticAccessReceipt, type SourceSemanticAccessPolicy,
  type SourceSemanticHandleDescriptor, type SourceSemanticQuery, type RequestBudget, type SourceSemanticPreviewExtents,
  type SourceSemanticAcquisitionPhase, type SourceSemanticCompactAcquisition, type PreparedSourceSemanticCanonicalSubtrees
} from "@do-soul/alaya-protocol";
import { CoreError, authorizeSemanticScope, createSourceSemanticAccessPolicy, sourceSemanticAccessInputIdentity, fieldContractSha256,
  projectSourceDisclosure } from "@do-soul/alaya-core";
import { SqliteFieldSourceRecordRepo } from "@do-soul/alaya-storage";
import { sourceSemanticReadStores, SourceSemanticReadBudget } from "../field/source-semantic-read-stores.js";
import { listEligibleSemanticSources, semanticSourceTupleIdentity } from "./source-recall-catalog.js";
import { sourceRecallPhaseAllowance } from "./source-recall.js";
import { admissionOf, loadVerified, type SourceSemanticWorkerPayload } from "./source-semantic-discovery.js";
import type { SourceSemanticReadRuntime } from "./runtime.js";
import type { QueryPreparationLeaseBase } from "./source-semantic-leases.js";
import type { SourceSemanticRequestExecution } from "./source-semantic-reasoning.js";
import { beginCanonicalSourceText, readSourceText } from "./source-recall-source-text.js";
import { acquireSourceSemanticIndex, type NativeSourceRouteCaptures } from "./source-semantic-index-acquisition.js";
import { SourceSemanticUnionCompletion } from "./source-semantic-empty-population-budget.js";
import { observeSourceRecallAccess, orderSourceRecallObservations, readSourceRecallHeaders, navigateSourceRecallHeaders } from "./source-recall-access.js";
import { bindAccessPoolIdentity, sourceSemanticObservationAccounting,
  sourceSemanticAccessReceiptValue, preparationAccessReceiptValue } from "./source-semantic-access-receipts.js";

type SourceObservation = SourceSemanticAccessReceipt["source_candidates"][number];
type InterpretationObservation = SourceSemanticAccessReceipt["interpretation_candidates"][number];
type Policy = ReturnType<typeof createSourceSemanticAccessPolicy>;
type Stop = SourceSemanticAccessReceipt["stopping_reasons"][number];

export type SourceSemanticAccessPool<Access extends SourceSemanticReadableAccessReceipt = SourceSemanticAccessReceipt> = Readonly<{
  sources: readonly SourceRecordIdentity[];
  descriptors: readonly SourceSemanticHandleDescriptor[];
  access: Access extends SourceSemanticAccessReceipt ? Omit<SourceSemanticAccessReceipt, "trace"> : Omit<SourceSemanticProfiledAccessReceipt, "trace">;
  retainedWitness?: SourceSemanticRetainedNominationWitness;
  nativeCaptures?: NativeSourceRouteCaptures;
  catalogPositions?: readonly (readonly [string, number])[];
  accessHint?: string;
  sourcePreviewExtents?: SourceSemanticPreviewExtents;
  sourcePages: number; interpretationPages: number;
}>;
export type SourceSemanticReadableAccessPool = SourceSemanticAccessPool<SourceSemanticReadableAccessReceipt>;
type EmptyCompletion = Readonly<{
  leaseContext: QueryPreparationLeaseBase; suppliedQuerySemantics?: SourceSemanticQuery;
  executionOf?: SourceSemanticRequestExecution<SourceSemanticReadableExecution> }>;

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
export function observeSourceSemanticAccess(runtime: SourceSemanticReadRuntime,
  payload: SourceSemanticWorkerPayload,
  authorized: readonly string[] | null, meter: SourceSemanticReadBudget, original: string,
  query: SourceSemanticQuery | undefined, policyName: SourceSemanticAccessPolicy, budget: RequestBudget,
  sourceId?: string, completion?: EmptyCompletion, sourcePreviewExtents?: SourceSemanticPreviewExtents,
  preferredSourceIds?: readonly string[], accessHint?: string): SourceSemanticAccessPool;
export function observeSourceSemanticAccess(runtime: SourceSemanticReadRuntime, payload: SourceSemanticWorkerPayload,
  authorized: readonly string[] | null, meter: SourceSemanticReadBudget, original: string,
  query: SourceSemanticQuery | undefined, policyName: SourceSemanticAccessPolicy, budget: RequestBudget,
  sourceId?: string, completion?: EmptyCompletion, sourcePreviewExtents?: SourceSemanticPreviewExtents,
  preferredSourceIds?: readonly string[], accessHint?: string): SourceSemanticReadableAccessPool {
  if (sourceId !== undefined && preferredSourceIds !== undefined) {
    throw new CoreError("VALIDATION", "source-scoped access cannot use source nomination");
  }
  if (sourceId !== undefined && accessHint !== undefined) {
    throw new CoreError("VALIDATION", "source-scoped access cannot use an access hint");
  }
  // Only the request owner's actual fused capture proves the public ownership entry was omitted.
  // Keep the exact pre-child allowance: no new tuple, borrower closure or eligibility scan here.
  if (meter.preparation !== undefined && completion?.executionOf?.(meter.preparation) !== undefined) meter.charge(1, 16, "source phase request ownership bridge");
  let identity: PreparedSourceSemanticCanonicalSubtrees<SourceSemanticReadableAccessPhases> | undefined;
  let retainedWitness: SourceSemanticRetainedNominationWitness | undefined;
  meter.charge(1, 64, "source catalog position map");
  const catalogPositions = new Map<string, number>();
  let nativeCaptures: NativeSourceRouteCaptures | undefined;
  const policy = createSourceSemanticAccessPolicy(original, query, policyName, meter, accessHint);
  // Keep output/lease and branch work available after bounded observation. These are portions of the same request ledger.
  const observation = meter.child(sourceRecallPhaseAllowance(meter, "observation"), "observation");
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
  let acquisition: SourceSemanticReadableAcquisition | SourceSemanticAcquisitionPhase =
    packSourceSemanticAcquisition(sourceSemanticAcquisitionNotRun(controlled ? "controlled_or_scoped_access" : "observation_allowance"), meter);
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
    phases: { preparation: prepare, acquisition: acquisition as SourceSemanticReadableAcquisition }, retainedWitness });
  const sources = sourceId === undefined ? listEligibleSemanticSources(runtime.database, payload.workspace_id, observation, authorized,
    preferredSourceIds, { nominations: [], beforeRetain, catalogPositions,
      ...(sourcePreviewExtents !== undefined || preferredSourceIds !== undefined || policyName === "canonical-v1" ? {} : {
        acquire: (next: SourceRecordIdentity | null, bodyBytes: number) => {
          const acquisitionInput = { runtime, workspace: payload.workspace_id,
            navigation: original, authorized, meter: observation, metadataMeter: meter,
            vector: payload.prepared_query?.vector ?? { status: "unavailable", reason: sourceSemanticPreparationReason(prepare, meter) ?? "preparation_unavailable" },
            ...(accessHint === undefined || accessHint === original ? {} : { supplemental: { navigation: accessHint,
              vector: payload.prepared_query?.supplemental?.vector ?? { status: "unavailable", reason: "hint_preparation_unavailable" } } }),
            canonicalBytes: next === null ? 0 : bodyBytes, sourceCost: policy.sourceCost };
          const observed = acquireAtCatalogSeam(acquisitionInput, next, policy, unionCompletion);
          retainedWitness = observed.witness;
          nativeCaptures = "captures" in observed ? observed.captures : undefined;
          releaseCanonical = observed.releaseCanonical; acquisition = observed.phase;
          sourceReader = observed.sourceReader; canonicalRead = observed.canonicalRead; canonicalRecord = observed.canonicalRecord;
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
          phases: { preparation: prepare, acquisition: observation.acquisition ?? acquisition as SourceSemanticReadableAcquisition },
          retainedWitness,
          borrowPreparation: completion.executionOf,
          acquisitionCapture: !Array.isArray(acquisition) ? acquisition as SourceSemanticAcquisitionPhase : undefined
        }); }, sourcePreviewExtents, beforeRetain, unionCompletion,
      () => { if (canonicalRead === undefined) releaseCanonical(); }, canonicalRead?.resume, sourceReader);
  } finally {
    // The navigation/header child already ran even when completion planning fails.
    canonicalRead?.close(); releaseCanonical(); unionCompletion.release();
    absorbed = true; meter.absorb(observation);
  }
  return finalizeObservedSourceAccess(runtime, payload.workspace_id, authorized, meter, policy, policyName, records, sources, interpretations,
    sourceRows, byId, stops, original, query, budget, sourceId,
    prepare, observation.acquisition ?? acquisition as SourceSemanticReadableAcquisition, observation,
    sourcePreviewExtents, accessHint, identity, retainedWitness, catalogPositions, nativeCaptures);
  } finally {
    // The prepared identity survives completion-hold release but never the request.
    identity?.close(); identity = undefined;
    completion?.executionOf?.("retire_prepare");
    canonicalRead?.close(); releaseCanonical(); unionCompletion.release();
    if (!absorbed) meter.absorb(observation);
  }
}

/** Own the handoff from acquisition's native reservation to the first source extent.
 * A failed metadata quote must close that extent before returning ownership to observation. */
function acquireAtCatalogSeam(input: Parameters<typeof acquireSourceSemanticIndex>[0], next: SourceRecordIdentity | null,
  policy: Policy, completion: SourceSemanticUnionCompletion) {
  const observed = acquireSourceSemanticIndex(input);
  const witness = [...(observed.captures.original?.witness ?? []), ...(observed.captures.hint?.witness ?? [])];
  let releaseCanonical = observed.releaseCanonical;
  let sourceReader: SqliteFieldSourceRecordRepo | undefined;
  let canonicalRead: ReturnType<typeof beginCanonicalSourceText>;
  try {
    if (!("witness" in observed)) input.metadataMeter.charge(witness.length, 64 + witness.length * 8, "retained route witness references");
    if (next !== null) {
      releaseCanonical();
      sourceReader = new SqliteFieldSourceRecordRepo(input.runtime.database, fieldContractSha256);
      canonicalRead = beginCanonicalSourceText(sourceReader, next, policy, input.meter, input.metadataMeter, input.canonicalBytes);
      if (canonicalRead !== undefined) releaseCanonical = canonicalRead.release;
    }
    completion.metadata(input.meter.acquisition!);
    if (witness !== undefined) completion.metadata({ retainedWitness: witness });
    return { ...observed, witness, sourceReader, canonicalRead, releaseCanonical,
      canonicalRecord: canonicalRead === undefined ? undefined : next! };
  } catch (error) { canonicalRead?.close(); releaseCanonical(); throw error; }
}

/** Observation is complete and absorbed before ordering/identity publication begins.
 * Keep this finalization phase separate without allocating a request-context copy. */
function finalizeObservedSourceAccess(runtime: SourceSemanticReadRuntime, workspace: string, authorized: readonly string[] | null,
  meter: SourceSemanticReadBudget, policy: Policy, policyName: SourceSemanticAccessPolicy, records: readonly SourceRecordIdentity[],
  sources: { open: boolean; truncated: boolean; pages: number }, interpretations: ReturnType<typeof observeInterpretations>,
  sourceRows: Map<string, SourceObservation>, byId: Map<string, SourceRecordIdentity>, stops: Set<Stop>,
  original: string, query: SourceSemanticQuery | undefined, budget: RequestBudget, sourceId: string | undefined,
  preparation: SourceSemanticAccessReceipt["phases"][1], acquisition: SourceSemanticReadableAcquisition,
  observation: SourceSemanticReadBudget, sourcePreviewExtents?: SourceSemanticPreviewExtents, accessHint?: string,
  identity?: PreparedSourceSemanticCanonicalSubtrees<SourceSemanticReadableAccessPhases>,
  retainedWitness?: SourceSemanticRetainedNominationWitness, catalogPositions?: ReadonlyMap<string, number>,
  nativeCaptures?: NativeSourceRouteCaptures): SourceSemanticReadableAccessPool {
  const { orderedSources, orderedInterpretations } = orderSourceRecallObservations(records, sourceRows,
    interpretations.rows, stops, meter, rows => policy.order(rows, meter), count => {
      const cost = SourceSemanticReadBudget.signalReconciliationCost(count);
      meter.charge(cost.work_units, cost.memory_bytes, "access final source signal reconciliation");
    });
  const inputId = accessInputIdentity(original, query, budget, policyName, sourceId, sourcePreviewExtents, accessHint);
  const accounting = sourceSemanticObservationAccounting(acquisition, observation, meter);
  const receipt = sourceSemanticAccessReceiptValue(meter, policyName, inputId, orderedSources, orderedInterpretations,
    sources.open || sources.truncated || orderedSources.some((row) => !row.complete), interpretations.open, [...stops],
    sourcePreviewExtents, { preparation, acquisition, observation: accounting }, undefined);
  meter.retain(receipt, "access receipt identity", "borrow");
  const access = bindAccessPoolIdentity(runtime, workspace, authorized, receipt, meter, identity, retainedWitness);
  meter.observer?.event("access_order", meter.phase, () => ({ pool_id: access.pool_id,
    sources: orderedSources.map((row, position) => ({ position, record_id: row.record_id, source_id: row.source_id,
      read_bytes: row.read_bytes, body_bytes: row.body_bytes, complete: row.complete })), stopping_reasons: [...stops] }));
  const selectedSources = new Array<SourceRecordIdentity>(orderedSources.length);
  for (let index = 0; index < selectedSources.length; index++) selectedSources[index] = byId.get(orderedSources[index]!.record_id)!;
  const descriptors = new Array<SourceSemanticHandleDescriptor>(orderedInterpretations.length);
  for (let index = 0; index < descriptors.length; index++) descriptors[index] = interpretations.descriptors.get(orderedInterpretations[index]!.interpretation_id)!;
  meter.charge(catalogPositions?.size ?? 0, 64 + 24 * (catalogPositions?.size ?? 0), "retained catalog position references");
  const pool = { sources: selectedSources, descriptors,
    nativeCaptures, catalogPositions: [...(catalogPositions ?? [])],
    access, ...(retainedWitness === undefined ? {} : { retainedWitness }), ...(accessHint === undefined ? {} : { accessHint }),
    ...(sourcePreviewExtents === undefined ? {} : { sourcePreviewExtents }),
    sourcePages: sources.pages, interpretationPages: interpretations.pages };
  meter.observer?.facts.pool(pool, access.pool_id, selectedSources,
    access.unvisited_sources, access.unvisited_interpretations, "created");
  return pool;
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
  const observed = observeSourceRecallAccess({ records, byId, sources, stops, meter, sourceId,
    preview: sourcePreviewExtents !== undefined, readSource: observeSource,
    readHeaders: after => readSourceRecallHeaders(runtime.database, payload.workspace_id, meter, after),
    navigate: () => navigateSourceRecallHeaders(runtime.database, payload.workspace_id, meter, route => policy.navigationQuery(meter, route)),
    schedule: (pending, exploration) => policy.schedule(pending, exploration, meter),
    sourceSignal: text => policy.source(text, meter),
    associateSource: (digest, signal) => policy.associateSourceHint(digest, signal, meter),
    previewExtent: record => { previewExtent(record, sourcePreviewExtents!); }, beforeRetain,
    discoveredLookup: () => {
      const lookup = SourceSemanticReadBudget.tupleLookupCost("discovered", 1);
      meter.charge(lookup.work_units, lookup.memory_bytes, "access discovered source lookup");
    }, onConclusiveEmpty, beginCanonicalObservation,
    filtered: error => ["filtered", "no_eligible_source"].includes(admissionOf(error) ?? "") || error.code === "NOT_FOUND",
    verify: (row, admission) => {
      const checked = loadVerified(runtime, payload.workspace_id, { evidence_object_id: row.object_id }, authorized, meter,
        sourceId === undefined && sourcePreviewExtents === undefined ? undefined
          : bound => admission.allows(bound.interpretation.source.source_id));
      if (checked === null) return;
      const record = checked.stored.record, interpretation = checked.bound.interpretation;
      const sourceSignal = admission.acceptSource(record, checked.stored.content_bytes);
      const signal = policy.interpretation(sourceSignal, interpretation, meter);
      const descriptor = { interpretation_id: checked.bound.interpretation_id,
        source_id: record.source_id, source_version: record.source_version, content_digest: record.content_digest,
        producer_id: interpretation.producer_id, producer_version: interpretation.producer_version, contract_version: interpretation.contract_version,
        ...(interpretation.generation_task === undefined ? {} : { generation_task: sourceSemanticGenerationTaskSummary(interpretation.generation_task) }) };
      const observation = { interpretation_id: descriptor.interpretation_id, record_id: record.identity, signal };
      completion?.interpretation(descriptor, observation);
      meter.retain([descriptor, observation], "access interpretation retention");
      descriptors.set(descriptor.interpretation_id, descriptor); rows.push(observation);
    }
  });
  return { descriptors, rows, ...observed };
}

export function accessDescriptorPage(runtime: SourceSemanticReadRuntime, workspace: string, asOf: string, authorized: readonly string[] | null,
  meter: SourceSemanticReadBudget, pool: SourceSemanticReadableAccessPool, offset: number) {
  const delivery = meter.child({ work_units: Math.floor(meter.work / 2), memory_bytes: Math.floor(meter.bytes / 2) }, "descriptor_delivery");
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
export function preparationAccessReceipt(pool: SourceSemanticReadableAccessPool, sourceOffset: number,
  interpretationOffset: number, interpretationCount: number, meter: SourceSemanticReadBudget): SourceSemanticReadableAccessReceipt {
  const receipt = preparationAccessReceiptValue(pool, sourceOffset, interpretationOffset, interpretationCount);
  meter.retain(receipt, "access trace delivery", "borrow");
  return receipt;
}
