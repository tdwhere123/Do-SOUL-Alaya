import { createHash, type Hash } from "node:crypto";
import {
  materializeEvidenceFactFrameFormation,
  RULE_BASED_EVIDENCE_FACT_FRAME_PROPOSAL_NORMALIZER
} from "@do-soul/alaya-core";
import type {
  EvidenceFactFrameFormationCapture,
  EvidenceSearchProjection
} from "@do-soul/alaya-protocol";
import type BetterSqlite3 from "better-sqlite3";
import {
  RecallQualifiedEvidenceReader,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import {
  disposeVerifiedAssertionAuthorityQueue,
  initializeVerifiedAssertionAuthorityQueue,
  markVerifiedAssertionAuthoritiesBackfilled,
  readVerifiedAssertionAuthorityBatch,
  type QueuedVerifiedAssertionAuthority
} from "./verified-assertion-authority.js";

export const DEFAULT_FACT_FRAME_FORMATION_BACKFILL_OPERATOR_ID =
  "default_evidence_fact_frame_formation_backfill_v1";

const BACKFILL_BATCH_SIZE = 512;

export interface FactFrameFormationBackfillReport {
  readonly schema_version: 1;
  readonly operator_id: typeof DEFAULT_FACT_FRAME_FORMATION_BACKFILL_OPERATOR_ID;
  readonly eligible_owner_count: number;
  readonly existing_capture_count: number;
  readonly backfilled_capture_count: number;
  readonly formed_capture_count: number;
  readonly unavailable_capture_count: number;
  readonly rejected_capture_count: number;
  readonly projection_count: number;
  readonly capture_binding_sha256: string;
  readonly projection_content_sha256: string;
}

interface BackfillPlan {
  readonly authority: QueuedVerifiedAssertionAuthority;
  readonly capture: Readonly<EvidenceFactFrameFormationCapture>;
  readonly projections: readonly Readonly<EvidenceSearchProjection>[];
}

interface CanonicalCaptureRow {
  readonly evidence_object_id: string;
  readonly capture_digest: string;
}

interface CanonicalProjectionRow {
  readonly evidence_object_id: string;
  readonly projection_id: number;
  readonly projection_kind: string;
  readonly workspace_id: string;
  readonly source_hash: string;
  readonly content: string;
}

interface BackfillCounters {
  eligibleOwnerCount: number;
  existingCaptureCount: number;
  backfilledCaptureCount: number;
  formedCaptureCount: number;
  unavailableCaptureCount: number;
  rejectedCaptureCount: number;
  projectionCount: number;
}

export function backfillMissingFactFrameFormations(
  db: StorageDatabase,
  batchSize = BACKFILL_BATCH_SIZE
): FactFrameFormationBackfillReport {
  if (!db.connection.inTransaction) {
    throw new Error("fact-frame formation backfill requires an enclosing transaction");
  }
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error("fact-frame formation backfill batch size must be positive");
  }
  const eligibleOwnerCount = initializeVerifiedAssertionAuthorityQueue(db);
  const counters = createCounters(eligibleOwnerCount);
  const captureDigest = new JsonArrayDigest();
  const projectionDigest = new JsonArrayDigest();
  try {
    processAuthorityBatches(db, batchSize, counters, captureDigest, projectionDigest);
    const digests = auditBackfill(db, captureDigest.finish(), projectionDigest.finish());
    return buildReport(counters, digests);
  } finally {
    disposeVerifiedAssertionAuthorityQueue(db);
  }
}

function processAuthorityBatches(
  db: StorageDatabase,
  batchSize: number,
  counters: BackfillCounters,
  captureDigest: JsonArrayDigest,
  projectionDigest: JsonArrayDigest
): void {
  let afterSequence = 0;
  while (true) {
    const authorities = readVerifiedAssertionAuthorityBatch(
      db,
      afterSequence,
      batchSize
    );
    if (authorities.length === 0) return;
    afterSequence = authorities[authorities.length - 1]!.sequence;
    processAuthorityBatch(db, authorities, counters, captureDigest, projectionDigest);
  }
}

function processAuthorityBatch(
  db: StorageDatabase,
  authorities: readonly QueuedVerifiedAssertionAuthority[],
  counters: BackfillCounters,
  captureDigest: JsonArrayDigest,
  projectionDigest: JsonArrayDigest
): void {
  const missing = authorities.filter(({ captureExists }) => !captureExists);
  counters.existingCaptureCount += authorities.length - missing.length;
  if (missing.length === 0) return;
  assertRuntimeQualifiedOwners(db, missing);
  const plans = computePlans(missing);
  applyPlans(db, plans);
  recordPlans(plans, counters, captureDigest, projectionDigest);
}

