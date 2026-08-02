export interface RecallRoutingKeyProjection {
  readonly owner_id: string;
  readonly owner_kind: string;
  readonly source_signal_id: string;
  readonly independence_group: string;
  readonly signal_kind: string;
  readonly object_type: string;
  readonly reliability: number;
  readonly proposed_entities: readonly string[];
  readonly proposed_preference: Readonly<{
    readonly subject: string | null;
    readonly predicate: string | null;
    readonly object: string | null;
    readonly category: string | null;
    readonly polarity: string | null;
  }>;
  readonly temporal: Readonly<{
    readonly start: string | null;
    readonly end: string | null;
    readonly precision: string | null;
  }>;
  readonly proposed_fact: string | null;
  readonly source_version: string;
}

export interface RecallRoutingKeyProjectionPort {
  findByOwnerIds(
    workspaceId: string,
    ownerIds: readonly string[]
  ): Promise<readonly Readonly<RecallRoutingKeyProjection>[]>;
}
