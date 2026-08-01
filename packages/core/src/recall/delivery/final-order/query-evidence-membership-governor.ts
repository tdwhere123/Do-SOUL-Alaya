import type { RecallQueryProbes } from "../../query/recall-query-probes.js";
import type { PathInflowEdge } from "../../runtime/recall-service-types.js";
import { isWorkspaceMemoryCandidate } from "../../runtime/recall-service-helpers.js";
import { hasNonEmbeddingQueryEvidenceRank } from
  "../../scoring/query-evidence-support.js";
import type { FineAssessmentCandidate } from
  "../fine-assessment-selection/types.js";
import {
  isFinitePositiveRank,
  isRankWithinHead,
  reciprocalAnswersWithCertificate
} from
  "./membership/path-certificate.js";
import {
  directEvidenceDominates,
  membershipSessionKey
} from "./membership/candidate-support.js";
import { projectAuthorizedMembershipOrder } from
  "./membership/authorized-order.js";
import { authorizedIntroductionKeys } from
  "./membership/authorized-introductions.js";
import { freezeMembershipPlan } from "./membership/membership-plan.js";
import {
  behaviorAuthoritiesAreBound,
  behaviorIdentityAuthority,
  buildMembershipAuthorizations,
  directQueryEvidenceAuthority,
  graphPathAuthority,
  type MembershipRequirementAuthority,
  type QueryEvidenceMembershipAuthorization
} from "./membership/authorization.js";

export type QueryEvidenceMembershipCandidate = Readonly<{
  readonly candidateKey: string;
  readonly rawEmbeddingRank?: number;
  readonly sourceCandidate: FineAssessmentCandidate;
}>;

export type QueryEvidenceMembershipSubstitution = Readonly<{
  readonly protectedCandidateKey: string;
  readonly substituteCandidateKey: string;
  readonly sourceCandidateKey: string;
  readonly targetCandidateKey: string;
  readonly pathId: string;
  readonly pathSourceVersion: string;
  readonly relationKind: "answers_with";
  readonly sessionKey: string;
}>;

export type QueryEvidenceMembershipPlan<
  T extends QueryEvidenceMembershipCandidate
> = Readonly<{
  readonly head: readonly T[];
  readonly protectedCandidateKeys: readonly string[];
  readonly substitutions: readonly QueryEvidenceMembershipSubstitution[];
  readonly authorizations: readonly QueryEvidenceMembershipAuthorization[];
  readonly feasible: boolean;
}>;

type MembershipRequirement = Readonly<{
  readonly candidateKey: string;
  readonly identityRequired: boolean;
  readonly sessionKey: string | null;
  readonly authority: MembershipRequirementAuthority;
}>;

type MembershipAssignment = Readonly<{
  readonly candidateKey: string;
  readonly substitution?: QueryEvidenceMembershipSubstitution;
}>;

type MembershipContext<T extends QueryEvidenceMembershipCandidate> = Readonly<{
  readonly candidatesByKey: ReadonlyMap<string, T>;
  readonly candidatesByObjectId: ReadonlyMap<string, T>;
  readonly pathInflowByTarget: Readonly<Record<string, readonly PathInflowEdge[]>>;
  readonly headWidth: number;
  readonly fixedCandidateKeys: ReadonlySet<string>;
}>;

export function governQueryEvidenceMembership<
  T extends QueryEvidenceMembershipCandidate
>(params: Readonly<{
  readonly preProjectionHead: readonly T[];
  readonly fallbackHead?: readonly T[];
  readonly proposedHead: readonly T[];
  readonly sourceCandidates: readonly T[];
  readonly opportunityCandidates?: readonly T[];
  readonly graphOpportunityCandidates?: readonly T[];
  readonly visibleCandidateKeys?: ReadonlySet<string>;
  readonly queryProbes: Readonly<RecallQueryProbes>;
  readonly pathInflowByTarget?: Readonly<Record<string, readonly PathInflowEdge[]>>;
  readonly behaviorAuthorityEvidenceRefByCandidateKey: ReadonlyMap<string, string>;
  readonly fixedCandidateKeys?: ReadonlySet<string>;
  readonly selectorConsensusActive?: boolean;
}>): QueryEvidenceMembershipPlan<T> {
  if (params.preProjectionHead.length !== params.proposedHead.length) {
    return freezeMembershipPlan(params.proposedHead, [], [], false);
  }
  if (!behaviorAuthoritiesAreBound(
    params.sourceCandidates,
    params.behaviorAuthorityEvidenceRefByCandidateKey
  )) return freezeMembershipPlan(params.preProjectionHead, [], [], false);
  const context = buildContext(params);
  const requirements = buildRequirements(params, context);
  const governed = requirements.length === 0
    ? freezeMembershipPlan(params.proposedHead, [], [], true)
    : resolveRequirementPlan(params, requirements, context);
  return enforceAuthorizedIntroductions(params, requirements, governed, context);
}

