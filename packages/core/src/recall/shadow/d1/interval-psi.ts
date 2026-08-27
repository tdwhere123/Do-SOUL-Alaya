import type { ShadowChannelVote } from "../compare.js";
import { freezeShadow, ShadowContractError } from "../envelope.js";
import {
  SHADOW_LINEAGE_IDS,
  type ShadowLineageId
} from "../observations.js";
import {
  cmpChannel,
  type ShadowPsiCandidateView,
  type ShadowPsiObservationField,
  type ShadowPsiOutcome,
  type ShadowPsiOutcomeKind,
  type ShadowPsiQResult
} from "../psi.js";
import type { ShadowNotADominanceCompare } from "../receipts.js";
import type { LexicalBoundProof } from "../../runtime/diagnostics/lexical-bound-proof.js";
import { d1LexicalChannelVote } from "./interval-compare.js";
import {
  d1IdentitiesEqual,
  d1LaneEnvelopes,
  type D1CandidateEnvelopeMap
} from "./legal-envelope.js";

type EnvelopeIndex = (key: string) => readonly D1CandidateEnvelopeMap[];

export function d1PsiPredicate(
  observations: ShadowPsiObservationField,
  applicableChannels: readonly ShadowLineageId[],
  proofs: readonly LexicalBoundProof[]
): (v: string, u: string) => boolean {
  const index = envelopeIndex(proofs);
  return (v, u) => {
    const result = d1PsiQ(v, u, observations, applicableChannels, index);
    if (typeof result !== "boolean") {
      throw new ShadowContractError("H-ineligible is not a dominance compare");
    }
    return result;
  };
}

export function d1PsiOutcome(
  v: string,
  u: string,
  observations: ShadowPsiObservationField,
  applicableChannels: readonly ShadowLineageId[],
  proofs: readonly LexicalBoundProof[] | EnvelopeIndex
): ShadowPsiOutcome | ShadowNotADominanceCompare {
  if (v === u) return freezeShadow({ kind: "skip", n_gt: 0, n_lt: 0, n_eq: 0 });
  const index = typeof proofs === "function" ? proofs : envelopeIndex(proofs);
  return evaluateD1Pair(v, u, observations, applicableChannels, index);
}

export function d1PsiQ(
  v: string,
  u: string,
  observations: ShadowPsiObservationField,
  applicableChannels: readonly ShadowLineageId[],
  proofs: readonly LexicalBoundProof[] | EnvelopeIndex
): ShadowPsiQResult {
  if (v === u) return false;
  const index = typeof proofs === "function" ? proofs : envelopeIndex(proofs);
  const result = evaluateD1Pair(v, u, observations, applicableChannels, index);
  if (result.kind === "not_a_dominance_compare") return result;
  return result.kind === "dominates";
}

function evaluateD1Pair(
  v: string,
  u: string,
  observations: ShadowPsiObservationField,
  applicableChannels: readonly ShadowLineageId[],
  index: EnvelopeIndex
): ShadowPsiOutcome | ShadowNotADominanceCompare {
  const left = lookupCandidate(observations, v);
  const right = lookupCandidate(observations, u);
  if (left.h_gate !== "none") return notADominanceCompare(v, left.h_gate);
  if (right.h_gate !== "none") return notADominanceCompare(u, right.h_gate);
  const votes = collectD1Votes(v, u, left, right, canonicalChannels(applicableChannels), index);
  return interpretOutcome(votes);
}

function collectD1Votes(
  v: string,
  u: string,
  left: ShadowPsiCandidateView,
  right: ShadowPsiCandidateView,
  channels: readonly ShadowLineageId[],
  index: EnvelopeIndex
): readonly ShadowChannelVote[] {
  return channels.map((channel) => {
    if (channel === "lexical") return lexicalVote(v, u, index);
    return cmpChannel(requireLineage(left, channel), requireLineage(right, channel));
  });
}

function lexicalVote(
  v: string,
  u: string,
  index: EnvelopeIndex
): ShadowChannelVote {
  const votes: ShadowChannelVote[] = [];
  const rights = index(u);
  for (const left of index(v)) {
    const right = rights.find((item) => sameProofIdentity(left, item));
    if (right === undefined) continue;
    votes.push(d1LexicalChannelVote(left, right));
  }
  return reduceIdentityVotes(votes);
}

function reduceIdentityVotes(votes: readonly ShadowChannelVote[]): ShadowChannelVote {
  const remaining = votes.filter((vote) => vote !== "skip");
  if (remaining.length === 0) return "skip";
  const first = remaining[0]!;
  return remaining.every((vote) => vote === first) ? first : "incomparable";
}

function sameProofIdentity(
  left: D1CandidateEnvelopeMap,
  right: D1CandidateEnvelopeMap
): boolean {
  if (left.identity !== null && right.identity !== null) {
    return d1IdentitiesEqual(left.identity, right.identity);
  }
  return left.identity === null && right.identity === null;
}

function envelopeIndex(proofs: readonly LexicalBoundProof[]): EnvelopeIndex {
  const cache = new Map<string, readonly D1CandidateEnvelopeMap[]>();
  return (key) => {
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const maps = Object.freeze(proofs.map((proof) => d1LaneEnvelopes(proof, key)));
    cache.set(key, maps);
    return maps;
  };
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
) {
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
  gate: Exclude<ShadowPsiCandidateView["h_gate"], "none">
): ShadowNotADominanceCompare {
  return freezeShadow({
    kind: "not_a_dominance_compare",
    reason: "h_ineligible",
    gate,
    candidate_key: candidateKey
  });
}
