import type { ShadowChannelVote } from "../compare.js";
import { d1IntervalVote } from "../d1/interval-compare.js";
import { d1IdentitiesEqual } from "../d1/legal-envelope.js";
import { freezeShadow } from "../envelope.js";
import { parseMeasurementGroupContractV1 } from "../measurement/index.js";
import type {
  MeasurementComparisonDirectionV1
} from "../measurement/index.js";
import { lexDomainsEqual } from "../observations.js";
import type {
  PsiV2CandidateV1,
  PsiV2CoordinateV1,
  PsiV2VerdictKind,
  PsiV2VerdictV1
} from "./types.js";

type CoordinateVote = "gt" | "lt" | "eq" | "skip" | "blocked" | "incomparable";

export function comparePsiV2(
  left: PsiV2CandidateV1,
  right: PsiV2CandidateV1
): PsiV2VerdictV1 {
  if (left.candidate_id === right.candidate_id) {
    return verdict("equal", "irreflexive identity pair is not dominance");
  }
  const votes = propositionVotes(left, right);
  if (votes.blocked.length > 0) return verdict("blocked", ...votes.blocked);
  if (votes.incomparable.length > 0) {
    return verdict("incomparable", ...votes.incomparable);
  }
  if (votes.gt > 0 && votes.lt > 0) return verdict("tradeoff", "heterogeneous propositions disagree");
  if (votes.gt > 0) return verdict("dominates", "strict safe dominance on collapsed coordinates");
  if (votes.lt > 0) return verdict("dominated_by", "reverse strict safe dominance");
  if (votes.eq > 0) return verdict("equal", "collapsed coordinates agree");
  return verdict("incomparable", "no comparable collapsed proposition");
}

export function psiV2Dominates(left: PsiV2CandidateV1, right: PsiV2CandidateV1): boolean {
  return comparePsiV2(left, right).kind === "dominates";
}

function propositionVotes(left: PsiV2CandidateV1, right: PsiV2CandidateV1): {
  gt: number;
  lt: number;
  eq: number;
  blocked: string[];
  incomparable: string[];
} {
  const ids = new Set([
    ...left.coordinates.map((row) => row.proposition_id),
    ...right.coordinates.map((row) => row.proposition_id)
  ]);
  let gt = 0;
  let lt = 0;
  let eq = 0;
  const blocked: string[] = [];
  const incomparable: string[] = [];
  for (const propositionId of ids) {
    const vote = voteProposition(
      findCoordinate(left, propositionId),
      findCoordinate(right, propositionId)
    );
    if (vote === "blocked") blocked.push(`unresolved comparison blocks ${propositionId}`);
    if (vote === "incomparable") incomparable.push(`incomparable on ${propositionId}`);
    if (vote === "gt") gt += 1;
    if (vote === "lt") lt += 1;
    if (vote === "eq") eq += 1;
  }
  return { gt, lt, eq, blocked, incomparable };
}

function voteProposition(
  left: PsiV2CoordinateV1 | undefined,
  right: PsiV2CoordinateV1 | undefined
): CoordinateVote {
  const applicability = applicabilityVote(left, right);
  if (applicability !== "compare" || left === undefined || right === undefined) {
    return applicability === "compare" ? "blocked" : applicability;
  }
  if (!identitiesComparable(left, right)) return "incomparable";
  if (isBlockingCollapse(left) || isBlockingCollapse(right)) return "blocked";
  if (!domainsComparable(left, right)) return "incomparable";
  return directedIntervalVote(left, right);
}

function applicabilityVote(
  left: PsiV2CoordinateV1 | undefined,
  right: PsiV2CoordinateV1 | undefined
): CoordinateVote | "compare" {
  if (left === undefined && right === undefined) return "skip";
  if (left === undefined) return right!.applicable ? "blocked" : "skip";
  if (right === undefined) return left.applicable ? "blocked" : "skip";
  if (!left.applicable && !right.applicable) return "skip";
  if (!left.applicable || !right.applicable) return "incomparable";
  return "compare";
}

function domainsComparable(left: PsiV2CoordinateV1, right: PsiV2CoordinateV1): boolean {
  if (left.lex_domain === null && right.lex_domain === null) return true;
  if (left.lex_domain === null || right.lex_domain === null) return false;
  return lexDomainsEqual(left.lex_domain, right.lex_domain);
}

function identitiesComparable(left: PsiV2CoordinateV1, right: PsiV2CoordinateV1): boolean {
  if (left.envelope_identity === null && right.envelope_identity === null) return true;
  if (left.envelope_identity === null || right.envelope_identity === null) return false;
  return d1IdentitiesEqual(left.envelope_identity, right.envelope_identity);
}

function isBlockingCollapse(coordinate: PsiV2CoordinateV1): boolean {
  return coordinate.collapse.status !== "collapsed";
}

function directedIntervalVote(
  left: PsiV2CoordinateV1,
  right: PsiV2CoordinateV1
): CoordinateVote {
  if (left.collapse.status !== "collapsed" || right.collapse.status !== "collapsed") {
    return "blocked";
  }
  const contractVote = measurementContractVote(
    left.collapse.contract,
    right.collapse.contract
  );
  if (contractVote !== "compare") return contractVote;
  const direction = left.collapse.contract.comparison_direction;
  const leftPayload = left.collapse.witness.payload;
  const rightPayload = right.collapse.witness.payload;
  if (leftPayload === null || rightPayload === null) return "blocked";
  return applyDirection(
    d1IntervalVote(
      { kind: "interval", lower: leftPayload.lower, upper: leftPayload.upper },
      { kind: "interval", lower: rightPayload.lower, upper: rightPayload.upper }
    ),
    direction
  );
}

function measurementContractVote(left: unknown, right: unknown): CoordinateVote | "compare" {
  try {
    const leftContract = parseMeasurementGroupContractV1(left);
    const rightContract = parseMeasurementGroupContractV1(right);
    return leftContract.digest === rightContract.digest ? "compare" : "incomparable";
  } catch {
    return "blocked";
  }
}

function applyDirection(
  vote: ShadowChannelVote,
  direction: MeasurementComparisonDirectionV1
): CoordinateVote {
  if (vote === "eq") return "eq";
  if (vote !== "gt" && vote !== "lt") return "incomparable";
  if (direction === "exact") return "incomparable";
  if (direction === "lower_is_stronger") return vote === "gt" ? "lt" : "gt";
  return vote;
}

function findCoordinate(
  candidate: PsiV2CandidateV1,
  propositionId: string
): PsiV2CoordinateV1 | undefined {
  return candidate.coordinates.find((row) => row.proposition_id === propositionId);
}

function verdict(kind: PsiV2VerdictKind, ...reasons: string[]): PsiV2VerdictV1 {
  return freezeShadow({ kind, reasons: Object.freeze(reasons) });
}
