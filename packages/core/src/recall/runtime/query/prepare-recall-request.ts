import type { RecallPolicy } from "@do-soul/alaya-protocol";
import {
  compileRecallAnswerShapePlan,
  resolvePreparedAnswerShapePlan
} from "../../query/recall-answer-shape-plan.js";
import { compileRecallQueryDemand } from "../../query/recall-query-demand.js";
import { compileRecallQueryProbes } from "../../query/recall-query-probes.js";
import { extendQueryProbesWithOpenSemanticFactors } from
  "../../query/query-factor-expanded-terms.js";
import { captureRecallQueryFactFrames } from
  "../../field/query-attribution/query-fact-frame-attribution-producer.js";
import { deriveQueryFactFrameOsfObligation } from
  "../../field/open-semantic-factors/query-obligation.js";
import { captureCertifiedRecallQueryOpenSemanticFactors } from
  "../../field/open-semantic-factors/query-capture.js";
import { captureRecallQueryEntities } from
  "../../field/query-entity-attribution-producer.js";
import { createRecallRetrievalFieldBundle } from
  "../../field/retrieval/retrieval-field-bundle.js";
import { errorNameOf, normalizeQueryText, toErrorMessage } from
  "../recall-service-helpers.js";
import type { RecallServiceDependencies } from "../recall-service-types.js";
import { makeTokenEstimator } from "../recall-service-types.js";
import {
  type PreparedRecallRequest,
  type RecallExecutionContext,
  type RecallExecutionParams
} from "../recall-service-runner-types.js";
import { loadActiveConstraints, resolvePolicy } from "../orchestration.js";
import { capturePreparedRequestCondition } from "./prepare-recall-query-condition.js";
import {
  finishProjectionPinCleanup,
  startProjectionPinLeaseGuard
} from "./projection-pin-lease.js";
import type { ProjectionPinLeaseGuard } from "./projection-pin-lease.js";
import {
  PREPARE_RETRIEVAL_CHANNEL_OWNERS,
  capturePreparedSnapshotVector,
  createSnapshotCoherenceReceiptV1,
  finalizePreparedSnapshotReadLease
} from "../snapshot-coherence/index.js";
import {
  compileCanonicalQueryCompilation,
  verifyCanonicalQueryCompilationV1
} from "../../query/canonical-query/index.js";
import { deepFreeze } from "../../../shared/deep-freeze.js";

export async function prepareRecallRequest(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  time: PreparedRecallRequest["time"]
): Promise<PreparedRecallRequest> {
  const queryText = normalizeQueryText(params.taskSurface.display_name);
  const certified = await certifyPreparedSemanticCapture(context, params, queryText);
  const semanticCapture = certified?.formation;
  const seed = prepareQuerySeed(context, params, time, queryText, semanticCapture);
  const captured = capturePreparedRequestCondition({
    workspaceId: params.workspaceId,
    explicitAsOf: params.referenceTime,
    queryText: seed.queryText,
    tokenBudget: seed.policy.fine_assessment.budgets.max_total_tokens,
    activationBudget: seed.policy.fine_assessment.budgets.max_entries,
    sha256: context.sha256,
    time,
    session: context.fieldQuerySession,
    semanticCapture
  });
  const releaseProjectionPin = projectionPinReleaseHandle(context, captured.pin, time);
  return await loadPinnedPreparedRequest({
    context, params, time, seed, captured, certified, releaseProjectionPin
  });
}

async function loadPinnedPreparedRequest(input: Readonly<{
  context: RecallExecutionContext;
  params: RecallExecutionParams;
  time: PreparedRecallRequest["time"];
  seed: ReturnType<typeof prepareQuerySeed>;
  captured: ReturnType<typeof capturePreparedRequestCondition>;
  certified: Awaited<ReturnType<typeof certifyPreparedSemanticCapture>>;
  releaseProjectionPin: () => void;
}>): Promise<PreparedRecallRequest> {
  const { context, params, time, seed, captured, certified, releaseProjectionPin } = input;
  let projectionPinLease: ProjectionPinLeaseGuard | null = null;
  try {
    projectionPinLease = startProjectionPinLeaseGuard({
      session: context.fieldQuerySession,
      pin: captured.pin,
      captureOperationalTime: time.captureOperationalTime,
      scheduler: context.projectionPinHeartbeatScheduler
    });
    const fieldSelection = context.fieldQuerySession.selectCandidates(
      captured.receipt,
      captured.pin,
      time.captureOperationalTime()
    );
    projectionPinLease.assertHealthy();
    const world = capturePinnedQueryWorld(
      captured, params, certified, seed.queryText, fieldSelection.candidate_keys
    );
    projectionPinLease.assertHealthy();
    const loaded = await loadPreparationInputs(
      context,
      params,
      seed,
      fieldSelection.candidate_keys,
      captured.referenceTime
    );
    return freezePreparedRequest({
      seed, loaded, time, captured, fieldSelection, projectionPinLease,
      releaseProjectionPin, certified, world
    });
  } catch (error) {
    cleanupFailedPreparation({ context, projectionPinLease,
      releaseProjectionPin, error });
  }
}

