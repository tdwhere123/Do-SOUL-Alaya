import {
  SoulActiveConstraintSchema,
  isPathActiveForRecall,
  normalizeActiveConstraintScopes,
  listActiveConstraintCandidateMemoryIds,
  selectActiveConstraintRecords,
  type BoundedActiveConstraintsRequest,
  type BoundedActiveConstraintsResult,
  type ActiveConstraintClaim,
  type MemoryEntry,
  type PathRelation
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../../sqlite/db.js";
import {
  MEMORY_ENTRY_SELECT_COLUMNS,
  parseMemoryEntryRow,
  type MemoryEntryRow
} from "../../memory-entry/mappers/row-mapper.js";

export interface BoundedGovernancePathPage {
  readonly rows: readonly Readonly<PathRelation>[];
  readonly rowsRead: number;
  readonly bytesRead: number;
  readonly truncated: boolean;
  readonly unavailable: boolean;
  readonly temporalUncertain: boolean;
}

export type BoundedGovernancePathReader = (input: Readonly<{
  workspaceId: string; asOf: string; afterPathId: string | null;
  limit: number; byteLimit: number;
}>) => BoundedGovernancePathPage;

const MEMORY_BYTES_SQL = MEMORY_ENTRY_SELECT_COLUMNS.split(",").map((column) =>
  `COALESCE(length(CAST(${column.trim()} AS BLOB)), 0)`).join(" + ");
const CLAIM_BYTES_SQL = ["claim_status", "source_object_refs", "created_at", "updated_at", "lifecycle_state"]
  .map((column) => `COALESCE(length(CAST(${column} AS BLOB)),0)`).join(" + ");

interface ReadAllowance {
  native: number;
  bytes: number;
  visits: number;
  bytesRead: number;
  complete: boolean;
  temporalUncertain: boolean;
}

type PinnedConstraintsRequest = Readonly<BoundedActiveConstraintsRequest & { snapshotId: string }>;

/** Row probes precede hydration so oversized JSON never crosses the native boundary. */
export function readBoundedActiveConstraints(
  db: StorageDatabase,
  request: PinnedConstraintsRequest,
  readPaths: BoundedGovernancePathReader
): Readonly<BoundedActiveConstraintsResult> {
  assertRequest(request);
  return db.connection.transaction(() => readSnapshot(db, request, readPaths))();
}

function readSnapshot(
  db: StorageDatabase,
  request: PinnedConstraintsRequest,
  readPaths: BoundedGovernancePathReader
): Readonly<BoundedActiveConstraintsResult> {
  const allowance: ReadAllowance = {
    native: request.nativeLimit, bytes: Math.max(0, request.byteLimit - 1024),
    visits: 0, bytesRead: 0, complete: true, temporalUncertain: false
  };
  const pathLimit = Math.floor(allowance.native / 3);
  const page = readPaths({
    workspaceId: request.workspaceId, asOf: request.asOf, afterPathId: null,
    limit: pathLimit, byteLimit: Math.floor(allowance.bytes / 3)
  });
  debit(allowance, page.rowsRead, page.bytesRead);
  allowance.complete &&= !page.truncated && !page.unavailable && !page.temporalUncertain;
  allowance.temporalUncertain ||= page.temporalUncertain;
  const claims = readClaims(db, request, allowance, Math.floor(allowance.native / 2));
  const activePaths = page.rows.filter((path) => isPathActiveForRecall(path.lifecycle.status));
  const memories: Readonly<MemoryEntry>[] = [];
  const ids = new Set(listActiveConstraintCandidateMemoryIds({ claims, paths: activePaths }));
  for (const id of ids) {
    if (allowance.native < 2 || allowance.bytes < 64) {
      allowance.complete = false;
      break;
    }
    const memory = readMemory(db, request, id, allowance);
    if (memory !== null) memories.push(memory);
  }
  const selected = selectActiveConstraintRecords({
    workspaceId: request.workspaceId, memories, claims, paths: activePaths, cap: request.cap
  });
  const constraints = selected.constraints.map((record) => SoulActiveConstraintSchema.parse({
    object_id: record.memory.object_id, object_kind: record.memory.object_kind,
    content: record.memory.content, dimension: record.memory.dimension,
    scope_class: record.memory.scope_class,
    governance_state: {
      claim_status: record.claim_status, governance_class: record.governance_class,
      source_channels: record.source_channels
    }
  }));
  return finish(request, allowance, constraints, page.rows, selected.total_count);
}

function readClaims(
  db: StorageDatabase,
  request: PinnedConstraintsRequest,
  allowance: ReadAllowance,
  limit: number
): readonly ActiveConstraintClaim[] {
  const claims: ActiveConstraintClaim[] = [];
  const probe = db.connection.prepare(`SELECT rowid AS cursor, ${CLAIM_BYTES_SQL} AS bytes
    FROM claim_forms INDEXED BY idx_claim_forms_workspace_id
    WHERE workspace_id = ? AND rowid > ? ORDER BY rowid LIMIT 1`);
  const hydrate = db.connection.prepare(`SELECT claim_status, source_object_refs, created_at,
    updated_at, lifecycle_state FROM claim_forms WHERE rowid = ? AND workspace_id = ?`);
  let cursor = 0;
  let used = 0;
  while (used < limit && allowance.bytes >= 64) {
    const row = probe.get(request.workspaceId, cursor) as { cursor: number; bytes: number } | undefined;
    debit(allowance, 1, row === undefined ? 0 : Buffer.byteLength(JSON.stringify(row), "utf8"));
    used += 1;
    if (row === undefined) return claims;
    cursor = row.cursor;
    if (row.bytes * 6 + 256 > allowance.bytes || used >= limit) break;
    const data = hydrate.get(cursor, request.workspaceId) as {
      claim_status: ActiveConstraintClaim["claim_status"]; source_object_refs: string;
      created_at: string; updated_at: string; lifecycle_state: string;
    };
    debit(allowance, 1, Buffer.byteLength(JSON.stringify(data), "utf8"));
    used += 1;
    if (Date.parse(data.created_at) > Date.parse(request.asOf)) continue;
    if (Date.parse(data.updated_at) > Date.parse(request.asOf)) {
      allowance.complete = false;
      allowance.temporalUncertain = true;
      continue;
    }
    if (data.lifecycle_state !== "active") continue;
    const refs: unknown = JSON.parse(data.source_object_refs);
    if (!Array.isArray(refs) || !refs.every((id) => typeof id === "string")) {
      allowance.complete = false;
      continue;
    }
    claims.push({ claim_status: data.claim_status, source_object_refs: refs });
  }
  allowance.complete = false;
  return claims;
}

function readMemory(
  db: StorageDatabase,
  request: PinnedConstraintsRequest,
  id: string,
  allowance: ReadAllowance
): Readonly<MemoryEntry> | null {
  const scopes = normalizeActiveConstraintScopes(request.authorizedScopes);
  const scopeFilter = scopes.length === 0 ? "" : `AND scope_class IN (${scopes.map(() => "?").join(",")})`;
  const row = db.connection.prepare(`SELECT ${MEMORY_BYTES_SQL} AS bytes FROM memory_entries
    WHERE workspace_id = ? AND object_id = ?
      ${scopeFilter} LIMIT 1`)
    .get(request.workspaceId, id, ...scopes) as
    { bytes: number } | undefined;
  debit(allowance, 1, row === undefined ? 0 : Buffer.byteLength(JSON.stringify(row), "utf8"));
  if (row === undefined) return null;
  if (row.bytes * 6 + 4096 > allowance.bytes) {
    allowance.complete = false;
    return null;
  }
  const raw = db.connection.prepare(`SELECT ${MEMORY_ENTRY_SELECT_COLUMNS} FROM memory_entries
    WHERE workspace_id = ? AND object_id = ? LIMIT 1`).get(request.workspaceId, id) as MemoryEntryRow;
  debit(allowance, 1, Buffer.byteLength(JSON.stringify(raw), "utf8"));
  if (Date.parse(raw.created_at) > Date.parse(request.asOf)) return null;
  if (Date.parse(raw.updated_at) > Date.parse(request.asOf)) {
    allowance.complete = false;
    allowance.temporalUncertain = true;
    return null;
  }
  return parseMemoryEntryRow(raw);
}

function finish(
  request: PinnedConstraintsRequest,
  allowance: ReadAllowance,
  constraints: readonly BoundedActiveConstraintsResult["constraints"][number][],
  paths: readonly Readonly<PathRelation>[],
  count: number
): Readonly<BoundedActiveConstraintsResult> {
  const base = {
    constraints, paths, total_count: allowance.complete ? count : null,
    completeness: allowance.complete ? "complete" as const : "incomplete" as const,
    temporal_uncertain: allowance.temporalUncertain,
    binding: { workspace_id: request.workspaceId, as_of: request.asOf, snapshot_id: request.snapshotId,
      authorized_scopes: normalizeActiveConstraintScopes(request.authorizedScopes) },
    work: { native_visits: allowance.visits, bytes_read: allowance.bytesRead, retained_bytes: 0 }
  };
  if (Buffer.byteLength(JSON.stringify(base), "utf8") > request.byteLimit) {
    base.constraints = [];
    base.paths = [];
    base.total_count = null;
    base.completeness = "incomplete";
  }
  for (let pass = 0; pass < 3; pass += 1) {
    base.work.retained_bytes = Buffer.byteLength(JSON.stringify(base), "utf8");
  }
  return Object.freeze(base);
}

function debit(allowance: ReadAllowance, visits: number, bytes: number): void {
  if (visits > allowance.native || bytes > allowance.bytes) throw new Error("governance reader exceeded allowance");
  allowance.native -= visits;
  allowance.bytes -= bytes;
  allowance.visits += visits;
  allowance.bytesRead += bytes;
}

function assertRequest(request: PinnedConstraintsRequest): void {
  normalizeActiveConstraintScopes(request.authorizedScopes);
  if (!Number.isSafeInteger(request.nativeLimit) || request.nativeLimit < 0 || request.nativeLimit > 65536 ||
      !Number.isSafeInteger(request.byteLimit) || request.byteLimit < 1024 || request.byteLimit > 16 * 1024 * 1024 ||
      !Number.isFinite(Date.parse(request.asOf)) || request.asOf.length > 64 ||
      request.workspaceId.length === 0 || request.workspaceId.length > 256 ||
      request.snapshotId.length === 0 || request.snapshotId.length > 256 ||
      (request.cap != null && (!Number.isSafeInteger(request.cap) || request.cap < 0 || request.cap > 50))) {
    throw new Error("invalid bounded active constraints request");
  }
}
