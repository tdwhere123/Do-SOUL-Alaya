import { indexEntryCacheKey, sourceGoldRootIdentity, sourceIndexNativeRootKey, sourceRecallTarget, SourceSemanticResourceLedger,
  SourceSemanticResourceExhausted, type SourceIndexQueryVector,
  type SourceSemanticAcquisitionPhase, type SourceIndexNominationAllowance } from "@do-soul/alaya-protocol";
import {
  SourceIndexAcquisition,
  restrictStatementAssociation,
  bindEvidenceDemands,
  authorizeSourceIndexScope,
  readSourceDependencyDelivery,
  assertRecallConsumerCompatibility,
  authorizedScopesFromAdmission,
  captureIndexPreviews,
  captureIndexSourceMetadata,
  fieldContractSha256,
  issuedDeliveryIdOf,
  type NativeSourceNomination,
  runConditionalFieldRecallWithReceipt,
  reserveSnapshotPinWork,
  snapshotIdFromPin,
  toSourceObserverRow,
  toSourceRootObserverRow,
  type ConditionalFieldRecallPortResult,
  type ConditionalFieldRecallRequest,
  type ObserverReaders
} from "@do-soul/alaya-core";
import {
  SqliteSourceIndexRepository,
  SqliteEvidenceCapsuleRepo,
  SqliteFieldSourceRecordRepo,
  SqliteIndexedRecallProjection,
  SqliteMemoryRecallReader,
  SqliteRelationRecallReader,
  SqliteSourceRootRecallReader,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { withWorkerActualCost } from "../recall/worker-actual-cost.js";
import { storedMeasurementReaders } from "./stored-measurement-readers.js";
import type { ConditionalFieldRecallWorkerPayload } from "./protocol.js";
import type { RecallReadWorkerRuntime } from "./runtime.js";
import { prepareWorkerDelivery } from "./prepared-delivery.js";
import { sourceSemanticAcquisitionOutcome } from "./source-semantic-index-acquisition.js";
import { taskInterpretationReader } from "./source-semantic-discovery.js";
import type { SourceSemanticObserver } from "./source-semantic-observation.js";

const readersByRuntime = new WeakMap<RecallReadWorkerRuntime, ObserverReaders>();

/** One nomination allowance for the field's source-index frontier. */
export const NATIVE_SOURCE_NOMINATION_ALLOWANCE = Object.freeze({
  max_attempts: 128, max_roots: 16, max_vector_windows: 4096
} as const);

export function runConditionalFieldWorkerRecall(
  runtime: RecallReadWorkerRuntime,
  payload: ConditionalFieldRecallWorkerPayload,
  adapters: Readonly<{ readers?: ObserverReaders; encode_page?: ConditionalFieldRecallRequest["encode_page"];
    observe_page_fit?: ConditionalFieldRecallRequest["observe_page_fit"];
    observe_navigation?: ConditionalFieldRecallRequest["observe_navigation"];
    observe_source_association?: ConditionalFieldRecallRequest["observe_source_association"];
    observer?: SourceSemanticObserver;
    capture_budget_work?: (work: number | undefined) => void }> = {}
): ConditionalFieldRecallPortResult {
  assertRecallConsumerCompatibility(payload);
  const workspaceId = payload.workspace_id;
  const reserved = reserveSnapshotPinWork(payload.budget);
  const observer = adapters.observer;
  observer?.queryVector(payload.prepared_query?.vector);
  const base: ObserverReaders = reserved.permitted && payload.cancelled !== true
    ? adapters.readers ?? (payload.prepared_query === undefined && observer === undefined ? readersFor(runtime)
      : createConditionalFieldObserverReaders(runtime.database, [], payload.prepared_query?.vector, observer,
        "allowance", payload.prepared_query?.evidence)) : {};
  const readers: ObserverReaders = observer === undefined || base.nominateSources === undefined ? base : {
    ...base, nominateSources: input => {
      const nomination = base.nominateSources!(input);
      observer.nomination(nomination);
      return nomination;
    }
  };
  let governance = payload.governance;
  const snapshotId = "snapshotPin" in readers && readers.snapshotPin !== undefined
    ? snapshotIdFromPin(workspaceId, readers.snapshotPin(workspaceId))
    : payload.snapshot_id;
  if (governance?.completeness === "incomplete" && governance.work.native_visits === 0
    && governance.paths.length === 0 && governance.constraints.length === 0) {
    governance = { ...governance, binding: { ...governance.binding, snapshot_id: snapshotId } };
  }
  if (reserved.permitted && governance !== undefined && (governance.binding.workspace_id !== workspaceId
    || governance.binding.snapshot_id !== snapshotId || governance.binding.as_of !== payload.as_of)) {
    throw new Error("conditional field governance snapshot mismatch");
  }
  const executed = withWorkerActualCost(readers, (instrumented) => runConditionalFieldRecallWithReceipt({
    workspace_id: workspaceId,
    query_text: payload.query_text,
    encode_page: adapters.encode_page,
    observe_page_fit: adapters.observe_page_fit,
    observe_page_attempt: observer === undefined ? undefined
      : capture => observer.pageAttempt(capture),
    observe_navigation: adapters.observe_navigation ?? (observer === undefined ? undefined
      : capture => observer.event("field_access_order", "index", capture)),
    observe_source_association: adapters.observe_source_association ?? (observer === undefined ? undefined
      : capture => observer.associationRetention(capture)),
    delivery_budget: payload.delivery_budget,
    delivery_context: payload.delivery_context,
    ...(payload.prepared_query === undefined ? {} : { prepared_query: payload.prepared_query }),
    budget: reserved.budget,
    ...(payload.requested_budget === undefined ? {} : {
      requested_budget: payload.requested_budget
    }),
    ...(payload.source_id === undefined ? {} : { source_id: payload.source_id }),
    ...(payload.access_hint === undefined ? {} : { access_hint: payload.access_hint }),
    snapshot_id: snapshotId,
    ...(governance === undefined ? {} : { governance }),
    interpretation_clock: payload.interpretation_clock,
    as_of: payload.as_of,
    expires_at: payload.expires_at,
    ...(payload.lifetime_now === undefined ? {} : { lifetime_now: payload.lifetime_now }),
    readers: instrumented,
    ...(payload.since === undefined ? {} : { since: payload.since }),
    ...(payload.until === undefined ? {} : { until: payload.until }),
    ...(payload.time_field === undefined ? {} : { time_field: payload.time_field }),
    ...(payload.dimension_filter === undefined ? {} : { dimension_filter: payload.dimension_filter }),
    ...(payload.domain_tag_filter === undefined ? {} : { domain_tag_filter: payload.domain_tag_filter }),
    continuation: payload.continuation ?? null,
    cancelled: payload.cancelled === true,
    ...authorizedScopesFromAdmission(payload.authorized_scopes),
    ...(payload.enumeration_policy === undefined
      ? {}
      : { enumeration_policy: payload.enumeration_policy }),
    ...(payload.result_kind_view === undefined
      ? {}
      : { result_kind_view: payload.result_kind_view }),
    ...(payload.interpretation_proposal === undefined
      ? {}
      : { interpretation_proposal: payload.interpretation_proposal }),
    ...(payload.payload_continuation === undefined
      ? {}
      : { payload_continuation: payload.payload_continuation }),
    ...(payload.cap_contracts === undefined ? {} : { cap_contracts: payload.cap_contracts }),
    ...(payload.claim_demands === undefined ? {} : { claim_demands: payload.claim_demands }),
    ...(payload.protocol_version === undefined ? {} : { protocol_version: payload.protocol_version }),
    ...(payload.supported_result_kinds === undefined
      ? {}
      : { supported_result_kinds: payload.supported_result_kinds }),
    ...(payload.supports_source_evidence === undefined
      ? {}
      : { supports_source_evidence: payload.supports_source_evidence }),
    ...(payload.supports_product_updates === undefined
      ? {}
      : { supports_product_updates: payload.supports_product_updates })
  }, { issue: "defer", capture_budget_work: adapters.capture_budget_work }));
  const index = executed.index;
  const previews = captureIndexPreviews(executed.index, readers, workspaceId);
  const source_metadata = captureIndexSourceMetadata(executed.index);
  observer?.event("field_page_metadata", "index", () => ({ entries: index.entries.map(entry => ({
    entry, metadata: source_metadata[indexEntryCacheKey(entry)] ?? null })) }));
  const issuedDeliveryId = executed.delivery_id ?? issuedDeliveryIdOf(executed.index);
  const preparationId = prepareWorkerDelivery(runtime, executed, source_metadata);
  return {
    execution_receipt: executed.execution_receipt,
    index,
    previews: Object.fromEntries(previews),
    source_metadata,
    preparation_id: preparationId,
    ...(issuedDeliveryId === undefined ? {} : { issued_delivery_id: issuedDeliveryId })
  };
}

type NominationCapture = Omit<ReturnType<SourceIndexAcquisition["nominateWithWitness"]>, "witness"> & {
  witness: NativeSourceNomination["witness"];
  task_observations?: NativeSourceNomination["task_observations"];
};
type NominationInput = Parameters<NonNullable<ObserverReaders["nominateSources"]>>[0];
type AcquisitionFunding = "allowance" | "request";
type PreparedEvidence = Parameters<typeof bindEvidenceDemands>[1];

/** Native acquisition is the only source filter and cost owner. A prepared hint is a
 * second route under the same allowance, never a replacement for original work; a
 * query-lease source restriction narrows the acquired membership, not only identity.
 * Only the allowance quote prices statement-key association, so request-funded pages never associate;
 * keys yield evidence coverage only for the admitted statements' bound prepared vectors.
 */
export function nominateNativeSources(database: StorageDatabase, input: NominationInput,
  queryVector: SourceIndexQueryVector, observer?: SourceSemanticObserver,
  funding: AcquisitionFunding = "allowance", evidence?: PreparedEvidence): NativeSourceNomination {
  const repository = new SqliteSourceIndexRepository(database, fieldContractSha256, { captureReadTargets: true });
  const acquisition = new SourceIndexAcquisition(repository, fieldContractSha256);
  const admit: Parameters<SourceIndexAcquisition["nominateWithWitness"]>[1] = (scope, source) => {
    try { authorizeSourceIndexScope(scope, source, input.authorizedScopes); return "admitted" as const; }
    catch { return "denied" as const; }
  };
  const fields = { workspace_id: input.workspaceId, vector: queryVector,
    allowance: NATIVE_SOURCE_NOMINATION_ALLOWANCE,
    ...(input.questionTime === undefined ? {} : { question_time: input.questionTime }),
    ...(input.sourceTemplate === undefined ? {} : { source_template: input.sourceTemplate }),
    ...(input.sourceTaskObservation === undefined ? {} : { source_task_observation: input.sourceTaskObservation }) };
  const capacity = funding === "allowance" ? repository.quoteQueryCapacity(input.workspaceId, fields.allowance) : undefined;
  const budget = capacity === undefined ? input.budget
    : SourceIndexAcquisition.quoteAllowanceBudget({ ...fields, navigation_text: input.query }, capacity);
  const meter = new SourceSemanticResourceLedger(budget);
  let prepaidCapture: NativeSourceNomination | undefined;
  if (capacity !== undefined) meter.charge(capacity.resources.work, capacity.resources.memory_bytes, "source acquisition capacity reads");
  const run = (navigation_text: string, allowance: SourceIndexNominationAllowance, invocation: "original" | "hint") => {
    const capture = acquisition.nominateWithWitness({ ...fields, allowance, navigation_text, budget: meter.remaining(),
      ...(invocation === "hint" ? { question_time: undefined, source_template: undefined, source_task_observation: undefined } : {}) }, admit, invocation,
      observer === undefined ? undefined : (capture, kind) =>
        observer.sourceIndexAcquisition(invocation, "field", () => {
          const fact = capture();
          return fact.kind !== "source_task_inventory" ? fact : { ...fact, context: {
            block: input.taskObservationBlock ?? (input.sourceTemplate !== undefined ? "source_template"
              : funding !== "allowance" ? "request_funded" : null),
            source_id: input.sourceId ?? null } };
        }, kind), invocation === "original" && capacity !== undefined ? demands : undefined,
      invocation !== "original" || capacity === undefined || input.sourceTemplate === undefined && input.sourceTaskObservation === undefined ? undefined : {
        ...(input.sourceId === undefined ? {} : { source_id: input.sourceId }),
        readInterpretation: taskInterpretationReader(database, input.workspaceId, input.authorizedScopes),
        retain: (capture, retentionMeter) => {
          const retained = nominationFromCaptures([capture], input.sourceId, { charged_by_caller: true });
          const bytes = retainBaseNomination(retained, retentionMeter);
          prepaidCapture = retained;
          return bytes;
        }
      }, observer === undefined ? undefined : input.sourceId);
    meter.charge(capture.result.resources.work, capture.result.resources.memory_bytes, "source native acquisition");
    return capture;
  };
  const demands = bindEvidenceDemands(input.evidenceConditions, evidence, queryVector, input.evidenceRelation);
  const originalBudget = meter.remaining(), original = run(input.query, fields.allowance, "original");
  const hintBudget = meter.remaining(), hintAllowance = {
    max_attempts: fields.allowance.max_attempts - original.result.accounting.attempted,
    max_roots: Math.min(fields.allowance.max_roots - original.result.nominations.length,
      fields.allowance.max_attempts - original.result.accounting.attempted),
    max_vector_windows: fields.allowance.max_vector_windows - original.result.vector.inspected_windows
  };
  const hint = input.hint === undefined || input.hint === input.query || hintAllowance.max_attempts === 0
    || hintAllowance.max_roots === 0 ? undefined : run(input.hint, hintAllowance, "hint");
  observer?.event("source_index_routes", "field", () => {
    const phase = (captured: NominationCapture, budget: typeof input.budget,
      allowance: SourceIndexNominationAllowance): SourceSemanticAcquisitionPhase => ({
      policy: "source-index-interleaved-prefix.v1", ...sourceSemanticAcquisitionOutcome(captured.result),
      allowance, budget, result: captured.result
    });
    return { original: { ...phase(original, originalBudget, fields.allowance),
      ...(hint === undefined ? {} : { supplemental: [phase(hint, hintBudget, hintAllowance)] }) },
      beyond_observed_prefix: "unknown_not_nomination_limit" };
  });
  const captured = prepaidCapture === undefined ? nominationFromCaptures(hint === undefined ? [original] : [original, hint], input.sourceId,
    capacity === undefined ? undefined : { charged_by_caller: true }) : {
    ...prepaidCapture, result: { ...original.result, nominations: prepaidCapture.result!.nominations },
    ...(original.association === undefined ? {} : { association: restrictStatementAssociation(original.association,
      key => prepaidCapture!.result!.nominations.some(row => sourceIndexNativeRootKey(row.source) === key)) })
  };
  // Library requests already have an explicit outer resource ledger; their field
  // must continue paying acquisition from that request, without an ordinary allowance.
  if (capacity === undefined) {
    observer?.associationRetention(() => ({ stage: "source_retention", status: captured.association === undefined ? "absent" : "retained",
      reason: "request_funded_acquisition", required_bytes: null, available_bytes: meter.bytes, retained_bytes: null }));
    return captured;
  }
  const result = captured.result!;
  const { association, ...baseCapture } = captured;
  const baseRetainedBytes = original.prepaid_base_bytes ?? retainBaseNomination(captured, meter);
  let retainedAssociation = association, associationRetainedBytes = 0;
  const associationAvailableBytes = meter.bytes;
  if (association !== undefined) {
    const beforeAssociation = meter.spentBytes;
    try {
      meter.retain(association, "source retained statement association");
      associationRetainedBytes = meter.spentBytes - beforeAssociation;
    } catch (error) {
      if (!(error instanceof SourceSemanticResourceExhausted)) throw error;
      retainedAssociation = undefined;
    }
  }
  observer?.associationRetention(() => ({ stage: "source_retention",
    status: retainedAssociation !== undefined ? "retained" : association !== undefined ? "discarded" : "absent",
    reason: retainedAssociation !== undefined ? null : association !== undefined ? "source_retained_statement_association" : "association_not_provided",
    required_bytes: retainedAssociation === undefined ? null : associationRetainedBytes,
    available_bytes: associationAvailableBytes, retained_bytes: associationRetainedBytes }));
  const resources = {
    ...result.resources, work: meter.spentWork,
    native_bytes: result.resources.native_bytes + capacity.resources.native_bytes,
    memory_bytes: meter.spentBytes
  };
  return { ...baseCapture, ...(retainedAssociation === undefined ? {} : { association: retainedAssociation }),
    association_retained_bytes: associationRetainedBytes, retained_bytes: baseRetainedBytes + associationRetainedBytes,
    acquisition_resources: resources, result: { ...result, resources,
      resource_refusals: association !== undefined && retainedAssociation === undefined
        ? [...result.resource_refusals, { stage: "admission", phase: "source retained statement association" }] : result.resource_refusals } };
}

/** The same actual capture is paid either at the late preference choice or after ordinary acquisition. */
function retainBaseNomination(captured: NativeSourceNomination, meter: SourceSemanticResourceLedger): number {
  const { association: _association, ...baseCapture } = captured, before = meter.spentBytes;
  meter.retain({ ...baseCapture, association: null, retained_bytes: 0, association_retained_bytes: 0,
    acquisition_resources: captured.result!.resources }, "source retained nomination");
  return meter.spentBytes - before;
}

/** Frozen captures are already paid; reuse reports their real membership and totals. */
export function nominationFromCaptures(captures: readonly NominationCapture[], sourceId: string | undefined,
  options?: Readonly<{ catalog_positions?: Readonly<Record<string, number>>; charged_by_caller?: true }>): NativeSourceNomination {
  const results = captures.flatMap(row => row.result === null ? [] : [row.result]);
  const witness = captures.flatMap(row => row.witness);
  if (results.length === 0) return { result: null, witness };
  const base = results[0]!;
  const seen = new Set<string>(), nominations = [];
  for (const result of results) for (const row of result.nominations) {
    const key = sourceGoldRootIdentity(row.source.target);
    if (seen.has(key)) continue;
    seen.add(key); nominations.push(row);
  }
  const membership = sourceId === undefined ? { nominations, witness } : {
    nominations: nominations.filter(row => row.source.source_id === sourceId),
    witness: witness.filter(row => row.source.source_id === sourceId)
  };
  const resources = results.reduce((sum, row) => ({
    work: sum.work + row.resources.work, memory_bytes: sum.memory_bytes + row.resources.memory_bytes,
    native_bytes: sum.native_bytes + row.resources.native_bytes, sql_internal_work: "unknown" as const
  }), { work: 0, memory_bytes: 0, native_bytes: 0, sql_internal_work: "unknown" as const });
  const accounting = results.reduce((sum, row) => ({
    attempted: sum.attempted + row.accounting.attempted, admitted: sum.admitted + row.accounting.admitted,
    duplicate: sum.duplicate + row.accounting.duplicate, rejected: sum.rejected + row.accounting.rejected,
    scope_denied: sum.scope_denied + row.accounting.scope_denied,
    native_unknown: sum.native_unknown + row.accounting.native_unknown,
    resource_refused: sum.resource_refused + row.accounting.resource_refused,
    stale: sum.stale + row.accounting.stale, nomination_limit: sum.nomination_limit + row.accounting.nomination_limit
  }), { attempted: 0, admitted: 0, duplicate: 0, rejected: 0, scope_denied: 0, native_unknown: 0,
    resource_refused: 0, stale: 0, nomination_limit: 0 });
  const completion = results.every(row => row.completion === "complete") ? "complete" as const
    : results.some(row => row.completion === "unavailable") ? "unavailable" as const : "partial" as const;
  const digests = {
    original: results[0]!.navigation_digest ?? results.at(-1)!.navigation_digest,
    ...(results.length < 2 || results[1]!.navigation_digest === null ? {}
      : { hint: results[1]!.navigation_digest })
  };
  return {
    result: { ...base, completion, nominations: membership.nominations, accounting, resources,
      resource_refusals: results.flatMap(row => row.resource_refusals),
      limitations: [...new Set(results.flatMap(row => row.limitations))] },
    witness: membership.witness,
    ...(captures[0]?.question_time_order === undefined ? {} : { question_time_order:
      captures[0].question_time_order.filter(key => membership.nominations.some(row => sourceIndexNativeRootKey(row.source) === key)) }),
    ...(captures[0]?.task_observations === undefined ? {} : { task_observations: captures[0].task_observations.filter(
      observation => membership.nominations.some(row => sourceGoldRootIdentity(row.source.target)
        === sourceGoldRootIdentity(observation.observation.source))) }),
    ...(captures[0]?.association === undefined ? {} : { association: restrictStatementAssociation(captures[0].association,
      key => membership.nominations.some(row => sourceIndexNativeRootKey(row.source) === key)) }),
    ...(digests.original === null ? {} : { navigation_digests: { original: digests.original,
      ...(digests.hint === undefined ? {} : { hint: digests.hint }) } }),
    ...(options?.catalog_positions === undefined ? {} : { catalog_positions: options.catalog_positions }),
    ...(options?.charged_by_caller === true ? { charged_by_caller: true as const } : {})
  };
}

export function createConditionalFieldObserverReaders(database: StorageDatabase, permittedTimelessPolicyIds: readonly string[] = [],
  queryVector: SourceIndexQueryVector = { status: "unavailable", reason: "embedding_preparation_unwired" },
  observer?: SourceSemanticObserver, acquisitionFunding: AcquisitionFunding = "allowance", evidence?: PreparedEvidence): ObserverReaders {
  const memory = new SqliteMemoryRecallReader(database);
  const relation = new SqliteRelationRecallReader(database);
  const projection = new SqliteIndexedRecallProjection(database.connection);
  const sourceRoots = new SqliteSourceRootRecallReader(
    new SqliteFieldSourceRecordRepo(database, fieldContractSha256),
    new SqliteEvidenceCapsuleRepo(database)
  );
  const kindsSql = database.connection.prepare(
    `SELECT relation_kind AS kind FROM relation_assertions
     WHERE workspace_id = ? AND relation_kind > ? ORDER BY relation_kind LIMIT 1`
  );
  return {
    permittedTimelessPolicyIds: () => permittedTimelessPolicyIds,
    sourceDependencies: input => readSourceDependencyDelivery(new SqliteSourceIndexRepository(database, fieldContractSha256), input),
    nominateSources: input => nominateNativeSources(database, input, queryVector, observer, acquisitionFunding, evidence),
    lexical: (input) => memory.lexical(
      input.workspaceId,
      input.query,
      input.limit,
      input.nativeLimit,
      input.afterObjectId
    ),
    source: (input) => {
      const page = memory.source(
        input.workspaceId,
        input.objectId,
        input.byteLimit ?? 65536
      );
      return {
        row: page.row === null ? null : toSourceObserverRow(page.row),
        rowsRead: page.rowsRead,
        bytesRead: page.bytesRead,
        unavailable: page.unavailable,
        resourceLimited: page.resourceLimited
      };
    },
    sourceRootMetadataByteLimit: 8192,
    sourceRootChunkByteLimit: 4096,
    sourceRoots: (input) => {
      const page = sourceRoots.page({
        workspaceId: input.workspaceId,
        query: input.query,
        limit: input.limit,
        nativeLimit: input.nativeLimit,
        workLimit: input.workLimit,
        afterCursor: input.afterCursor,
        byteLimit: input.byteLimit,
        nativeByteLimit: input.nativeByteLimit
      });
      return {
        rows: page.rows.map(toSourceRootObserverRow),
        nativeVisits: page.nativeVisits,
        nativeBytes: page.nativeBytes,
        rowsRead: page.rowsRead,
        bytesRead: page.bytesRead,
        metadataBytes: page.metadataBytes,
        nativeWork: page.nativeWork,
        truncated: page.truncated,
        committedThrough: page.committedThrough,
        unavailable: page.unavailable
      };
    },
    sourceRoot: (input) => {
      if (input.revision === undefined || input.digest === undefined) {
        return { row: null, rowsRead: 0, bytesRead: 0, unavailable: true };
      }
      const page = sourceRoots.hydrate(
        input.workspaceId,
        sourceRecallTarget({
          workspace_id: input.workspaceId,
          root_kind: input.rootKind,
          root_id: input.rootId,
          source_version: input.revision,
          content_digest: input.digest,
          evidence_object_id: input.evidenceObjectId ?? (input.rootKind === "evidence_capsule" ? input.rootId : null)
        }),
        input.byteLimit ?? 65536,
        input.offset ?? 0,
        // 12288 is the retained chunk+metadata reservation; logical clip is separate.
        input.nativeByteLimit ?? Math.max(input.byteLimit ?? 65536, 12_288),
        input.workLimit,
        input.purpose === "payload",
        input.firstDeliveryUnit === true
      );
      return {
        row: page.row === null ? null : toSourceRootObserverRow(page.row),
        rowsRead: page.rowsRead,
        bytesRead: page.bytesRead,
        metadataBytes: page.metadataBytes,
        nativeWork: page.nativeWork,
        unavailable: page.unavailable,
        resourceLimited: page.resourceLimited
      };
    },
    relation: (input) => relation.read(
      input.workspaceId,
      input.subject,
      input.predicate,
      input.limit,
      input.nativeLimit,
      input.afterAssertionId,
      input.asOf
    ),
    relationKinds: (input) => {
      const kinds: string[] = [];
      for (let i = 0; i < Math.min(512, input.limit ?? 32); i += 1) {
        const row = kindsSql.get(input.workspaceId, kinds.at(-1) ?? "") as { readonly kind: string } | undefined;
        if (row === undefined) break;
        kinds.push(row.kind);
      }
      return kinds;
    },
    snapshotPin: (workspaceId) => projection.observablePin(workspaceId),
    ...storedMeasurementReaders(database)
  };
}

function readersFor(runtime: RecallReadWorkerRuntime): ObserverReaders {
  const existing = readersByRuntime.get(runtime);
  if (existing !== undefined) return existing;
  const created = createConditionalFieldObserverReaders(runtime.database);
  readersByRuntime.set(runtime, created);
  return created;
}