function capturePinnedQueryWorld(
  captured: ReturnType<typeof capturePreparedRequestCondition>,
  params: RecallExecutionParams,
  certified: Awaited<ReturnType<typeof certifyPreparedSemanticCapture>>,
  queryText: string | null,
  observableObjectIds: readonly string[]
) {
  const snapshotVector = capturePreparedSnapshotVector({
    queryCondition: captured.receipt,
    pin: captured.pin,
    snapshotDigest: params.snapshotDigest,
    retrieval_channel_owners: PREPARE_RETRIEVAL_CHANNEL_OWNERS,
    formation_operator_versions: declaredFormationVersions(certified)
  });
  const snapshotReadLease = finalizePreparedSnapshotReadLease(snapshotVector);
  const snapshotCoherenceReceipt = createSnapshotCoherenceReceiptV1(snapshotVector);
  const baseProbes = compileRecallQueryProbes(queryText);
  const canonicalQueryEvidence = deepFreeze({
    probes: baseProbes,
    demand: compileRecallQueryDemand(baseProbes),
    shape: compileRecallAnswerShapePlan(baseProbes),
    factFrameCapture: certified?.factFrameCapture,
    osfCapture: certified?.formation,
    observer: observerFromPinnedObjects(captured.receipt, observableObjectIds),
    query_identity: queryIdentityFromReceipt(captured.receipt)
  });
  const canonicalQueryCompilation = compileCanonicalQueryCompilation(
    canonicalQueryEvidence,
    snapshotCoherenceReceipt
  );
  verifyCanonicalQueryCompilationV1(
    canonicalQueryCompilation,
    canonicalQueryEvidence,
    snapshotCoherenceReceipt
  );
  return {
    snapshotVector,
    snapshotCoherenceReceipt,
    snapshotReadLease,
    canonicalQueryEvidence,
    canonicalQueryCompilation
  };
}

function observerFromPinnedObjects(
  receipt: PreparedRecallRequest["queryCondition"],
  objectIds: readonly string[]
) {
  const observer_universe = uniqueObserverIds(objectIds);
  // Empty pin-view is not a finite authorized observable set.
  if (observer_universe.length === 0) return undefined;
  const condition = receipt.condition;
  return {
    principal: condition.principal,
    scope: condition.authorized_scopes[0] ?? condition.workspace_id,
    observer_universe
  };
}

function uniqueObserverIds(objectIds: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const id of objectIds) {
    if (id.length === 0 || id.trim() !== id || seen.has(id)) {
      return Object.freeze([]);
    }
    seen.add(id);
    ids.push(id);
  }
  return Object.freeze(ids.sort((left, right) => left.localeCompare(right)));
}

function queryIdentityFromReceipt(
  receipt: PreparedRecallRequest["queryCondition"]
) {
  return {
    condition_identity: receipt.identity,
    query_operator_id: receipt.query_operator_id,
    generation_id: receipt.generation_id,
    query_cache_key: receipt.query_cache_key
  };
}

function declaredFormationVersions(
  certified: Awaited<ReturnType<typeof certifyPreparedSemanticCapture>>
): readonly (readonly [string, string])[] {
  if (certified === undefined) return [];
  const rows = new Map<string, string>();
  addFormationVersion(rows, certified.factFrameCapture.producer_operator_id,
    certified.factFrameCapture.schema_version);
  addFormationVersion(rows, certified.formation.producer_operator_id,
    certified.formation.schema_version);
  return Object.freeze([...rows.entries()].map(([id, version]) =>
    Object.freeze([id, version] as const)));
}

