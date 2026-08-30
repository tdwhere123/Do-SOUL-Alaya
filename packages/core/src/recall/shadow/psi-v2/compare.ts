import { freezeShadow } from "../envelope.js";
import { measurementAdmissionsShareAuthority } from "../measurement/admission.js";
import {
  compareCollapsedPropositionStatesExact,
  compareLexicalIntervals,
  lexicalIntervalIdentitiesEqual,
  validateMeasurementAdmissionV1,
  type MeasurementCollapseV1,
  type MeasurementComparisonDirectionV1,
  type CurrentMeasurementAuthoritiesV1,
  type PropositionStateCollapseV1
} from "../measurement/index.js";
import { lexDomainsEqual } from "../observations.js";
import type {
  PsiV2CandidateV1,
  PsiV2CoordinateV1,
  PsiV2VerdictKind,
  PsiV2VerdictV1
} from "./types.js";

type CoordinateVote = "gt" | "lt" | "eq" | "skip" | "blocked" | "incomparable";
type VoteTally = {
  gt: number;
  lt: number;
  eq: number;
  blocked: string[];
  incomparable: string[];
};

export function comparePsiV2(
  left: PsiV2CandidateV1,
  right: PsiV2CandidateV1,
  currentAuthorities: CurrentMeasurementAuthoritiesV1
): PsiV2VerdictV1 {
  if (left.candidate_id === right.candidate_id) {
    return verdict("equal", "irreflexive identity pair is not dominance");
  }
  const votes = propositionVotes(left, right, currentAuthorities);
  if (votes.blocked.length > 0) return verdict("blocked", ...votes.blocked);
  if (votes.incomparable.length > 0) {
    return verdict("incomparable", ...votes.incomparable);
  }
  return resolvePsiV2ComparableVotes([
    ...Array.from({ length: votes.gt }, () => "gt" as const),
    ...Array.from({ length: votes.lt }, () => "lt" as const),
    ...Array.from({ length: votes.eq }, () => "eq" as const)
  ]);
}

export function resolvePsiV2ComparableVotes(
  votes: readonly ("gt" | "lt" | "eq")[]
): PsiV2VerdictV1 {
  if (votes.includes("gt") && votes.includes("lt")) {
    return verdict("tradeoff", "heterogeneous propositions disagree");
  }
  if (votes.includes("gt")) return verdict("dominates", "strict safe dominance on collapsed coordinates");
  if (votes.includes("lt")) return verdict("dominated_by", "reverse strict safe dominance");
  if (votes.includes("eq")) return verdict("equal", "collapsed coordinates agree");
  return verdict("incomparable", "no comparable collapsed proposition");
}

export function psiV2Dominates(
  left: PsiV2CandidateV1,
  right: PsiV2CandidateV1,
  currentAuthorities: CurrentMeasurementAuthoritiesV1
): boolean {
  return comparePsiV2(left, right, currentAuthorities).kind === "dominates";
}

function propositionVotes(
  left: PsiV2CandidateV1,
  right: PsiV2CandidateV1,
  currentAuthorities: CurrentMeasurementAuthoritiesV1
): VoteTally {
  const tally: VoteTally = { gt: 0, lt: 0, eq: 0, blocked: [], incomparable: [] };
  tally.blocked.push(
    ...candidateBindingFailures(left, currentAuthorities),
    ...candidateBindingFailures(right, currentAuthorities)
  );
  if (tally.blocked.length > 0) return tally;
  const ids = new Set([
    ...left.coordinates.map((row) => row.proposition_id),
    ...right.coordinates.map((row) => row.proposition_id)
  ]);
  for (const propositionId of ids) {
    recordVote(tally, propositionId, voteProposition(
      findCoordinate(left, propositionId),
      findCoordinate(right, propositionId)
    ));
  }
  return tally;
}

