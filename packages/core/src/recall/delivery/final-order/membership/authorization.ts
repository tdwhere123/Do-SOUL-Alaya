import type { RecallQueryProbes } from "../../../query/recall-query-probes.js";
import { hasTemporalQuerySignal } from "../../../query/recall-query-plan.js";
import type { RecallFusionStreamRanks } from
  "../../../runtime/recall-service-types.js";
import type { ReciprocalAnswersWithCertificate } from "./path-certificate.js";
import {
  DIRECT_QUERY_EVIDENCE_STREAMS,
  type DirectQueryEvidenceStream
} from "../../packet-plan/packet-plan-observation.js";

type AuthorizationCandidate = Readonly<{
  readonly candidateKey: string;
  readonly sourceCandidate: Readonly<{
    readonly entry: Readonly<{ readonly evidence_refs: readonly string[] }>;
    readonly fusion: Readonly<{ readonly per_stream_rank: RecallFusionStreamRanks }>;
  }>;
}>;

export type DirectQueryEvidenceSource =
  | "pre_projection_requirement"
  | "proposed_head"
  | "planned_tail_opportunity";

export type MembershipRequirementAuthority =
  | Readonly<{
      readonly kind: "direct_query_evidence";
      readonly origin: DirectQueryEvidenceSource;
      readonly stream: DirectQueryEvidenceStream;
      readonly rank: number;
      readonly sourceProximityRank: number | null;
      readonly sourceEvidenceAgreementRank: number | null;
    }>
  | Readonly<{
      readonly kind: "graph_path_opportunity";
      readonly graphRank: number;
      readonly sourceProximityRank: number;
      readonly certificate: ReciprocalAnswersWithCertificate;
    }>
  | Readonly<{
      readonly kind: "behavior_identity";
      readonly evidenceRef: string | null;
    }>;

export type MembershipSubstitutionAuthority = Readonly<{
  readonly protectedCandidateKey: string;
  readonly substituteCandidateKey: string;
  readonly sourceCandidateKey: string;
  readonly targetCandidateKey: string;
  readonly pathId: string;
  readonly pathSourceVersion: string;
  readonly relationKind: "answers_with";
  readonly sessionKey: string;
}>;

export type QueryEvidenceMembershipAuthorization = Readonly<{
  readonly kind:
    | MembershipRequirementAuthority["kind"]
    | "same_session_substitution";
  readonly authorizedCandidateKey: string;
  readonly satisfiedByCandidateKey: string;
  readonly witness: MembershipRequirementAuthority | MembershipSubstitutionAuthority;
}>;

export type QueryEvidenceMembershipAuthorizationReceipt =
  QueryEvidenceMembershipAuthorization & Readonly<{
    readonly satisfiedHeadSlot: number;
    readonly displacedHeadBaseline: MembershipPacketSlot | null;
    readonly evictedPacketBaseline: MembershipPacketSlot | null;
  }>;

export type MembershipPacketSlot = Readonly<{
  readonly slot: number;
  readonly candidateKey: string;
}>;

type AuthorizationRequirement = Readonly<{
  readonly candidateKey: string;
  readonly authority: MembershipRequirementAuthority;
}>;

type AuthorizationAssignment = Readonly<{
  readonly substitution?: MembershipSubstitutionAuthority;
}>;

export function directQueryEvidenceAuthority(
  candidate: AuthorizationCandidate,
  queryProbes: Readonly<RecallQueryProbes>,
  maxRank: number,
  origin: DirectQueryEvidenceSource
): MembershipRequirementAuthority | null {
  const ranks = candidate.sourceCandidate.fusion.per_stream_rank;
  const streams = hasTemporalQuerySignal(queryProbes)
    ? DIRECT_QUERY_EVIDENCE_STREAMS
    : DIRECT_QUERY_EVIDENCE_STREAMS.filter(
        (stream) => stream !== "temporal_recency"
      );
  const witness = streams.flatMap((stream) => {
    const rank = ranks[stream];
    return rank !== null && rank <= maxRank ? [{ stream, rank }] : [];
  }).sort((left, right) => left.rank - right.rank)[0];
  if (witness === undefined) return null;
  return Object.freeze({
    kind: "direct_query_evidence",
    origin,
    ...witness,
    sourceProximityRank: ranks.source_proximity,
    sourceEvidenceAgreementRank: ranks.source_evidence_agreement
  });
}

export function behaviorIdentityAuthority(
  verifiedEvidenceRef: string
): MembershipRequirementAuthority {
  return Object.freeze({
    kind: "behavior_identity",
    evidenceRef: verifiedEvidenceRef
  });
}

export function behaviorAuthoritiesAreBound(
  candidates: readonly AuthorizationCandidate[],
  evidenceRefByCandidateKey: ReadonlyMap<string, string>
): boolean {
  const byKey = new Map(candidates.map((candidate) => [
    candidate.candidateKey,
    candidate
  ]));
  return [...evidenceRefByCandidateKey].every(([candidateKey, evidenceRef]) => {
    const candidate = byKey.get(candidateKey);
    return evidenceRef.trim().length > 0 &&
      candidate?.sourceCandidate.entry.evidence_refs.includes(evidenceRef) === true;
  });
}

