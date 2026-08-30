import type { D1CandidateEnvelopeMap } from "../d1/legal-envelope.js";
import {
  issueMeasurementGroupAdmission,
  LEXICAL_INTERVAL_MEASUREMENT_CONTRACT,
  LEXICAL_INTERVAL_PROPOSITION_ID,
  type MeasurementAdmissionV1,
  type MeasurementCollapseV1,
  type VerifiedMeasurementAuthorityV1
} from "../measurement/index.js";
import { lexDomainsEqual, type LexDomain } from "../observations.js";
import { adaptLexicalIntervalEnvelopeToCollapse } from "./lexical-interval-adapter.js";
import type { PsiV2CandidateV1, PsiV2CoordinateV1 } from "./types.js";

const ADAPTER_PROVENANCE = Object.freeze([
  Object.freeze({ source_id: "lexical.interval.primary", producer: "lexical.interval.adapter.v1" })
]);

export function psiV2CandidateFromLexicalEnvelope(
  key: string,
  map: D1CandidateEnvelopeMap | undefined,
  preparedOrQueryId: VerifiedMeasurementAuthorityV1 | string,
  legacySnapshotDigest?: string
): PsiV2CandidateV1 {
  const prepared = typeof preparedOrQueryId === "string" ? null : preparedOrQueryId;
  const queryId = prepared?.query_id ?? preparedOrQueryId as string;
  const snapshotDigest = prepared?.snapshot_digest ?? legacySnapshotDigest ?? "";
  if (map === undefined) {
    return candidate(key, unresolvedCoordinate(
      null,
      null,
      "missing lexical envelope remains unresolved"
    ));
  }
  const envelopeIdentity = lexicalEnvelopeIdentity(map);
  if (map.identity !== null && envelopeIdentity === null) {
    return candidate(key, unresolvedCoordinate(
      primaryDomainHint(map),
      null,
      "lexical envelope proof map identity is inconsistent"
    ));
  }
  if (map.primary === null) {
    return candidate(key, unresolvedCoordinate(
      primaryDomainHint(map),
      envelopeIdentity,
      "missing primary lexical interval remains unresolved"
    ));
  }
  if (prepared === null) {
    return candidate(key, unresolvedCoordinate(
      map.primary.domain,
      envelopeIdentity,
      "prepared lexical request identity is unavailable"
    ));
  }
  const collapse = adaptLexicalIntervalEnvelopeToCollapse(
    map.primary.envelope,
    {
      coordinate_id: `${LEXICAL_INTERVAL_PROPOSITION_ID}:${key}`,
      query_id: queryId,
      snapshot_digest: snapshotDigest,
      candidate_id: key,
      proposition_id: LEXICAL_INTERVAL_PROPOSITION_ID
    },
    ADAPTER_PROVENANCE,
    envelopeIdentity,
    prepared
  );
  const admission = issueLexicalAdmission(prepared, collapse, map);
  if (collapse.status === "collapsed" && admission === null) {
    return candidate(key, unresolvedCoordinate(
      map.primary.domain,
      envelopeIdentity,
      "verified lexical measurement authority is unavailable"
    ));
  }
  return candidate(key, {
    proposition_id: LEXICAL_INTERVAL_PROPOSITION_ID,
    proposition_schema: LEXICAL_INTERVAL_MEASUREMENT_CONTRACT.proposition_schema,
    applicable: true,
    identity: admission,
    lex_domain: map.primary.domain,
    envelope_identity: envelopeIdentity,
    collapse,
    admission
  });
}

function issueLexicalAdmission(
  authority: VerifiedMeasurementAuthorityV1,
  collapse: MeasurementCollapseV1,
  envelope: D1CandidateEnvelopeMap
): MeasurementAdmissionV1 | null {
  if (collapse.status !== "collapsed" || envelope.primary === null ||
      envelope.identity === null) return null;
  try {
    return issueMeasurementGroupAdmission({
      authority,
      contract: LEXICAL_INTERVAL_MEASUREMENT_CONTRACT,
      proposition_schema: LEXICAL_INTERVAL_MEASUREMENT_CONTRACT.proposition_schema,
      collapse,
      lexical_source: {
        envelope,
        lex_domain: envelope.primary.domain,
        envelope_identity: envelope.identity
      }
    });
  } catch {
    return null;
  }
}

function lexicalEnvelopeIdentity(
  map: D1CandidateEnvelopeMap
): D1CandidateEnvelopeMap["identity"] {
  const identity = map.identity;
  if (identity === null) return null;
  return map.field_prefix === identity.field_prefix &&
    map.query_run_id === identity.query_run_id &&
    map.snapshot_digest === identity.snapshot_digest &&
    map.request_digest === identity.request_digest
    ? identity
    : null;
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
    proposition_id: LEXICAL_INTERVAL_PROPOSITION_ID,
    proposition_schema: LEXICAL_INTERVAL_MEASUREMENT_CONTRACT.proposition_schema,
    applicable: true,
    identity: null,
    lex_domain: lexDomain,
    envelope_identity: envelopeIdentity,
    admission: null,
    collapse: { status: "unresolved", reason, observations: [] }
  };
}

function candidate(key: string, coordinate: PsiV2CoordinateV1): PsiV2CandidateV1 {
  return { candidate_id: key, coordinates: [coordinate] };
}
