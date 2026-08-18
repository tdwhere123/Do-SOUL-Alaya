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

export interface RecallActivationTopKQuery {
  readonly workspaceId: string;
  readonly tier: StorageTierType;
  readonly limit: number;
  readonly min_activation_score?: number | null;
  readonly exclude_object_ids?: readonly string[];
}