function assertRuntimeQualifiedOwners(
  db: StorageDatabase,
  authorities: readonly QueuedVerifiedAssertionAuthority[]
): void {
  const byWorkspace = new Map<string, QueuedVerifiedAssertionAuthority[]>();
  for (const authority of authorities) {
    const current = byWorkspace.get(authority.owner.workspace_id) ?? [];
    current.push(authority);
    byWorkspace.set(authority.owner.workspace_id, current);
  }
  const reader = new RecallQualifiedEvidenceReader(db);
  for (const [workspaceId, workspaceAuthorities] of byWorkspace) {
    const requested = workspaceAuthorities.map(({ owner }) => owner.object_id);
    const qualified = new Set(reader.findReceiptQualifiedOwnerIds(workspaceId, requested));
    const rejected = workspaceAuthorities.find(({ owner }) => !qualified.has(owner.object_id));
    if (rejected !== undefined) {
      throw new Error(`verified assertion formation ${rejected.signalId}: runtime qualification failed`);
    }
  }
}

function computePlans(
  authorities: readonly QueuedVerifiedAssertionAuthority[]
): readonly BackfillPlan[] {
  return Object.freeze(authorities.map((authority) => {
    const formation = materializeEvidenceFactFrameFormation({
      sourceAssertion: authority.sourceAssertion,
      sourceHash: authority.sourceHash,
      normalizer: RULE_BASED_EVIDENCE_FACT_FRAME_PROPOSAL_NORMALIZER
    });
    if (formation.capture.status === "ineligible") {
      throw new Error(`verified assertion formation ${authority.signalId}: became ineligible`);
    }
    return Object.freeze({
      authority,
      capture: formation.capture,
      projections: Object.freeze([...formation.searchProjections].sort(
        (left, right) => left.projection_id - right.projection_id
      ))
    });
  }));
}

function applyPlans(db: StorageDatabase, plans: readonly BackfillPlan[]): void {
  const insertCapture = db.connection.prepare(INSERT_CAPTURE_SQL);
  const removeFactKeys = db.connection.prepare(DELETE_FACT_KEYS_SQL);
  const insertProjection = db.connection.prepare(INSERT_PROJECTION_SQL);
  for (const plan of plans) {
    persistCapture(insertCapture, plan);
    removeFactKeys.run(plan.authority.owner.object_id);
    for (const projection of plan.projections) {
      persistProjection(insertProjection, plan, projection);
    }
  }
  markVerifiedAssertionAuthoritiesBackfilled(
    db,
    plans.map(({ authority }) => authority.sequence)
  );
}

function persistCapture(insert: BetterSqlite3.Statement, plan: BackfillPlan): void {
  const capture = plan.capture;
  insert.run(
    plan.authority.owner.object_id,
    plan.authority.owner.workspace_id,
    capture.schema_version,
    capture.operator_id,
    capture.status,
    capture.producer_operator_id,
    capture.source_hash,
    capture.fact_frame === null ? null : JSON.stringify(capture.fact_frame),
    capture.capture_digest
  );
}

function persistProjection(
  insert: BetterSqlite3.Statement,
  plan: BackfillPlan,
  projection: Readonly<EvidenceSearchProjection>
): void {
  insert.run(
    plan.authority.owner.object_id,
    projection.projection_id,
    projection.projection_kind,
    plan.authority.owner.workspace_id,
    plan.authority.sourceHash,
    projection.content
  );
}

function recordPlans(
  plans: readonly BackfillPlan[],
  counters: BackfillCounters,
  captureDigest: JsonArrayDigest,
  projectionDigest: JsonArrayDigest
): void {
  for (const plan of plans) {
    counters.backfilledCaptureCount += 1;
    incrementStatus(counters, plan.capture.status);
    captureDigest.add(canonicalCaptureRow(plan));
    for (const row of canonicalProjectionRows(plan)) {
      counters.projectionCount += 1;
      projectionDigest.add(row);
    }
  }
}

function auditBackfill(
  db: StorageDatabase,
  expectedCaptureDigest: string,
  expectedProjectionDigest: string
): Readonly<{ capture: string; projections: string }> {
  const actualCaptureDigest = digestRows(
    db.connection.prepare(READ_BACKFILLED_CAPTURES_SQL).iterate()
  );
  const actualProjectionDigest = digestRows(
    db.connection.prepare(READ_BACKFILLED_PROJECTIONS_SQL).iterate()
  );
  if (actualCaptureDigest !== expectedCaptureDigest ||
      actualProjectionDigest !== expectedProjectionDigest) {
    throw new Error("verified assertion formation persisted audit mismatch");
  }
  return Object.freeze({
    capture: expectedCaptureDigest,
    projections: expectedProjectionDigest
  });
}

