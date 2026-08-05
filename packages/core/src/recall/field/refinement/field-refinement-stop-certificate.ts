import {
  evaluateCoverageSelectionCandidateStates,
  materializeCoverageSelectionObjectiveReceipt,
  type CoverageSelectableCandidate,
  type CoverageSelectionCandidateState,
  type CoverageSelectionSupplementary
} from "../../delivery/coverage-selection.js";
import type { MaterializedConfiguredCoverageSelection } from
  "../facility/selection-objective.js";
import {
  verifyRecallFiniteFieldSeal,
  type RecallFiniteFieldSeal
} from "../finite-field-seal.js";
import {
  digestRecallFieldIdentity,
  type RecallFieldDigest
} from "../field-identity.js";
import type { CoverageSelectionObjectiveReceipt } from
  "../../delivery/coverage-selection.js";
import {
  verifyRecallRelevanceUpperBoundReceipt,
  type RecallRelevanceUpperBoundReceipt
} from "../../rerank/relevance-upper-bound-receipt.js";
import {
  verifyRecallRetrievalFieldRefinementReceipt,
  type RecallRetrievalFieldRefinementReceipt
} from "./field-refinement-receipt.js";

export const RECALL_FIELD_SELECTOR_EXCHANGE_BOUND_OPERATOR_ID =
  "recall_field_selector_exchange_bound_v1";
const TOP_FIVE_CARDINALITY = 5;
const SCORE_EPSILON = 1e-12;

export type RecallFieldExchangeBound = Readonly<{
  readonly removed_candidate_key: string | null;
  readonly incumbent_loss: number;
  readonly unseen_gain_upper_bound: number;
  readonly improvement_upper_bound: number;
}>;

export type RecallFieldRefinementStopCertificate = Readonly<{
  readonly schema_version: 1;
  readonly operator_id: typeof RECALL_FIELD_SELECTOR_EXCHANGE_BOUND_OPERATOR_ID;
  readonly activation_mode: "shadow";
  readonly field_seal_digest: RecallFieldDigest;
  readonly refinement_receipt_digests: readonly RecallFieldDigest[];
  readonly objective: CoverageSelectionObjectiveReceipt;
  readonly relevance_upper_bound:
    Readonly<RecallRelevanceUpperBoundReceipt> | null;
  readonly selected_candidate_keys: readonly string[];
  readonly exchange_bounds: readonly Readonly<RecallFieldExchangeBound>[];
  readonly maximum_exchange_improvement_upper_bound: number | null;
  readonly status: "certified" | "uncertified";
  readonly reason:
    | "all_channels_closed"
    | "source_unavailable"
    | "relevance_bound_unavailable"
    | "objective_bound_unavailable"
    | "exchange_dominated"
    | "exchange_not_dominated";
  readonly candidate_membership_changed: false;
  readonly receipt_digest: RecallFieldDigest;
}>;

export function createRecallFieldRefinementStopCertificate<
  T extends CoverageSelectableCandidate
>(params: Readonly<{
  readonly fieldSeal: Readonly<RecallFiniteFieldSeal>;
  readonly refinementReceipts:
    readonly Readonly<RecallRetrievalFieldRefinementReceipt>[];
  readonly preparedSelection: MaterializedConfiguredCoverageSelection<T>;
  readonly selectedCandidateKeys: readonly string[];
  readonly supplementaryData: CoverageSelectionSupplementary;
  readonly relevanceUpperBound:
    Readonly<RecallRelevanceUpperBoundReceipt> | null;
}>): RecallFieldRefinementStopCertificate {
  verifyInputs(params);
  const selected = selectTopFiveStates(
    params.preparedSelection.candidateStates,
    params.selectedCandidateKeys
  );
  const context = baseContext(params, selected);
  const unavailable = params.fieldSeal.channels.some(
    ({ status }) => status === "unavailable"
  );
  if (unavailable) return sealCertificate(context, "source_unavailable", []);
  const truncated = params.fieldSeal.channels.some(
    ({ status }) => status === "truncated"
  );
  if (!truncated) return sealCertificate(context, "all_channels_closed", []);
  if (params.relevanceUpperBound === null) {
    return sealCertificate(context, "relevance_bound_unavailable", []);
  }
  if (params.preparedSelection.objective.mathematical_class !== "monotone_submodular" ||
      params.preparedSelection.objective.unseenMarginalGainUpperBound === undefined) {
    return sealCertificate(context, "objective_bound_unavailable", []);
  }
  const bounds = computeExchangeBounds({
    selected,
    objective: params.preparedSelection.objective,
    supplementaryData: params.supplementaryData,
    relevanceUpperBound: params.relevanceUpperBound.upper_bound
  });
  const maximum = Math.max(...bounds.map(({ improvement_upper_bound }) =>
    improvement_upper_bound));
  return sealCertificate(
    context,
    maximum <= SCORE_EPSILON ? "exchange_dominated" : "exchange_not_dominated",
    bounds,
    maximum
  );
}

