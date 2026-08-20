import { createHash } from "node:crypto";
import {
  EvidenceSearchProjectionSchema,
  GARDEN_SOURCE_TURN_FALLBACK_V2_SOURCE_HASH_PREFIX,
  formatGardenSourceTurnFallbackArtifactRef,
  formatGardenSourceTurnFallbackV2SourceHash,
  isGardenSourceTurnFallbackV2Receipt,
  readGardenSourceTurnFallbackArtifactSignalId,
  verifyGardenSourceTurnFallbackReceipt,
  type CandidateMemorySignal,
  type EvidenceSearchProjection
} from "@do-soul/alaya-protocol";
import {
  buildGardenTurnEvidenceSearchProjections,
  verifyOfficialApiSourceLocatorBinding
} from "@do-soul/alaya-soul";
import {
  getCurrentSchemaSummary,
  initDatabase,
  readSchemaMigrationLedger,
  RecallQualifiedEvidenceReader,
  SqliteSignalRepo,
  TEMPORAL_OFFLINE_MIGRATION_VERSION,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { sha256File } from "../integrity.js";
import {
  applyFactFrameRetrofit,
  readFactFrameRetrofitLedger
} from "./fact-frame-retrofit.js";
import { replayStoredEvidenceFactFrameFormation } from
  "./fact-frame-formation-replay.js";
import {
  readEvidenceProjectionOwners,
  type EvidenceProjectionOwnerRow
} from "./evidence-projection-owner-read.js";
import {
  emptyFactFrameFormationSummary,
  summarizeFactFrameFormations
} from "./fact-frame-formation-summary.js";
import { backfillMissingFactFrameFormations } from
  "./fact-frame-formation/backfill.js";
import {
  EVIDENCE_PROJECTION_REBUILD_REPORT_SCHEMA_VERSION,
  type EvidenceSearchProjectionKindCount,
  type EvidenceSearchProjectionRebuildReport,
  type EvidenceSearchProjectionRebuildReportBody
} from "./evidence-search-projection-rebuild-report.js";

export type {
  EvidenceSearchProjectionKindCount,
  EvidenceSearchProjectionRebuildReport
} from "./evidence-search-projection-rebuild-report.js";

const FIRST_EVIDENCE_PROJECTION_SCHEMA_VERSION = 2;

interface PlannedOwner {
  readonly owner: EvidenceProjectionVerifiedOwnerRow;
  readonly projections: readonly Readonly<EvidenceSearchProjection>[];
}

interface EvidenceProjectionVerifiedOwnerRow extends EvidenceProjectionOwnerRow {
  readonly source_hash: string;
}

interface ResolvedV2Owner {
  readonly owner: EvidenceProjectionVerifiedOwnerRow;
  readonly signal: CandidateMemorySignal;
}

interface RejectedOwner {
  readonly objectId: string;
  readonly reason: string;
}

interface CanonicalProjectionRow {
  readonly evidence_object_id: string;
  readonly projection_id: number;
  readonly projection_kind: string;
  readonly workspace_id: string;
  readonly source_hash: string;
  readonly content: string;
}

export class EvidenceSearchProjectionRebuildError extends Error {
  public constructor(
    message: string,
    public readonly report: EvidenceSearchProjectionRebuildReportBody
  ) {
    super(message);
    this.name = "EvidenceSearchProjectionRebuildError";
  }
}

export async function rebuildEvidenceSearchProjectionsOnWorkingCopy(input: {
  readonly workingDbPath: string;
  readonly factFrameRetrofitLedgerPath?: string;
  readonly backfillMissingFactFrameFormations?: boolean;
  readonly sourceExtractionSystemPromptSha256?: string;
}): Promise<EvidenceSearchProjectionRebuildReport> {
  const inputDbSha256 = await sha256File(input.workingDbPath);
  if (input.factFrameRetrofitLedgerPath !== undefined &&
      input.backfillMissingFactFrameFormations === true) {
    throw new Error("default fact-frame backfill cannot be combined with retrofit ledger");
  }
  const sourceSchemaVersion = assertEligibleWorkingSchema(input.workingDbPath);
  const retrofitLedger = input.factFrameRetrofitLedgerPath === undefined
    ? null
    : readFactFrameRetrofitLedger(input.factFrameRetrofitLedgerPath);
  const db = initDatabase({
    filename: input.workingDbPath,
    temporalMode: "candidate"
  });
  let report: EvidenceSearchProjectionRebuildReportBody;
  try {
    const workingSchemaVersion = assertCurrentProjectionSchema(db);
    report = db.connection.transaction(() => {
      const backfill = input.backfillMissingFactFrameFormations === true
        ? backfillMissingFactFrameFormations(db)
        : null;
      const rebuilt = rebuildAllVerifiedOwners(
        db,
        sourceSchemaVersion,
        workingSchemaVersion
      );
      const withBackfill = backfill === null ? rebuilt : Object.freeze({
        ...rebuilt,
        fact_frame_formation_backfill: backfill
      });
      if (retrofitLedger === null) return withBackfill;
      return Object.freeze({
        ...withBackfill,
        fact_frame_retrofit: applyFactFrameRetrofit(db, retrofitLedger)
      });
    }).immediate();
  } finally {
    db.close();
  }
  const attributedReport = input.sourceExtractionSystemPromptSha256 === undefined
    ? report
    : Object.freeze({
        ...report,
        source_extraction_system_prompt_sha256:
          input.sourceExtractionSystemPromptSha256
      });
  return Object.freeze({
    ...attributedReport,
    input_db_sha256: inputDbSha256,
    rebuilt_db_identity_sha256: digestRebuiltDatabaseIdentity(
      inputDbSha256,
      attributedReport
    )
  });
}

function digestRebuiltDatabaseIdentity(
  inputDbSha256: string,
  report: EvidenceSearchProjectionRebuildReportBody
): string {
  return createHash("sha256")
    .update(JSON.stringify({ input_db_sha256: inputDbSha256, ...report }), "utf8")
    .digest("hex");
}

function rebuildAllVerifiedOwners(
  db: StorageDatabase,
  sourceSchemaVersion: number,
  workingSchemaVersion: number
): EvidenceSearchProjectionRebuildReportBody {
  const owners = readEvidenceProjectionOwners(db);
  const signalRepo = new SqliteSignalRepo(db);
  const { resolved, rejected } = resolveCandidateOwners(signalRepo, owners);
  const qualifiedOwnerIds = readRuntimeQualifiedOwnerIds(db, resolved);
  const planned = resolved.flatMap((owner) => {
    if (!qualifiedOwnerIds.has(owner.owner.object_id)) {
      rejected.push(reject(owner.owner, "runtime qualification failed"));
      return [];
    }
    const result = planResolvedOwner(db, owner);
    if ("reason" in result) {
      rejected.push(result);
      return [];
    }
    return [result];
  });
  const eligibleOwnerCount = planned.length + rejected.length;
  if (rejected.length > 0) {
    throw new EvidenceSearchProjectionRebuildError(
      renderRejectionMessage(rejected),
      emptyReport(
        sourceSchemaVersion,
        workingSchemaVersion,
        eligibleOwnerCount,
        rejected.length
      )
    );
  }
  replacePlannedOwners(db, planned);
  return buildReport(
    db,
    sourceSchemaVersion,
    workingSchemaVersion,
    eligibleOwnerCount,
    planned
  );
}

function resolveCandidateOwners(
  signalRepo: SqliteSignalRepo,
  owners: readonly EvidenceProjectionOwnerRow[]
): {
  readonly resolved: readonly ResolvedV2Owner[];
  readonly rejected: RejectedOwner[];
} {
  const resolved: ResolvedV2Owner[] = [];
  const rejected: RejectedOwner[] = [];
  for (const owner of owners) {
    const result = resolveV2Owner(signalRepo, owner);
    if (result === null) continue;
    if ("reason" in result) rejected.push(result);
    else resolved.push(result);
  }
  return { resolved: Object.freeze(resolved), rejected };
}

function readRuntimeQualifiedOwnerIds(
  db: StorageDatabase,
  owners: readonly ResolvedV2Owner[]
): ReadonlySet<string> {
  const byWorkspace = new Map<string, ResolvedV2Owner[]>();
  for (const owner of owners) {
    const current = byWorkspace.get(owner.owner.workspace_id);
    if (current === undefined) byWorkspace.set(owner.owner.workspace_id, [owner]);
    else current.push(owner);
  }
  const reader = new RecallQualifiedEvidenceReader(
    db,
    verifyOfficialApiSourceLocatorBinding,
    { strictParse: true }
  );
  const qualified = new Set<string>();
  for (const [workspaceId, workspaceOwners] of byWorkspace) {
    const objectIds = workspaceOwners.map(({ owner }) => owner.object_id);
    for (const objectId of reader.findReceiptQualifiedOwnerIds(
      workspaceId,
      objectIds
    )) {
      qualified.add(objectId);
    }
  }
  return qualified;
}

function planResolvedOwner(
  db: StorageDatabase,
  resolved: ResolvedV2Owner
): PlannedOwner | RejectedOwner {
  let factKeys: readonly Readonly<EvidenceSearchProjection>[];
  try {
    factKeys = replayStoredEvidenceFactFrameFormation(db, {
      objectId: resolved.owner.object_id,
      workspaceId: resolved.owner.workspace_id,
      sourceHash: resolved.owner.source_hash,
      sourceAssertion: resolved.owner.excerpt
    });
  } catch (error) {
    return reject(resolved.owner, `fact-frame formation replay failed: ${
      error instanceof Error ? error.message : "unknown error"
    }`);
  }
  const projections = [
    ...buildGardenTurnEvidenceSearchProjections(resolved.signal),
    ...factKeys
  ]
    .map((projection) => EvidenceSearchProjectionSchema.parse(projection))
    .sort(compareProjections);
  if (new Set(projections.map(projectionIdentity)).size !==
      projections.length) {
    return reject(
      resolved.owner,
      "receipt projector returned duplicate projection identities"
    );
  }
  return Object.freeze({
    owner: resolved.owner,
    projections: Object.freeze(projections)
  });
}

function resolveV2Owner(
  signalRepo: SqliteSignalRepo,
  owner: EvidenceProjectionOwnerRow
): ResolvedV2Owner | RejectedOwner | null {
  if (owner.artifact_ref === null) return reject(owner, "artifact_ref missing");
  const signalId = readGardenSourceTurnFallbackArtifactSignalId(owner.artifact_ref);
  if (signalId === null ||
      formatGardenSourceTurnFallbackArtifactRef(signalId) !== owner.artifact_ref) {
    return reject(owner, "artifact_ref mismatch");
  }
  const signal = signalRepo.getByIdInCurrentTransaction(signalId);
  if (signal === null) return reject(owner, "receipt signal missing");
  const receipt = verifyGardenSourceTurnFallbackReceipt(signal, digestText);
  if (receipt === null) return reject(owner, "receipt mismatch");
  if (!isGardenSourceTurnFallbackV2Receipt(receipt)) {
    return owner.source_hash?.startsWith(
      GARDEN_SOURCE_TURN_FALLBACK_V2_SOURCE_HASH_PREFIX
    ) === true
      ? reject(owner, "source_hash v2 receipt mismatch")
      : null;
  }
  const sourceHash = formatGardenSourceTurnFallbackV2SourceHash(receipt.digest);
  if (sourceHash !== owner.source_hash) {
    return reject(owner, "source_hash mismatch");
  }
  if (signal.workspace_id !== owner.workspace_id) {
    return reject(owner, "workspace mismatch");
  }
  return Object.freeze({
    owner: Object.freeze({
      ...owner,
      source_hash: sourceHash
    }),
    signal
  });
}

function replacePlannedOwners(
  db: StorageDatabase,
  planned: readonly PlannedOwner[]
): void {
  const remove = db.connection.prepare(`
    DELETE FROM evidence_search_projections WHERE evidence_object_id = ?
  `);
  const insert = db.connection.prepare(`
    INSERT INTO evidence_search_projections (
      evidence_object_id,
      projection_id,
      projection_kind,
      workspace_id,
      source_hash,
      content
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const { owner, projections } of planned) {
    remove.run(owner.object_id);
    for (const projection of projections) {
      insert.run(
        owner.object_id,
        projection.projection_id,
        projection.projection_kind,
        owner.workspace_id,
        owner.source_hash,
        projection.content
      );
    }
  }
}

function buildReport(
  db: StorageDatabase,
  sourceSchemaVersion: number,
  workingSchemaVersion: number,
  eligibleOwnerCount: number,
  planned: readonly PlannedOwner[]
): EvidenceSearchProjectionRebuildReportBody {
  const rows = canonicalProjectionRows(planned);
  const zeroChildOwnerCount = planned.filter(
    (owner) => owner.projections.length === 0
  ).length;
  return Object.freeze({
    schema_version: EVIDENCE_PROJECTION_REBUILD_REPORT_SCHEMA_VERSION,
    promotable: false,
    source_schema_version: sourceSchemaVersion,
    working_schema_version: workingSchemaVersion,
    eligible_owner_count: eligibleOwnerCount,
    rebuilt_owner_count: planned.length,
    rejected_owner_count: 0,
    zero_child_owner_count: zeroChildOwnerCount,
    nonzero_child_owner_count: planned.length - zeroChildOwnerCount,
    child_count: rows.length,
    projection_kind_counts: countProjectionKinds(rows),
    projection_content_sha256: digestRows(rows),
    fact_frame_formation: summarizeFactFrameFormations(
      db,
      planned.map(({ owner }) => owner.object_id)
    )
  });
}

function emptyReport(
  sourceSchemaVersion: number,
  workingSchemaVersion: number,
  eligibleOwnerCount: number,
  rejectedOwnerCount: number
): EvidenceSearchProjectionRebuildReportBody {
  return Object.freeze({
    schema_version: EVIDENCE_PROJECTION_REBUILD_REPORT_SCHEMA_VERSION,
    promotable: false,
    source_schema_version: sourceSchemaVersion,
    working_schema_version: workingSchemaVersion,
    eligible_owner_count: eligibleOwnerCount,
    rebuilt_owner_count: 0,
    rejected_owner_count: rejectedOwnerCount,
    zero_child_owner_count: 0,
    nonzero_child_owner_count: 0,
    child_count: 0,
    projection_kind_counts: Object.freeze([]),
    projection_content_sha256: digestRows([]),
    fact_frame_formation: emptyFactFrameFormationSummary()
  });
}

function canonicalProjectionRows(
  planned: readonly PlannedOwner[]
): readonly CanonicalProjectionRow[] {
  return Object.freeze(planned.flatMap(({ owner, projections }) =>
    projections.map((projection) => Object.freeze({
      evidence_object_id: owner.object_id,
      projection_id: projection.projection_id,
      projection_kind: projection.projection_kind,
      workspace_id: owner.workspace_id,
      source_hash: owner.source_hash,
      content: projection.content
    }))
  ));
}

function countProjectionKinds(
  rows: readonly CanonicalProjectionRow[]
): readonly EvidenceSearchProjectionKindCount[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.projection_kind, (counts.get(row.projection_kind) ?? 0) + 1);
  }
  return Object.freeze([...counts].sort(([left], [right]) =>
    left.localeCompare(right)
  ).map(([projectionKind, childCount]) => Object.freeze({
    projection_kind: projectionKind,
    child_count: childCount
  })));
}

function digestRows(rows: readonly CanonicalProjectionRow[]): string {
  return createHash("sha256").update(JSON.stringify(rows), "utf8").digest("hex");
}

function digestText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function compareProjections(
  left: Readonly<EvidenceSearchProjection>,
  right: Readonly<EvidenceSearchProjection>
): number {
  return left.projection_kind.localeCompare(right.projection_kind) ||
    left.projection_id - right.projection_id ||
    left.content.localeCompare(right.content);
}

function projectionIdentity(
  projection: Readonly<EvidenceSearchProjection>
): string {
  return `${projection.projection_kind}:${projection.projection_id}`;
}

function reject(
  owner: EvidenceProjectionOwnerRow,
  reason: string
): RejectedOwner {
  return Object.freeze({ objectId: owner.object_id, reason });
}

function renderRejectionMessage(rejected: readonly RejectedOwner[]): string {
  return "evidence search projection rebuild rejected candidate owners: " +
    rejected.map((owner) => `${owner.objectId} (${owner.reason})`).join(", ");
}

function assertEligibleWorkingSchema(workingDbPath: string): number {
  const sourceSchemaVersion = readSchemaMigrationLedger(workingDbPath).at(-1);
  if (sourceSchemaVersion === undefined ||
      sourceSchemaVersion < TEMPORAL_OFFLINE_MIGRATION_VERSION) {
    throw new Error(
      `derived evidence projection rebuild requires working schema ${TEMPORAL_OFFLINE_MIGRATION_VERSION} or newer`
    );
  }
  return sourceSchemaVersion;
}

function assertCurrentProjectionSchema(db: StorageDatabase): number {
  const schema = getCurrentSchemaSummary(db);
  if (!schema.schemaOk ||
      schema.persistedMaxVersion === null ||
      schema.persistedMaxVersion < FIRST_EVIDENCE_PROJECTION_SCHEMA_VERSION) {
    throw new Error(
      "derived evidence projection rebuild did not migrate to the current projection schema"
    );
  }
  return schema.persistedMaxVersion;
}
