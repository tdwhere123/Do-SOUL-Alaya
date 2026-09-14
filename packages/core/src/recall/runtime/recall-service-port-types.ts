export type {
  RecallEventTimeWindowQuery,
  RecallMemoryListPageOptions,
  RecallTierWindowCursor,
  RecallTierWindowResult
} from "./recall-memory-window-port.js";

export interface RecallEvidenceSourceAnchor {
  readonly evidence_object_id: string;
  readonly artifact_ref: string;
}

export interface RecallTemporalProjectionReadOptions {
  readonly asOf?: string;
}

export interface TokenEstimator {
  estimate(text: string): number;
}
