import { SourceSemanticResourceLedger, sourceEvidenceRootTarget, type InformationIndex,
  type QueryInterpretation, type RequestBudget } from "@do-soul/alaya-protocol";
import type { FieldEngineState } from "../conditional-field/engine/field-engine.js";
import { payloadExpansionCompleteness, uniformCompleteness } from "../conditional-field/completeness-report.js";
import type { ConditionalFieldRecallRequest } from "./recall-service-runner-types.js";
import type { RequestCostLedger } from "./request-cost-ledger.js";
import { annotatePublicIndex, invalidatedPublicIndex } from "./recall-field-projection.js";
import { fitProjectedRecallPage, framingInterruption, pageResourceRefusal } from "./recall-page-fit.js";
import { deliveredPayloadEntry, recallDeliveryIdentity, replayIssuedDelivery,
  revisionRetentionBytes, sealRetainedContinuation } from "./index-continuation.js";
import { restoredFieldFootprint } from "./request-cost-engine-snapshot.js";
import { nextContinuation } from "../conditional-field/index/project-accepting-continuation.js";
import type { ObserveFieldInput } from "./conditional-field-observe.js";
import { CoreError } from "../../shared/errors.js";
import type { SupportWorkBlock } from "./semantic-attribution.js";

export type RecallObservationWorkBlock = Parameters<NonNullable<ObserveFieldInput["on_atomic_work_block"]>>[0] | SupportWorkBlock;

export type RecallProgressDelivery = ReturnType<typeof recallDeliveryIdentity> & Readonly<{
  /** A fully fitted immutable response, not a sizing estimate or a free fallback. */
  control?: InformationIndex;
  spent_work: number;
  spent_memory: number;
  retention_hold: number;
  control_generation?: number;
  /** Observer-owned progress made before projection on this request. */
  observation_advanced?: boolean;
  execution_work_limit?: number;
  /** Present only when the fresh request cannot fund the blocked atomic operation. */
  refuse_idle_observation?: () => never;
}>;

/** Keep an unaffordable observation separate from still-useful projection work.
 * The projection commit owner invokes refusal only if that work cannot advance. */
export function observedRecallProgressDelivery(prepared: RecallProgressDelivery, field: FieldEngineState,
  observed: Readonly<{ block?: RecallObservationWorkBlock;
    advanced: boolean; fresh_exploration: number; fresh_execution: number }>): RecallProgressDelivery {
  const block = observed.block;
  return { ...prepared, observation_advanced: observed.advanced, execution_work_limit: observed.fresh_execution,
    ...(block !== undefined && block.required_exploration_work > observed.fresh_exploration ? {
      refuse_idle_observation: (): never => {
        throw new CoreError("CONFLICT", "Recall work budget cannot fund its next atomic operation", {
          details: { outcome: "resource_exhausted", resource: block.phase === "support" ? "support_work" : "observation_work", phase: block.phase,
            required_work: block.required_exploration_work, available_work: observed.fresh_exploration,
            remaining_work: block.available_exploration_work, residuals: field.residuals }
        });
      }
    } : {}) };
}

/** Pay for a bounded progress response before observation/solve can exhaust work.
 * Its token acknowledges the retained server state, not membership or a client
 * copy of the emitted ledger. The response remains unchanged if later computation
 * uses all remaining work; only acknowledgment commits that computation. */
