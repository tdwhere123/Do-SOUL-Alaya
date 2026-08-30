import type { FineAssessParams } from "../delivery/fine-assessment.js";
import { buildRecallCandidateDedupeKey } from
  "../runtime/recall-service-helpers.js";
import {
  admitLiveLexicalIntervalSources,
  liveQueryProofAuthorityFailureCode,
  verifyLiveQueryProofAuthority,
  type LiveQueryProofAuthorityFailureCode,
  type VerifiedLiveQueryProofPins
} from "../runtime/query/live-query-proof-authority.js";
import type { ShadowIntegrateInput } from "./integrate.js";
import {
  lexicalIntervalSourceEnvelopes
} from "./measurement/lexical-interval-envelope.js";
import {
  verifyLexicalMeasurementPreparedAuthorityV1,
  verifySupportMeasurementPreparedAuthorityV1,
  type VerifiedMeasurementAuthorityV1
} from "./measurement/index.js";
import {
  materializeSupportFromReceipts,
  type SupportMaterializationV1
} from "./support/index.js";
import {
  liveSupportReceiptsMatchProjection,
  projectLiveSupportCandidateReceipts,
  supportReceiptBindsCurrentQuery,
  supportReceiptIsPropositionLegal
} from "./live-support-receipts.js";
import type { PsiV2ProducerOutcomeV1 } from "./psi-v2/index.js";

type LiveAuthority = NonNullable<FineAssessParams["queryProofAuthority"]>;
type ProducerResult<T> = Readonly<{
  readonly payload?: T;
  readonly measurementAuthority?: VerifiedMeasurementAuthorityV1;
  readonly outcome: PsiV2ProducerOutcomeV1;
}>;

export function materializePsiV2ShadowInput(
  params: FineAssessParams
): Pick<ShadowIntegrateInput,
  "lexicalIntervalEnvelopesByKey" | "supportMaterialization" |
  "lexical_measurement_authority" | "support_measurement_authority" |
  "psi_v2_producer_outcomes" | "query_id" | "snapshot_digest"> {
  const authority = params.queryProofAuthority;
  const authorityState = verifyAuthority(params, authority);
  const lexical = materializeLexicalIntervals(params, authorityState);
  const support = materializeSupport(params, authorityState);
  return {
    psi_v2_producer_outcomes: Object.freeze([lexical.outcome, support.outcome]),
    ...(authorityState.status === "verified" ? authorityState.pins : {}),
    ...(lexical.payload === undefined ? {} : {
      lexicalIntervalEnvelopesByKey: lexical.payload,
      lexical_measurement_authority: lexical.measurementAuthority
    }),
    ...(support.payload === undefined ? {} : {
      supportMaterialization: support.payload,
      support_measurement_authority: support.measurementAuthority
    })
  };
}

type AuthorityState =
  | Readonly<{ readonly status: "verified"; readonly authority: LiveAuthority;
      readonly pins: VerifiedLiveQueryProofPins }>
  | Readonly<{ readonly status: "unavailable" }>
  | Readonly<{ readonly status: "identity_mismatch" }>
  | Readonly<{ readonly status: "verification_failed";
      readonly failure_code: LiveQueryProofAuthorityFailureCode | null }>;

function verifyAuthority(
  params: FineAssessParams,
  authority: LiveAuthority | undefined
): AuthorityState {
  if (authority === undefined) return Object.freeze({ status: "unavailable" });
  if (authority.workspace_id !== params.workspace_id) {
    return Object.freeze({ status: "identity_mismatch" });
  }
  try {
    return Object.freeze({
      status: "verified",
      authority,
      pins: verifyLiveQueryProofAuthority(authority)
    });
  } catch (error) {
    return Object.freeze({
      status: "verification_failed",
      failure_code: liveQueryProofAuthorityFailureCode(error)
    });
  }
}

function materializeLexicalIntervals(
  params: FineAssessParams,
  authorityState: AuthorityState
): ProducerResult<NonNullable<ShadowIntegrateInput["lexicalIntervalEnvelopesByKey"]>> {
  if (params.lexicalIntervalSources !== undefined) {
    return materializeLexicalIntervalSources(params, authorityState);
  }
  return materializeLegacyLexicalIntervals(params, authorityState);
}