export function graphPathAuthority(
  candidate: AuthorizationCandidate,
  certificate: ReciprocalAnswersWithCertificate
): MembershipRequirementAuthority | null {
  const ranks = candidate.sourceCandidate.fusion.per_stream_rank;
  if (ranks.graph_expansion === null || ranks.source_proximity === null) return null;
  return Object.freeze({
    kind: "graph_path_opportunity",
    graphRank: ranks.graph_expansion,
    sourceProximityRank: ranks.source_proximity,
    certificate
  });
}

export function buildMembershipAuthorizations<T extends AuthorizationCandidate>(
  params: Readonly<{
    readonly fallbackHead: readonly T[];
    readonly governedHead: readonly T[];
    readonly requirements: readonly AuthorizationRequirement[];
    readonly assignments: ReadonlyMap<string, AuthorizationAssignment>;
    readonly fixedCandidateKeys: ReadonlySet<string>;
    readonly queryProbes: Readonly<RecallQueryProbes>;
  }>
): readonly QueryEvidenceMembershipAuthorization[] | null {
  const fallbackKeys = new Set(
    params.fallbackHead.map((candidate) => candidate.candidateKey)
  );
  const substitutions = [...params.assignments.values()].flatMap(
    (assignment) => assignment.substitution === undefined
      ? []
      : [assignment.substitution]
  );
  const authorizations: QueryEvidenceMembershipAuthorization[] = [];
  for (const candidate of params.governedHead) {
    if (fallbackKeys.has(candidate.candidateKey) ||
        params.fixedCandidateKeys.has(candidate.candidateKey)) continue;
    const substitution = substitutions.find(
      (item) => item.substituteCandidateKey === candidate.candidateKey
    );
    if (substitution !== undefined) {
      authorizations.push(Object.freeze({
        kind: "same_session_substitution",
        authorizedCandidateKey: substitution.protectedCandidateKey,
        satisfiedByCandidateKey: substitution.substituteCandidateKey,
        witness: substitution
      }));
      continue;
    }
    const requirement = params.requirements.find(
      (item) => item.candidateKey === candidate.candidateKey
    );
    const authority = requirement?.authority ?? directQueryEvidenceAuthority(
      candidate,
      params.queryProbes,
      params.governedHead.length,
      "proposed_head"
    );
    if (authority === null ||
        (authority.kind === "behavior_identity" && authority.evidenceRef === null)) {
      return null;
    }
    authorizations.push(Object.freeze({
      kind: authority.kind,
      authorizedCandidateKey: candidate.candidateKey,
      satisfiedByCandidateKey: candidate.candidateKey,
      witness: authority
    }));
  }
  return Object.freeze(authorizations);
}

export function attachAuthorizationEffects(
  authorizations: readonly QueryEvidenceMembershipAuthorization[],
  baselineHead: readonly AuthorizationCandidate[],
  governedHead: readonly AuthorizationCandidate[],
  baselinePacket: readonly AuthorizationCandidate[],
  plannedPacket: readonly AuthorizationCandidate[]
): readonly QueryEvidenceMembershipAuthorizationReceipt[] {
  const plannedKeys = new Set(plannedPacket.map((candidate) => candidate.candidateKey));
  const baselineKeys = new Set(
    baselinePacket.map((candidate) => candidate.candidateKey)
  );
  const removed = baselinePacket.filter(
    (candidate) => !plannedKeys.has(candidate.candidateKey)
  );
  let addedIndex = 0;
  return Object.freeze(authorizations.map((authorization) => {
    const index = governedHead.findIndex(
      (candidate) => candidate.candidateKey === authorization.satisfiedByCandidateKey
    );
    if (index < 0) throw new Error("Membership authorization is absent from governed head");
    const displaced = baselineHead[index];
    const displacedSlot = displaced === undefined ||
      displaced.candidateKey === authorization.satisfiedByCandidateKey
      ? null
      : packetSlot(index, displaced.candidateKey);
    const added = !baselineKeys.has(authorization.satisfiedByCandidateKey);
    const evictedCandidate = added ? removed[addedIndex++] : undefined;
    const packetIndex = evictedCandidate === undefined ? -1 :
      baselinePacket.findIndex(
        (candidate) => candidate.candidateKey === evictedCandidate.candidateKey
      );
    const evicted = evictedCandidate === undefined
      ? null
      : packetSlot(packetIndex, evictedCandidate.candidateKey);
    return Object.freeze({
      ...authorization,
      satisfiedHeadSlot: index + 1,
      displacedHeadBaseline: displacedSlot,
      evictedPacketBaseline: evicted
    });
  }));
}

function packetSlot(index: number, candidateKey: string): MembershipPacketSlot {
  return Object.freeze({ slot: index + 1, candidateKey });
}
