import {
  FieldStopCertificateReceiptSchema,
  RECALL_FIELD_SELECTOR_EXCHANGE_BOUND_OPERATOR_ID,
  hashLabeledIdentity,
  type FieldContractSha256,
  type FieldStopCertificateReceipt,
  type FieldStopExchangeBound
} from "@do-soul/alaya-protocol";

import {
  decideRecallFieldStop,
  type RecallFieldRefinementStopCertificate
} from "./field-refinement-stop-certificate.js";

export type BundleFrontierBound = Readonly<{
  readonly unseen_gain_upper_bound: number;
  readonly incumbent_loss?: number;
  readonly opened?: boolean;
}>;

export function evaluateBundleFrontierBounds(
  frontiers: readonly BundleFrontierBound[]
): readonly FieldStopExchangeBound[] {
  return Object.freeze(frontiers
    .filter((frontier) => frontier.opened !== true)
    .map((frontier) => {
      const incumbentLoss = frontier.incumbent_loss ?? 0;
      return Object.freeze({
        removed_candidate_key: null,
        incumbent_loss: incumbentLoss,
        unseen_gain_upper_bound: frontier.unseen_gain_upper_bound,
        improvement_upper_bound: frontier.unseen_gain_upper_bound - incumbentLoss
      });
    }));
}

export function createFieldStopCertificateEnvelope(params: Readonly<{
  readonly workspace_id: string;
  readonly generation_id: string;
  readonly condition_digest: string;
  readonly recorded_at: string;
  readonly sha256: FieldContractSha256;
  readonly selected_candidate_keys: readonly string[];
  readonly coreCertificate?: Readonly<RecallFieldRefinementStopCertificate>;
  readonly bundleFrontiers?: readonly BundleFrontierBound[];
  readonly activationBudgetRemaining?: number;
}>): FieldStopCertificateReceipt {
  const bundleBounds = evaluateBundleFrontierBounds(params.bundleFrontiers ?? []);
  const coreBounds = params.coreCertificate?.exchange_bounds ?? [];
  const bounds = Object.freeze([...coreBounds, ...bundleBounds]);
  const decision = decideRecallFieldStop({
    bounds,
    ...(params.coreCertificate === undefined
      ? {}
      : { coreReason: params.coreCertificate.reason }),
    activationBudgetRemaining: params.activationBudgetRemaining
  });
  return FieldStopCertificateReceiptSchema.parse({
    schema_version: 1,
    producer: RECALL_FIELD_SELECTOR_EXCHANGE_BOUND_OPERATOR_ID,
    consumer: "select_gamma",
    identity: hashStopIdentity(params, decision),
    replay_rule: "idempotent_same_identity",
    failure_disposition: "fail_closed",
    governance_effect: "audit_only",
    deletion_behavior: "rebuildable",
    workspace_id: params.workspace_id,
    operator_id: RECALL_FIELD_SELECTOR_EXCHANGE_BOUND_OPERATOR_ID,
    status: decision.status,
    frontier: decision.frontier,
    reason: decision.reason,
    selected_candidate_keys: Object.freeze([...params.selected_candidate_keys]),
    exchange_bounds: decision.reason === "all_channels_closed" ? Object.freeze([]) : bounds,
    improvement_upper_bound: decision.improvement,
    generation_id: params.generation_id,
    condition_digest: params.condition_digest,
    candidate_membership_changed: false,
    recorded_at: params.recorded_at
  });
}

function hashStopIdentity(
  params: Parameters<typeof createFieldStopCertificateEnvelope>[0],
  decision: ReturnType<typeof decideRecallFieldStop>
): string {
  return hashLabeledIdentity("stop_certificate", [
    params.workspace_id,
    params.generation_id,
    params.condition_digest,
    decision.status,
    decision.frontier,
    decision.reason,
    decision.improvement === null ? "null" : String(decision.improvement),
    ...params.selected_candidate_keys
  ], params.sha256);
}