function addFormationVersion(
  rows: Map<string, string>,
  operatorId: string | null | undefined,
  schemaVersion: number | undefined
): void {
  if (operatorId === null || operatorId === undefined || operatorId.length === 0) return;
  rows.set(operatorId, String(schemaVersion ?? 1));
}

function freezePreparedRequest(input: Readonly<{
  seed: ReturnType<typeof prepareQuerySeed>;
  loaded: Awaited<ReturnType<typeof loadPreparationInputs>>;
  time: PreparedRecallRequest["time"];
  captured: ReturnType<typeof capturePreparedRequestCondition>;
  fieldSelection: PreparedRecallRequest["fieldProjectionSelection"];
  projectionPinLease: ProjectionPinLeaseGuard;
  releaseProjectionPin: () => void;
  certified: Awaited<ReturnType<typeof certifyPreparedSemanticCapture>>;
  world: ReturnType<typeof capturePinnedQueryWorld>;
}>): PreparedRecallRequest {
  return Object.freeze({
    ...input.seed,
    ...input.loaded,
    time: input.time,
    referenceTime: input.captured.referenceTime,
    temporalProjectionAsOf: input.captured.referenceTime,
    queryCondition: input.captured.receipt,
    fieldProjectionSelection: input.fieldSelection,
    projectionPin: input.captured.pin,
    projectionPinLease: input.projectionPinLease,
    releaseProjectionPin: input.releaseProjectionPin,
    querySemanticFactorFormationCapture: input.certified?.formation,
    querySemanticFactorCompletenessReceipt: input.certified === undefined
      ? undefined
      : input.certified.receipt,
    snapshotVector: input.world.snapshotVector,
    snapshotCoherenceReceipt: input.world.snapshotCoherenceReceipt,
    snapshotReadLease: input.world.snapshotReadLease,
    canonicalQueryEvidence: input.world.canonicalQueryEvidence,
    canonicalQueryCompilation: input.world.canonicalQueryCompilation
  });
}

function cleanupFailedPreparation(input: Readonly<{
  context: RecallExecutionContext;
  projectionPinLease: ProjectionPinLeaseGuard | null;
  releaseProjectionPin: () => void;
  error: unknown;
}>): never {
  try {
    finishProjectionPinCleanup([
      () => input.projectionPinLease?.stop(), input.releaseProjectionPin
    ], input.context.warn);
  } catch (cleanupError) {
    const message = input.error instanceof Error
      ? input.error.message : String(input.error);
    throw new AggregateError(
      [input.error, cleanupError], `recall preparation failed: ${message}`,
      { cause: input.error }
    );
  }
  throw input.error;
}

function projectionPinReleaseHandle(
  context: RecallExecutionContext,
  pin: PreparedRecallRequest["projectionPin"],
  time: PreparedRecallRequest["time"]
): () => void {
  let released = false;
  return () => {
    if (released) return;
    context.fieldQuerySession.release(pin, time.captureOperationalTime());
    released = true;
  };
}

function prepareQuerySeed(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  time: PreparedRecallRequest["time"],
  queryText: string | null,
  semanticCapture: Readonly<
    import("@do-soul/alaya-protocol").OpenSemanticFactorFormationCapture
  > | undefined
) {
  const policy = resolvePolicy({
    strategy: params.strategy,
    taskSurfaceRef: params.taskSurface.runtime_id,
    policyOverride: params.policyOverride,
    buildDefaultPolicy: (strategy, taskSurfaceRef) =>
      context.buildDefaultPolicy(strategy, taskSurfaceRef, time.capturedAt),
    defaultPolicyDecorator: context.dependencies.defaultPolicyDecorator
  });
  const queryProbes = extendQueryProbesWithOpenSemanticFactors(
    compileRecallQueryProbes(queryText), semanticCapture
  );
  return Object.freeze({
    policy,
    tokenEstimator: makeTokenEstimator({ hint: params.hostContext?.tokenizer_hint }),
    queryText,
    queryProbes,
    answerShapePlan: resolvePreparedAnswerShapePlan(queryProbes),
    retrievalFieldBundle: createRetrievalBundle(context, params, policy, queryText)
  });
}

