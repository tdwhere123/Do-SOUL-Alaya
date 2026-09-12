import {
  type ObserverAction,
  type ObserverCursor,
  type ObserverPage,
  type QueryInterpretation,
  type RelationValidity,
  type SnapshotReadLease,
  type SourceEvidenceRootKind,
  type StagedWarningArray,
  type StoredCosineObligation,
  type TypedObservation
} from "@do-soul/alaya-protocol";
import type {
  MeasureStoredPairsInput,
  ObservationMeasurement,
  StoredPairMeasurement,
  StoredPairsMeasurement
} from "./measure-stored.js";

export type LexicalObserverPage = Readonly<{
  readonly ids: readonly string[];
  readonly nativeVisits: number;
  readonly nativeBytes: number;
  readonly rowsRead: number;
  readonly bytesRead: number;
  readonly truncated: boolean;
  readonly committedThrough?: string | null;
}>;

export type SourceObserverRow = Readonly<{
  readonly object_id: string;
  readonly sourceRevision: string;
  readonly predicates?: Readonly<Record<string, boolean>>;
  readonly observed_at?: string;
  readonly content?: string;
  readonly lifecycle_state?: string;
  readonly retention_state?: string | null;
  readonly scope_class?: string;
  readonly evidence_refs?: readonly string[];
  readonly staged_warnings?: StagedWarningArray;
  readonly valid_from?: string | null;
  readonly valid_to?: string | null;
  readonly dimension?: string;
  readonly domain_tags?: readonly string[];
  readonly created_at?: string;
  readonly last_used_at?: string | null;
}>;

export type SourceObserverPage = Readonly<{
  readonly row: SourceObserverRow | null;
  readonly rowsRead: number;
  readonly bytesRead: number;
  readonly unavailable: boolean;
  readonly resourceLimited?: boolean;
}>;

export type SourceRootObserverRow = Readonly<{
  readonly kind: SourceEvidenceRootKind;
  readonly workspace_id: string;
  readonly root_id: string;
  readonly revision: string;
  readonly digest: string;
  readonly evidence_object_id: string | null;
  readonly evidence_verified?: boolean;
  readonly event_time?: string | null;
  readonly role?: string;
  readonly content?: string;
  readonly content_complete?: boolean;
  readonly content_start?: number;
  readonly content_end?: number;
  readonly retained_extent?: "body" | "excerpt" | "gist";
  readonly literal_verdicts?: Readonly<Record<string, "true" | "false" | "unresolved">>;
  readonly original_complete?: boolean;
  readonly scope_class?: string;
  readonly valid_from?: string | null;
  readonly valid_to?: string | null;
  readonly body_erased?: boolean;
}>;

export type SourceRootObserverPage = Readonly<{
  readonly rows: readonly SourceRootObserverRow[];
  readonly nativeVisits: number;
  readonly nativeBytes: number;
  readonly rowsRead: number;
  readonly bytesRead: number;
  readonly metadataBytes?: number;
  readonly nativeWork?: number;
  readonly resourceLimited?: boolean;
  readonly truncated: boolean;
  readonly committedThrough?: string | null;
  readonly unavailable?: boolean;
}>;

export type SourceRootHydrateObserverPage = Readonly<{
  readonly row: SourceRootObserverRow | null;
  readonly rowsRead: number;
  readonly bytesRead: number;
  readonly metadataBytes?: number;
  readonly nativeWork?: number;
  readonly unavailable: boolean;
  readonly resourceLimited?: boolean;
}>;

export type RelationObserverRow = Readonly<{
  readonly assertionId: string;
  readonly sourceObjectId: string;
  readonly targetObjectId: string;
  readonly resultObjectId: string;
  readonly predicate: string;
  readonly validity?: RelationValidity;
  readonly evidenceRefs?: readonly string[];
  readonly evidenceReceipts?: readonly Readonly<{ evidenceId: string; eventId: string; eventType: string; occurredAt: string }>[];
  readonly sourceObservations?: readonly Readonly<{ source_id: string; source_sha256: string }>[];
  readonly source_revision?: string;
  readonly resolutionKind?: string | null;
  readonly resolvedAt?: string | null;
  readonly source_event_id?: string;
  readonly occurred_at?: string;
}>;

export type RelationObserverPage = Readonly<{
  readonly unavailable?: boolean;
  readonly observations: readonly RelationObserverRow[];
  readonly nativeVisits: number;
  readonly nativeBytes: number;
  readonly rowsRead: number;
  readonly bytesRead: number;
  readonly truncated: boolean;
  readonly committedThrough?: string | null;
}>;

export type EmbeddingObserverPage = Readonly<{
  readonly objectIds: readonly string[];
  readonly rowVisits: number;
  readonly metadataUtf8Bytes: number;
  readonly truncated: boolean;
  readonly committedThrough?: string | null;
  readonly domainStatus?: "missing" | "unavailable";
}>;