function resolveRequirementPlan<T extends QueryEvidenceMembershipCandidate>(
  params: Parameters<typeof governQueryEvidenceMembership<T>>[0],
  requirements: readonly MembershipRequirement[],
  context: MembershipContext<T>
): QueryEvidenceMembershipPlan<T> {
  const governed = reconcileHead(
    requirements, params.preProjectionHead, params.proposedHead, context
  );
  const assignments = assignRequirements(requirements, governed.head, context);
  if (governed.feasible && assignments !== null) {
    return freezeMembershipPlan(
      governed.head, requirements,
      collectSubstitutions(requirements, assignments), true
    );
  }
  return restoreDominatedIntroducedCandidate(params, context, requirements) ??
    freezeMembershipPlan(params.preProjectionHead, requirements, [], false);
}

function enforceAuthorizedIntroductions<T extends QueryEvidenceMembershipCandidate>(
  params: Parameters<typeof governQueryEvidenceMembership<T>>[0],
  requirements: readonly MembershipRequirement[],
  plan: QueryEvidenceMembershipPlan<T>,
  context: MembershipContext<T>
): QueryEvidenceMembershipPlan<T> {
  const preProjectionKeys = new Set(
    params.preProjectionHead.map((candidate) => candidate.candidateKey)
  );
  const authorizedKeys = authorizedIntroductionKeys({
    proposedHead: params.proposedHead,
    queryProbes: params.queryProbes,
    requirements,
    substituteCandidateKeys: plan.substitutions.map(
      (substitution) => substitution.substituteCandidateKey
    ),
    preProjectionKeys,
    fixedCandidateKeys: context.fixedCandidateKeys
  });
  const unauthorized = plan.head.filter((candidate) =>
    !preProjectionKeys.has(candidate.candidateKey) &&
    !authorizedKeys.has(candidate.candidateKey)
  );
  if (unauthorized.length === plan.head.length) {
    return exactNoOpPlan(params, requirements, plan.feasible, context);
  }
  const projected = projectAuthorizedMembershipOrder({
    fallbackHead: params.fallbackHead ?? params.preProjectionHead,
    proposedHead: plan.head,
    preProjectionKeys,
    authorizedIntroductionKeys: authorizedKeys
  });
  if (projected === null) {
    return freezeMembershipPlan(params.preProjectionHead, requirements, [], false);
  }
  const assignments = assignRequirements(requirements, projected, context);
  if (assignments === null) {
    return freezeMembershipPlan(params.preProjectionHead, requirements, [], false);
  }
  const authorizations = buildMembershipAuthorizations({
    fallbackHead: params.fallbackHead ?? params.preProjectionHead,
    governedHead: projected,
    requirements,
    assignments,
    fixedCandidateKeys: context.fixedCandidateKeys,
    queryProbes: params.queryProbes
  });
  return authorizations === null
    ? freezeMembershipPlan(params.preProjectionHead, requirements, [], false)
    : freezeMembershipPlan(
        projected,
        requirements,
        collectSubstitutions(requirements, assignments),
        plan.feasible,
        authorizations
      );
}

