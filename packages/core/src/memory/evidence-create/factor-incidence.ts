import {
  FACTOR_INCIDENCE_OPERATOR_ID,
  OPEN_SEMANTIC_FACTOR_FORMATION_OPERATOR_ID,
  hashDerivationJobId,
  verifyDerivationJobReceipt,
  verifyFactorIncidence,
  type DerivationJobReceipt,
  type FactorDescriptor,
  type FactorIncidence,
  type FactorIncidencePort,
  type FieldContractSha256,
  type OpenSemanticFactorFormationCapture
} from "@do-soul/alaya-protocol";
import type { OpenSemanticFactorExtractionPort } from
  "../../semantic/open-semantic-factor-extraction-port.js";
import type { FieldFormationStores } from "./field-stores.js";
import {
  EVIDENCE_OSF_SEMANTIC_COMPLETENESS_OPERATOR_ID,
  verifyEvidenceSemanticCompletenessReceipt,
  type EvidenceOsfSemanticCompletenessReceipt
} from "./evidence-semantic-completeness.js";

export function createFactorIncidencePort(input: Readonly<{
  readonly sha256: FieldContractSha256;
  readonly stores: FieldFormationStores;
}>): FactorIncidencePort {
  return {
    recordIncidence: (incidence) => input.stores.putIncidence(
      verifyFactorIncidence(incidence, input.sha256)
    ),
    nominateJob: (job) => input.stores.putJob(verifyDerivationJobReceipt(job, input.sha256))
  };
}

export function nominateSemanticDerivationJob(input: Readonly<{
  readonly sha256: FieldContractSha256;
  readonly incidence: FactorIncidencePort;
  readonly extractor?: OpenSemanticFactorExtractionPort;
  readonly workspace_id: string;
  readonly evidence_object_id: string;
  readonly recorded_at: string;
}>): DerivationJobReceipt | null {
  idleExtractor(input.extractor);
  const operatorId = OPEN_SEMANTIC_FACTOR_FORMATION_OPERATOR_ID;
  const evidenceIds = Object.freeze([input.evidence_object_id]);
  const identity = hashDerivationJobId({
    purpose: "f3_semantic",
    operator_id: operatorId,
    input_evidence_ids: evidenceIds
  }, input.sha256);
  return input.incidence.nominateJob({
    schema_version: 1,
    producer: FACTOR_INCIDENCE_OPERATOR_ID,
    consumer: "projection_generation",
    identity,
    replay_rule: "idempotent_same_identity",
    failure_disposition: "fail_closed",
    governance_effect: "none",
    deletion_behavior: "rebuildable",
    workspace_id: input.workspace_id,
    purpose: "f3_semantic",
    operator_id: operatorId,
    input_evidence_ids: evidenceIds,
    status: "nominated",
    disposition: "pending",
    recorded_at: input.recorded_at
  });
}

export function persistSemanticFormationReceipt(input: Readonly<{
  readonly sha256: FieldContractSha256;
  readonly incidence: FactorIncidencePort;
  readonly workspace_id: string;
  readonly evidence_object_id: string;
  readonly recorded_at: string;
  readonly capture: Readonly<OpenSemanticFactorFormationCapture>;
  readonly factFrame: Parameters<typeof verifyEvidenceSemanticCompletenessReceipt>[0]["factFrame"];
  readonly sourceText: string;
  readonly semanticCompleteness: Readonly<EvidenceOsfSemanticCompletenessReceipt>;
}>): DerivationJobReceipt | null {
  const producer = input.capture.producer_operator_id;
  if (input.capture.status !== "formed" || producer === null ||
      input.semanticCompleteness.status !== "certified") return null;
  verifyEvidenceSemanticCompletenessReceipt({
    receipt: input.semanticCompleteness,
    sourceText: input.sourceText,
    factFrame: input.factFrame,
    semanticFormation: input.capture
  });
  const evidenceIds = Object.freeze([input.evidence_object_id]);
  const identityInput = {
    purpose: "f3_semantic_capture",
    operator_id: EVIDENCE_OSF_SEMANTIC_COMPLETENESS_OPERATOR_ID,
    input_evidence_ids: evidenceIds
  };
  return input.incidence.nominateJob({
    schema_version: 1,
    producer: FACTOR_INCIDENCE_OPERATOR_ID,
    consumer: "projection_generation",
    identity: hashDerivationJobId(identityInput, input.sha256),
    replay_rule: "idempotent_same_identity",
    failure_disposition: "fail_closed",
    governance_effect: "none",
    deletion_behavior: "rebuildable",
    workspace_id: input.workspace_id,
    ...identityInput,
    status: "succeeded",
    disposition: input.semanticCompleteness.receipt_digest,
    recorded_at: input.recorded_at
  });
}

export function persistIncidences(
  port: FactorIncidencePort,
  incidences: readonly FactorIncidence[]
): readonly FactorIncidence[] {
  return Object.freeze(incidences.map((incidence) => port.recordIncidence(incidence)));
}

export function persistDescriptors(
  stores: FieldFormationStores,
  factors: readonly FactorDescriptor[]
): void {
  for (const factor of factors) {
    stores.putDescriptor(factor);
  }
}

function idleExtractor(extractor?: OpenSemanticFactorExtractionPort): void {
  if (extractor === undefined) return;
}
