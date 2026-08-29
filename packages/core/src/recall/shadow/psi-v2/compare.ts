import { freezeShadow } from "../envelope.js";
import type { MeasurementCollapseV1 } from "../measurement/index.js";
import type {
  PsiV2CandidateV1,
  PsiV2CoordinateV1,
  PsiV2VerdictKind,
  PsiV2VerdictV1
} from "./types.js";

export function comparePsiV2(
  left: PsiV2CandidateV1,
  right: PsiV2CandidateV1
): PsiV2VerdictV1 {
  if (left.candidate_id === right.candidate_id) {
    return verdict("equal", "irreflexive identity pair is not dominance");
  }
  const votes = propositionVotes(left, right);
  if (votes.blocked.length > 0) return verdict("blocked", ...votes.blocked);
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
} {
  const ids = new Set([
    ...left.coordinates.map((row) => row.proposition_id),
    ...right.coordinates.map((row) => row.proposition_id)
  ]);
  let gt = 0;
  let lt = 0;
  let eq = 0;
  const blocked: string[] = [];
  for (const propositionId of ids) {
    const vote = voteProposition(
      findCoordinate(left, propositionId),
      findCoordinate(right, propositionId)
    );
    if (vote === "blocked") blocked.push(`unknown blocks ${propositionId}`);
    if (vote === "gt") gt += 1;
    if (vote === "lt") lt += 1;
    if (vote === "eq") eq += 1;
  }
  return { gt, lt, eq, blocked };
}

function voteProposition(
  left: PsiV2CoordinateV1 | undefined,
  right: PsiV2CoordinateV1 | undefined
): "gt" | "lt" | "eq" | "skip" | "blocked" {
  if (left !== undefined && !left.applicable && right !== undefined && !right.applicable) {
    return "skip";
  }
  if (left === undefined || right === undefined) return "skip";
  if (!left.applicable || !right.applicable) return "skip";
  if (isBlockingCollapse(left.collapse) || isBlockingCollapse(right.collapse)) return "blocked";
  if (left.collapse.status !== "collapsed" || right.collapse.status !== "collapsed") {
    return "blocked";
  }
  return intervalVote(left.collapse.witness.payload, right.collapse.witness.payload);
}

function intervalVote(
  left: { readonly lower: number; readonly upper: number } | null,
  right: { readonly lower: number; readonly upper: number } | null
): "gt" | "lt" | "eq" | "skip" | "blocked" {
  if (left === null || right === null) return "blocked";
  if (left.lower > right.upper) return "gt";
  if (right.lower > left.upper) return "lt";
  if (left.lower === left.upper && right.lower === right.upper && left.lower === right.lower) {
    return "eq";
  }
  return "skip";
}

function isBlockingCollapse(collapse: MeasurementCollapseV1): boolean {
  return collapse.status === "unresolved" || collapse.status === "conflict";
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