function materializeLexicalIntervalSources(
  params: FineAssessParams,
  authorityState: AuthorityState
): ProducerResult<NonNullable<ShadowIntegrateInput["lexicalIntervalEnvelopesByKey"]>> {
  const values = params.lexicalIntervalSources;
  if (values === undefined || values.length === 0) return absent("lex.interval");
  const preflight = lexicalIntervalSourcePreflight(values, authorityState);
  if (preflight !== null) return preflight;
  if (authorityState.status !== "verified") {
    return malformed("lex.interval", "diagnostic_contract_failure");
  }
  const authority = authorityState.authority;
  try {
    const admitted = admitLiveLexicalIntervalSources(authority, values);
    if (admitted === undefined) return malformed("lex.interval", "producer_contract_invalid");
    if (admitted.some((source) => source.status === "unavailable")) {
      return unavailable("lex.interval", "source_unavailable");
    }
    const relaxed = admitted.filter((source) =>
      source.status === "captured" && source.field_prefix === "lexical_relaxed");
    if (relaxed.length !== 1) return unavailable("lex.interval", "source_unavailable");
    const source = relaxed[0];
    if (source === undefined || source.status !== "captured") {
      return unavailable("lex.interval", "source_unavailable");
    }
    const pin = authority.expected_lexical_request_pins.find((candidate) =>
      sourcePinKey(candidate) === sourcePinKey(source));
    if (pin === undefined) return malformed("lex.interval", "measurement_identity_pin_absent");
    const measurementAuthority = verifyLexicalMeasurementPreparedAuthorityV1({
      evidence: {
        ...preparedEvidence(authority),
        lexical_request_pin: pin,
        lexical_source_receipt: source,
        lexical_source_bundle: authority.lexical_source_bundle!
      }
    });
    const envelopes = Object.freeze(Object.fromEntries(params.candidates.map((candidate) => {
      const key = buildRecallCandidateDedupeKey(candidate);
      return [key, lexicalIntervalSourceEnvelopes(source, key)];
    })));
    if (!Object.values(envelopes).some((envelope) => envelope.primary !== null)) {
      return notObserved("lex.interval", "applicable_receipt_absent");
    }
    return Object.freeze({
      payload: envelopes,
      measurementAuthority,
      outcome: observed("lex.interval")
    });
  } catch {
    return malformed("lex.interval", "producer_contract_invalid");
  }
}

function lexicalIntervalSourcePreflight(
  values: NonNullable<FineAssessParams["lexicalIntervalSources"]>,
  authorityState: AuthorityState
): ProducerResult<never> | null {
  const keys = values.map(sourcePinKey);
  if (new Set(keys).size !== keys.length) return malformed("lex.interval", "duplicate_receipt");
  const authorityFailure = failureForAuthority("lex.interval", authorityState);
  if (authorityFailure !== null) return authorityFailure;
  if (authorityState.status !== "verified") {
    return malformed("lex.interval", "diagnostic_contract_failure");
  }
  const authority = authorityState.authority;
  if (values.some((source) =>
    source.snapshot_digest !== authority.snapshot_vector.vector_digest)) {
    return malformed("lex.interval", "authority_identity_mismatch");
  }
  const expected = new Set(authority.expected_lexical_request_pins.map(sourcePinKey));
  if (keys.some((key) => !expected.has(key))) {
    return malformed("lex.interval", "authority_identity_mismatch");
  }
  if (keys.length < expected.size) return unavailable("lex.interval", "source_unavailable");
  if (keys.length > expected.size) return malformed("lex.interval", "producer_contract_invalid");
  return null;
}

function sourcePinKey(input: Readonly<{
  readonly workspace_id: string;
  readonly request_digest: string;
  readonly field_prefix: string;
  readonly candidate_key_domain: string;
}>): string {
  return [input.workspace_id, input.request_digest,
    input.field_prefix, input.candidate_key_domain].join("\u0000");
}

function materializeLegacyLexicalIntervals(
  params: FineAssessParams,
  authorityState: AuthorityState
): ProducerResult<NonNullable<ShadowIntegrateInput["lexicalIntervalEnvelopesByKey"]>> {
  const values = params.lexicalBoundProofs;
  if (values === undefined || values.length === 0) {
    return authorityState.status === "verified"
      ? notObserved("lex.interval", "applicable_receipt_absent")
      : absent("lex.interval");
  }
  const preflight = legacyLexicalPreflight(values, authorityState);
  if (preflight !== null) return preflight;
  return notObserved("lex.interval", "applicable_receipt_absent");
}

