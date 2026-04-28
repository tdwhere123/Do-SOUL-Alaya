import { type MemoryDimension, type ScopeClass } from "@do-what/protocol";

export interface GlobalMemoryRecallEntry {
  readonly global_object_id: string;
  readonly dimension: MemoryDimension;
  readonly scope_class: ScopeClass;
  readonly content: string;
  readonly domain_tags?: readonly string[];
  readonly evidence_refs?: readonly string[];
  readonly activation_score?: number | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface GlobalMemoryRecallPort {
  recall(params: {
    readonly workspaceId: string;
    readonly queryText: string | null;
    readonly limit: number;
  }): Promise<readonly Readonly<GlobalMemoryRecallEntry>[]>;
}

export type GlobalMemoryRecallCacheClassification = "included" | "excluded";

export interface GlobalMemoryRecallCacheRecord {
  readonly workspaceId: string;
  readonly globalObjectId: string;
  readonly classification: GlobalMemoryRecallCacheClassification;
}

export interface GlobalMemoryRecallCachePort {
  recordClassifications(
    records: readonly Readonly<GlobalMemoryRecallCacheRecord>[]
  ): Promise<void>;
}