export function prepareRecallProgressDelivery(input: ConditionalFieldRecallRequest,
  interpretation: QueryInterpretation, restored: FieldEngineState | undefined,
  cost: RequestCostLedger): RecallProgressDelivery {
  const identity = recallDeliveryIdentity(input, interpretation);
  const skipped = { ...identity, spent_work: 0, spent_memory: 0, retention_hold: 0 };
  if (input.cancelled || replayIssuedDelivery(identity.request_digest) !== undefined) return skipped;
  const generation = (restored?.projection_progress?.generation ?? 0) + 1;
  const control = input.payload_continuation === undefined
    ? membershipControl(input, interpretation, restored, generation)
    : payloadControl(input, identity.query_key);
  if (control === undefined) return skipped;
  const prior = restored?.projection_progress;
  const retention = input.payload_continuation === undefined
    ? revisionRetentionBytes(prior?.delivered_entries ?? {}, prior?.delivered_entries ?? {}, prior === undefined) : 0;
  const meter = new SourceSemanticResourceLedger({ work_units: input.budget.work_units,
    memory_bytes: Math.max(0, input.budget.memory_bytes - (restored === undefined ? 0 : restoredFieldFootprint(restored)) - retention) });
  let fitted;
  try {
    fitted = cost.time("index", () => fitProjectedRecallPage({ index: control, previews: new Map(), metadata: {},
      request: input, request_digest: identity.request_digest, meter }));
  } finally {
    cost.add("index", { budget_work: meter.spentWork, charged_retained_bytes: meter.spentBytes });
    cost.addFieldBudgetWork(meter.spentWork);
  }
  if (fitted.interruption !== undefined) throw framingInterruption(fitted.interruption, fitted.observation);
  if (!fitted.fits) throw pageResourceRefusal({ message: "Recall output budget cannot carry its required public envelope",
    fit: fitted.observation });
  return { ...identity, control: fitted.index, spent_work: meter.spentWork,
    spent_memory: meter.spentBytes, retention_hold: retention, control_generation: generation };
}

/** This is the remaining execution allowance, not a replacement requested policy.
 * The compiler/receipt retain the sent budget. Both fresh and resumed solvers see
 * only the balance after the already-performed fit and its uncommitted retention. */
export function progressExecutionBudget(budget: RequestBudget, prepared: RecallProgressDelivery): RequestBudget {
  const work = Math.max(0, budget.work_units - prepared.spent_work);
  // Framing already paid from this request's finalization obligation. Keeping
  // the full original reserve as well would subtract the same protected work
  // from exploration twice and trap small, otherwise serviceable continuations.
  return { ...budget, work_units: work,
    finalization_reserve: Math.min(Math.max(0, budget.finalization_reserve - prepared.spent_work), work),
    memory_bytes: Math.max(0, budget.memory_bytes - prepared.spent_memory - prepared.retention_hold) };
}

function membershipControl(input: ConditionalFieldRecallRequest, interpretation: QueryInterpretation,
  restored: FieldEngineState | undefined, generation: number): InformationIndex {
  const prior = restored?.projection_progress;
  const index = invalidatedPublicIndex(interpretation, input);
  const snapshot = restored?.binding.kind === "bound" ? restored.binding.snapshot
    : { schema_version: 1 as const, query_id: index.query_id, snapshot_id: index.snapshot_id,
      seeds: [], values: [], retained_transitions: [], facets: [] };
  // The cursor describes the last acknowledged projection frontier. New
  // computation belongs to the retained field, never to client-authored offsets.
  const continuation = nextContinuation({ snapshot, query_id: index.query_id, snapshot_id: index.snapshot_id,
    result_version: index.result_version, view: interpretation.view, budget: input.budget,
    expires_at: input.expires_at, authorized_scopes: input.authorized_scopes,
    grounding_progress: restored?.grounding_progress, projection_generation: generation,
    interpretation_id: index.interpretation_id, delivered_product_ids: new Set(Object.keys(prior?.delivered_entries ?? {}))
  }, 1, 0, [], prior?.offset ?? 0, prior?.delivered_entries ?? {}, true)!;
  return annotatePublicIndex({ ...index, completeness: { ...uniformCompleteness("interrupted"),
    interpretation_coverage: undefined }, page_purpose: "membership", explanations: [],
    representation: { ...index.representation, page_budget: 0 },
    continuation: sealRetainedContinuation(continuation) }, interpretation);
}

function payloadControl(input: ConditionalFieldRecallRequest, queryKey: string): InformationIndex | undefined {
  if (input.payload_continuation === undefined) return undefined;
  const delivered = deliveredPayloadEntry(queryKey, input.payload_continuation.target);
  if (delivered === undefined) return undefined;
  return { ...delivered.index, entries: [{ ...delivered.entry, target: delivered.entry.target.kind === "source_evidence"
    ? sourceEvidenceRootTarget(delivered.entry.target) : delivered.entry.target }],
    continuation: input.continuation ?? null, page_purpose: "payload", product_updates: [],
    completeness: payloadExpansionCompleteness(delivered.index.completeness, "interrupted", "interrupted") };
}