function candidateBindingFailures(
  candidate: PsiV2CandidateV1,
  currentAuthorities: CurrentMeasurementAuthoritiesV1
): string[] {
  const failures: string[] = [];
  const ids = new Set<string>();
  for (const coordinate of candidate.coordinates) {
    if (ids.has(coordinate.proposition_id)) {
      failures.push(`duplicate proposition coordinate ${coordinate.proposition_id}`);
    }
    ids.add(coordinate.proposition_id);
    if (coordinate.collapse.status !== "collapsed") continue;
    if (coordinate.identity === null) {
      failures.push(`coordinate identity is absent on ${coordinate.proposition_id}`);
      continue;
    }
    const validation = validateMeasurementAdmissionV1({
      admission: coordinate.admission,
      current_authorities: currentAuthorities,
      contract: coordinate.collapse.contract,
      proposition_schema: coordinate.proposition_schema,
      collapse: coordinate.collapse,
      lexical_source: isNumericCollapse(coordinate.collapse) ? {
        lex_domain: coordinate.lex_domain,
        envelope_identity: coordinate.envelope_identity
      } : undefined
    });
    if (validation.status === "blocked") {
      failures.push(validation.reason);
      continue;
    }
    if (coordinate.admission?.candidate_id !== candidate.candidate_id) {
      failures.push(`candidate identity mismatch on ${coordinate.proposition_id}`);
    }
    if (coordinate.admission?.proposition_id !== coordinate.proposition_id) {
      failures.push(`proposition identity mismatch on ${coordinate.proposition_id}`);
    }
    if (!coordinateIdentityMatchesAdmission(coordinate)) {
      failures.push(`raw and collapsed identity mismatch on ${coordinate.proposition_id}`);
    }
    if (!lexicalIdentityBound(coordinate)) {
      failures.push(`lexical identity mismatch on ${coordinate.proposition_id}`);
    }
  }
  return failures;
}