function exactNoOpPlan<T extends QueryEvidenceMembershipCandidate>(
  params: Parameters<typeof governQueryEvidenceMembership<T>>[0],
  requirements: readonly MembershipRequirement[],
  feasible: boolean,
  context: MembershipContext<T>
): QueryEvidenceMembershipPlan<T> {
  const fallback = params.fallbackHead ?? params.preProjectionHead;
  const assignments = assignRequirements(requirements, fallback, context);
  return assignments === null
    ? freezeMembershipPlan(params.preProjectionHead, requirements, [], false)
    : freezeMembershipPlan(
        fallback, requirements,
        collectSubstitutions(requirements, assignments), feasible
      );
}

function buildRequirements<T extends QueryEvidenceMembershipCandidate>(
  params: Parameters<typeof governQueryEvidenceMembership<T>>[0],
  context: MembershipContext<T>
): readonly MembershipRequirement[] {
  const requirements: MembershipRequirement[] = params.preProjectionHead.flatMap(
    (candidate) => {
      const behaviorEvidenceRef = params.behaviorAuthorityEvidenceRefByCandidateKey.get(
        candidate.candidateKey
      );
      const behaviorEligible = behaviorEvidenceRef !== undefined;
      const directQueryEvidence = !params.selectorConsensusActive &&
        hasNonEmbeddingQueryEvidenceRank(
          candidate.sourceCandidate.fusion.per_stream_rank,
          params.queryProbes,
          params.proposedHead.length
        );
      if (!behaviorEligible && !directQueryEvidence) return [];
      const authority = behaviorEligible
        ? behaviorIdentityAuthority(behaviorEvidenceRef)
        : directQueryEvidenceAuthority(
            candidate, params.queryProbes, params.proposedHead.length,
            "pre_projection_requirement"
          );
      if (authority === null) return [];
      return [Object.freeze({
        candidateKey: candidate.candidateKey,
        identityRequired: behaviorEligible,
        sessionKey: membershipSessionKey(candidate.sourceCandidate),
        authority
      })];
    }
  );
  const requirementKeys = new Set(requirements.map((item) => item.candidateKey));
  for (const candidate of params.proposedHead) {
    if (
      !params.behaviorAuthorityEvidenceRefByCandidateKey.has(candidate.candidateKey) ||
      requirementKeys.has(candidate.candidateKey)
    ) continue;
    const evidenceRef = params.behaviorAuthorityEvidenceRefByCandidateKey.get(
      candidate.candidateKey
    );
    if (evidenceRef === undefined) continue;
    requirements.push(Object.freeze({
      candidateKey: candidate.candidateKey,
      identityRequired: true,
      sessionKey: membershipSessionKey(candidate.sourceCandidate),
      authority: behaviorIdentityAuthority(evidenceRef)
    }));
    requirementKeys.add(candidate.candidateKey);
  }
  for (const opportunity of [
    chooseDirectOpportunity(params),
    chooseGraphOpportunity(params, context)
  ]) {
    if (opportunity === undefined || requirementKeys.has(opportunity.candidateKey)) continue;
    requirements.push(opportunity);
    requirementKeys.add(opportunity.candidateKey);
  }
  return requirements;
}

function chooseDirectOpportunity<T extends QueryEvidenceMembershipCandidate>(
  params: Parameters<typeof governQueryEvidenceMembership<T>>[0]
): MembershipRequirement | undefined {
  const candidates = params.opportunityCandidates ?? [];
  const candidate = candidates.find((candidate) =>
    hasNonEmbeddingQueryEvidenceRank(
      candidate.sourceCandidate.fusion.per_stream_rank,
      params.queryProbes,
      params.proposedHead.length
    ) &&
    isFinitePositiveRank(
      candidate.sourceCandidate.fusion.per_stream_rank.source_proximity
    ) &&
    isFinitePositiveRank(
      candidate.sourceCandidate.fusion.per_stream_rank.source_evidence_agreement
    )
  );
  if (candidate === undefined) return undefined;
  const authority = directQueryEvidenceAuthority(
    candidate, params.queryProbes, params.proposedHead.length,
    "planned_tail_opportunity"
  );
  return authority === null ? undefined : Object.freeze({
    candidateKey: candidate.candidateKey,
    identityRequired: true,
    sessionKey: membershipSessionKey(candidate.sourceCandidate),
    authority
  });
}

