import type { AddressableSourceSpan, AddressableSourceSpanPurpose, SourceRecordIdentity } from "./source-span.js";
import type { FactorFamily } from "./factor-incidence.js";
import type { ProjectionEraseSubjectKind, ProjectionGenerationStatus } from "./projection-generation.js";
import type { EffectDecision, EffectRequest } from "./proof-effect.js";
import type { FieldStopCertificateStatus, FieldStopFrontier } from "./stop-certificate.js";

export type FieldPortFailureDisposition = "fail_closed" | "explicit_incomplete";

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

export type SourceAdmissionPort = Readonly<{
  readonly input_receipt: SourceAdmissionRequest;
  readonly output_receipt: SourceAdmissionResult;
  readonly failure_disposition: "fail_closed";
}>;

export type FactorIncidencePort = Readonly<{
  readonly input_receipt: Readonly<{
    readonly span_id: string;
    readonly family: FactorFamily;
    readonly canonical_payload: string;
  }>;
  readonly output_receipt: Readonly<{
    readonly incidence_id: string;
    readonly job_id: string | null;
  }>;
  readonly failure_disposition: "fail_closed";
}>;

export type ProjectionGenerationPort = Readonly<{
  readonly input_receipt: Readonly<{
    readonly workspace_id: string;
    readonly input_event_frontier: string;
    readonly governance_frontier: string;
  }>;
  readonly output_receipt: Readonly<{
    readonly generation_id: string;
    readonly status: ProjectionGenerationStatus;
  }>;
  readonly failure_disposition: "fail_closed";
}>;

export type QueryConditionPort = Readonly<{
  readonly input_receipt: Readonly<{
    readonly principal: string;
    readonly effective_as_of: string;
  }>;
  readonly output_receipt: Readonly<{
    readonly condition_digest: string;
  }>;
  readonly failure_disposition: "fail_closed";
}>;

export type AttributedActivationPort = Readonly<{
  readonly input_receipt: Readonly<{
    readonly generation_id: string;
    readonly condition_digest: string;
  }>;
  readonly output_receipt: Readonly<{
    readonly activation_receipt_id: string;
  }>;
  readonly failure_disposition: "fail_closed";
}>;

export type StopCertificatePort = Readonly<{
  readonly input_receipt: Readonly<{
    readonly generation_id: string;
    readonly condition_digest: string;
  }>;
  readonly output_receipt: Readonly<{
    readonly status: FieldStopCertificateStatus;
    readonly frontier: FieldStopFrontier;
  }>;
  readonly failure_disposition: "explicit_incomplete";
}>;

export type ProofEffectPort = Readonly<{
  readonly input_receipt: EffectRequest;
  readonly output_receipt: Readonly<{
    readonly decision: EffectDecision;
  }>;
  readonly failure_disposition: "fail_closed";
}>;

export type CausalUsagePort = Readonly<{
  readonly input_receipt: Readonly<{
    readonly causal_key: string;
    readonly downstream_ref: string;
    readonly weight: number;
  }>;
  readonly output_receipt: Readonly<{
    readonly receipt_id: string;
  }>;
  readonly failure_disposition: "fail_closed";
}>;

export type SelectGammaPort = Readonly<{
  readonly input_receipt: Readonly<{
    readonly generation_id: string;
    readonly condition_digest: string;
  }>;
  readonly output_receipt: Readonly<{
    readonly selected_candidate_keys: readonly string[];
  }>;
  readonly failure_disposition: "fail_closed";
}>;

export type EraseBarrierPort = Readonly<{
  readonly input_receipt: Readonly<{
    readonly subject_kind: ProjectionEraseSubjectKind;
    readonly subject_id: string;
  }>;
  readonly output_receipt: Readonly<{
    readonly barrier_id: string;
  }>;
  readonly failure_disposition: "fail_closed";
}>;