export function verifyRecallFieldRefinementStopCertificate(
  receipt: Readonly<RecallFieldRefinementStopCertificate>
): void {
  if (receipt.schema_version !== 1 ||
      receipt.operator_id !== RECALL_FIELD_SELECTOR_EXCHANGE_BOUND_OPERATOR_ID ||
      receipt.activation_mode !== "shadow" ||
      receipt.candidate_membership_changed !== false ||
      receipt.receipt_digest !== digestRecallFieldIdentity(receiptBody(receipt))) {
    throw new Error("field refinement stop certificate fidelity mismatch");
  }
  assertDigest(receipt.field_seal_digest);
  receipt.refinement_receipt_digests.forEach(assertDigest);
  if (new Set(receipt.refinement_receipt_digests).size !==
      receipt.refinement_receipt_digests.length ||
      new Set(receipt.selected_candidate_keys).size !==
      receipt.selected_candidate_keys.length ||
      receipt.selected_candidate_keys.length > TOP_FIVE_CARDINALITY) {
    throw new Error("field refinement stop certificate identities are invalid");
  }
  if (receipt.relevance_upper_bound !== null) {
    verifyRecallRelevanceUpperBoundReceipt(receipt.relevance_upper_bound);
  }
  assertCertificateDecision(receipt);
}

type CertificateContext = Omit<
  RecallFieldRefinementStopCertificate,
  "exchange_bounds" | "maximum_exchange_improvement_upper_bound" |
  "status" | "reason" | "receipt_digest"
>;

function baseContext<T extends CoverageSelectableCandidate>(
  params: Parameters<typeof createRecallFieldRefinementStopCertificate<T>>[0],
  selected: readonly CoverageSelectionCandidateState<T>[]
): CertificateContext {
  return Object.freeze({
    schema_version: 1,
    operator_id: RECALL_FIELD_SELECTOR_EXCHANGE_BOUND_OPERATOR_ID,
    activation_mode: "shadow",
    field_seal_digest: params.fieldSeal.seal_digest,
    refinement_receipt_digests: Object.freeze(params.refinementReceipts
      .map(({ receipt_digest }) => receipt_digest).sort()),
    objective: materializeCoverageSelectionObjectiveReceipt(
      params.preparedSelection.objective
    ),
    relevance_upper_bound: params.relevanceUpperBound,
    selected_candidate_keys: Object.freeze(selected.map(({ candidate }) =>
      candidate.fusion.candidate_key)),
    candidate_membership_changed: false
  });
}

function sealCertificate(
  context: CertificateContext,
  reason: RecallFieldRefinementStopCertificate["reason"],
  bounds: readonly Readonly<RecallFieldExchangeBound>[],
  maximum: number | null = null
): RecallFieldRefinementStopCertificate {
  const certified = reason === "all_channels_closed" ||
    reason === "exchange_dominated";
  const body = Object.freeze({
    ...context,
    exchange_bounds: Object.freeze(bounds),
    maximum_exchange_improvement_upper_bound: maximum,
    status: certified ? "certified" as const : "uncertified" as const,
    reason
  });
  return Object.freeze({ ...body, receipt_digest: digestRecallFieldIdentity(body) });
}

