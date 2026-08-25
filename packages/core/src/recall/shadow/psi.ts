import { compareText } from "../../shared/compare-text.js";
import {
  compareChannelEnvelopes,
  type ShadowChannelVote
} from "./compare.js";
import {
  freezeShadow,
  ShadowContractError,
  type ShadowEnvelope
} from "./envelope.js";
import { SHADOW_PSI_OPERATOR_ID } from "./identity.js";
import {
  embeddingDomainsEqual,
  lexDomainsEqual,
  SHADOW_LINEAGE_IDS,
  subjectDomainsEqual,
  temporalDomainsEqual,
  type ShadowLineageId,
  type ShadowPointwiseObservation
} from "./observations.js";
import {
  parsePsiEdge,
  parsePsiPairReceipt,
  type ShadowNotADominanceCompare,
  type ShadowPsiEdge,
  type ShadowPsiPairReceipt
} from "./receipts.js";

export type ShadowPsiHGate = "none" | "event" | "temporal" | "hidden";

export type ShadowPsiLineages = Readonly<
  Partial<Record<ShadowLineageId, ShadowPointwiseObservation>>
>;

export type ShadowPsiCandidateView = Readonly<{
  readonly h_gate: ShadowPsiHGate;
  readonly lineages: ShadowPsiLineages;
}>;

export type ShadowPsiObservationField = Readonly<
  Record<string, ShadowPsiCandidateView>
>;

export type ShadowPsiQResult = boolean | ShadowNotADominanceCompare;

export type ShadowPsiOutcomeKind =
  | "dominates"
  | "dominated_by"
  | "blocked"
  | "tradeoff"
  | "equal"
  | "skip";

export type ShadowPsiOutcome = Readonly<{
  readonly kind: ShadowPsiOutcomeKind;
  readonly n_gt: number;
  readonly n_lt: number;
  readonly n_eq: number;
}>;

export type ShadowPsiPairEmission =
  | ShadowPsiEdge
  | ShadowPsiPairReceipt
  | ShadowNotADominanceCompare;

export function psiQ(
  v: string,
  u: string,
  observations: ShadowPsiObservationField,
  applicableChannels: readonly ShadowLineageId[]
): ShadowPsiQResult {
  if (v === u) return false;
  const result = evaluatePair(v, u, observations, applicableChannels);
  if (result.kind === "not_a_dominance_compare") return result;
  return result.kind === "dominates";
}

export function psiOutcome(
  v: string,
  u: string,
  observations: ShadowPsiObservationField,
  applicableChannels: readonly ShadowLineageId[]
): ShadowPsiOutcome | ShadowNotADominanceCompare {
  if (v === u) {
    return freezeShadow({ kind: "skip", n_gt: 0, n_lt: 0, n_eq: 0 });
  }
  return evaluatePair(v, u, observations, applicableChannels);
}

export function psiPredicate(
  observations: ShadowPsiObservationField,
  applicableChannels: readonly ShadowLineageId[]
): (v: string, u: string) => boolean {
  return (v, u) => {
    const result = psiQ(v, u, observations, applicableChannels);
    if (typeof result !== "boolean") {
      throw new ShadowContractError("H-ineligible is not a dominance compare");
    }
    return result;
  };
}

export function eligibleCandidateKeys(
  observations: ShadowPsiObservationField
): readonly string[] {
  return Object.freeze(
    Object.keys(observations)
      .filter((key) => observations[key]?.h_gate === "none")
      .sort(compareText)
  );
}

export function e0MembershipSubsetOfE1(
  e0Keys: readonly string[],
  e1Keys: readonly string[]
): boolean {
  const e1 = new Set(e1Keys);
  return e0Keys.every((key) => e1.has(key));
}

export function isNotADominanceCompare(
  result: ShadowPsiQResult
): result is ShadowNotADominanceCompare {
  return result !== true && result !== false;
}

