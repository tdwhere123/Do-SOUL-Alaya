import {
  RevokeReason,
  type EventLogEntry,
  type MemoryEntry,
  type MemoryEntryMutableFields,
  type MemoryEntryRepoUpdateFields as ProtocolMemoryEntryRepoUpdateFields,
  type ScopeClass,
  type SynthesisCapsule
} from "@do-soul/alaya-protocol";

export type MemoryEntryInput = Omit<
  MemoryEntry,
  | "object_id"
  | "object_kind"
  | "schema_version"
  | "lifecycle_state"
  | "created_at"
  | "updated_at"
  | "storage_tier"
  | "activation_score"
  | "retention_score"
  | "manifestation_state"
  | "retention_state"
  | "decay_profile"
  | "confidence"
  | "last_used_at"
  | "last_hit_at"
  | "reinforcement_count"
  | "contradiction_count"
  | "superseded_by"
> & {
  readonly storage_tier?: MemoryEntry["storage_tier"];
  // invariant: enqueueEnrichment means memory row + enrich_pending marker
  // commit atomically, or create throws instead of silently dropping the marker.
  // see also: packages/soul/src/garden/materialization-router/router.ts:enqueueEnrichment.
  // see also: packages/storage/src/repos/enrich-pending-repo.ts:enqueue.
  readonly enqueueEnrichment?: {
    readonly runId: string | null;
    readonly sourceSignalId: string | null;
  };
};

export type MemoryEntryUpdateFields = MemoryEntryMutableFields & {
  readonly last_used_at?: string;
  readonly last_hit_at?: string;
};
export type MemoryEntryRepoUpdateFields = ProtocolMemoryEntryRepoUpdateFields & {
  readonly last_used_at?: string;
  readonly last_hit_at?: string;
};

export interface MemoryListPageOptions {
  readonly limit: number;
  readonly offset: number;
}

export interface MemoryServiceEventLogRepoPort {
  append(event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): EventLogEntry | Promise<EventLogEntry>;
  queryByEntity(entityType: string, entityId: string): Promise<readonly EventLogEntry[]>;
}

// ISP: the memory-entry repo port is segregated into read / write / lifecycle
// facets so a narrow consumer (e.g. a query path) can depend on the read facet
// alone. A full repo satisfies the composed MemoryServiceMemoryEntryRepoPort.
export interface MemoryEntryReadPort {
  findById(objectId: string): Promise<Readonly<MemoryEntry> | null>;
  findByIds?(
    workspaceId: string,
    objectIds: readonly string[]
  ): Promise<readonly Readonly<MemoryEntry>[]>;
  findByWorkspaceId(
    workspaceId: string,
    tier?: MemoryEntry["storage_tier"],
    page?: MemoryListPageOptions
  ): Promise<readonly Readonly<MemoryEntry>[]>;
  findByWorkspaceIdAll?(
    workspaceId: string,
    tier?: MemoryEntry["storage_tier"]
  ): Promise<readonly Readonly<MemoryEntry>[]>;
  countByWorkspaceId?(workspaceId: string, tier?: MemoryEntry["storage_tier"]): Promise<number>;
  findByRunId(
    runId: string,
    page?: MemoryListPageOptions
  ): Promise<readonly Readonly<MemoryEntry>[]>;
  findByRunIdAll?(runId: string): Promise<readonly Readonly<MemoryEntry>[]>;
  countByRunId?(runId: string): Promise<number>;
  findByDimension(
    workspaceId: string,
    dimension: MemoryEntry["dimension"],
    page?: MemoryListPageOptions
  ): Promise<readonly Readonly<MemoryEntry>[]>;
  findByDimensionAll?(
    workspaceId: string,
    dimension: MemoryEntry["dimension"]
  ): Promise<readonly Readonly<MemoryEntry>[]>;
  countByDimension?(workspaceId: string, dimension: MemoryEntry["dimension"]): Promise<number>;
  findByScopeClass(
    workspaceId: string,
    scopeClass: ScopeClass,
    page?: MemoryListPageOptions
  ): Promise<readonly Readonly<MemoryEntry>[]>;
  findByScopeClassAll?(
    workspaceId: string,
    scopeClass: ScopeClass
  ): Promise<readonly Readonly<MemoryEntry>[]>;
}

export interface MemoryEntryWritePort {
  create(entry: MemoryEntry): Promise<Readonly<MemoryEntry>>;
  // invariant: callbacks commit atomically with the row insert.
  // see also: packages/storage/src/repos/memory-entry/sqlite-memory-entry-repo.ts:createWithinTransaction.
  createWithinTransaction?(
    entry: MemoryEntry,
    callbacks: {
      readonly beforeCreate?: () => void;
      readonly afterCreate?: () => void;
    }
  ): Readonly<MemoryEntry>;
  update(objectId: string, fields: MemoryEntryRepoUpdateFields): Promise<Readonly<MemoryEntry>>;
  updateScoped?(
    objectId: string,
    workspaceId: string,
    fields: MemoryEntryRepoUpdateFields
  ): Promise<Readonly<MemoryEntry>>;
}

