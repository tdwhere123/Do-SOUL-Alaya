import { authorizeSourceIndexScope, fieldContractSha256, RecallService } from "@do-soul/alaya-core";
import {
  compareUtcInstants, isRelationValidityActiveAt, sourceIndexTarget, sourceRecallTarget,
  SourceSemanticResourceExhausted, SourceSemanticResourceLedger, type SourceIndexTarget
} from "@do-soul/alaya-protocol";
import { SqliteFieldSourceRecordRepo, SqliteRelationRecallReader, type StorageDatabase } from "@do-soul/alaya-storage";

const ANCHOR_CAP = 16;
const NEIGHBOR_CAP = 6;
const RELATION_PAGE = 16;
const NO_TIMELESS_POLICIES = new Set<string>();

export type StructuralMemberScope = Readonly<{
  workspaceId: string;
  asOf: string;
  authorizedScopes?: readonly string[] | null;
  sourceId?: string;
}>;

type NeighborInput = StructuralMemberScope & Readonly<{
  anchors: readonly string[];
  exclude: ReadonlySet<string>;
}>;

/** The optional member listing reads one bounded relation page per admitted anchor and predicate. */
export function collectSoftStructuralNeighbors(database: StorageDatabase, input: NeighborInput): readonly SourceIndexTarget[] {
  if (input.authorizedScopes === undefined || input.authorizedScopes?.length === 0 || input.anchors.length === 0) return [];
  const sessionGrades = Object.entries(RecallService.sessionStructuralGrades ?? {});
  if (sessionGrades.length === 0) return [];
  const relations = new SqliteRelationRecallReader(database);
  const records = new SqliteFieldSourceRecordRepo(database, fieldContractSha256);
  const ledger = new SourceSemanticResourceLedger({ work_units: 2048, memory_bytes: 2 * 1024 * 1024 });
  const best = new Map<string, number>();
  const neighbors: SourceIndexTarget[] = [];
  try {
    for (const anchor of [...new Set(input.anchors)].slice(0, ANCHOR_CAP)) {
      ledger.charge(1, 0, "member structural anchor currentness");
      if (records.readTargetAvailability(input.workspaceId, anchor) !== "ok") continue;
      for (const [kind, grade] of sessionGrades) {
        const page = relations.read(input.workspaceId, anchor, kind, RELATION_PAGE, RELATION_PAGE, null, input.asOf);
        ledger.charge(1 + page.nativeVisits, page.nativeBytes, "member structural adjacency");
        for (const row of page.observations) {
          if (input.exclude.has(row.targetObjectId) || row.resolvedAt !== null || row.resolutionKind !== null ||
              !isRelationValidityActiveAt(row.validity, input.asOf, NO_TIMELESS_POLICIES)) continue;
          best.set(row.targetObjectId, Math.max(best.get(row.targetObjectId) ?? 0, grade));
        }
      }
    }
    for (const [root] of [...best].sort(([a, left], [b, right]) => right - left || (a < b ? -1 : 1))) {
      const source = readNeighbor(records, input, root, ledger);
      if (source !== null) neighbors.push(source);
      if (neighbors.length === NEIGHBOR_CAP) break;
    }
  } catch (error) {
    if (!(error instanceof SourceSemanticResourceExhausted)) throw error;
  }
  return neighbors;
}

function readNeighbor(records: SqliteFieldSourceRecordRepo, input: NeighborInput, root: string,
  ledger: SourceSemanticResourceLedger): SourceIndexTarget | null {
  ledger.charge(1, 0, "member structural target currentness");
  if (records.readTargetAvailability(input.workspaceId, root) !== "ok") return null;
  const read = records.findByIdBounded(input.workspaceId, root, 1, 0, {
    workLimit: ledger.work, nativeByteLimit: ledger.bytes
  });
  if (read === null) return null;
  ledger.charge(1 + read.dependencyWork, read.nativeBytes + read.metadataBytes, "member structural target identity");
  const row = read.record;
  if (read.resourceLimited || row === null || row.source_body === null
    || (input.sourceId !== undefined && row.source_id !== input.sourceId)
    || (row.valid_from !== null && (compareUtcInstants(row.valid_from, input.asOf) ?? 1) > 0)
    || (row.valid_to !== null && (compareUtcInstants(input.asOf, row.valid_to) ?? 0) >= 0)) return null;
  const source = sourceIndexTarget(sourceRecallTarget({
    workspace_id: input.workspaceId, root_kind: "source_record", root_id: row.record_id,
    source_version: row.source_version, content_digest: row.content_digest, evidence_object_id: row.evidence_object_id
  }), row.source_id, read.bodyBytes);
  try { authorizeSourceIndexScope(row.scope_class, source, input.authorizedScopes ?? null); }
  catch { return null; }
  return source;
}
