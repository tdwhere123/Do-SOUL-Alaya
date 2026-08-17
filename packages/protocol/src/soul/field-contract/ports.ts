import type { AddressableSourceSpan, AddressableSourceSpanPurpose, SourceRecordIdentity } from "./source-span.js";
import type { DerivationJobReceipt, FactorIncidence } from "./factor-incidence.js";
import type {
  FieldProjectionGeneration,
  ProjectionEraseBarrier,
  ProjectionGenerationPointer,
  ProjectionPin,
  ProjectionPinRelease
} from "./projection-generation.js";
import type { QueryCondition, QueryConditionReceipt } from "./query-condition.js";
import type { CausalUsageReceipt } from "./causal-usage.js";
import type { EffectDecisionReceipt, EffectRequest } from "./proof-effect.js";
import type { FieldStopCertificateReceipt } from "./stop-certificate.js";

export type SourceAdmissionRequest = Readonly<{
  readonly workspace_id: string;
  readonly source_id: string;
  readonly source_version: string;
  readonly content_bytes: string;
  readonly evidence_object_id: string | null;
  readonly recorded_at: string;
  readonly event_time: string | null;
  readonly valid_from: string | null;
  readonly valid_to: string | null;
  readonly spans: readonly Readonly<{
    readonly start_offset: number;
    readonly end_offset: number;
    readonly purpose: AddressableSourceSpanPurpose;
  }>[];
}>;

export type SourceAdmissionResult = Readonly<{
  readonly record: SourceRecordIdentity;
  readonly spans: readonly AddressableSourceSpan[];
}>;

export interface SourceAdmissionPort {
  admit(input: SourceAdmissionRequest): SourceAdmissionResult;
}

export interface FactorIncidencePort {
  recordIncidence(input: FactorIncidence): FactorIncidence;
  nominateJob(input: DerivationJobReceipt): DerivationJobReceipt;
}

export interface ProjectionGenerationPort {
  snapshot(input: FieldProjectionGeneration): FieldProjectionGeneration;
  verify(input: FieldProjectionGeneration): FieldProjectionGeneration;
  activatePointer(input: ProjectionGenerationPointer): ProjectionGenerationPointer;
  pin(input: ProjectionPin): ProjectionPin;
  release(input: ProjectionPinRelease): ProjectionPin;
}

export interface QueryConditionPort {
  captureCondition(input: QueryCondition): QueryConditionReceipt;
}

export type AttributedActivationReceipt = Readonly<{
  readonly workspace_id: string;
  readonly generation_id: string;
  readonly condition_digest: string;
  readonly seed_ids: readonly string[];
  readonly opened_candidate_keys: readonly string[];
  readonly stop_disposition: "certified" | "uncertified";
  readonly frontier: "closed" | "incomplete";
}>;

export interface AttributedActivationPort {
  attribute(input: QueryConditionReceipt): AttributedActivationReceipt;
}

export interface StopCertificatePort {
  certify(input: FieldStopCertificateReceipt): FieldStopCertificateReceipt;
}

export interface ProofEffectPort {
  decide(input: EffectRequest): EffectDecisionReceipt;
}

export interface CausalUsagePort {
  recordUsage(input: CausalUsageReceipt): Readonly<{
    readonly receipt: CausalUsageReceipt;
    readonly inserted: boolean;
  }>;
}

export interface EraseBarrierPort {
  erase(input: ProjectionEraseBarrier): ProjectionEraseBarrier;
}