export interface MemoryEntryLifecyclePort {
  transitionLifecycle?(
    objectId: string,
    lifecycleState: MemoryEntry["lifecycle_state"],
    updatedAt: string,
    onTransition?: () => void
  ): Promise<Readonly<MemoryEntry>>;
  // invariant: guarded active -> dormant demotion commits audit + UPDATE
  // atomically and returns null on benign 0-row races.
  transitionToDormantIfActive?(
    objectId: string,
    updatedAt: string,
    onTransition?: () => void
  ): Promise<Readonly<MemoryEntry> | null>;
  archive(objectId: string, updatedAt: string, onArchived?: () => void): Promise<Readonly<MemoryEntry>>;
  hardDeleteTombstoned?(objectId: string, onDeleted?: () => void): Promise<void>;
  // invariant: gated autonomous tombstone writes the durable forget_disposition
  // marker and terminalizes only a dormant row.
  autonomousTombstone?(input: {
    readonly objectId: string;
    readonly disposition: MemoryEntry["forget_disposition"];
    readonly dispositionRef: string | null;
    readonly updatedAt: string;
  }, options?: { readonly onTransition?: () => void }): Promise<Readonly<MemoryEntry>>;
  // invariant: gated autonomous physical delete removes only tombstoned
  // past-grace rows that carry a non-null disposition.
  // requireLiveCapsuleRef makes capsule liveness + membership atomic with delete.
  hardDeleteTombstonedWithDisposition?(
    objectId: string,
    options?: {
      readonly requireLiveCapsuleRef?: boolean;
      readonly requireJudgedUselessVerdict?: boolean;
      readonly onDeleted?: () => void;
    }
  ): Promise<boolean>;
}

export interface MemoryServiceMemoryEntryRepoPort
  extends MemoryEntryReadPort,
    MemoryEntryWritePort,
    MemoryEntryLifecyclePort {}

export interface MemoryServiceEvidenceServicePort {
  findById(objectId: string): Promise<Readonly<{ readonly object_id?: string; readonly workspace_id?: string }> | null>;
  findByIds?(workspaceId: string, objectIds: readonly string[]): Promise<readonly { readonly object_id: string }[]>;
}

// invariant: compressed physical delete re-verifies live capsule preservation
// at delete time, not only at tombstone marking time.
export interface MemoryServiceSynthesisCapsuleLookupPort {
  findById(objectId: string): Promise<Readonly<SynthesisCapsule> | null>;
}

export interface MemoryRuntimeNotifier {
  notifyEntry(entry: EventLogEntry): void | Promise<void>;
}

export interface MemoryServiceDynamicsPort {
  assignInitialDynamics(params: {
    readonly dimension: MemoryEntry["dimension"];
    readonly formation_kind: MemoryEntry["formation_kind"];
    readonly created_at: string;
  }): {
    readonly decay_profile: MemoryEntry["decay_profile"];
    readonly confidence: number;
    readonly retention_score: number;
    readonly retention_state: MemoryEntry["retention_state"];
    readonly activation_score: number;
    readonly manifestation_state: NonNullable<MemoryEntry["manifestation_state"]>;
    readonly reinforcement_count: number;
    readonly contradiction_count: number;
  };
}

// invariant: enrich_pending enqueue runs inside the memory-row create
// transaction and must be synchronous.
// see also: packages/storage/src/repos/enrich-pending-repo.ts:enqueue.
export interface MemoryServiceEnrichPendingWriterPort {
  enqueue(params: {
    readonly workspaceId: string;
    readonly memoryId: string;
    readonly runId: string | null;
    readonly sourceSignalId: string | null;
  }): void;
}

export interface MemoryServiceGreenPort {
  reevaluate(params: {
    readonly targetObjectId: string;
    readonly workspaceId: string;
  }): Promise<unknown>;
  pierce?(params: {
    readonly targetObjectId: string;
    readonly workspaceId: string;
    readonly reason: typeof RevokeReason.MAPPING_REVOKED;
    readonly runId?: string;
  }): Promise<unknown>;
}

export interface MemoryServiceDependencies {
  readonly memoryEntryRepo: MemoryServiceMemoryEntryRepoPort;
  readonly evidenceService: MemoryServiceEvidenceServicePort;
  readonly eventLogRepo: MemoryServiceEventLogRepoPort;
  readonly runtimeNotifier: MemoryRuntimeNotifier;
  readonly dynamicsService?: MemoryServiceDynamicsPort;
  readonly greenService?: MemoryServiceGreenPort;
  // invariant: compressed deletes fail closed when capsule preservation cannot
  // be re-verified at delete time.
  readonly synthesisCapsuleLookup?: MemoryServiceSynthesisCapsuleLookupPort;
  // invariant: enqueueEnrichment requires atomic createWithinTransaction wiring.
  readonly enrichPendingWriter?: MemoryServiceEnrichPendingWriterPort;
  readonly generateObjectId?: () => string;
  readonly now?: () => string;
}