export type ObserverReaders = Readonly<{
  readonly sourceRootMetadataByteLimit?: number;
  readonly sourceRootChunkByteLimit?: number;
  readonly permittedTimelessPolicyIds?: () => readonly string[];
  readonly lexical?: (input: Readonly<{
    readonly workspaceId: string;
    readonly query: string;
    readonly limit: number;
    readonly nativeLimit: number;
    readonly afterObjectId: string | null;
  }>) => LexicalObserverPage;
  readonly source?: (input: Readonly<{
    readonly workspaceId: string;
    readonly objectId: string;
    readonly byteLimit?: number;
  }>) => SourceObserverPage;
  readonly sourceRoots?: (input: Readonly<{
    readonly workspaceId: string;
    readonly query?: string;
    readonly limit: number;
    readonly nativeLimit: number;
    readonly workLimit?: number;
    readonly afterCursor: string | null;
    readonly byteLimit?: number;
    readonly nativeByteLimit?: number;
  }>) => SourceRootObserverPage;
  readonly sourceRoot?: (input: Readonly<{
    readonly workspaceId: string;
    readonly rootKind: SourceEvidenceRootKind;
    readonly rootId: string;
    readonly revision?: string;
    readonly digest?: string;
    readonly evidenceObjectId?: string | null;
    readonly byteLimit?: number;
    readonly nativeByteLimit?: number;
    readonly offset?: number;
  }>) => SourceRootHydrateObserverPage;
  readonly relation?: (input: Readonly<{
    readonly workspaceId: string;
    readonly subject: string | null;
    readonly predicate: string;
    readonly limit: number;
    readonly nativeLimit: number;
    readonly afterAssertionId: string | null;
    readonly asOf?: string;
  }>) => RelationObserverPage;
  readonly relationKinds?: (input: Readonly<{
    readonly workspaceId: string;
    readonly subject: string | null;
    readonly limit?: number;
  }>) => readonly string[];
  readonly snapshotPin?: (workspaceId: string) => Readonly<{
    readonly source_revision: string;
    readonly applied_at?: string;
  }>;
  readonly embeddingIds?: (input: Readonly<{
    readonly workspaceId: string;
    readonly afterObjectId: string | null;
    readonly maxRows: number;
    readonly byteLimit?: number;
    readonly modelId?: string;
    readonly profile?: StoredCosineObligation;
  }>) => EmbeddingObserverPage;
  readonly measureStoredPair?: (input: Readonly<{
    readonly workspaceId: string;
    readonly objectId: string;
    readonly queryDigest: string;
    readonly profile?: StoredCosineObligation;
    readonly byteLimit?: number;
    readonly workLimit?: number;
  }>) => StoredPairMeasurement;
  readonly measureStoredPairs?: (input: MeasureStoredPairsInput) => StoredPairsMeasurement;
}>;

export type ObserverWorkReceipt = Readonly<{
  readonly work_units: number;
  readonly residual_work_units: number;
  readonly native_visits: number;
  readonly bytes_read: number;
}>;

export type ObserveConditionalFieldInput = Readonly<{
  readonly measurement_profile?: StoredCosineObligation;
  readonly lease: SnapshotReadLease;
  readonly action: ObserverAction;
  readonly cursor: ObserverCursor;
  readonly query: QueryInterpretation;
  readonly workspace_id: string;
  readonly readers: ObserverReaders;
  readonly seed_query?: string;
  readonly relation_subject?: string | null;
  readonly relation_kind?: string;
  readonly authorized_scopes?: readonly string[] | null;
  readonly permitted_timeless_policy_ids?: readonly string[];
  readonly anchor_object_ids?: readonly string[];
  readonly object_observed_at?: Readonly<Record<string, string>>;
  readonly page_limit?: number;
  readonly as_of?: string;
  readonly model_id?: string;
  readonly measurement_id?: string;
  readonly expected_model_id?: string;
  readonly expected_source_revision?: string;
  readonly source_byte_limit?: number;
}>;

export const DEFAULT_SOURCE_BYTE_LIMIT = 65_536;
/** Spare work `collectObserved` needs after native visits before hydrating one identity. */
export const SOURCE_IDENTITY_HYDRATE_RESERVE = 3;

export type ObserverActionResult = Readonly<{
  readonly page: ObserverPage;
  readonly work: ObserverWorkReceipt;
  readonly measurements?: readonly ObservationMeasurement[];
  readonly source_roots?: readonly SourceRootObserverRow[];
}>;

export type {
  ObserverAction,
  ObserverCursor,
  ObserverPage,
  QueryInterpretation,
  SnapshotReadLease,
  TypedObservation
};