function computeExchangeBounds<T extends CoverageSelectableCandidate>(params: {
  readonly selected: readonly CoverageSelectionCandidateState<T>[];
  readonly objective: MaterializedConfiguredCoverageSelection<T>["objective"];
  readonly supplementaryData: CoverageSelectionSupplementary;
  readonly relevanceUpperBound: number;
}): readonly RecallFieldExchangeBound[] {
  const baseline = evaluate(params.selected, params);
  const removals = params.selected.length < TOP_FIVE_CARDINALITY
    ? [null]
    : params.selected.map((_, index) => index);
  return Object.freeze(removals.map((removedIndex) => {
    const remaining = removedIndex === null
      ? params.selected
      : params.selected.filter((_, index) => index !== removedIndex);
    const reduced = evaluate(remaining, params);
    const incumbentLoss = baseline.score - reduced.score;
    if (!Number.isFinite(incumbentLoss) || incumbentLoss < -SCORE_EPSILON) {
      throw new Error("field refinement exchange requires a monotone incumbent objective");
    }
    const unseen = params.objective.unseenMarginalGainUpperBound!({
      relevanceUpperBound: params.relevanceUpperBound,
      state: reduced.state,
      supplementaryData: params.supplementaryData
    });
    if (!Number.isFinite(unseen) || unseen < 0) {
      throw new Error("field refinement unseen marginal bound is invalid");
    }
    return Object.freeze({
      removed_candidate_key: removedIndex === null
        ? null
        : params.selected[removedIndex]!.candidate.fusion.candidate_key,
      incumbent_loss: Math.max(0, incumbentLoss),
      unseen_gain_upper_bound: unseen,
      improvement_upper_bound: unseen - Math.max(0, incumbentLoss)
    });
  }));
}

function evaluate<T extends CoverageSelectableCandidate>(
  candidates: readonly CoverageSelectionCandidateState<T>[],
  params: Parameters<typeof computeExchangeBounds<T>>[0]
) {
  return evaluateCoverageSelectionCandidateStates({
    candidates,
    objective: params.objective,
    supplementaryData: params.supplementaryData
  });
}

function selectTopFiveStates<T extends CoverageSelectableCandidate>(
  states: readonly CoverageSelectionCandidateState<T>[],
  selectedKeys: readonly string[]
): readonly CoverageSelectionCandidateState<T>[] {
  const byKey = new Map(states.map((state) => [
    state.candidate.fusion.candidate_key,
    state
  ]));
  const keys = selectedKeys.slice(0, TOP_FIVE_CARDINALITY);
  const selected = keys.map((key) => {
    const state = byKey.get(key);
    if (state === undefined) throw new Error("selected refinement candidate is absent");
    return state;
  });
  if (new Set(keys).size !== keys.length) {
    throw new Error("selected refinement candidates must be unique");
  }
  return Object.freeze(selected);
}

function verifyInputs<T extends CoverageSelectableCandidate>(
  params: Parameters<typeof createRecallFieldRefinementStopCertificate<T>>[0]
): void {
  verifyRecallFiniteFieldSeal(params.fieldSeal);
  params.refinementReceipts.forEach(verifyRecallRetrievalFieldRefinementReceipt);
  if (params.relevanceUpperBound !== null) {
    verifyRecallRelevanceUpperBoundReceipt(params.relevanceUpperBound);
  }
}

function assertCertificateDecision(
  receipt: Readonly<RecallFieldRefinementStopCertificate>
): void {
  const bounds = receipt.exchange_bounds;
  bounds.forEach((bound) => {
    if (![bound.incumbent_loss, bound.unseen_gain_upper_bound,
      bound.improvement_upper_bound].every(Number.isFinite) ||
      bound.incumbent_loss < 0 || bound.unseen_gain_upper_bound < 0 ||
      bound.improvement_upper_bound !==
        bound.unseen_gain_upper_bound - bound.incumbent_loss) {
      throw new Error("field refinement exchange bound is invalid");
    }
  });
  const maximum = bounds.length === 0 ? null : Math.max(
    ...bounds.map(({ improvement_upper_bound }) => improvement_upper_bound)
  );
  if (maximum !== receipt.maximum_exchange_improvement_upper_bound) {
    throw new Error("field refinement maximum exchange bound mismatch");
  }
  const certified = receipt.reason === "all_channels_closed" ||
    receipt.reason === "exchange_dominated";
  if ((certified ? "certified" : "uncertified") !== receipt.status ||
      (receipt.reason === "exchange_dominated" &&
        (maximum === null || maximum > SCORE_EPSILON)) ||
      (receipt.reason === "exchange_not_dominated" &&
        (maximum === null || maximum <= SCORE_EPSILON)) ||
      (!receipt.reason.startsWith("exchange_") && bounds.length > 0)) {
    throw new Error("field refinement stop decision is inconsistent");
  }
}

function receiptBody(receipt: Readonly<RecallFieldRefinementStopCertificate>) {
  const { receipt_digest: _digest, ...body } = receipt;
  return body;
}

function assertDigest(value: string): void {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new Error("field refinement stop certificate digest is invalid");
  }
}
