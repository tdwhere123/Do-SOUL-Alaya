import {
  QueryConditionReceiptSchema,
  verifyQueryConditionReceipt,
  type QueryConditionReceipt
} from "@do-soul/alaya-protocol";
import { digestRecallFieldIdentity, type RecallFieldDigest } from
  "../../../field/field-identity.js";
import { sameTextSet } from "../../../../shared/compare-text.js";
import type { LexicalRequestPin } from
  "../../../field/retrieval/retrieval-field-bundle.js";
import type { RecallRetrievalFieldBundle } from
  "../../../field/retrieval/retrieval-field-bundle.js";
import type { LexicalIntervalSourceReceiptV1 } from
  "../../../field/retrieval/lexical-interval-source-receipt.js";
import { verifyLexicalIntervalSourceReceiptV1 } from
  "../../../field/retrieval/retrieval-field-source-authority.js";
import {
  verifyCanonicalQueryCompilationV1,
  type CanonicalQueryCompilationV1,
  type CanonicalQueryEvidenceV1
} from "../../../query/canonical-query/index.js";
import { fieldContractSha256 } from "../../../../shared/field-hash.js";
import { freezeShadow, requireNonemptyString, ShadowContractError } from
  "../../contract-primitives.js";
import {
  finalizePreparedSnapshotReadLease,
  verifySnapshotCoherenceReceiptV1,
  verifySnapshotVectorV1,
  type SnapshotCoherenceReceiptV1,
  type SnapshotReadLeaseV1,
  type SnapshotVectorV1
} from "../../../runtime/snapshot-coherence/index.js";
import type { WitnessIdentityPins } from "../witness/index.js";
import type { MeasurementCollapseV1 } from "./collapse.js";
import type { MeasurementGroupContractV1 } from "./contract.js";
import { LEXICAL_INTERVAL_MEASUREMENT_CONTRACT } from "./lexical-interval.js";
import {
  assertLexicalMeasurementSourceObservation,
  bindLexicalMeasurementAuthoritySource,
  lexicalCoordinateMatchesSourceBinding,
  lexicalSourceContext,
  type LexicalMeasurementCoordinateContextV1,
  type LexicalMeasurementSourceContextV1,
  type VerifiedLexicalSourceBinding
} from "./lexical-source-admission.js";
import {
  PROPOSITION_STATE_MEASUREMENT_CONTRACT,
  type PropositionStateCollapseV1
} from "./proposition-state.js";
import {
  assertSupportMeasurementSourceObservation,
  bindSupportMeasurementAuthoritySource,
  supportMeasurementSourceIdentity,
  type SupportMeasurementAuthorityEvidenceV1
} from "./support-source-admission.js";

type CollapsedNumericMeasurementV1 =
  Extract<MeasurementCollapseV1, { status: "collapsed" }>;
type CollapsedPropositionStateV1 =
  Extract<PropositionStateCollapseV1, { status: "collapsed" }>;
export type AdmissibleMeasurementCollapseV1 =
  | CollapsedNumericMeasurementV1
  | CollapsedPropositionStateV1;

declare const VERIFIED_MEASUREMENT_AUTHORITY: unique symbol;

export type VerifiedMeasurementAuthorityV1 = Readonly<{
  readonly query_id: string;
  readonly snapshot_digest: string;
  readonly request_digest: string;
  readonly workspace_id: string;
  readonly principal: string;
  readonly field_prefix: LexicalRequestPin["field_prefix"] | null;
  readonly candidate_key_domain: LexicalRequestPin["candidate_key_domain"] | null;
  readonly contract_digest: RecallFieldDigest;
  readonly authority_digest: RecallFieldDigest;
  readonly [VERIFIED_MEASUREMENT_AUTHORITY]: true;
}>;