function voteProposition(
  left: PsiV2CoordinateV1 | undefined,
  right: PsiV2CoordinateV1 | undefined
): CoordinateVote {
  const applicability = applicabilityVote(left, right);
  if (applicability !== "compare" || left === undefined || right === undefined) {
    return applicability === "compare" ? "blocked" : applicability;
  }
  if (left.collapse.status !== "collapsed" || right.collapse.status !== "collapsed") {
    return "blocked";
  }
  if (!sameAdmittedCoordinateJurisdiction(left, right)) return "blocked";
  if (isPropositionStateCollapse(left.collapse) &&
    isPropositionStateCollapse(right.collapse)) {
    return compareCollapsedPropositionStatesExact(left.collapse, right.collapse);
  }
  if (!isNumericCollapse(left.collapse) || !isNumericCollapse(right.collapse)) {
    return "blocked";
  }
  if (!domainsComparable(left, right) || !identitiesComparable(left, right)) {
    return "incomparable";
  }
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

function sameAdmittedCoordinateJurisdiction(
  left: PsiV2CoordinateV1,
  right: PsiV2CoordinateV1
): boolean {
  const leftAdmission = left.admission;
  const rightAdmission = right.admission;
  return leftAdmission !== null && rightAdmission !== null &&
    measurementAdmissionsShareAuthority(leftAdmission, rightAdmission) &&
    leftAdmission.contract_digest === rightAdmission.contract_digest &&
    leftAdmission.operator_id === rightAdmission.operator_id &&
    leftAdmission.operator_version === rightAdmission.operator_version &&
    leftAdmission.proposition_schema === rightAdmission.proposition_schema &&
    leftAdmission.proposition_id === rightAdmission.proposition_id &&
    leftAdmission.authority_digest === rightAdmission.authority_digest &&
    leftAdmission.query_id === rightAdmission.query_id &&
    leftAdmission.snapshot_digest === rightAdmission.snapshot_digest &&
    leftAdmission.request_digest === rightAdmission.request_digest &&
    leftAdmission.workspace_id === rightAdmission.workspace_id;
}

function coordinateIdentityMatchesAdmission(coordinate: PsiV2CoordinateV1): boolean {
  const identity = coordinate.identity;
  const admission = coordinate.admission;
  return identity !== null && admission !== null &&
    identity.coordinate_id === admission.coordinate_id &&
    identity.query_id === admission.query_id &&
    identity.snapshot_digest === admission.snapshot_digest &&
    identity.request_digest === admission.request_digest &&
    identity.workspace_id === admission.workspace_id &&
    identity.candidate_id === admission.candidate_id &&
    identity.proposition_id === admission.proposition_id;
}

function lexicalIdentityBound(coordinate: PsiV2CoordinateV1): boolean {
  if (coordinate.collapse.status !== "collapsed" ||
    coordinate.collapse.contract.measurement_domain !== "numeric_interval") {
    return true;
  }
  const admission = coordinate.admission;
  const identity = coordinate.envelope_identity;
  return admission !== null && identity !== null && coordinate.lex_domain !== null &&
    identity.snapshot_digest === admission.snapshot_digest &&
    identity.request_digest === admission.request_digest &&
    identity.workspace_id === admission.workspace_id;
}

function domainsComparable(left: PsiV2CoordinateV1, right: PsiV2CoordinateV1): boolean {
  return left.lex_domain !== null && right.lex_domain !== null &&
    lexDomainsEqual(left.lex_domain, right.lex_domain);
}

function identitiesComparable(left: PsiV2CoordinateV1, right: PsiV2CoordinateV1): boolean {
  return left.envelope_identity !== null && right.envelope_identity !== null &&
    lexicalIntervalIdentitiesEqual(left.envelope_identity, right.envelope_identity);
}

function directedIntervalVote(
  left: PsiV2CoordinateV1,
  right: PsiV2CoordinateV1
): CoordinateVote {
  if (left.collapse.status !== "collapsed" || right.collapse.status !== "collapsed") {
    return "blocked";
  }
  if (!isNumericCollapse(left.collapse) || !isNumericCollapse(right.collapse)) return "blocked";
  const leftContract = left.collapse.contract;
  const leftPayload = left.collapse.witness.payload;
  const rightPayload = right.collapse.witness.payload;
  if (leftPayload === null || rightPayload === null) return "blocked";
  return applyDirection(compareLexicalIntervals(
    { kind: "interval", lower: leftPayload.lower, upper: leftPayload.upper },
    { kind: "interval", lower: rightPayload.lower, upper: rightPayload.upper }
  ), leftContract.comparison_direction);
}

function isNumericCollapse(
  collapse: PsiV2CoordinateV1["collapse"]
): collapse is Extract<MeasurementCollapseV1, { status: "collapsed" }> {
  return collapse.status === "collapsed" && collapse.witness.domain === "numeric_interval";
}

function isPropositionStateCollapse(
  collapse: PsiV2CoordinateV1["collapse"]
): collapse is Extract<PropositionStateCollapseV1, { status: "collapsed" }> {
  return collapse.status === "collapsed" &&
    collapse.witness.domain === "four_valued_proposition";
}

function applyDirection(
  vote: ReturnType<typeof compareLexicalIntervals>,
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

function recordVote(tally: VoteTally, propositionId: string, vote: CoordinateVote): void {
  if (vote === "blocked") tally.blocked.push(`unresolved comparison blocks ${propositionId}`);
  if (vote === "incomparable") tally.incomparable.push(`incomparable on ${propositionId}`);
  if (vote === "gt") tally.gt += 1;
  if (vote === "lt") tally.lt += 1;
  if (vote === "eq") tally.eq += 1;
}

function verdict(kind: PsiV2VerdictKind, ...reasons: string[]): PsiV2VerdictV1 {
  return freezeShadow({ kind, reasons: Object.freeze(reasons) });
}
