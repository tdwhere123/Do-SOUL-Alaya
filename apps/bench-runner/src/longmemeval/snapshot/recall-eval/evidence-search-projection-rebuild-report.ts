import type { FactFrameRetrofitReport } from "./fact-frame-retrofit.js";

export const EVIDENCE_PROJECTION_REBUILD_REPORT_SCHEMA_VERSION = 1;

export interface EvidenceSearchProjectionKindCount {
  readonly projection_kind: string;
  readonly child_count: number;
}

export interface EvidenceSearchProjectionRebuildReport {
  readonly schema_version: typeof EVIDENCE_PROJECTION_REBUILD_REPORT_SCHEMA_VERSION;
  readonly promotable: false;
  readonly input_db_sha256: string;
  readonly rebuilt_db_identity_sha256: string;
  readonly source_schema_version: number;
  readonly working_schema_version: number;
  readonly eligible_owner_count: number;
  readonly rebuilt_owner_count: number;
  readonly rejected_owner_count: number;
  readonly zero_child_owner_count: number;
  readonly nonzero_child_owner_count: number;
  readonly child_count: number;
  readonly projection_kind_counts: readonly EvidenceSearchProjectionKindCount[];
  readonly projection_content_sha256: string;
  readonly fact_frame_retrofit?: FactFrameRetrofitReport;
  readonly source_extraction_system_prompt_sha256?: string;
}

export type EvidenceSearchProjectionRebuildReportBody = Omit<
  EvidenceSearchProjectionRebuildReport,
  "input_db_sha256" | "rebuilt_db_identity_sha256"
>;
