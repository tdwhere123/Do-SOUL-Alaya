import type { LexicalIntervalSourceReceiptV1 } from
  "../../../field/retrieval/lexical-interval-source-receipt.js";
import type { RecallRetrievalFieldBundle } from
  "../../../field/retrieval/retrieval-field-bundle.js";
import { verifyLexicalIntervalSourceObservationV1 } from
  "../../../field/retrieval/retrieval-field-source-authority.js";
import type { SnapshotReadLeaseV1 } from
  "../../../runtime/snapshot-coherence/index.js";
import { digestRecallFieldIdentity, type RecallFieldDigest } from
  "../../../field/field-identity.js";
import type { D1CandidateEnvelopeMap, D1EnvelopeIdentity } from
  "../adapters/lexical-bound/legal-envelope.js";
import { d1IdentitiesEqual } from "../adapters/lexical-bound/legal-envelope.js";
import { requireNonemptyString, ShadowContractError } from "../../contract-primitives.js";
import { lexDomainsEqual, type LexDomain } from "../observations.js";
import {
  collapsedMeasurementCoordinateId,
  type MeasurementCollapseV1
} from "./collapse.js";
import type { MeasurementGroupContractV1 } from "./contract.js";
import { lexicalIntervalSourceEnvelopes } from "./lexical-interval-envelope.js";
import {
  LEXICAL_INTERVAL_MEASUREMENT_CONTRACT,
  LEXICAL_INTERVAL_PROPOSITION_ID
} from "./lexical-interval.js";
import type {
  AdmissibleMeasurementCollapseV1,
  LexicalMeasurementAuthorityEvidenceV1,
  VerifiedMeasurementAuthorityV1
} from "./admission.js";

type CollapsedNumericMeasurementV1 =
  Extract<MeasurementCollapseV1, { status: "collapsed" }>;

const sources = new WeakMap<object, Readonly<{
  readonly receipt: Readonly<LexicalIntervalSourceReceiptV1>;
  readonly bundle: Readonly<RecallRetrievalFieldBundle>;
  readonly lease: SnapshotReadLeaseV1;
}>>();

export type LexicalMeasurementSourceContextV1 = Readonly<{
  readonly envelope: D1CandidateEnvelopeMap;
  readonly lex_domain: LexDomain;
  readonly envelope_identity: D1EnvelopeIdentity;
}>;

export type LexicalMeasurementCoordinateContextV1 = Readonly<{
  readonly lex_domain: LexDomain | null;
  readonly envelope_identity: D1EnvelopeIdentity | null;
}>;

export type VerifiedLexicalSourceBinding = Readonly<{
  readonly digest: RecallFieldDigest;
  readonly lex_domain: LexDomain;
  readonly envelope_identity: D1EnvelopeIdentity;
  readonly source_context: LexicalMeasurementSourceContextV1;
}>;

export function bindLexicalMeasurementAuthoritySource(
  authority: VerifiedMeasurementAuthorityV1,
  evidence: LexicalMeasurementAuthorityEvidenceV1
): void {
  sources.set(authority, Object.freeze({
    receipt: evidence.lexical_source_receipt,
    bundle: evidence.lexical_source_bundle,
    lease: evidence.snapshot_read_lease
  }));
}