export type PreparedMeasurementAuthorityEvidenceV1 = Readonly<{
  readonly workspace_id: string;
  readonly query_condition: QueryConditionReceipt;
  readonly canonical_query_evidence: CanonicalQueryEvidenceV1;
  readonly canonical_query_compilation: CanonicalQueryCompilationV1;
  readonly snapshot_vector: SnapshotVectorV1;
  readonly snapshot_coherence_receipt: SnapshotCoherenceReceiptV1;
  readonly snapshot_read_lease: SnapshotReadLeaseV1;
}>;

export type LexicalMeasurementAuthorityEvidenceV1 =
  PreparedMeasurementAuthorityEvidenceV1 & Readonly<{
    readonly lexical_request_pin: Readonly<LexicalRequestPin>;
    readonly lexical_source_receipt: Readonly<LexicalIntervalSourceReceiptV1>;
    readonly lexical_source_bundle: Readonly<RecallRetrievalFieldBundle>;
  }>;

export type MeasurementAdmissionV1 = Readonly<{
  readonly schema_version: 1;
  readonly admission_id: "recall.measurement.admission.v1";
  readonly authority_digest: RecallFieldDigest;
  readonly contract_digest: RecallFieldDigest;
  readonly operator_id: string;
  readonly operator_version: string;
  readonly proposition_schema: string;
  readonly coordinate_id: string;
  readonly query_id: string;
  readonly snapshot_digest: string;
  readonly request_digest: string;
  readonly workspace_id: string;
  readonly principal: string;
  readonly candidate_id: string;
  readonly proposition_id: string;
  readonly hypothesis_digest: string | null;
  readonly jurisdiction: string;
  readonly producer_outcome: "observed";
  readonly measurement_digest: RecallFieldDigest;
  readonly source_binding_digest: RecallFieldDigest | null;
  readonly digest: RecallFieldDigest;
}>;

export type MeasurementCoordinateIdentityV1 = Pick<
  MeasurementAdmissionV1,
  | "coordinate_id"
  | "query_id"
  | "snapshot_digest"
  | "request_digest"
  | "workspace_id"
  | "candidate_id"
  | "proposition_id"
>;

export type MeasurementAdmissionValidationV1 =
  | Readonly<{ readonly status: "admitted" }>
  | Readonly<{ readonly status: "blocked"; readonly reason: string }>;

export type CurrentMeasurementAuthoritiesV1 =
  readonly VerifiedMeasurementAuthorityV1[];

const PREDECLARED_CONTRACTS = new Set<MeasurementGroupContractV1>([
  LEXICAL_INTERVAL_MEASUREMENT_CONTRACT,
  PROPOSITION_STATE_MEASUREMENT_CONTRACT
]);
const VERIFIED_AUTHORITIES = new WeakSet<object>();
const ISSUED_ADMISSIONS = new WeakSet<object>();
const ADMISSION_AUTHORITIES = new WeakMap<object, VerifiedMeasurementAuthorityV1>();
const ADMISSION_SOURCE_BINDINGS = new WeakMap<object, VerifiedLexicalSourceBinding | { readonly digest: RecallFieldDigest }>();

export function verifyLexicalMeasurementPreparedAuthorityV1(input: Readonly<{
  readonly evidence: LexicalMeasurementAuthorityEvidenceV1;
}>): VerifiedMeasurementAuthorityV1 {
  const authority = verifyPreparedAuthority(
    input.evidence,
    LEXICAL_INTERVAL_MEASUREMENT_CONTRACT,
    lexicalMeasurementSourceIdentity(input.evidence)
  );
  bindLexicalMeasurementAuthoritySource(authority, input.evidence);
  return authority;
}

export function verifySupportMeasurementPreparedAuthorityV1(input: Readonly<{
  readonly evidence: SupportMeasurementAuthorityEvidenceV1;
}>): VerifiedMeasurementAuthorityV1 {
  const authority = verifyPreparedAuthority(
    input.evidence,
    PROPOSITION_STATE_MEASUREMENT_CONTRACT,
    supportMeasurementSourceIdentity(input.evidence)
  );
  bindSupportMeasurementAuthoritySource(authority, input.evidence);
  return authority;
}