function canonicalCaptureRow(plan: BackfillPlan): CanonicalCaptureRow {
  return {
    evidence_object_id: plan.authority.owner.object_id,
    capture_digest: plan.capture.capture_digest
  };
}

function canonicalProjectionRows(plan: BackfillPlan): readonly CanonicalProjectionRow[] {
  return Object.freeze(plan.projections.map((projection) => ({
    evidence_object_id: plan.authority.owner.object_id,
    projection_id: projection.projection_id,
    projection_kind: projection.projection_kind,
    workspace_id: plan.authority.owner.workspace_id,
    source_hash: plan.authority.sourceHash,
    content: projection.content
  })));
}

function incrementStatus(counters: BackfillCounters, status: string): void {
  if (status === "formed") counters.formedCaptureCount += 1;
  else if (status === "unavailable") counters.unavailableCaptureCount += 1;
  else if (status === "rejected") counters.rejectedCaptureCount += 1;
}

function createCounters(eligibleOwnerCount: number): BackfillCounters {
  return {
    eligibleOwnerCount,
    existingCaptureCount: 0,
    backfilledCaptureCount: 0,
    formedCaptureCount: 0,
    unavailableCaptureCount: 0,
    rejectedCaptureCount: 0,
    projectionCount: 0
  };
}

function buildReport(
  counters: BackfillCounters,
  digests: Readonly<{ capture: string; projections: string }>
): FactFrameFormationBackfillReport {
  return Object.freeze({
    schema_version: 1,
    operator_id: DEFAULT_FACT_FRAME_FORMATION_BACKFILL_OPERATOR_ID,
    eligible_owner_count: counters.eligibleOwnerCount,
    existing_capture_count: counters.existingCaptureCount,
    backfilled_capture_count: counters.backfilledCaptureCount,
    formed_capture_count: counters.formedCaptureCount,
    unavailable_capture_count: counters.unavailableCaptureCount,
    rejected_capture_count: counters.rejectedCaptureCount,
    projection_count: counters.projectionCount,
    capture_binding_sha256: digests.capture,
    projection_content_sha256: digests.projections
  });
}

class JsonArrayDigest {
  private readonly hash: Hash = createHash("sha256").update("[", "utf8");
  private count = 0;

  public add(value: unknown): void {
    if (this.count > 0) this.hash.update(",", "utf8");
    this.hash.update(JSON.stringify(value), "utf8");
    this.count += 1;
  }

  public finish(): string {
    return this.hash.update("]", "utf8").digest("hex");
  }
}

function digestRows(rows: Iterable<unknown>): string {
  const digest = new JsonArrayDigest();
  for (const row of rows) digest.add(row);
  return digest.finish();
}

const INSERT_CAPTURE_SQL = `
  INSERT INTO evidence_fact_frame_formations (
    evidence_object_id, workspace_id, schema_version, operator_id, status,
    producer_operator_id, source_hash, fact_frame_json, capture_digest
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const DELETE_FACT_KEYS_SQL = `
  DELETE FROM evidence_search_projections
   WHERE evidence_object_id = ? AND projection_kind = 'fact_key'
`;

const INSERT_PROJECTION_SQL = `
  INSERT INTO evidence_search_projections (
    evidence_object_id, projection_id, projection_kind,
    workspace_id, source_hash, content
  ) VALUES (?, ?, ?, ?, ?, ?)
`;

const READ_BACKFILLED_CAPTURES_SQL = `
  SELECT queue.owner_id AS evidence_object_id, formation.capture_digest
    FROM verified_assertion_formation_queue AS queue
    JOIN evidence_fact_frame_formations AS formation
      ON formation.evidence_object_id = queue.owner_id
   WHERE queue.backfilled = 1
   ORDER BY queue.sequence ASC
`;

const READ_BACKFILLED_PROJECTIONS_SQL = `
  SELECT projection.evidence_object_id, projection.projection_id,
         projection.projection_kind, projection.workspace_id,
         projection.source_hash, projection.content
    FROM verified_assertion_formation_queue AS queue
    JOIN evidence_search_projections AS projection
      ON projection.evidence_object_id = queue.owner_id
     AND projection.projection_kind = 'fact_key'
   WHERE queue.backfilled = 1
   ORDER BY queue.sequence ASC, projection.projection_id ASC
`;