function chooseGraphOpportunity<T extends QueryEvidenceMembershipCandidate>(
  params: Parameters<typeof governQueryEvidenceMembership<T>>[0],
  context: MembershipContext<T>
): MembershipRequirement | undefined {
  const visibleKeys = params.visibleCandidateKeys ?? new Set<string>();
  const proposedKeys = new Set(
    params.proposedHead.map((candidate) => candidate.candidateKey)
  );
  const candidate = (params.graphOpportunityCandidates ?? [])
    .filter((candidate) => !proposedKeys.has(candidate.candidateKey))
    .filter((candidate) => candidate.rawEmbeddingRank === undefined)
    .filter((candidate) =>
      isRankWithinHead(
        candidate.sourceCandidate.fusion.per_stream_rank.graph_expansion,
        context.headWidth
      )
    )
    .filter((candidate) =>
      isFinitePositiveRank(
        candidate.sourceCandidate.fusion.per_stream_rank.source_proximity
      )
    )
    .find((candidate) => {
      const certificate = reciprocalAnswersWithCertificate(candidate, context, false);
      if (certificate === null || !visibleKeys.has(certificate.sourceCandidateKey)) {
        return false;
      }
      const source = context.candidatesByKey.get(certificate.sourceCandidateKey);
      return source !== undefined && hasNonEmbeddingQueryEvidenceRank(
        source.sourceCandidate.fusion.per_stream_rank,
        params.queryProbes,
        context.headWidth
      );
    });
  if (candidate === undefined) return undefined;
  const certificate = reciprocalAnswersWithCertificate(candidate, context, false);
  if (certificate === null) return undefined;
  const authority = graphPathAuthority(candidate, certificate);
  return authority === null ? undefined : Object.freeze({
    candidateKey: candidate.candidateKey,
    identityRequired: true,
    sessionKey: membershipSessionKey(candidate.sourceCandidate),
    authority
  });
}

function buildContext<T extends QueryEvidenceMembershipCandidate>(
  params: Parameters<typeof governQueryEvidenceMembership<T>>[0]
): MembershipContext<T> {
  const workspaceCandidates = params.sourceCandidates.filter((candidate) =>
    isWorkspaceMemoryCandidate(candidate.sourceCandidate)
  );
  return Object.freeze({
    candidatesByKey: new Map(params.sourceCandidates.map((candidate) => [
      candidate.candidateKey, candidate
    ])),
    candidatesByObjectId: new Map(workspaceCandidates.map((candidate) => [
      candidate.sourceCandidate.entry.object_id, candidate
    ])),
    pathInflowByTarget: params.pathInflowByTarget ?? Object.freeze({}),
    headWidth: params.proposedHead.length,
    fixedCandidateKeys: params.fixedCandidateKeys ?? new Set()
  });
}

function restoreDominatedIntroducedCandidate<
  T extends QueryEvidenceMembershipCandidate
>(
  params: Parameters<typeof governQueryEvidenceMembership<T>>[0],
  context: MembershipContext<T>,
  requirements: readonly MembershipRequirement[]
): QueryEvidenceMembershipPlan<T> | null {
  const preProjectionKeys = new Set(
    params.preProjectionHead.map((candidate) => candidate.candidateKey)
  );
  const proposedKeys = new Set(
    params.proposedHead.map((candidate) => candidate.candidateKey)
  );
  for (const candidate of params.preProjectionHead) {
    if (proposedKeys.has(candidate.candidateKey)) continue;
    if (!hasNonEmbeddingQueryEvidenceRank(
      candidate.sourceCandidate.fusion.per_stream_rank,
      params.queryProbes,
      context.headWidth
    )) continue;
    for (let index = params.proposedHead.length - 1; index >= 0; index -= 1) {
      const victim = params.proposedHead[index]!;
      if (preProjectionKeys.has(victim.candidateKey)) continue;
      if (context.fixedCandidateKeys.has(victim.candidateKey)) continue;
      if (!directEvidenceDominates(candidate, victim)) continue;
      const head = [...params.proposedHead];
      head.splice(index, 1, candidate);
      const assignments = assignRequirements(requirements, head, context);
      if (assignments === null) continue;
      return freezeMembershipPlan(
        head, requirements, collectSubstitutions(requirements, assignments), true
      );
    }
  }
  return null;
}

