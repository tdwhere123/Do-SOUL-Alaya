import type { RecallPolicy } from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "../../../shared/field-hash.js";
import { resolvePreparedAnswerShapePlan } from "../../query/recall-answer-shape-plan.js";
import { compileRecallQueryProbes } from "../../query/recall-query-probes.js";
import { extendQueryProbesWithOpenSemanticFactors } from
  "../../query/query-factor-expanded-terms.js";
import { captureRecallQueryEntities } from
  "../../field/query-entity-attribution-producer.js";
import { createRecallRetrievalFieldBundle } from
  "../../field/retrieval/retrieval-field-bundle.js";
import { errorNameOf, normalizeQueryText, toErrorMessage } from
  "../recall-service-helpers.js";
import type { RecallServiceDependencies } from "../recall-service-types.js";
import { makeTokenEstimator } from "../recall-service-types.js";
import type {
  PreparedRecallRequest,
  RecallExecutionContext,
  RecallExecutionParams
} from "../recall-service-runner-types.js";
import { loadActiveConstraints, resolvePolicy } from "../orchestration.js";
import { capturePreparedRequestCondition } from "./prepare-recall-query-condition.js";
import { startProjectionPinLeaseGuard } from "./projection-pin-lease.js";
import type { ProjectionPinLeaseGuard } from "./projection-pin-lease.js";

export async function prepareRecallRequest(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  time: PreparedRecallRequest["time"]
): Promise<PreparedRecallRequest> {
  const seed = prepareQuerySeed(context, params, time);
  const captured = capturePreparedRequestCondition({
    workspaceId: params.workspaceId,
    explicitAsOf: params.referenceTime,
    queryText: seed.queryText,
    tokenBudget: seed.policy.fine_assessment.budgets.max_total_tokens,
    activationBudget: seed.policy.fine_assessment.budgets.max_entries,
    sha256: context.sha256,
    time,
    session: context.fieldQuerySession,
    semanticCapture: params.querySemanticFactorFormationCapture
  });
  const releaseProjectionPin = projectionPinReleaseHandle(context, captured.pin, time);
  let projectionPinLease: ProjectionPinLeaseGuard | null = null;
  try {
    const fieldSelection = context.fieldQuerySession.selectCandidates(
      captured.receipt,
      captured.pin,
      time.captureOperationalTime()
    );
    projectionPinLease = startProjectionPinLeaseGuard({
      session: context.fieldQuerySession,
      pin: captured.pin,
      captureOperationalTime: time.captureOperationalTime
    });
    const loaded = await loadPreparationInputs(
      context,
      params,
      seed,
      fieldSelection.candidate_keys,
      captured.referenceTime
    );
    return Object.freeze({
      ...seed,
      ...loaded,
      time,
      referenceTime: captured.referenceTime,
      temporalProjectionAsOf: captured.referenceTime,
      queryCondition: captured.receipt,
      fieldProjectionSelection: fieldSelection,
      projectionPin: captured.pin,
      projectionPinLease,
      releaseProjectionPin
    });
  } catch (error) {
    try {
      projectionPinLease?.stop();
    } finally {
      releaseProjectionPin();
    }
    throw error;
  }
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
  time: PreparedRecallRequest["time"]
) {
  const policy = resolvePolicy({
    strategy: params.strategy,
    taskSurfaceRef: params.taskSurface.runtime_id,
    policyOverride: params.policyOverride,
    buildDefaultPolicy: (strategy, taskSurfaceRef) =>
      context.buildDefaultPolicy(strategy, taskSurfaceRef, time.capturedAt),
    defaultPolicyDecorator: context.dependencies.defaultPolicyDecorator
  });
  const queryText = normalizeQueryText(params.taskSurface.display_name);
  const queryProbes = extendQueryProbesWithOpenSemanticFactors(
    compileRecallQueryProbes(queryText),
    params.querySemanticFactorFormationCapture
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
  return Object.freeze(await dependencies.memoryRepo.findByEvidenceRefs(
    workspaceId,
    evidenceObjectIds
  ));
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