export function assertLexicalMeasurementSourceObservation(
  authority: VerifiedMeasurementAuthorityV1,
  contract: MeasurementGroupContractV1,
  collapse: AdmissibleMeasurementCollapseV1,
  context: LexicalMeasurementSourceContextV1 | undefined
): VerifiedLexicalSourceBinding | null {
  if (contract !== LEXICAL_INTERVAL_MEASUREMENT_CONTRACT) return null;
  if (!isNumericCollapse(collapse)) {
    throw new ShadowContractError("measurement authority lacks source-owned jurisdiction");
  }
  const source = sources.get(authority);
  const payload = collapse.witness.payload;
  if (source === undefined || source.receipt.status !== "captured" ||
      context === undefined || payload === null ||
      payload.lower !== payload.upper ||
      !isLexicalAdapterProvenance(collapse.witness.provenance)) {
    throw new ShadowContractError("lexical measurement is not bound to issued source bytes");
  }
  const candidateId = requireNonemptyString(
    collapse.witness.identity.candidate_id,
    "candidate_id"
  );
  const canonical = lexicalIntervalSourceEnvelopes(source.receipt, candidateId);
  const primary = canonical.primary;
  const identity = canonical.identity;
  if (primary === null || identity === null ||
      digestRecallFieldIdentity(context.envelope) !== digestRecallFieldIdentity(canonical) ||
      !lexDomainsEqual(context.lex_domain, primary.domain) ||
      !d1IdentitiesEqual(context.envelope_identity, identity) ||
      !canonicalWitness(collapse, authority, candidateId, primary.envelope.lower)) {
    throw new ShadowContractError("lexical measurement is not the canonical adapter collapse");
  }
  try {
    verifyLexicalIntervalSourceObservationV1(source.receipt, {
      bundle: source.bundle,
      lease: source.lease,
      candidate_key: candidateId,
      normalized_rank: payload.lower
    });
  } catch {
    throw new ShadowContractError("lexical measurement source authority is not active and exact");
  }
  return Object.freeze({
    digest: digestRecallFieldIdentity({
      candidate_id: candidateId,
      envelope: canonical,
      witness: collapse.witness,
      contract_digest: contract.digest
    }),
    lex_domain: primary.domain,
    envelope_identity: identity,
    source_context: context
  });
}

export function lexicalSourceContext(
  binding: VerifiedLexicalSourceBinding | { readonly digest: RecallFieldDigest } | null
): LexicalMeasurementSourceContextV1 | undefined {
  return binding !== null && "source_context" in binding ? binding.source_context : undefined;
}

export function lexicalCoordinateMatchesSourceBinding(
  binding: VerifiedLexicalSourceBinding | { readonly digest: RecallFieldDigest } | null,
  context: LexicalMeasurementCoordinateContextV1 | undefined
): boolean {
  if (binding === null || !("lex_domain" in binding)) return context === undefined;
  return context !== undefined && context.lex_domain !== null &&
    context.envelope_identity !== null &&
    lexDomainsEqual(binding.lex_domain, context.lex_domain) &&
    d1IdentitiesEqual(binding.envelope_identity, context.envelope_identity);
}

function isNumericCollapse(
  collapse: AdmissibleMeasurementCollapseV1
): collapse is CollapsedNumericMeasurementV1 {
  return collapse.witness.domain === "numeric_interval";
}

function isLexicalAdapterProvenance(
  provenance: CollapsedNumericMeasurementV1["witness"]["provenance"]
): boolean {
  return provenance.length === 1 &&
    provenance[0]?.source_id === "lexical.interval.primary" &&
    provenance[0]?.producer === "lexical.interval.adapter.v1";
}

function canonicalWitness(
  collapse: CollapsedNumericMeasurementV1,
  authority: VerifiedMeasurementAuthorityV1,
  candidateId: string,
  rank: number
): boolean {
  const witness = collapse.witness;
  const identity = witness.identity;
  const payload = witness.payload;
  return collapse.contract === LEXICAL_INTERVAL_MEASUREMENT_CONTRACT &&
    witness.domain === "numeric_interval" && witness.epistemic.kind === "exact" &&
    payload !== null && payload.lower === rank && payload.upper === rank &&
    identity.coordinate_id ===
      collapsedMeasurementCoordinateId(LEXICAL_INTERVAL_PROPOSITION_ID) &&
    identity.query_id === authority.query_id &&
    identity.snapshot_digest === authority.snapshot_digest &&
    identity.candidate_id === candidateId &&
    identity.proposition_id === LEXICAL_INTERVAL_PROPOSITION_ID;
}