function legacyLexicalPreflight(
  values: NonNullable<FineAssessParams["lexicalBoundProofs"]>,
  authorityState: AuthorityState
): ProducerResult<never> | null {
  if (values.every((proof) => proof.status === "proof_absent")) {
    if (values.length !== 1) return malformed("lex.interval", "duplicate_receipt");
    return authorityState.status === "verified"
      ? notObserved("lex.interval", "applicable_receipt_absent")
      : absent("lex.interval");
  }
  if (values.some((proof) => proof.status !== "captured")) {
    return malformed("lex.interval", "producer_contract_invalid");
  }
  const authorityFailure = failureForAuthority("lex.interval", authorityState);
  if (authorityFailure !== null) return authorityFailure;
  if (authorityState.status !== "verified") {
    return malformed("lex.interval", "diagnostic_contract_failure");
  }
  return null;
}

function materializeSupport(
  params: FineAssessParams,
  authorityState: AuthorityState
): ProducerResult<SupportMaterializationV1> {
  const receipts = params.supportCandidateReceipts;
  if (receipts === undefined || receipts.length === 0) {
    return authorityState.status === "verified"
      ? notObserved("support", "applicable_receipt_absent")
      : absent("support");
  }
  const rejected = rejectInvalidSupportReceipts(receipts, params, authorityState);
  if (rejected !== null) return rejected;
  if (!receipts.every(supportReceiptIsPropositionLegal)) {
    return malformed("support", "producer_contract_invalid");
  }
  if (authorityState.status !== "verified") {
    return malformed("support", "diagnostic_contract_failure");
  }
  return observeVerifiedSupport(params, authorityState, receipts);
}

function rejectInvalidSupportReceipts(
  receipts: NonNullable<FineAssessParams["supportCandidateReceipts"]>,
  params: FineAssessParams,
  authorityState: AuthorityState
): ProducerResult<never> | null {
  if (receipts.some((receipt) => !supportReceiptShapeValid(receipt))) {
    return malformed("support", "producer_contract_invalid");
  }
  const candidateKeys = new Set(params.candidates.map(buildRecallCandidateDedupeKey));
  const receiptKeys = new Set(receipts.map(({ candidate_key }) => candidate_key));
  if (receiptKeys.size !== receipts.length) return malformed("support", "duplicate_receipt");
  if (receipts.some(({ candidate_key }) => !candidateKeys.has(candidate_key))) {
    return malformed("support", "foreign_candidate_receipt");
  }
  return failureForAuthority("support", authorityState);
}

function observeVerifiedSupport(
  params: FineAssessParams,
  authorityState: Extract<AuthorityState, { status: "verified" }>,
  receipts: NonNullable<FineAssessParams["supportCandidateReceipts"]>
): ProducerResult<SupportMaterializationV1> {
  const lease = authorityState.authority.snapshot_read_lease;
  const capability = lease.capabilities.find((bound) =>
    bound.source_owner === "path_graph_generation");
  if (capability === undefined) {
    return notObserved("support", "applicable_receipt_absent");
  }
  if (capability.view_kind !== "captured" && capability.view_kind !== "pinned") {
    return unavailable("support", "source_unavailable");
  }
  const compilation = authorityState.authority.canonical_query_compilation;
  if (!receipts.every((receipt) => supportReceiptBindsCurrentQuery(receipt, compilation))) {
    return malformed("support", "authority_identity_mismatch");
  }
  const projected = projectLiveSupportCandidateReceipts(
    params.candidates,
    params.supplementaryData,
    compilation
  );
  if (!liveSupportReceiptsMatchProjection(receipts, projected)) {
    return malformed("support", "producer_contract_invalid");
  }
  try {
    const payload = materializeSupportFromReceipts({
      query_id: authorityState.pins.query_id,
      snapshot_digest: authorityState.pins.snapshot_digest,
      authority_context: {
        snapshot_vector: authorityState.authority.snapshot_vector,
        snapshot_receipt: authorityState.authority.snapshot_coherence_receipt,
        read_lease: lease
      },
      candidates: receipts
    });
    const measurementAuthority = verifySupportMeasurementPreparedAuthorityV1({
      evidence: {
        ...preparedEvidence(authorityState.authority),
        support_source_capability: capability
      }
    });
    return Object.freeze({
      payload,
      measurementAuthority,
      outcome: observed("support")
    });
  } catch {
    return malformed("support", "producer_contract_invalid");
  }
}