function verifyPreparedAuthority(
  evidence: PreparedMeasurementAuthorityEvidenceV1,
  contract: MeasurementGroupContractV1,
  source: Readonly<{
    readonly request_digest: string;
    readonly field_prefix: LexicalRequestPin["field_prefix"] | null;
    readonly candidate_key_domain: LexicalRequestPin["candidate_key_domain"] | null;
  }>
): VerifiedMeasurementAuthorityV1 {
  requirePredeclaredContract(contract);
  const livePins = verifyPreparedEvidence(evidence);
  const body = freezeShadow({
    query_id: livePins.query_id,
    snapshot_digest: livePins.snapshot_digest,
    request_digest: source.request_digest,
    workspace_id: livePins.workspace_id,
    principal: livePins.principal,
    field_prefix: source.field_prefix,
    candidate_key_domain: source.candidate_key_domain,
    contract_digest: contract.digest,
    authority_digest: digestRecallFieldIdentity({
      canonical_query_compilation_digest:
        evidence.canonical_query_compilation.digest,
      snapshot_vector_digest: evidence.snapshot_vector.vector_digest,
      snapshot_receipt_digest:
        evidence.snapshot_coherence_receipt.receipt_digest,
      snapshot_read_lease: evidence.snapshot_read_lease,
      request_digest: source.request_digest,
      workspace_id: livePins.workspace_id,
      field_prefix: source.field_prefix,
      candidate_key_domain: source.candidate_key_domain,
      contract_digest: contract.digest
    })
  });
  const authority = body as VerifiedMeasurementAuthorityV1;
  VERIFIED_AUTHORITIES.add(authority);
  return authority;
}

export function issueMeasurementGroupAdmission(input: Readonly<{
  readonly authority: VerifiedMeasurementAuthorityV1;
  readonly contract: MeasurementGroupContractV1;
  readonly proposition_schema: string;
  readonly collapse: MeasurementCollapseV1 | PropositionStateCollapseV1;
  readonly lexical_source?: LexicalMeasurementSourceContextV1;
}>): MeasurementAdmissionV1 {
  if (!VERIFIED_AUTHORITIES.has(input.authority)) {
    throw new ShadowContractError("measurement authority capability is not verified");
  }
  requirePredeclaredContract(input.contract);
  if (input.authority.contract_digest !== input.contract.digest) {
    throw new ShadowContractError("measurement authority contract mismatch");
  }
  const collapse = requireAdmissibleCollapse(input.contract, input.collapse);
  const propositionSchema = requireNonemptyString(
    input.proposition_schema,
    "proposition_schema"
  );
  if (propositionSchema !== input.contract.proposition_schema) {
    throw new ShadowContractError("measurement proposition schema mismatch");
  }
  const identity = requiredIdentity(collapse.witness.identity);
  assertAuthorityPins(input.authority, identity);
  const sourceBinding = assertLexicalMeasurementSourceObservation(
    input.authority, input.contract, collapse, input.lexical_source
  ) ?? assertSupportMeasurementSourceObservation(input.authority, input.contract, collapse);
  const body = admissionBody(
    input.authority,
    input.contract,
    propositionSchema,
    identity,
    collapse,
    sourceBinding
  );
  const admission = freezeShadow({
    ...body,
    digest: digestRecallFieldIdentity(body)
  });
  ISSUED_ADMISSIONS.add(admission);
  ADMISSION_AUTHORITIES.set(admission, input.authority);
  if (sourceBinding !== null) ADMISSION_SOURCE_BINDINGS.set(admission, sourceBinding);
  return admission;
}

