import type {
  RecallCandidateAnswerSupport
} from "../../query/recall-candidate-answer-support.js";
import type { FineAssessmentCandidate } from "../fine-assessment-selection.js";

export function orderByAnswerSupportMembership(params: Readonly<{
  readonly candidates: readonly FineAssessmentCandidate[];
  readonly protectedCandidateKeys: ReadonlySet<string>;
  readonly supportByCandidateKey: ReadonlyMap<
    string,
    Readonly<RecallCandidateAnswerSupport>
  >;
  readonly selectAdmitted: (
    candidates: readonly FineAssessmentCandidate[]
  ) => readonly FineAssessmentCandidate[];
}>): readonly FineAssessmentCandidate[] {
  const baseline = params.selectAdmitted(params.candidates);
  const baselineKeys = candidateKeys(baseline);
  const guardKeys = new Set(baseline
    .filter((candidate) => isGuard(params, candidate, baselineKeys))
    .map((candidate) => candidate.fusion.candidate_key));
  const guardedCandidates: FineAssessmentCandidate[] = [];
  const supportedCandidates: FineAssessmentCandidate[] = [];
  const remainingCandidates: FineAssessmentCandidate[] = [];
  for (const candidate of params.candidates) {
    if (guardKeys.has(candidate.fusion.candidate_key)) {
      guardedCandidates.push(candidate);
    } else if (isMembershipPreferred(supportFor(params, candidate))) {
      supportedCandidates.push(candidate);
    } else {
      remainingCandidates.push(candidate);
    }
  }
  const selectedKeys = candidateKeys(params.selectAdmitted([
    ...guardedCandidates,
    ...supportedCandidates,
    ...remainingCandidates
  ]));
  if (setsEqual(selectedKeys, baselineKeys)) return params.candidates;
  return Object.freeze([
    ...params.candidates.filter((candidate) =>
      selectedKeys.has(candidate.fusion.candidate_key)),
    ...params.candidates.filter((candidate) =>
      !selectedKeys.has(candidate.fusion.candidate_key))
  ]);
}

function supportFor(
  params: Readonly<{
    readonly supportByCandidateKey: ReadonlyMap<
      string,
      Readonly<RecallCandidateAnswerSupport>
    >;
  }>,
  candidate: FineAssessmentCandidate
): Readonly<RecallCandidateAnswerSupport> | undefined {
  return params.supportByCandidateKey.get(candidate.fusion.candidate_key);
}

function isMembershipPreferred(
  support: Readonly<RecallCandidateAnswerSupport> | undefined
): boolean {
  return support?.eligible === true
    && (support.status === "compatible" || support.status === "value_only");
}

function isGuard(
  params: Readonly<{
    readonly protectedCandidateKeys: ReadonlySet<string>;
    readonly supportByCandidateKey: ReadonlyMap<
      string,
      Readonly<RecallCandidateAnswerSupport>
    >;
  }>,
  candidate: FineAssessmentCandidate,
  baselineKeys: ReadonlySet<string>
): boolean {
  const key = candidate.fusion.candidate_key;
  return baselineKeys.has(key)
    && (supportFor(params, candidate)?.authority?.behavior_eligible === true
      || params.protectedCandidateKeys.has(key));
}

function candidateKeys(
  candidates: readonly FineAssessmentCandidate[]
): ReadonlySet<string> {
  return new Set(candidates.map((candidate) => candidate.fusion.candidate_key));
}

function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((key) => right.has(key));
}
