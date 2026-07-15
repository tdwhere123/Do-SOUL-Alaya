import {
  BoundedJsonObjectSchema,
  ManifestationBudgetEvaluatedPayloadSchema,
  ManifestationEscalationDecidedPayloadSchema,
  ManifestationLevel,
  RuntimeGovernanceEventType,
  type ManifestationDecision
} from "@do-soul/alaya-protocol";
import { countAssigned } from "./manifestation-resolver-helpers.js";
import type { ManifestationResolverEventLogWriterPort } from "./manifestation-resolver-types.js";

type AppendManifestationEventsInput = Readonly<{
  eventLogWriter: ManifestationResolverEventLogWriterPort;
  workspaceId: string;
  runId: string;
  decisions: readonly Readonly<ManifestationDecision>[];
  decidedAt: string;
}>;

type DecisionEventItem = Readonly<{
  candidate_id: string;
  assigned_level: ManifestationDecision["assigned_level"];
  reason: string;
}>;

// Wide placeholders so a later real batch_index/batch_count stamp cannot
// push a previously-accepted batch over the bounded JSON limit.
const BATCH_FIT_PROBE_INDEX = 999_999;
const BATCH_FIT_PROBE_COUNT = 1_000_000;

export async function appendManifestationGovernanceEvents(
  input: AppendManifestationEventsInput
): Promise<void> {
  const entries = [{
    event_type: RuntimeGovernanceEventType.MANIFESTATION_BUDGET_EVALUATED,
    entity_type: "manifestation_budget",
    entity_id: input.runId,
    workspace_id: input.workspaceId,
    run_id: input.runId,
    caused_by: "deterministic_rule",
    payload_json: createBudgetPayload(input)
  }, ...createBoundedDecisionPayloads(input).map((payload) => ({
      event_type: RuntimeGovernanceEventType.MANIFESTATION_ESCALATION_DECIDED,
      entity_type: "manifestation_decision_batch",
      entity_id: input.runId,
      workspace_id: input.workspaceId,
      run_id: input.runId,
      caused_by: "deterministic_rule",
      payload_json: payload
  }))] as const;
  await input.eventLogWriter.appendAtomically(entries);
}

function createBudgetPayload(input: AppendManifestationEventsInput) {
  return ManifestationBudgetEvaluatedPayloadSchema.parse({
    workspace_id: input.workspaceId,
    run_id: input.runId,
    total_candidates: input.decisions.length,
    stance_bias_assigned: countAssigned(input.decisions, ManifestationLevel.STANCE_BIAS),
    dialogue_nudge_assigned: countAssigned(input.decisions, ManifestationLevel.DIALOGUE_NUDGE),
    lens_entry_assigned: countAssigned(input.decisions, ManifestationLevel.LENS_ENTRY),
    discarded: input.decisions.filter((decision) => decision.assigned_level === null).length,
    evaluated_at: input.decidedAt
  });
}

function createBoundedDecisionPayloads(input: AppendManifestationEventsInput) {
  const batches: DecisionEventItem[][] = [];
  let batch: DecisionEventItem[] = [];
  for (const decision of input.decisions) {
    const nextBatch = [...batch, toDecisionEventItem(decision)];
    if (fitsDecisionBatch(input, nextBatch)) {
      batch = nextBatch;
      continue;
    }
    batches.push(batch);
    batch = [toDecisionEventItem(decision)];
  }
  if (batch.length > 0) {
    batches.push(batch);
  }
  const batchCount = batches.length;
  return Object.freeze(
    batches.map((items, batchIndex) =>
      BoundedJsonObjectSchema.parse(
        createDecisionPayload(input, items, batchIndex, batchCount)
      )
    )
  );
}

function fitsDecisionBatch(
  input: AppendManifestationEventsInput,
  decisions: readonly DecisionEventItem[]
): boolean {
  return BoundedJsonObjectSchema.safeParse(
    createDecisionPayload(input, decisions, BATCH_FIT_PROBE_INDEX, BATCH_FIT_PROBE_COUNT)
  ).success;
}

function createDecisionPayload(
  input: AppendManifestationEventsInput,
  decisions: readonly DecisionEventItem[],
  batchIndex: number,
  batchCount: number
) {
  return ManifestationEscalationDecidedPayloadSchema.parse({
    workspace_id: input.workspaceId,
    run_id: input.runId,
    decisions,
    decided_at: input.decidedAt,
    batch_index: batchIndex,
    batch_count: batchCount
  });
}

function toDecisionEventItem(decision: Readonly<ManifestationDecision>): DecisionEventItem {
  return Object.freeze({
    candidate_id: decision.candidate_id,
    assigned_level: decision.assigned_level,
    reason: decision.reason
  });
}