export function validateMeasurementAdmissionV1(input: Readonly<{
  readonly admission: MeasurementAdmissionV1 | null;
  readonly current_authorities: CurrentMeasurementAuthoritiesV1;
  readonly contract: MeasurementGroupContractV1;
  readonly proposition_schema: string;
  readonly collapse: MeasurementCollapseV1 | PropositionStateCollapseV1;
  readonly lexical_source?: LexicalMeasurementCoordinateContextV1;
}>): MeasurementAdmissionValidationV1 {
  if (input.admission === null || !ISSUED_ADMISSIONS.has(input.admission)) {
    return blocked("measurement admission was not issued from verified authority");
  }
  try {
    requirePredeclaredContract(input.contract);
    const collapse = requireAdmissibleCollapse(input.contract, input.collapse);
    const identity = requiredIdentity(collapse.witness.identity);
    const authority = ADMISSION_AUTHORITIES.get(input.admission);
    if (input.current_authorities.some((candidate) => !VERIFIED_AUTHORITIES.has(candidate))) {
      return blocked("current measurement authority set contains an unverified capability");
    }
    const currentJurisdiction = input.current_authorities.filter((candidate) =>
      candidate.contract_digest === input.contract.digest
    );
    if (authority === undefined || !VERIFIED_AUTHORITIES.has(authority) ||
      currentJurisdiction.length !== 1 || currentJurisdiction[0] !== authority) {
      return blocked("measurement admission is not bound to current verified authority");
    }
    const binding = ADMISSION_SOURCE_BINDINGS.get(input.admission) ?? null;
    assertLexicalMeasurementSourceObservation(
      authority, input.contract, collapse, lexicalSourceContext(binding));
    assertSupportMeasurementSourceObservation(authority, input.contract, collapse);
    if (!lexicalCoordinateMatchesSourceBinding(binding, input.lexical_source)) {
      return blocked("lexical coordinate is not bound to the issued source envelope");
    }
    if ((binding?.digest ?? null) !== input.admission.source_binding_digest) {
      return blocked("source binding digest mismatch");
    }
    if (input.proposition_schema !== input.contract.proposition_schema ||
      !admissionMatches(input.admission, input.contract, identity, collapse)) {
      return blocked("measurement admission binding mismatch");
    }
    return freezeShadow({ status: "admitted" as const });
  } catch (error) {
    return blocked(error instanceof Error ? error.message : "measurement admission invalid");
  }
}

export function measurementAdmissionsShareAuthority(
  left: MeasurementAdmissionV1,
  right: MeasurementAdmissionV1
): boolean {
  const authority = ADMISSION_AUTHORITIES.get(left);
  return authority !== undefined && ADMISSION_AUTHORITIES.get(right) === authority;
}

function verifyPreparedEvidence(
  evidence: PreparedMeasurementAuthorityEvidenceV1
): Readonly<{ readonly query_id: string; readonly workspace_id: string;
  readonly principal: string; readonly snapshot_digest: string }> {
  const condition = evidence.query_condition;
  const canonicalEvidence = evidence.canonical_query_evidence;
  const compilation = evidence.canonical_query_compilation;
  const vector = evidence.snapshot_vector;
  const receipt = evidence.snapshot_coherence_receipt;
  QueryConditionReceiptSchema.parse(condition);
  verifyQueryConditionReceipt(condition, fieldContractSha256);
  verifySnapshotVectorV1(vector);
  verifySnapshotCoherenceReceiptV1(receipt, vector);
  verifyCanonicalQueryCompilationV1(compilation, canonicalEvidence, receipt);
  if (condition.condition.workspace_id !== evidence.workspace_id ||
    vector.principal !== condition.condition.principal ||
    !sameTextSet(vector.authorized_scopes, condition.condition.authorized_scopes) ||
    vector.effective_as_of !== condition.condition.effective_as_of) {
    throw new ShadowContractError("prepared measurement workspace identity mismatch");
  }
  if (compilation.query_identity.condition_identity !== condition.identity ||
    compilation.query_identity.query_operator_id !== condition.query_operator_id ||
    compilation.query_identity.generation_id !== condition.generation_id ||
    compilation.query_identity.query_cache_key !== condition.query_cache_key) {
    throw new ShadowContractError("prepared measurement canonical query identity mismatch");
  }
  if (compilation.snapshot_receipt_digest !== receipt.receipt_digest) {
    throw new ShadowContractError("prepared measurement snapshot receipt mismatch");
  }
  verifyFullFinalizedLease(evidence.snapshot_read_lease, vector);
  return freezeShadow({
    query_id: compilation.query_identity.condition_identity,
    workspace_id: condition.condition.workspace_id,
    principal: vector.principal,
    snapshot_digest: vector.vector_digest
  });
}

