import type {
  MemoryEntry,
  StorageTier as StorageTierType
} from "@do-soul/alaya-protocol";

export interface RecallMemoryListPageOptions {
  readonly limit: number;
  readonly offset: number;
}

export interface RecallTierWindowCursor {
  readonly created_at: string;
  readonly object_id: string;
}

export interface RecallTierWindowResult {
  readonly memories: readonly Readonly<MemoryEntry>[];
  readonly next_cursor: Readonly<RecallTierWindowCursor> | null;
  readonly truncated: boolean;
}

export interface RecallEventTimeWindowQuery {
  readonly workspaceId: string;
  readonly tier: StorageTierType;
  readonly startTime: string;
  readonly endTime: string;
  readonly limit: number;
}

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

export interface RecallServiceWarnPort {
  (message: string, meta: Record<string, unknown>): void;
}
