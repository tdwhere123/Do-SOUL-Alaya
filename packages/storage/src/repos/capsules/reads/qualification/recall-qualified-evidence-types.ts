import type {
  CandidateMemorySignal,
  EvidenceCapsule,
  EvidenceFactFrameFormationCapture,
  GardenSourceTurnFallbackVerifiedReceipt,
  OpenSemanticFactorFormationCapture
} from "@do-soul/alaya-protocol";
import type { EvidenceCapsuleRow } from "../../mappers/evidence-capsule-mappers.js";
import type { StoredFactFrameFormationColumns } from "./fact-frame-formation-read.js";
import type { StoredSemanticFactorFormationColumns } from
  "./semantic-factor-formation-read.js";

export interface StoredSignalRow {
  readonly signal_id: string;
  readonly workspace_id: string;
  readonly run_id: string;
  readonly surface_id: string | null;
  readonly source: string;
  readonly signal_kind: string;
  readonly object_kind: string;
  readonly scope_hint: string | null;
  readonly domain_tags_json: string;
  readonly confidence: number;
  readonly evidence_refs_json: string;
  readonly source_memory_refs_json: string;
  readonly supersedes_refs_json: string;
  readonly exception_to_refs_json: string;
  readonly contradicts_refs_json: string;
  readonly incompatible_with_refs_json: string;
  readonly raw_payload_json: string;
  readonly source_delivery_ids_json: string | null;
  readonly source_observation_json: string | null;
  readonly signal_state: string;
  readonly created_at: string;
}

export interface StoredMaterializationRow {
  readonly event_type: string;
  readonly entity_type: string;
  readonly entity_id: string;
  readonly workspace_id: string;
  readonly run_id: string | null;
  readonly caused_by: string | null;
  readonly payload_json: string;
}

export interface EvidenceQualificationRow extends EvidenceCapsuleRow,
  StoredSemanticFactorFormationColumns, StoredFactFrameFormationColumns {
  readonly source_signal_id: string | null;
}

export interface EvidenceCandidate {
  readonly capsule: Readonly<EvidenceCapsule>;
  readonly signalId: string | null;
  readonly semanticFactorFormation?: Readonly<OpenSemanticFactorFormationCapture>;
  readonly factFrameFormation?: Readonly<EvidenceFactFrameFormationCapture>;
}

export interface QualificationInputs {
  readonly candidates: readonly EvidenceCandidate[];
  readonly signals: ReadonlyMap<string, Readonly<CandidateMemorySignal>>;
  readonly events: ReadonlyMap<string, readonly StoredMaterializationRow[]>;
}

export interface QualifiedEvidenceProof {
  readonly turnReceipt: Readonly<GardenSourceTurnFallbackVerifiedReceipt> | null;
}