export function cmpChannel(
  left: ShadowPointwiseObservation,
  right: ShadowPointwiseObservation
): ShadowChannelVote {
  if (left.lineage !== right.lineage) {
    throw new ShadowContractError("Cmp_c requires the same lineage");
  }
  const pair = compareChannelEnvelopes(
    left.envelope,
    right.envelope,
    observedDomainsMatch(left, right)
  );
  if (pair.kind === "contract_failure") {
    throw new ShadowContractError("illegal pointwise state reached Cmp");
  }
  if (pair.kind === "skip") return "skip";
  if (pair.kind === "incomparable") return "incomparable";
  return numericVote(left.envelope, right.envelope);
}

export function toPsiReceipt(
  v: string,
  u: string,
  outcome: ShadowPsiOutcome
): ShadowPsiEdge | ShadowPsiPairReceipt {
  if (outcome.kind === "dominates") {
    return parsePsiEdge({
      kind: "psi_edge",
      operator_id: SHADOW_PSI_OPERATOR_ID,
      dominator: v,
      dominated: u
    });
  }
  if (outcome.kind === "dominated_by") {
    return parsePsiEdge({
      kind: "psi_edge",
      operator_id: SHADOW_PSI_OPERATOR_ID,
      dominator: u,
      dominated: v
    });
  }
  return parsePsiPairReceipt({
    left: v,
    right: u,
    reason: outcome.kind,
    dominates: false
  });
}

export function emitPsiPair(
  v: string,
  u: string,
  observations: ShadowPsiObservationField,
  applicableChannels: readonly ShadowLineageId[]
): ShadowPsiPairEmission {
  const outcome = psiOutcome(v, u, observations, applicableChannels);
  if (outcome.kind === "not_a_dominance_compare") return outcome;
  return toPsiReceipt(v, u, outcome);
}

function evaluatePair(
  v: string,
  u: string,
  observations: ShadowPsiObservationField,
  applicableChannels: readonly ShadowLineageId[]
): ShadowPsiOutcome | ShadowNotADominanceCompare {
  const left = lookupCandidate(observations, v);
  const right = lookupCandidate(observations, u);
  if (left.h_gate !== "none") return notADominanceCompare(v, left.h_gate);
  if (right.h_gate !== "none") return notADominanceCompare(u, right.h_gate);
  const votes = collectVotes(left, right, canonicalChannels(applicableChannels));
  return interpretOutcome(votes);
}

function collectVotes(
  left: ShadowPsiCandidateView,
  right: ShadowPsiCandidateView,
  channels: readonly ShadowLineageId[]
): readonly ShadowChannelVote[] {
  return channels.map((channel) =>
    cmpChannel(requireLineage(left, channel), requireLineage(right, channel))
  );
}

function interpretOutcome(votes: readonly ShadowChannelVote[]): ShadowPsiOutcome {
  let blocked = false;
  let nGt = 0;
  let nLt = 0;
  let nEq = 0;
  for (const vote of votes) {
    if (vote === "incomparable") blocked = true;
    if (vote === "gt") nGt += 1;
    if (vote === "lt") nLt += 1;
    if (vote === "eq") nEq += 1;
  }
  return freezeShadow({
    kind: outcomeKind(blocked, nGt, nLt, nEq),
    n_gt: nGt,
    n_lt: nLt,
    n_eq: nEq
  });
}

function outcomeKind(
  blocked: boolean,
  nGt: number,
  nLt: number,
  nEq: number
): ShadowPsiOutcomeKind {
  if (blocked) return "blocked";
  if (nGt >= 1 && nLt === 0) return "dominates";
  if (nLt >= 1 && nGt === 0) return "dominated_by";
  if (nGt >= 1 && nLt >= 1) return "tradeoff";
  if (nEq >= 1) return "equal";
  return "skip";
}

