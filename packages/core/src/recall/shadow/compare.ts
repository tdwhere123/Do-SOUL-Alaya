import {
  freezeShadow,
  isCmpIllegalState,
  isUnknownNeutral,
  SHADOW_ENVELOPE_STATES,
  type ShadowEnvelope,
  type ShadowEnvelopeState
} from "./envelope.js";

export type ShadowPairReason = "equal" | "tradeoff" | "blocked" | "skip";

export const SHADOW_PAIR_REASONS = [
  "equal",
  "tradeoff",
  "blocked",
  "skip"
] as const satisfies readonly ShadowPairReason[];

export type ShadowChannelVote = "skip" | "incomparable" | "gt" | "lt" | "eq";

export type ShadowStatePairKind =
  | "skip"
  | "incomparable"
  | "numeric"
  | "contract_failure";

export type ShadowStatePairResult = Readonly<{
  readonly kind: ShadowStatePairKind;
}>;

export type ShadowStatePairMatrix = Readonly<
  Record<ShadowEnvelopeState, Readonly<Record<ShadowEnvelopeState, ShadowStatePairKind>>>
>;

export function shadowStatePairKind(
  left: ShadowEnvelopeState,
  right: ShadowEnvelopeState
): ShadowStatePairKind {
  if (isCmpIllegalState(left) || isCmpIllegalState(right)) {
    return "contract_failure";
  }
  if (left === "observed" && right === "observed") return "numeric";
  if (left === right && isUnknownNeutral(left)) return "skip";
  return "incomparable";
}

export const SHADOW_STATE_PAIR_MATRIX: ShadowStatePairMatrix = freezeStatePairMatrix();

export function compareEnvelopeStates(
  left: ShadowEnvelopeState,
  right: ShadowEnvelopeState
): ShadowStatePairResult {
  return freezeShadow({ kind: SHADOW_STATE_PAIR_MATRIX[left][right] });
}

export function compareChannelEnvelopes(
  left: ShadowEnvelope,
  right: ShadowEnvelope,
  domainsMatch: boolean
): ShadowStatePairResult {
  const base = compareEnvelopeStates(left.state, right.state);
  if (base.kind === "numeric" && !domainsMatch) {
    return freezeShadow({ kind: "incomparable" });
  }
  return base;
}

function freezeStatePairMatrix(): ShadowStatePairMatrix {
  const matrix = {} as Record<
    ShadowEnvelopeState,
    Record<ShadowEnvelopeState, ShadowStatePairKind>
  >;
  for (const left of SHADOW_ENVELOPE_STATES) {
    const row = {} as Record<ShadowEnvelopeState, ShadowStatePairKind>;
    for (const right of SHADOW_ENVELOPE_STATES) {
      row[right] = shadowStatePairKind(left, right);
    }
    matrix[left] = freezeShadow(row);
  }
  return freezeShadow(matrix);
}
