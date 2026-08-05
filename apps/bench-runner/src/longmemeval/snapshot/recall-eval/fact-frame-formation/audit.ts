import { createHash } from "node:crypto";
import { lstat, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { replayEvidenceFactFrameFormationCapture } from "@do-soul/alaya-core";
import type {
  EvidenceFactFrameFormationCapture,
  EvidenceSearchProjection
} from "@do-soul/alaya-protocol";
import { sha256File } from "../../integrity.js";
import {
  summarizeFactFrameFormationBindings,
  type FormationBindingRow
} from "../fact-frame-formation-summary.js";

const REQUIRED_FORMATION_MIGRATION = 116;

export interface FactFrameFormationAuditCount {
  readonly reason: string;
  readonly owner_count: number;
}

export interface FactFrameFormationAuditReport {
  readonly schema_version: 1;
  readonly report_kind: "evidence_fact_frame_formation_audit";
  readonly promotable: false;
  readonly snapshot_db_sha256: string;
  readonly working_schema_version: number;
  readonly integrity_valid: boolean;
  readonly formation_complete: boolean;
  readonly evidence_owner_count: number;
  readonly source_eligible_owner_count: number;
  readonly capture_count: number;
  readonly captured_source_eligible_owner_count: number;
  readonly legacy_uncaptured_owner_count: number;
  readonly source_bound_count: number;
  readonly formed_owner_count: number;
  readonly formed_rate_of_source_eligible: number | null;
  readonly status_counts: readonly Readonly<{
    readonly status: string;
    readonly capture_count: number;
  }>[];
  readonly producer_operator_counts: readonly Readonly<{
    readonly producer_operator_id: string | null;
    readonly capture_count: number;
  }>[];
  readonly fact_key_projection_count: number;
  readonly replay_verified_owner_count: number;
  readonly invalid_owner_count: number;
  readonly invalid_reason_counts: readonly Readonly<FactFrameFormationAuditCount>[];
  readonly capture_binding_sha256: string;
  readonly projection_binding_sha256: string;
}

interface EvidenceOwnerRow {
  readonly object_id: string;
  readonly workspace_id: string;
  readonly source_hash: string | null;
  readonly excerpt: string | null;
}

interface FormationRow extends FormationBindingRow {
  readonly workspace_id: string;
  readonly schema_version: number;
  readonly operator_id: string;
  readonly fact_frame_json: string | null;
}

interface ProjectionRow {
  readonly evidence_object_id: string;
  readonly projection_id: number;
  readonly projection_kind: string;
  readonly workspace_id: string;
  readonly source_hash: string | null;
  readonly content: string;
}

interface AuditRows {
  readonly owners: readonly EvidenceOwnerRow[];
  readonly formations: readonly FormationRow[];
  readonly projections: readonly ProjectionRow[];
  readonly workingSchemaVersion: number;
}

interface AuditCoverage {
  readonly sourceEligibleOwnerCount: number;
  readonly capturedSourceEligibleOwnerCount: number;
  readonly legacyUncapturedOwnerCount: number;
  readonly replayVerifiedOwnerCount: number;
  readonly issues: ReadonlyMap<string, ReadonlySet<string>>;
  readonly ownerIds: ReadonlySet<string>;
}

export async function auditEvidenceFactFrameFormations(
  snapshotDbPath: string
): Promise<Readonly<FactFrameFormationAuditReport>> {
  const resolvedPath = path.resolve(snapshotDbPath);
  await assertSealedRegularDatabase(resolvedPath);
  const beforeHash = await sha256File(resolvedPath);
  const rows = readAuditRows(resolvedPath);
  await assertSealedRegularDatabase(resolvedPath);
  const afterHash = await sha256File(resolvedPath);
  if (afterHash !== beforeHash) {
    throw new Error("formation audit input changed while it was being read");
  }
  return buildAuditReport(rows, beforeHash);
}

async function assertSealedRegularDatabase(dbPath: string): Promise<void> {
  const stats = await lstat(dbPath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error("formation audit snapshot must be a regular non-symlink file");
  }
  for (const suffix of ["-wal", "-journal"]) {
    const sidecar = await stat(`${dbPath}${suffix}`).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (sidecar !== null && sidecar.size > 0) {
      throw new Error(`formation audit snapshot has uncheckpointed ${suffix} data`);
    }
  }
}

function readAuditRows(dbPath: string): AuditRows {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const workingSchemaVersion = readWorkingSchemaVersion(db);
    if (workingSchemaVersion < REQUIRED_FORMATION_MIGRATION) {
      throw new Error(
        `formation audit requires schema migration ${REQUIRED_FORMATION_MIGRATION}`
      );
    }
    return Object.freeze({
      owners: readOwners(db),
      formations: readFormations(db),
      projections: readFactKeyProjections(db),
      workingSchemaVersion
    });
  } finally {
    db.close();
  }
}

function readWorkingSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare("SELECT MAX(version) AS version FROM schema_version")
    .get() as unknown as { readonly version: number | null };
  if (!Number.isInteger(row.version)) {
    throw new Error("formation audit snapshot has no schema migration ledger");
  }
  return row.version as number;
}

function readOwners(db: DatabaseSync): readonly EvidenceOwnerRow[] {
  return db.prepare(`
    SELECT object_id, workspace_id, source_hash, excerpt
    FROM evidence_capsules
    ORDER BY object_id ASC
  `).all() as unknown as readonly EvidenceOwnerRow[];
}

function readFormations(db: DatabaseSync): readonly FormationRow[] {
  return db.prepare(`
    SELECT evidence_object_id, workspace_id, schema_version, operator_id, status,
           producer_operator_id, source_hash, fact_frame_json, capture_digest
    FROM evidence_fact_frame_formations
    ORDER BY evidence_object_id ASC
  `).all() as unknown as readonly FormationRow[];
}

function readFactKeyProjections(db: DatabaseSync): readonly ProjectionRow[] {
  return db.prepare(`
    SELECT evidence_object_id, projection_id, projection_kind,
           workspace_id, source_hash, content
    FROM evidence_search_projections
    WHERE projection_kind = 'fact_key'
    ORDER BY evidence_object_id ASC, projection_id ASC
  `).all() as unknown as readonly ProjectionRow[];
}

function buildAuditReport(
  rows: AuditRows,
  snapshotDbSha256: string
): Readonly<FactFrameFormationAuditReport> {
  const coverage = inspectOwnerCoverage(rows);
  const summary = summarizeFactFrameFormationBindings(rows.formations);
  const formedOwnerCount = rows.formations.filter(({ evidence_object_id, status }) =>
    status === "formed" && coverage.ownerIds.has(evidence_object_id)).length;
  return Object.freeze({
    schema_version: 1,
    report_kind: "evidence_fact_frame_formation_audit",
    promotable: false,
    snapshot_db_sha256: snapshotDbSha256,
    working_schema_version: rows.workingSchemaVersion,
    integrity_valid: coverage.issues.size === 0,
    formation_complete: coverage.legacyUncapturedOwnerCount === 0,
    evidence_owner_count: rows.owners.length,
    source_eligible_owner_count: coverage.sourceEligibleOwnerCount,
    capture_count: summary.capture_count,
    captured_source_eligible_owner_count: coverage.capturedSourceEligibleOwnerCount,
    legacy_uncaptured_owner_count: coverage.legacyUncapturedOwnerCount,
    source_bound_count: summary.source_bound_count,
    formed_owner_count: formedOwnerCount,
    formed_rate_of_source_eligible: coverage.sourceEligibleOwnerCount === 0
      ? null
      : formedOwnerCount / coverage.sourceEligibleOwnerCount,
    status_counts: summary.status_counts,
    producer_operator_counts: summary.producer_operator_counts,
    fact_key_projection_count: rows.projections.length,
    replay_verified_owner_count: coverage.replayVerifiedOwnerCount,
    invalid_owner_count: coverage.issues.size,
    invalid_reason_counts: summarizeIssues(coverage.issues),
    capture_binding_sha256: summary.capture_binding_sha256,
    projection_binding_sha256: digestProjectionRows(rows.projections)
  });
}

function inspectOwnerCoverage(rows: AuditRows): AuditCoverage {
  const issues = new Map<string, Set<string>>();
  const ownersById = new Map(rows.owners.map((owner) => [owner.object_id, owner]));
  const formationsById = new Map(rows.formations.map((formation) =>
    [formation.evidence_object_id, formation]));
  const projectionsById = groupProjections(rows.projections);
  let sourceEligibleOwnerCount = 0;
  let capturedSourceEligibleOwnerCount = 0;
  let legacyUncapturedOwnerCount = 0;
  let replayVerifiedOwnerCount = 0;

  for (const owner of rows.owners) {
    const eligible = isSourceEligible(owner);
    if (eligible) sourceEligibleOwnerCount += 1;
    const formation = formationsById.get(owner.object_id);
    const projections = projectionsById.get(owner.object_id) ?? [];
    if (formation === undefined) {
      if (eligible) legacyUncapturedOwnerCount += 1;
      if (projections.length > 0) addIssue(issues, owner.object_id, "uncaptured_fact_key");
      continue;
    }
    if (eligible) capturedSourceEligibleOwnerCount += 1;
    if (verifyCapturedOwner(owner, formation, projections, issues)) {
      replayVerifiedOwnerCount += 1;
    }
  }
  markOrphans(rows, ownersById, issues);
  return Object.freeze({
    sourceEligibleOwnerCount,
    capturedSourceEligibleOwnerCount,
    legacyUncapturedOwnerCount,
    replayVerifiedOwnerCount,
    issues,
    ownerIds: new Set(ownersById.keys())
  });
}