function collectSubstitutions(
  requirements: readonly MembershipRequirement[],
  assignments: ReadonlyMap<string, MembershipAssignment>
): readonly QueryEvidenceMembershipSubstitution[] {
  return requirements.flatMap((requirement) => {
    const substitution = assignments.get(requirement.candidateKey)?.substitution;
    return substitution === undefined ? [] : [substitution];
  });
}

function reconcileHead<T extends QueryEvidenceMembershipCandidate>(
  requirements: readonly MembershipRequirement[],
  fallbackHead: readonly T[],
  proposedHead: readonly T[],
  context: MembershipContext<T>
): Readonly<{ readonly head: readonly T[]; readonly feasible: boolean }> {
  const head = [...proposedHead];
  for (const [index, requirement] of requirements.entries()) {
    const active = requirements.slice(0, index + 1);
    if (assignRequirements(active, head, context) !== null) continue;
    const source = context.candidatesByKey.get(requirement.candidateKey);
    if (source === undefined) return Object.freeze({ head: fallbackHead, feasible: false });
    const victimIndex = findVictimIndex(active, requirement, source, head, context);
    if (victimIndex < 0) return Object.freeze({ head: fallbackHead, feasible: false });
    head.splice(victimIndex, 1, source);
  }
  return Object.freeze({ head: Object.freeze(head), feasible: true });
}

function findVictimIndex<T extends QueryEvidenceMembershipCandidate>(
  requirements: readonly MembershipRequirement[],
  requirement: MembershipRequirement,
  source: T,
  head: readonly T[],
  context: MembershipContext<T>
): number {
  for (let index = head.length - 1; index >= 0; index -= 1) {
    if (head[index]?.candidateKey === requirement.candidateKey) continue;
    if (context.fixedCandidateKeys.has(head[index]?.candidateKey ?? "")) continue;
    const trial = [...head];
    trial.splice(index, 1, source);
    if (assignRequirements(requirements, trial, context) !== null) return index;
  }
  return -1;
}

function assignRequirements<T extends QueryEvidenceMembershipCandidate>(
  requirements: readonly MembershipRequirement[],
  head: readonly T[],
  context: MembershipContext<T>
): ReadonlyMap<string, MembershipAssignment> | null {
  const used = new Set<string>();
  const assignments = new Map<string, MembershipAssignment>();
  for (const requirement of requirements) {
    if (!head.some((candidate) => candidate.candidateKey === requirement.candidateKey)) continue;
    used.add(requirement.candidateKey);
    assignments.set(requirement.candidateKey, Object.freeze({
      candidateKey: requirement.candidateKey
    }));
  }
  for (const requirement of requirements) {
    if (assignments.has(requirement.candidateKey)) continue;
    const assignment = findSubstitute(requirement, head, used, context);
    if (assignment === null) return null;
    used.add(assignment.candidateKey);
    assignments.set(requirement.candidateKey, assignment);
  }
  return assignments;
}

function findSubstitute<T extends QueryEvidenceMembershipCandidate>(
  requirement: MembershipRequirement,
  head: readonly T[],
  used: ReadonlySet<string>,
  context: MembershipContext<T>
): MembershipAssignment | null {
  if (requirement.identityRequired || requirement.sessionKey === null) return null;
  const protectedCandidate = context.candidatesByKey.get(requirement.candidateKey);
  if (protectedCandidate === undefined) return null;
  for (const candidate of head) {
    if (used.has(candidate.candidateKey)) continue;
    if (membershipSessionKey(candidate.sourceCandidate) !== requirement.sessionKey) {
      continue;
    }
    if (directEvidenceDominates(protectedCandidate, candidate)) continue;
    const certificate = reciprocalAnswersWithCertificate(candidate, context);
    if (
      certificate === null ||
      certificate.sourceCandidateKey !== requirement.candidateKey
    ) continue;
    return Object.freeze({
      candidateKey: candidate.candidateKey,
      substitution: Object.freeze({
        protectedCandidateKey: requirement.candidateKey,
        substituteCandidateKey: candidate.candidateKey,
        ...certificate,
        sessionKey: requirement.sessionKey
      })
    });
  }
  return null;
}
