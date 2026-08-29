import type { D1CandidateEnvelopeMap } from "../d1/legal-envelope.js";
import { lexDomainsEqual, type LexDomain } from "../observations.js";
import { adaptLexicalIntervalEnvelopeToCollapse } from "./lexical-interval-adapter.js";
import type { PsiV2CandidateV1, PsiV2CoordinateV1 } from "./types.js";

const PROPOSITION_ID = "lex.interval";
const ADAPTER_PROVENANCE = Object.freeze([
  Object.freeze({ source_id: "lexical.interval.primary", producer: "lexical.interval.adapter.v1" })
]);

export function psiV2CandidateFromLexicalEnvelope(
  key: string,
  map: D1CandidateEnvelopeMap | undefined,
  queryId: string,
  snapshotDigest: string
): PsiV2CandidateV1 {
  if (map === undefined) {
    return candidate(key, unresolvedCoordinate(
      null,
      null,
      "missing lexical envelope remains unresolved"
    ));
  }
  if (map.primary === null) {
    return candidate(key, unresolvedCoordinate(
      primaryDomainHint(map),
      map.identity,
      "missing primary lexical interval remains unresolved"
    ));
  }
  return candidate(key, {
    proposition_id: PROPOSITION_ID,
    applicable: true,
    lex_domain: map.primary.domain,
    envelope_identity: map.identity,
    collapse: adaptLexicalIntervalEnvelopeToCollapse(
      map.primary.envelope,
      {
        coordinate_id: `${PROPOSITION_ID}:${key}`,
        query_id: queryId,
        snapshot_digest: snapshotDigest,
        candidate_id: key,
        proposition_id: PROPOSITION_ID
      },
      ADAPTER_PROVENANCE,
      map.identity
    )
  });
}

export function rawMissingFamilyFragment(
  left: D1CandidateEnvelopeMap,
  right: D1CandidateEnvelopeMap
): boolean {
  const leftDomains = intervalDomains(left);
  const rightDomains = intervalDomains(right);
  return missingDomain(leftDomains, rightDomains) || missingDomain(rightDomains, leftDomains);
}

function intervalDomains(map: D1CandidateEnvelopeMap): readonly LexDomain[] {
  const domains: LexDomain[] = [];
  if (map.primary !== null) domains.push(map.primary.domain);
  for (const lane of Object.values(map.lanes)) {
    const domain = lane?.domain;
    if (domain === null || domain === undefined || lane?.value.kind !== "interval") continue;
    if (domains.some((row) => lexDomainsEqual(row, domain))) continue;
    domains.push(domain);
  }
  return domains;
}

function missingDomain(
  present: readonly LexDomain[],
  other: readonly LexDomain[]
): boolean {
  return present.some((domain) => !other.some((row) => lexDomainsEqual(row, domain)));
}

function primaryDomainHint(map: D1CandidateEnvelopeMap): LexDomain | null {
  for (const lane of Object.values(map.lanes)) {
    if (lane?.domain !== null && lane?.domain !== undefined) return lane.domain;
  }
  return null;
}

function unresolvedCoordinate(
  lexDomain: LexDomain | null,
  envelopeIdentity: PsiV2CoordinateV1["envelope_identity"],
  reason: string
): PsiV2CoordinateV1 {
  return {
    proposition_id: PROPOSITION_ID,
    applicable: true,
    lex_domain: lexDomain,
    envelope_identity: envelopeIdentity,
    collapse: { status: "unresolved", reason, observations: [] }
  };
}

function candidate(key: string, coordinate: PsiV2CoordinateV1): PsiV2CandidateV1 {
  return { candidate_id: key, coordinates: [coordinate] };
}