function canonicalChannels(
  applicable: readonly ShadowLineageId[]
): readonly ShadowLineageId[] {
  for (const channel of applicable) {
    if (!isLineageId(channel)) {
      throw new ShadowContractError(`unknown Psi channel ${channel}`);
    }
  }
  return SHADOW_LINEAGE_IDS.filter((id) => applicable.includes(id));
}

function isLineageId(value: string): value is ShadowLineageId {
  return (SHADOW_LINEAGE_IDS as readonly string[]).includes(value);
}

function lookupCandidate(
  observations: ShadowPsiObservationField,
  key: string
): ShadowPsiCandidateView {
  const candidate = observations[key];
  if (candidate === undefined) {
    throw new ShadowContractError(`unknown candidate ${key}`);
  }
  return candidate;
}

function requireLineage(
  candidate: ShadowPsiCandidateView,
  channel: ShadowLineageId
): ShadowPointwiseObservation {
  const observation = candidate.lineages[channel];
  if (observation === undefined) {
    throw new ShadowContractError(`missing ${channel} observation`);
  }
  if (observation.lineage !== channel) {
    throw new ShadowContractError(`${channel} observation lineage mismatch`);
  }
  return observation;
}

function notADominanceCompare(
  candidateKey: string,
  gate: Exclude<ShadowPsiHGate, "none">
): ShadowNotADominanceCompare {
  return freezeShadow({
    kind: "not_a_dominance_compare",
    reason: "h_ineligible",
    gate,
    candidate_key: candidateKey
  });
}

function observedDomainsMatch(
  left: ShadowPointwiseObservation,
  right: ShadowPointwiseObservation
): boolean {
  if (left.envelope.state !== "observed" || right.envelope.state !== "observed") {
    return true;
  }
  if (left.lineage === "lexical" && right.lineage === "lexical") {
    return lexObservedEqual(left, right);
  }
  if (left.lineage === "embedding" && right.lineage === "embedding") {
    return embeddingObservedEqual(left, right);
  }
  if (left.lineage === "temporal" && right.lineage === "temporal") {
    return temporalObservedEqual(left, right);
  }
  if (left.lineage === "subject_preference" && right.lineage === "subject_preference") {
    return subjectDomainsEqual(left.domain, right.domain);
  }
  throw new ShadowContractError("Cmp_c requires the same lineage");
}

function lexObservedEqual(
  left: Extract<ShadowPointwiseObservation, { lineage: "lexical" }>,
  right: Extract<ShadowPointwiseObservation, { lineage: "lexical" }>
): boolean {
  if (left.domain === null || right.domain === null) {
    throw new ShadowContractError("observed lexical needs LexDomain");
  }
  return lexDomainsEqual(left.domain, right.domain);
}

function embeddingObservedEqual(
  left: Extract<ShadowPointwiseObservation, { lineage: "embedding" }>,
  right: Extract<ShadowPointwiseObservation, { lineage: "embedding" }>
): boolean {
  const leftDomain = left.snapshot.domain;
  const rightDomain = right.snapshot.domain;
  if (leftDomain === null || rightDomain === null) {
    throw new ShadowContractError("observed embedding needs EmbDomain");
  }
  return embeddingDomainsEqual(leftDomain, rightDomain);
}

function temporalObservedEqual(
  left: Extract<ShadowPointwiseObservation, { lineage: "temporal" }>,
  right: Extract<ShadowPointwiseObservation, { lineage: "temporal" }>
): boolean {
  const leftDomain = left.evaluator.domain;
  const rightDomain = right.evaluator.domain;
  if (leftDomain === null || rightDomain === null) {
    throw new ShadowContractError("observed temporal needs TempDomain");
  }
  return temporalDomainsEqual(leftDomain, rightDomain);
}

function numericVote(left: ShadowEnvelope, right: ShadowEnvelope): ShadowChannelVote {
  if (left.state !== "observed" || right.state !== "observed") {
    throw new ShadowContractError("numeric Cmp requires observed envelopes");
  }
  if (left.value > right.value) return "gt";
  if (left.value < right.value) return "lt";
  return "eq";
}
