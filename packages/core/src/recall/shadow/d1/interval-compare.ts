import type { ShadowChannelVote } from "../compare.js";
import { lexDomainsEqual, type LexDomain } from "../observations.js";
import {
  d1HasLegalEnvelope,
  d1IdentitiesEqual,
  type D1CandidateEnvelopeMap,
  type D1EnvelopeValue,
  type D1PrimaryObservation
} from "./legal-envelope.js";

export function d1IntervalVote(
  left: D1EnvelopeValue,
  right: D1EnvelopeValue
): ShadowChannelVote {
  if (left.kind === "inapplicable" && right.kind === "inapplicable") return "skip";
  if (left.kind === "inapplicable" || right.kind === "inapplicable") return "incomparable";
  if (left.kind === "unbounded" || right.kind === "unbounded") return "incomparable";
  if (left.lower > left.upper || right.lower > right.upper) return "incomparable";
  if (left.lower > right.upper) return "gt";
  if (right.lower > left.upper) return "lt";
  if (left.lower === left.upper && right.lower === right.upper && left.lower === right.lower) {
    return "eq";
  }
  return "incomparable";
}

export function d1LexicalChannelVote(
  left: D1CandidateEnvelopeMap,
  right: D1CandidateEnvelopeMap
): ShadowChannelVote {
  const gate = identityGate(left, right);
  if (gate !== "ok") return gate;
  if (left.primary !== null && right.primary !== null) {
    return voteBothPrimary(left.primary, right.primary);
  }
  if (left.primary !== null) return votePrimaryAgainstFamily(left.primary, right);
  if (right.primary !== null) {
    return invertVote(votePrimaryAgainstFamily(right.primary, left));
  }
  return voteBothFamily(left, right);
}

function identityGate(
  left: D1CandidateEnvelopeMap,
  right: D1CandidateEnvelopeMap
): "ok" | ShadowChannelVote {
  if (left.identity !== null && right.identity !== null) {
    return d1IdentitiesEqual(left.identity, right.identity) ? "ok" : "incomparable";
  }
  if (left.identity === null && right.identity === null) {
    return d1HasLegalEnvelope(left) || d1HasLegalEnvelope(right) ? "incomparable" : "skip";
  }
  return "incomparable";
}

function voteBothPrimary(
  left: D1PrimaryObservation,
  right: D1PrimaryObservation
): ShadowChannelVote {
  if (!lexDomainsEqual(left.domain, right.domain)) return "incomparable";
  return d1IntervalVote(left.envelope, right.envelope);
}

function votePrimaryAgainstFamily(
  primary: D1PrimaryObservation,
  family: D1CandidateEnvelopeMap
): ShadowChannelVote {
  const other = envelopeOnDomain(family, primary.domain);
  if (other === undefined) return "incomparable";
  return d1IntervalVote(primary.envelope, other);
}

function voteBothFamily(
  left: D1CandidateEnvelopeMap,
  right: D1CandidateEnvelopeMap
): ShadowChannelVote {
  const shared = sharedLegalValues(left, right);
  if (shared.length === 0) return "skip";
  const votes = shared.map(([leftValue, rightValue]) => d1IntervalVote(leftValue, rightValue));
  const first = votes[0]!;
  return votes.every((vote) => vote === first) ? first : "incomparable";
}

function sharedLegalValues(
  left: D1CandidateEnvelopeMap,
  right: D1CandidateEnvelopeMap
): readonly (readonly [D1EnvelopeValue, D1EnvelopeValue])[] {
  const pairs: Array<readonly [D1EnvelopeValue, D1EnvelopeValue]> = [];
  for (const lane of Object.values(left.lanes)) {
    if (lane === undefined || lane.domain === null || lane.value.kind !== "interval") {
      continue;
    }
    const other = envelopeOnDomain(right, lane.domain);
    if (other === undefined || other.kind !== "interval") continue;
    pairs.push([lane.value, other]);
  }
  return pairs;
}

function envelopeOnDomain(
  map: D1CandidateEnvelopeMap,
  domain: LexDomain
): D1EnvelopeValue | undefined {
  for (const lane of Object.values(map.lanes)) {
    if (lane?.domain !== null && lane?.domain !== undefined &&
      lexDomainsEqual(lane.domain, domain)) {
      return lane.value;
    }
  }
  return undefined;
}

function invertVote(vote: ShadowChannelVote): ShadowChannelVote {
  if (vote === "gt") return "lt";
  if (vote === "lt") return "gt";
  return vote;
}
