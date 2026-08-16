import type {
  FieldContractSha256,
  FieldStopCertificateReceipt
} from "@do-soul/alaya-protocol";

import { createFieldStopCertificateEnvelope } from
  "../../refinement/field-refinement-stop-envelope.js";

export type OpenableBundleFrontier = Readonly<{
  readonly bundle_id: string;
  readonly unseen_gain_upper_bound: number;
  readonly incumbent_loss: number;
  readonly opened: boolean;
}>;

export type ProgressiveOpeningResult = Readonly<{
  readonly opened_bundle_ids: readonly string[];
  readonly remaining: readonly OpenableBundleFrontier[];
  readonly stop: FieldStopCertificateReceipt;
}>;

export function openProjectionBundlesProgressively(params: Readonly<{
  readonly workspace_id: string;
  readonly generation_id: string;
  readonly condition_digest: string;
  readonly recorded_at: string;
  readonly sha256: FieldContractSha256;
  readonly selected_candidate_keys: readonly string[];
  readonly activationBudget: number;
  readonly frontiers: readonly OpenableBundleFrontier[];
}>): ProgressiveOpeningResult {
  const remaining: MutableFrontier[] = params.frontiers.map((frontier) => ({ ...frontier }));
  const openedIds: string[] = [];
  let budget = params.activationBudget;
  while (budget > 0) {
    const next = nextUnopened(remaining);
    if (next === undefined) break;
    next.opened = true;
    openedIds.push(next.bundle_id);
    budget -= 1;
  }
  return Object.freeze({
    opened_bundle_ids: Object.freeze([...openedIds]),
    remaining: Object.freeze(remaining.map((frontier) => Object.freeze({ ...frontier }))),
    stop: createFieldStopCertificateEnvelope({
      workspace_id: params.workspace_id,
      generation_id: params.generation_id,
      condition_digest: params.condition_digest,
      recorded_at: params.recorded_at,
      sha256: params.sha256,
      selected_candidate_keys: params.selected_candidate_keys,
      bundleFrontiers: remaining,
      activationBudgetRemaining: budget
    })
  });
}

type MutableFrontier = {
  bundle_id: string;
  unseen_gain_upper_bound: number;
  incumbent_loss: number;
  opened: boolean;
};

function nextUnopened(frontiers: MutableFrontier[]): MutableFrontier | undefined {
  return [...frontiers]
    .filter((frontier) => !frontier.opened)
    .sort((left, right) =>
      right.unseen_gain_upper_bound - left.unseen_gain_upper_bound ||
      (left.bundle_id < right.bundle_id ? -1 : left.bundle_id > right.bundle_id ? 1 : 0)
    )[0];
}