async function certifyPreparedSemanticCapture(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  queryText: string | null
) {
  if (queryText === null) return undefined;
  const factFrameCapture = await captureRecallQueryFactFrames({
    query_text: queryText,
    port: context.dependencies.queryFactFrameExtractionPort
  });
  const obligation = deriveQueryFactFrameOsfObligation({
    query_text: queryText, fact_frame_capture: factFrameCapture
  });
  const osf = await captureCertifiedRecallQueryOpenSemanticFactors({
    query_text: queryText,
    obligation,
    port: context.dependencies.openSemanticFactorExtractionPort,
    prepared_capture: params.querySemanticFactorFormationCapture,
    prepared_receipt: params.querySemanticFactorCompletenessReceipt,
    on_failure: (error) => context.warn("query open semantic factor extraction failed", {
      workspace_id: params.workspaceId,
      operation: "query_open_semantic_factor_extraction",
      errorName: errorNameOf(error),
      error: toErrorMessage(error)
    })
  });
  return {
    ...osf,
    factFrameCapture
  };
}

async function loadPreparationInputs(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  seed: ReturnType<typeof prepareQuerySeed>,
  fieldEvidenceIds: readonly string[],
  referenceTime: string
) {
  const [slots, activeConstraints, queryEntityExtraction, fieldProjectionMemories] =
    await Promise.all([
      context.dependencies.slotRepo.findByWorkspace(params.workspaceId),
      loadActiveConstraints({
        activeConstraintsPort: context.dependencies.activeConstraintsPort,
        warn: context.warn,
        workspaceId: params.workspaceId,
        cap: params.activeConstraintsCap ?? null,
        asOf: referenceTime
      }),
      captureRecallQueryEntities({
        query_text: seed.queryText,
        port: context.dependencies.entityExtractionPort,
        on_failure: (error) => context.warn("entity extraction failed", {
          workspace_id: params.workspaceId,
          operation: "entity_extraction",
          errorName: errorNameOf(error),
          error: toErrorMessage(error)
        })
      }),
      resolveFieldProjectionMemories(context.dependencies, params.workspaceId, fieldEvidenceIds)
    ]);
  return Object.freeze({
    activeConstraints,
    queryEntityExtraction,
    fieldProjectionMemories,
    winnerMemoryIds: await resolveWinnerMemoryIds(context, params.workspaceId, slots)
  });
}

function createRetrievalBundle(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  policy: Readonly<RecallPolicy>,
  queryText: string | null
) {
  return createRecallRetrievalFieldBundle({
    workspaceId: params.workspaceId,
    queryText,
    memoryRepo: context.dependencies.memoryRepo,
    evidenceSearchPort: context.dependencies.evidenceSearchPort,
    synthesisSearchPort: context.dependencies.synthesisSearchPort,
    refinementMaxDepth: policy.coarse_filter.semantic_supplement.field_observation_max_depth,
    captureProof: true,
    onFailure: (operation, error) => context.warn("retrieval field query failed", {
      workspace_id: params.workspaceId,
      operation,
      error: toErrorMessage(error)
    }),
    onBatchFailure: (operation, failure) => context.warn(
      "retrieval field batch query failed; using scalar field queries",
      { workspace_id: params.workspaceId, operation, ...failure }
    )
  });
}

async function resolveFieldProjectionMemories(
  dependencies: RecallServiceDependencies,
  workspaceId: string,
  evidenceObjectIds: readonly string[]
) {
  if (evidenceObjectIds.length === 0) return Object.freeze([]);
  if (dependencies.memoryRepo.findByEvidenceRefs === undefined) {
    throw new Error("field projection candidates require evidence-bound memory lookup");
  }
  const loaded = await dependencies.memoryRepo.findByEvidenceRefs(
    workspaceId,
    evidenceObjectIds
  );
  return Object.freeze(loaded.map((entry) => deepFreeze(structuredClone(entry))));
}

async function resolveWinnerMemoryIds(
  context: RecallExecutionContext,
  workspaceId: string,
  slots: Awaited<ReturnType<RecallServiceDependencies["slotRepo"]["findByWorkspace"]>>
): Promise<ReadonlySet<string>> {
  const winnerClaimIds = new Set(slots.flatMap((slot) =>
    slot.winner_claim_id === null ? [] : [slot.winner_claim_id]));
  if (winnerClaimIds.size === 0 || context.dependencies.claimResolverPort === undefined) {
    return new Set();
  }
  const claims = await context.dependencies.claimResolverPort.findByIds(
    workspaceId,
    [...winnerClaimIds]
  );
  return new Set(claims.flatMap((claim) => claim.source_object_refs)
    .filter((ref): ref is string => ref !== undefined));
}