function supportReceiptShapeValid(
  receipt: FineAssessParams["supportCandidateReceipts"] extends readonly (infer T)[] | undefined
    ? T
    : never
): boolean {
  if (typeof receipt.candidate_key !== "string" || receipt.candidate_key.length === 0) {
    return false;
  }
  if (receipt.evidence_ids !== undefined && !Array.isArray(receipt.evidence_ids)) return false;
  if (receipt.fact_frames !== undefined && !Array.isArray(receipt.fact_frames)) return false;
  const osf = receipt.osf;
  if (osf === undefined) return true;
  if (!(["composed", "no_match", "ineligible", "unavailable", "rejected", "absent"]
    .includes(osf.composition_status))) return false;
  return osf.bindings === undefined || Array.isArray(osf.bindings);
}

function failureForAuthority(
  producerId: PsiV2ProducerOutcomeV1["producer_id"],
  state: AuthorityState
): ProducerResult<never> | null {
  if (state.status === "verified") return null;
  if (state.status === "unavailable") return unavailable(producerId, "authority_unavailable");
  if (state.status === "identity_mismatch") {
    return malformed(producerId, "authority_identity_mismatch");
  }
  return malformed(producerId, state.failure_code === null
    ? "authority_verification_failed"
    : AUTHORITY_CONTRACT_CODES[state.failure_code]);
}

type MalformedContractCode =
  Extract<PsiV2ProducerOutcomeV1, { status: "malformed" }>["contract_code"];

const AUTHORITY_CONTRACT_CODES = Object.freeze({
  query_condition_invalid: "authority_query_condition_invalid",
  workspace_identity_mismatch: "authority_workspace_identity_mismatch",
  canonical_query_invalid: "authority_canonical_query_invalid",
  canonical_query_identity_mismatch: "authority_canonical_query_identity_mismatch",
  canonical_snapshot_receipt_mismatch: "authority_canonical_snapshot_receipt_mismatch",
  snapshot_vector_invalid: "authority_snapshot_vector_invalid",
  snapshot_coherence_invalid: "authority_snapshot_coherence_invalid",
  snapshot_lease_invalid: "authority_snapshot_lease_invalid",
  lexical_request_pin_invalid: "authority_lexical_request_pin_invalid"
}) satisfies Readonly<Record<LiveQueryProofAuthorityFailureCode, MalformedContractCode>>;

function observed(producer_id: PsiV2ProducerOutcomeV1["producer_id"]): PsiV2ProducerOutcomeV1 {
  return Object.freeze({ producer_id, status: "observed" as const });
}

function absent(producer_id: PsiV2ProducerOutcomeV1["producer_id"]): ProducerResult<never> {
  return Object.freeze({
    outcome: Object.freeze({ producer_id, status: "not_observed", reason: "input_absent" })
  });
}

function notObserved(
  producer_id: PsiV2ProducerOutcomeV1["producer_id"],
  reason: Extract<PsiV2ProducerOutcomeV1, { status: "not_observed" }>["reason"]
): ProducerResult<never> {
  return Object.freeze({
    outcome: Object.freeze({ producer_id, status: "not_observed", reason })
  });
}

function unavailable(
  producer_id: PsiV2ProducerOutcomeV1["producer_id"],
  reason: Extract<PsiV2ProducerOutcomeV1, { status: "producer_unavailable" }>["reason"]
): ProducerResult<never> {
  return Object.freeze({
    outcome: Object.freeze({ producer_id, status: "producer_unavailable", reason })
  });
}

function malformed(
  producer_id: PsiV2ProducerOutcomeV1["producer_id"],
  contract_code: Extract<PsiV2ProducerOutcomeV1, { status: "malformed" }>["contract_code"]
): ProducerResult<never> {
  return Object.freeze({
    outcome: Object.freeze({ producer_id, status: "malformed", contract_code })
  });
}

function preparedEvidence(
  authority: LiveAuthority
) {
  return {
    workspace_id: authority.workspace_id,
    query_condition: authority.query_condition,
    canonical_query_evidence: authority.canonical_query_evidence,
    canonical_query_compilation: authority.canonical_query_compilation,
    snapshot_vector: authority.snapshot_vector,
    snapshot_coherence_receipt: authority.snapshot_coherence_receipt,
    snapshot_read_lease: authority.snapshot_read_lease
  };
}