function verifyFullFinalizedLease(
  lease: SnapshotReadLeaseV1,
  vector: SnapshotVectorV1
): void {
  if (lease.schema_version !== 1 || lease.state !== "finalized" ||
    lease.vector_digest !== vector.vector_digest) {
    throw new ShadowContractError("prepared measurement snapshot lease is not finalized");
  }
  const reconstructed = finalizePreparedSnapshotReadLease(vector);
  if (digestRecallFieldIdentity(reconstructed) !== digestRecallFieldIdentity(lease) ||
    reconstructed.lease_id !== lease.lease_id) {
    throw new ShadowContractError("prepared measurement snapshot lease mismatch");
  }
}

function lexicalMeasurementSourceIdentity(
  evidence: LexicalMeasurementAuthorityEvidenceV1
): Readonly<{
  readonly request_digest: string;
  readonly field_prefix: LexicalRequestPin["field_prefix"] | null;
  readonly candidate_key_domain: LexicalRequestPin["candidate_key_domain"] | null;
}> {
  const pin = evidence.lexical_request_pin;
  const source = evidence.lexical_source_receipt;
  if (!validLexicalPin(pin, evidence.workspace_id) ||
      source.workspace_id !== pin.workspace_id ||
      source.request_digest !== pin.request_digest ||
      source.field_prefix !== pin.field_prefix ||
      source.candidate_key_domain !== pin.candidate_key_domain ||
      source.snapshot_digest !== evidence.snapshot_vector.vector_digest) {
    throw new ShadowContractError("lexical measurement source identity mismatch");
  }
  try {
    verifyLexicalIntervalSourceReceiptV1(source, {
      bundle: evidence.lexical_source_bundle,
      lease: evidence.snapshot_read_lease
    });
  } catch {
    throw new ShadowContractError("lexical measurement source authority is not issued");
  }
  return freezeShadow({
    request_digest: pin.request_digest,
    field_prefix: pin.field_prefix,
    candidate_key_domain: pin.candidate_key_domain
  });
}

function validLexicalPin(pin: LexicalRequestPin, workspaceId: string): boolean {
  return pin.workspace_id === workspaceId &&
    /^sha256:[0-9a-f]{64}$/u.test(pin.request_digest) &&
    (pin.field_prefix === "lexical_relaxed" || pin.field_prefix === "lexical_expanded") &&
    pin.candidate_key_domain === "memory_object_id";
}

function requirePredeclaredContract(contract: MeasurementGroupContractV1): void {
  if (!PREDECLARED_CONTRACTS.has(contract)) {
    throw new ShadowContractError("measurement contract is not predeclared");
  }
}

function requireAdmissibleCollapse(
  contract: MeasurementGroupContractV1,
  collapse: MeasurementCollapseV1 | PropositionStateCollapseV1
): AdmissibleMeasurementCollapseV1 {
  if (collapse.status !== "collapsed" || collapse.contract !== contract) {
    throw new ShadowContractError("collapse is not bound to the admitted contract");
  }
  if (contract.measurement_domain !== collapse.witness.domain) {
    throw new ShadowContractError("measurement domain does not match collapsed witness");
  }
  return collapse;
}

