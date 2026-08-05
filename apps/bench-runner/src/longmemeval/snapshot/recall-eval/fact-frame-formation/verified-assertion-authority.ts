import { createHash } from "node:crypto";
import {
  VERIFIED_USER_ASSERTION_SOURCE_HASH_PREFIX,
  buildVerifiedUserAssertionReceiptPreimage,
  formatVerifiedUserAssertionSourceHash,
  type CandidateMemorySignal
} from "@do-soul/alaya-protocol";
import {
  SqliteSignalRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";

const AUTHORITY_QUEUE_TABLE = "verified_assertion_formation_queue";

export interface VerifiedAssertionOwnerRow {
  readonly object_id: string;
  readonly workspace_id: string;
  readonly run_id: string;
  readonly surface_id: string | null;
  readonly created_by: string;
  readonly lifecycle_state: string;
  readonly evidence_kind: string;
  readonly evidence_health_state: string;
  readonly gist: string;
  readonly excerpt: string | null;
  readonly source_hash: string | null;
}

export interface VerifiedAssertionAuthority {
  readonly signalId: string;
  readonly owner: VerifiedAssertionOwnerRow & { readonly source_hash: string };
  readonly sourceAssertion: string;
  readonly sourceHash: string;
}

export interface QueuedVerifiedAssertionAuthority extends VerifiedAssertionAuthority {
  readonly sequence: number;
  readonly captureExists: boolean;
}

interface AssertionSignalEnvelope {
  readonly workspace_id: string;
  readonly run_id: string;
  readonly surface_id: string | null;
  readonly source: string;
  readonly signal_state: string;
  readonly raw_payload: Readonly<Record<string, unknown>>;
}

interface AuthorityBatchRow extends VerifiedAssertionOwnerRow {
  readonly sequence: number;
  readonly signal_id: string;
  readonly signal_workspace_id: string | null;
  readonly signal_run_id: string | null;
  readonly signal_surface_id: string | null;
  readonly signal_source: string | null;
  readonly signal_state: string | null;
  readonly raw_payload_json: string | null;
  readonly capture_exists: 0 | 1;
}

export function initializeVerifiedAssertionAuthorityQueue(db: StorageDatabase): number {
  db.connection.exec(`
    DROP TABLE IF EXISTS temp.${AUTHORITY_QUEUE_TABLE};
    CREATE TEMP TABLE ${AUTHORITY_QUEUE_TABLE} (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      signal_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      backfilled INTEGER NOT NULL DEFAULT 0 CHECK (backfilled IN (0, 1))
    );
  `);
  db.connection.prepare(INSERT_AUTHORITY_QUEUE_SQL).run(
    `${VERIFIED_USER_ASSERTION_SOURCE_HASH_PREFIX}%`
  );
  assertQueueIdentity(db, "signal_id", "multiple verified assertion owners resolve from one signal");
  assertQueueIdentity(db, "owner_id", "multiple verified assertion signals resolve to one evidence owner");
  const row = db.connection.prepare(
    `SELECT COUNT(*) AS count FROM ${AUTHORITY_QUEUE_TABLE}`
  ).get() as { readonly count: number };
  return row.count;
}

export function readVerifiedAssertionAuthorityBatch(
  db: StorageDatabase,
  afterSequence: number,
  limit: number
): readonly QueuedVerifiedAssertionAuthority[] {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("authority batch limit must be positive");
  const rows = db.connection.prepare(READ_AUTHORITY_BATCH_SQL).all(
    afterSequence,
    limit
  ) as AuthorityBatchRow[];
  return Object.freeze(rows.map(resolveAuthorityBatchRow));
}

export function markVerifiedAssertionAuthoritiesBackfilled(
  db: StorageDatabase,
  sequences: readonly number[]
): void {
  const mark = db.connection.prepare(
    `UPDATE ${AUTHORITY_QUEUE_TABLE} SET backfilled = 1 WHERE sequence = ?`
  );
  for (const sequence of sequences) mark.run(sequence);
}

export function disposeVerifiedAssertionAuthorityQueue(db: StorageDatabase): void {
  db.connection.exec(`DROP TABLE IF EXISTS temp.${AUTHORITY_QUEUE_TABLE}`);
}

export function resolveVerifiedAssertionAuthority(
  db: StorageDatabase,
  signalRepo: SqliteSignalRepo,
  signalId: string
): VerifiedAssertionAuthority {
  const signal = signalRepo.getByIdInCurrentTransaction(signalId);
  if (signal === null) throw authorityError(signalId, "signal missing");
  const sourceAssertion = assertSignalAuthority(signal, signalId);
  const owner = readAssertionOwner(db, signalId);
  return bindAuthority(signalId, signal, owner, sourceAssertion);
}

function resolveAuthorityBatchRow(row: AuthorityBatchRow): QueuedVerifiedAssertionAuthority {
  if (row.signal_source === null || row.signal_workspace_id === null ||
      row.signal_run_id === null || row.signal_state === null || row.raw_payload_json === null) {
    throw authorityError(row.signal_id, "signal missing");
  }
  const signal: AssertionSignalEnvelope = {
    workspace_id: row.signal_workspace_id,
    run_id: row.signal_run_id,
    surface_id: row.signal_surface_id,
    source: row.signal_source,
    signal_state: row.signal_state,
    raw_payload: parseRawPayload(row.raw_payload_json, row.signal_id)
  };
  const sourceAssertion = assertSignalAuthority(signal, row.signal_id);
  return Object.freeze({
    sequence: row.sequence,
    captureExists: row.capture_exists === 1,
    ...bindAuthority(row.signal_id, signal, row, sourceAssertion)
  });
}

function bindAuthority(
  signalId: string,
  signal: AssertionSignalEnvelope,
  owner: VerifiedAssertionOwnerRow,
  sourceAssertion: string
): VerifiedAssertionAuthority {
  assertOwnerAuthority(owner, signal, sourceAssertion, signalId);
  if (owner.source_hash === null) throw authorityError(signalId, "evidence source_hash missing");
  return Object.freeze({
    signalId,
    owner: owner as VerifiedAssertionOwnerRow & { readonly source_hash: string },
    sourceAssertion,
    sourceHash: owner.source_hash
  });
}

function assertSignalAuthority(signal: AssertionSignalEnvelope, signalId: string): string {
  if (signal.source !== "garden_compile" || signal.signal_state !== "materialized") {
    throw authorityError(signalId, "signal is not a materialized garden assertion");
  }
  const assertion = readNonEmptyString(signal.raw_payload.source_assertion);
  if (assertion === null || assertion !== assertion.trim()) {
    throw authorityError(signalId, "source_assertion missing or non-canonical");
  }
  const grounding = readObject(signal.raw_payload.source_grounding);
  if (grounding?.status !== "grounded" ||
      grounding.content_basis !== "source_assertion" ||
      grounding.source_assertion !== assertion) {
    throw authorityError(signalId, "source_grounding authority mismatch");
  }
  return assertion;
}

function assertOwnerAuthority(
  owner: VerifiedAssertionOwnerRow,
  signal: AssertionSignalEnvelope,
  assertion: string,
  signalId: string
): void {
  if (owner.created_by !== "garden_compile" || owner.lifecycle_state !== "active" ||
      owner.evidence_kind !== "conversation_excerpt" ||
      owner.evidence_health_state !== "verified") {
    throw authorityError(signalId, "evidence owner is not active verified Garden evidence");
  }
  if (owner.workspace_id !== signal.workspace_id || owner.run_id !== signal.run_id ||
      owner.surface_id !== signal.surface_id || owner.excerpt !== assertion) {
    throw authorityError(signalId, "evidence owner envelope mismatch");
  }
  if (readNonEmptyString(signal.raw_payload.full_turn_content) !== owner.gist) {
    throw authorityError(signalId, "source corpus mismatch");
  }
  if (owner.source_hash !== expectedSourceHash(owner, assertion)) {
    throw authorityError(signalId, "verified assertion receipt mismatch");
  }
}

function readAssertionOwner(db: StorageDatabase, signalId: string): VerifiedAssertionOwnerRow {
  const rows = db.connection.prepare(READ_OWNER_SQL).all(
    signalId,
    `${VERIFIED_USER_ASSERTION_SOURCE_HASH_PREFIX}%`
  ) as VerifiedAssertionOwnerRow[];
  if (rows.length !== 1) {
    throw authorityError(signalId, `expected one verified assertion owner, found ${rows.length}`);
  }
  return rows[0]!;
}

function assertQueueIdentity(db: StorageDatabase, column: "signal_id" | "owner_id", reason: string): void {
  const duplicate = db.connection.prepare(`
    SELECT ${column} AS identity
      FROM ${AUTHORITY_QUEUE_TABLE}
     GROUP BY ${column}
    HAVING COUNT(*) != 1
     LIMIT 1
  `).get() as { readonly identity: string } | undefined;
  if (duplicate !== undefined) throw authorityError(duplicate.identity, reason);
}

function expectedSourceHash(owner: VerifiedAssertionOwnerRow, assertion: string): string {
  return formatVerifiedUserAssertionSourceHash(digestText(
    buildVerifiedUserAssertionReceiptPreimage({
      workspace_id: owner.workspace_id,
      run_id: owner.run_id,
      surface_id: owner.surface_id,
      source_assertion: assertion,
      source_corpus: owner.gist
    })
  ));
}

function parseRawPayload(value: string, signalId: string): Readonly<Record<string, unknown>> {
  try {
    const parsed = readObject(JSON.parse(value) as unknown);
    if (parsed !== null) return parsed;
  } catch {
    // The authority error below is deliberately stable across malformed JSON shapes.
  }
  throw authorityError(signalId, "raw payload invalid");
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readObject(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function authorityError(signalId: string, reason: string): Error {
  return new Error(`verified assertion formation ${signalId}: ${reason}`);
}

function digestText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const INSERT_AUTHORITY_QUEUE_SQL = `
  INSERT INTO ${AUTHORITY_QUEUE_TABLE} (signal_id, workspace_id, owner_id)
  SELECT DISTINCT owner.signal_id, owner.workspace_id, owner.owner_id
    FROM recall_routing_key_owners AS owner
    JOIN evidence_capsules AS capsule
      ON capsule.workspace_id = owner.workspace_id
     AND capsule.object_id = owner.owner_id
   WHERE owner.owner_kind = 'evidence_capsule'
     AND capsule.source_hash LIKE ?
   ORDER BY owner.signal_id ASC, owner.owner_id ASC
`;

const READ_AUTHORITY_BATCH_SQL = `
  SELECT queue.sequence, queue.signal_id,
         signal.workspace_id AS signal_workspace_id,
         signal.run_id AS signal_run_id,
         signal.surface_id AS signal_surface_id,
         signal.source AS signal_source,
         signal.signal_state,
         signal.raw_payload_json,
         capsule.object_id, capsule.workspace_id, capsule.run_id,
         capsule.surface_id, capsule.created_by, capsule.lifecycle_state,
         capsule.evidence_kind, capsule.evidence_health_state, capsule.gist,
         capsule.excerpt, capsule.source_hash,
         CASE WHEN formation.evidence_object_id IS NULL THEN 0 ELSE 1 END AS capture_exists
    FROM ${AUTHORITY_QUEUE_TABLE} AS queue
    JOIN evidence_capsules AS capsule
      ON capsule.workspace_id = queue.workspace_id
     AND capsule.object_id = queue.owner_id
    LEFT JOIN signals AS signal ON signal.signal_id = queue.signal_id
    LEFT JOIN evidence_fact_frame_formations AS formation
      ON formation.evidence_object_id = queue.owner_id
   WHERE queue.sequence > ?
   ORDER BY queue.sequence ASC
   LIMIT ?
`;

const READ_OWNER_SQL = `
  SELECT DISTINCT capsule.object_id, capsule.workspace_id, capsule.run_id,
         capsule.surface_id, capsule.created_by, capsule.lifecycle_state,
         capsule.evidence_kind, capsule.evidence_health_state, capsule.gist,
         capsule.excerpt, capsule.source_hash
    FROM recall_routing_key_owners AS owner
    JOIN evidence_capsules AS capsule
      ON capsule.workspace_id = owner.workspace_id
     AND capsule.object_id = owner.owner_id
   WHERE owner.owner_kind = 'evidence_capsule'
     AND owner.signal_id = ?
     AND capsule.source_hash LIKE ?
   ORDER BY capsule.object_id ASC
`;
