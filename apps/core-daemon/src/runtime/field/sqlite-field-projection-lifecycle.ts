import {
  SoulEvidenceDeletedPayloadSchema,
  SoulEvidenceHealthChangedPayloadSchema,
  type FieldContractSha256,
  type FieldProjectionGeneration
} from "@do-soul/alaya-protocol";
import {
  activateProjectionGeneration,
  buildProjectionGeneration,
  digestRecallFieldIdentity,
  projectSourceFormationSnapshot,
  verifyProjectionGeneration,
  type FieldFormationStores,
  type SourceProjectionState
} from "@do-soul/alaya-core";
import {
  generationFromRow,
  type FieldProjectionGenerationRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import {
  appendGenerationActivated,
  appendGenerationRebuildStarted,
  type FieldEventLogPort
} from "./generation-audit.js";
import { createSqliteProjectionGenerationStore } from
  "./sqlite-projection-generation-store.js";

export type SqliteFieldProjectionLifecycleInput = Readonly<{
  readonly generations: FieldProjectionGenerationRepo;
  readonly stores: FieldFormationStores;
  readonly database: StorageDatabase;
  readonly eventLog: FieldEventLogPort;
  readonly sha256: FieldContractSha256;
}>;

export type SqliteFieldProjectionLifecycle = Readonly<{
  rebuild(
    workspaceId: string,
    recordedAt: string
  ): FieldProjectionGeneration;
  requestRebuild(workspaceId: string, requestedAt: string): void;
  drainPending(): void;
}>;

export function createSqliteFieldProjectionLifecycle(
  input: SqliteFieldProjectionLifecycleInput
): SqliteFieldProjectionLifecycle {
  const store = createSqliteProjectionGenerationStore(input.generations);
  const lifecycle: SqliteFieldProjectionLifecycle = {
    rebuild: (workspaceId, recordedAt) => rebuildActiveGeneration(
      input, store, workspaceId, recordedAt
    ),
    requestRebuild(workspaceId, requestedAt) {
      input.database.connection.prepare(`
        INSERT INTO field_projection_rebuild_requests (workspace_id, requested_at)
        VALUES (?, ?)
        ON CONFLICT(workspace_id) DO UPDATE SET
          requested_at = MAX(requested_at, excluded.requested_at)
      `).run(workspaceId, requestedAt);
    },
    drainPending() {
      drainPendingRebuilds(input.database, lifecycle);
    }
  };
  return Object.freeze(lifecycle);
}

function drainPendingRebuilds(
  database: StorageDatabase,
  lifecycle: Pick<SqliteFieldProjectionLifecycle, "rebuild">
): void {
  const pending = database.connection.prepare(`
    SELECT workspace_id, requested_at FROM field_projection_rebuild_requests
    ORDER BY workspace_id
  `).all() as readonly Readonly<{ workspace_id: string; requested_at: string }>[];
  for (const request of pending) {
    lifecycle.rebuild(request.workspace_id, request.requested_at);
    database.connection.prepare(`
      DELETE FROM field_projection_rebuild_requests
      WHERE workspace_id = ? AND requested_at = ?
    `).run(request.workspace_id, request.requested_at);
  }
}

function rebuildActiveGeneration(
  input: SqliteFieldProjectionLifecycleInput,
  store: ReturnType<typeof createSqliteProjectionGenerationStore>,
  workspaceId: string,
  recordedAt: string
): FieldProjectionGeneration {
  return input.database.connection.transaction(() => {
    const source = readSourceSnapshot(input, workspaceId, recordedAt);
    const governanceFrontier = readGovernanceFrontier(input.database, workspaceId, recordedAt);
    const active = readActiveGeneration(input.generations, workspaceId);
    if (generationMatchesSnapshot(
      store, active, source.input_event_frontier, governanceFrontier
    )) return active!;
    const rebuilt = rebuildGeneration({
      input, store, source, active, workspaceId, governanceFrontier, recordedAt
    });
    input.generations.collectRetired(workspaceId, recordedAt);
    return rebuilt;
  }).immediate();
}

function readSourceSnapshot(
  input: SqliteFieldProjectionLifecycleInput,
  workspaceId: string,
  recordedAt: string
) {
  return projectSourceFormationSnapshot({
    workspaceId,
    stores: input.stores,
    resolveState: ({ record, evidenceId, scope }) => readSourceState(
      input.database, evidenceId, record, scope, recordedAt
    )
  });
}

function readActiveGeneration(
  generations: FieldProjectionGenerationRepo,
  workspaceId: string
): FieldProjectionGeneration | null {
  const row = generations.readActive(workspaceId);
  return row === null ? null : generationFromRow(row);
}

function generationMatchesSnapshot(
  store: ReturnType<typeof createSqliteProjectionGenerationStore>,
  active: FieldProjectionGeneration | null,
  sourceFrontier: string,
  governanceFrontier: string
): boolean {
  return active !== null &&
    active.input_event_frontier === sourceFrontier &&
    active.governance_frontier === governanceFrontier &&
    store.readArtifacts(active.workspace_id, active.generation_id) !== null;
}

function rebuildGeneration(params: Readonly<{
  readonly input: SqliteFieldProjectionLifecycleInput;
  readonly store: ReturnType<typeof createSqliteProjectionGenerationStore>;
  readonly source: ReturnType<typeof projectSourceFormationSnapshot>;
  readonly active: FieldProjectionGeneration | null;
  readonly workspaceId: string;
  readonly governanceFrontier: string;
  readonly recordedAt: string;
}>): FieldProjectionGeneration {
  const built = buildProjectionGeneration({
    store: params.store,
    sha256: params.input.sha256,
    workspace_id: params.workspaceId,
    input_event_frontier: params.source.input_event_frontier,
    governance_frontier: params.governanceFrontier,
    recorded_at: params.recordedAt,
    sliceKeys: params.source.slice_keys
  });
  requireSynchronousAudit(appendGenerationRebuildStarted(params.input.eventLog, built.generation));
  const verified = verifyProjectionGeneration(
    params.store,
    built.generation,
    params.input.sha256
  ).generation;
  activateProjectionGeneration(params.store, {
    workspace_id: params.workspaceId,
    active_generation_id: verified.generation_id,
    activated_at: params.recordedAt
  });
  requireSynchronousAudit(appendGenerationActivated(
    params.input.eventLog,
    verified,
    params.active?.generation_id ?? null,
    params.recordedAt
  ));
  return readActiveGeneration(params.input.generations, params.workspaceId)!;
}

function readGovernanceFrontier(
  database: StorageDatabase,
  workspaceId: string,
  recordedAt: string
): string {
  const barriers = database.connection.prepare(`
    SELECT barrier_id, generation_id, subject_kind, subject_id, erased_at
    FROM projection_erase_barriers
    WHERE workspace_id = ? AND erased_at <= ?
    ORDER BY barrier_id
  `).all(workspaceId, recordedAt);
  const effects = database.connection.prepare(`
    SELECT request_digest, action, target, scope, effective_as_of, decision, recorded_at
    FROM proof_effect_decisions
    WHERE workspace_id = ? AND recorded_at <= ? AND effective_as_of <= ?
    ORDER BY request_digest
  `).all(workspaceId, recordedAt, recordedAt);
  const evidence = database.connection.prepare(`
    SELECT object_id
    FROM evidence_capsules
    WHERE workspace_id = ? AND created_at <= ?
    ORDER BY object_id
  `).all(workspaceId, recordedAt) as readonly Readonly<{ object_id: string }>[];
  const evidenceStates = evidence.map(({ object_id }) => Object.freeze({
    object_id,
    ...readEvidenceTemporalState(database, workspaceId, object_id, recordedAt)
  }));
  return digestRecallFieldIdentity({ barriers, effects, evidence: evidenceStates });
}

function readSourceState(
  database: StorageDatabase,
  evidenceId: string,
  record: Readonly<{
    readonly workspace_id: string;
    readonly event_time: string | null;
    readonly valid_from: string | null;
    readonly valid_to: string | null;
  }>,
  scope: string,
  recordedAt: string
): SourceProjectionState {
  const evidence = readEvidenceTemporalHistory(
    database, record.workspace_id, evidenceId, recordedAt
  );
  const effects = database.connection.prepare(`
    SELECT action, effective_as_of
    FROM proof_effect_decisions
    WHERE workspace_id = ? AND target = ? AND decision = 'allow'
      AND recorded_at <= ?
      AND action IN ('activate', 'revoke', 'seal', 'erase')
    ORDER BY effective_as_of, recorded_at, request_digest
  `).all(record.workspace_id, evidenceId, recordedAt) as readonly Readonly<{
    action: "activate" | "revoke" | "seal" | "erase";
    effective_as_of: string;
  }>[];
  return Object.freeze({
    scope,
    event_time: record.event_time,
    valid_from: record.valid_from,
    valid_to: record.valid_to,
    lifecycle_state: evidence.initial.lifecycle_state === "active" ? "active" : "inactive",
    governance_state: evidence.initial.evidence_health_state === "verified"
      ? "ordinary_evidence"
      : "restricted",
    sealed: false,
    erased: false,
    revoked: false,
    evidence_transitions: evidence.transitions,
    governance_effects: Object.freeze(effects.map((effect) => Object.freeze({ ...effect })))
  });
}

type EvidenceTemporalState = Readonly<{
  readonly lifecycle_state: string;
  readonly evidence_health_state: string;
}>;

type EvidenceTemporalHistory = Readonly<{
  readonly initial: EvidenceTemporalState;
  readonly transitions: readonly Readonly<{
    readonly kind: "health" | "lifecycle";
    readonly from_state: string;
    readonly to_state: string;
    readonly effective_as_of: string;
  }>[];
}>;

function readEvidenceTemporalState(
  database: StorageDatabase,
  workspaceId: string,
  evidenceId: string,
  asOf: string
): EvidenceTemporalState {
  const history = readEvidenceTemporalHistory(database, workspaceId, evidenceId, asOf);
  let lifecycle = history.initial.lifecycle_state;
  let health = history.initial.evidence_health_state;
  for (const transition of history.transitions) {
    if (transition.effective_as_of > asOf) continue;
    if (transition.kind === "health") health = transition.to_state;
    if (transition.kind === "lifecycle") lifecycle = transition.to_state;
  }
  return Object.freeze({ lifecycle_state: lifecycle, evidence_health_state: health });
}

function readEvidenceTemporalHistory(
  database: StorageDatabase,
  workspaceId: string,
  evidenceId: string,
  frontier: string
): EvidenceTemporalHistory {
  const current = database.connection.prepare(`
    SELECT lifecycle_state, evidence_health_state
    FROM evidence_capsules WHERE object_id = ? AND workspace_id = ? LIMIT 1
  `).get(evidenceId, workspaceId) as EvidenceTemporalState | undefined;
  const transitions = database.connection.prepare(`
    SELECT event_type, payload_json, revision FROM event_log
    WHERE workspace_id = ? AND entity_id = ?
      AND event_type IN ('soul.evidence.health_changed', 'soul.evidence.deleted')
    ORDER BY revision
  `).all(workspaceId, evidenceId) as readonly Readonly<{
    event_type: string;
    payload_json: string;
    revision: number;
  }>[];
  return decodeEvidenceTransitions(current, transitions, frontier);
}

function decodeEvidenceTransitions(
  current: EvidenceTemporalState | undefined,
  transitions: readonly Readonly<{
    event_type: string;
    payload_json: string;
    revision: number;
  }>[],
  frontier: string
): EvidenceTemporalHistory {
  const decoded = transitions.map((event) => {
    const raw: unknown = JSON.parse(event.payload_json);
    const payload = event.event_type === "soul.evidence.health_changed"
      ? SoulEvidenceHealthChangedPayloadSchema.parse(raw)
      : SoulEvidenceDeletedPayloadSchema.parse(raw);
    return { type: event.event_type, payload, revision: event.revision };
  }).sort((left, right) =>
    left.payload.occurred_at.localeCompare(right.payload.occurred_at) ||
    left.revision - right.revision
  );
  const firstHealth = decoded.find((event) => event.type === "soul.evidence.health_changed");
  const firstLifecycle = decoded.find((event) => event.type === "soul.evidence.deleted");
  const initial = Object.freeze({
    lifecycle_state: firstLifecycle?.payload.from_state ?? current?.lifecycle_state ?? "inactive",
    evidence_health_state: firstHealth?.payload.from_state ??
      current?.evidence_health_state ?? "unknown"
  });
  const projected = decoded.filter((event) => event.payload.occurred_at <= frontier).map((event) =>
    Object.freeze({
      kind: event.type === "soul.evidence.health_changed" ? "health" as const : "lifecycle" as const,
      from_state: event.payload.from_state,
      to_state: event.payload.to_state,
      effective_as_of: event.payload.occurred_at
    })
  );
  return Object.freeze({ initial, transitions: Object.freeze(projected) });
}

function requireSynchronousAudit(result: unknown): void {
  if (typeof result === "object" && result !== null && "then" in result) {
    throw new Error("generation audit must join the SQLite transaction");
  }
}