function assertAuthorityPins(
  authority: VerifiedMeasurementAuthorityV1,
  identity: ReturnType<typeof requiredIdentity>
): void {
  if (authority.query_id !== identity.query_id ||
    authority.snapshot_digest !== identity.snapshot_digest) {
    throw new ShadowContractError("verified query or snapshot authority mismatch");
  }
}

function requiredIdentity(identity: WitnessIdentityPins): Readonly<{
  readonly coordinate_id: string;
  readonly query_id: string;
  readonly snapshot_digest: string;
  readonly candidate_id: string;
  readonly proposition_id: string;
}> {
  return freezeShadow({
    coordinate_id: requireNonemptyString(identity.coordinate_id, "coordinate_id"),
    query_id: requireNonemptyString(identity.query_id, "query_id"),
    snapshot_digest: requireNonemptyString(identity.snapshot_digest, "snapshot_digest"),
    candidate_id: requireNonemptyString(identity.candidate_id, "candidate_id"),
    proposition_id: requireNonemptyString(identity.proposition_id, "proposition_id")
  });
}

function admissionBody(
  authority: VerifiedMeasurementAuthorityV1,
  contract: MeasurementGroupContractV1,
  propositionSchema: string,
  identity: ReturnType<typeof requiredIdentity>,
  collapse: AdmissibleMeasurementCollapseV1,
  sourceBinding: Readonly<{
    readonly digest: RecallFieldDigest;
    readonly hypothesis_digest?: string | null;
    readonly jurisdiction?: string;
  }> | null
) {
  return freezeShadow({
    schema_version: 1 as const,
    admission_id: "recall.measurement.admission.v1" as const,
    authority_digest: authority.authority_digest,
    contract_digest: contract.digest,
    operator_id: contract.operator_id,
    operator_version: contract.operator_version,
    proposition_schema: propositionSchema,
    ...identity,
    request_digest: authority.request_digest,
    workspace_id: authority.workspace_id,
    principal: authority.principal,
    hypothesis_digest: sourceBinding?.hypothesis_digest ?? null,
    jurisdiction: sourceBinding?.jurisdiction ?? authority.field_prefix ?? "support",
    producer_outcome: "observed" as const,
    measurement_digest: measurementDigest(contract, collapse),
    source_binding_digest: sourceBinding?.digest ?? null
  });
}

function admissionMatches(
  admission: MeasurementAdmissionV1,
  contract: MeasurementGroupContractV1,
  identity: ReturnType<typeof requiredIdentity>,
  collapse: AdmissibleMeasurementCollapseV1
): boolean {
  const body = {
    schema_version: admission.schema_version,
    admission_id: admission.admission_id,
    authority_digest: admission.authority_digest,
    contract_digest: contract.digest,
    operator_id: contract.operator_id,
    operator_version: contract.operator_version,
    proposition_schema: contract.proposition_schema,
    ...identity,
    request_digest: admission.request_digest,
    workspace_id: admission.workspace_id,
    principal: admission.principal,
    hypothesis_digest: admission.hypothesis_digest,
    jurisdiction: admission.jurisdiction,
    producer_outcome: admission.producer_outcome,
    measurement_digest: measurementDigest(contract, collapse),
    source_binding_digest: admission.source_binding_digest
  };
  return admission.digest === digestRecallFieldIdentity(body) &&
    admission.contract_digest === contract.digest &&
    admission.measurement_digest === body.measurement_digest;
}

function measurementDigest(
  contract: MeasurementGroupContractV1,
  collapse: AdmissibleMeasurementCollapseV1
): RecallFieldDigest {
  return digestRecallFieldIdentity({ contract_digest: contract.digest, witness: collapse.witness });
}

function blocked(reason: string): MeasurementAdmissionValidationV1 {
  return freezeShadow({ status: "blocked" as const, reason });
}