function verifyCapturedOwner(
  owner: EvidenceOwnerRow,
  formation: FormationRow,
  storedProjections: readonly ProjectionRow[],
  issues: Map<string, Set<string>>
): boolean {
  const beforeIssueCount = issues.get(owner.object_id)?.size ?? 0;
  if (formation.workspace_id !== owner.workspace_id) {
    addIssue(issues, owner.object_id, "workspace_mismatch");
  }
  if (formation.source_hash !== owner.source_hash) {
    addIssue(issues, owner.object_id, "source_hash_mismatch");
  }
  if ((formation.status !== "ineligible") !== isSourceEligible(owner)) {
    addIssue(issues, owner.object_id, "status_input_mismatch");
  }
  const replay = replayFormation(owner, formation, issues);
  if (replay !== null && !sameProjections(owner, replay, storedProjections)) {
    addIssue(issues, owner.object_id, "projection_mismatch");
  }
  return (issues.get(owner.object_id)?.size ?? 0) === beforeIssueCount;
}

function replayFormation(
  owner: EvidenceOwnerRow,
  formation: FormationRow,
  issues: Map<string, Set<string>>
): readonly Readonly<EvidenceSearchProjection>[] | null {
  try {
    const capture: EvidenceFactFrameFormationCapture = {
      schema_version: formation.schema_version as 1,
      operator_id: formation.operator_id as EvidenceFactFrameFormationCapture["operator_id"],
      status: formation.status as EvidenceFactFrameFormationCapture["status"],
      producer_operator_id: formation.producer_operator_id,
      source_hash: formation.source_hash,
      fact_frame: formation.fact_frame_json === null
        ? null
        : JSON.parse(formation.fact_frame_json) as EvidenceFactFrameFormationCapture["fact_frame"],
      capture_digest: formation.capture_digest
    };
    return replayEvidenceFactFrameFormationCapture({
      sourceAssertion: owner.excerpt,
      sourceHash: owner.source_hash,
      capture
    }).searchProjections;
  } catch {
    addIssue(issues, owner.object_id, "capture_replay_failed");
    return null;
  }
}

function sameProjections(
  owner: EvidenceOwnerRow,
  expected: readonly Readonly<EvidenceSearchProjection>[],
  stored: readonly ProjectionRow[]
): boolean {
  const expectedRows: readonly ProjectionRow[] = expected.map((projection) => ({
    evidence_object_id: owner.object_id,
    projection_id: projection.projection_id,
    projection_kind: projection.projection_kind,
    workspace_id: owner.workspace_id,
    source_hash: owner.source_hash,
    content: projection.content
  }));
  return JSON.stringify(stored) === JSON.stringify(expectedRows);
}

function groupProjections(
  rows: readonly ProjectionRow[]
): ReadonlyMap<string, readonly ProjectionRow[]> {
  const grouped = new Map<string, ProjectionRow[]>();
  for (const row of rows) {
    const ownerRows = grouped.get(row.evidence_object_id) ?? [];
    ownerRows.push(row);
    grouped.set(row.evidence_object_id, ownerRows);
  }
  return grouped;
}

function markOrphans(
  rows: AuditRows,
  owners: ReadonlyMap<string, EvidenceOwnerRow>,
  issues: Map<string, Set<string>>
): void {
  for (const formation of rows.formations) {
    if (!owners.has(formation.evidence_object_id)) {
      addIssue(issues, formation.evidence_object_id, "orphan_capture");
    }
  }
  for (const projection of rows.projections) {
    if (!owners.has(projection.evidence_object_id)) {
      addIssue(issues, projection.evidence_object_id, "orphan_fact_key");
    }
  }
}

function isSourceEligible(owner: EvidenceOwnerRow): boolean {
  return normalizeText(owner.excerpt) !== null && normalizeText(owner.source_hash) !== null;
}

function normalizeText(value: string | null): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length === 0 ? null : normalized;
}

function addIssue(
  issues: Map<string, Set<string>>,
  ownerId: string,
  reason: string
): void {
  const ownerIssues = issues.get(ownerId) ?? new Set<string>();
  ownerIssues.add(reason);
  issues.set(ownerId, ownerIssues);
}

function summarizeIssues(
  issues: ReadonlyMap<string, ReadonlySet<string>>
): readonly Readonly<FactFrameFormationAuditCount>[] {
  const counts = new Map<string, number>();
  for (const reasons of issues.values()) {
    for (const reason of reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return Object.freeze([...counts].sort(([left], [right]) =>
    left.localeCompare(right)).map(([reason, ownerCount]) => Object.freeze({
    reason,
    owner_count: ownerCount
  })));
}

function digestProjectionRows(rows: readonly ProjectionRow[]): string {
  const bindings = rows.map((row) => [
    row.evidence_object_id,
    row.projection_id,
    row.projection_kind,
    row.workspace_id,
    row.source_hash,
    row.content
  ]);
  return createHash("sha256").update(JSON.stringify(bindings), "utf8").digest("hex");
}
