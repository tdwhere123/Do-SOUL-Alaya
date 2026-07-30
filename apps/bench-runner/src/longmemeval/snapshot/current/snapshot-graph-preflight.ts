import { DatabaseSync } from "node:sqlite";
import {
  PathRelationSchema,
  type PathRelation
} from "@do-soul/alaya-protocol";
import {
  SNAPSHOT_GRAPH_REJECTION_REASONS,
  type SnapshotGraphPreflight,
  type SnapshotGraphRejectionReason
} from "./snapshot-graph-preflight-contract.js";

export type { SnapshotGraphPreflight } from
  "./snapshot-graph-preflight-contract.js";

type ClassifiedReason = SnapshotGraphRejectionReason | "eligible";

interface PathRelationRow {
  readonly path_id: string;
  readonly workspace_id: string;
  readonly anchors_json: string;
  readonly constitution_json: string;
  readonly effect_vector_json: string;
  readonly plasticity_state_json: string;
  readonly lifecycle_json: string;
  readonly legitimacy_json: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface ClassifiedPath {
  readonly workspaceId: string;
  readonly reason: ClassifiedReason;
  readonly relationKind?: string;
  readonly lifecycleStatus?: string;
}

export function inspectSnapshotGraphPreflight(
  dbPath: string
): Readonly<SnapshotGraphPreflight> {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const endpoints = readHqEndpoints(db);
    const classified = readPathRows(db).map((row) =>
      classifyPath(row, endpoints));
    return summarizeClassifiedPaths(classified);
  } finally {
    db.close();
  }
}

function readPathRows(db: DatabaseSync): readonly PathRelationRow[] {
  return db.prepare(`
    SELECT path_id, workspace_id, anchors_json, constitution_json,
      effect_vector_json, plasticity_state_json, lifecycle_json,
      legitimacy_json, created_at, updated_at
    FROM path_relations
    ORDER BY path_id
  `).all() as unknown as readonly PathRelationRow[];
}

function readHqEndpoints(db: DatabaseSync): ReadonlySet<string> {
  const rows = db.prepare(`
    SELECT workspace_id, object_id
    FROM memory_hq
  `).all() as unknown as readonly {
    readonly workspace_id: string;
    readonly object_id: string;
  }[];
  return new Set(rows.map((row) =>
    endpointKey(row.workspace_id, row.object_id)));
}

function classifyPath(
  row: PathRelationRow,
  endpoints: ReadonlySet<string>
): ClassifiedPath {
  const decoded = decodePath(row);
  if (decoded.reason !== undefined) {
    return { workspaceId: row.workspace_id, reason: decoded.reason };
  }
  const path = decoded.path;
  const reason = classifyValidPath(path, endpoints);
  return {
    workspaceId: row.workspace_id,
    reason,
    relationKind: path.constitution.relation_kind,
    lifecycleStatus: path.lifecycle.status ?? "active"
  };
}

function decodePath(
  row: PathRelationRow
): { readonly path: PathRelation; readonly reason?: never } |
   { readonly path?: never; readonly reason: "invalid_json" | "invalid_shape" } {
  let parsedFields: Record<string, unknown>;
  try {
    parsedFields = {
      anchors: JSON.parse(row.anchors_json),
      constitution: JSON.parse(row.constitution_json),
      effect_vector: JSON.parse(row.effect_vector_json),
      plasticity_state: JSON.parse(row.plasticity_state_json),
      lifecycle: JSON.parse(row.lifecycle_json),
      legitimacy: JSON.parse(row.legitimacy_json)
    };
  } catch {
    return { reason: "invalid_json" };
  }
  const parsed = PathRelationSchema.safeParse({
    path_id: row.path_id,
    workspace_id: row.workspace_id,
    ...parsedFields,
    created_at: row.created_at,
    updated_at: row.updated_at
  });
  return parsed.success
    ? { path: parsed.data }
    : { reason: "invalid_shape" };
}

function classifyValidPath(
  path: PathRelation,
  endpoints: ReadonlySet<string>
): ClassifiedReason {
  if (path.constitution.relation_kind !== "answers_with") {
    return "other_relation_kind";
  }
  if ((path.lifecycle.status ?? "active") !== "active") {
    return "inactive";
  }
  if (path.effect_vector.recall_bias <= 0) {
    return "non_positive";
  }
  if (path.legitimacy.governance_class !== "recall_allowed") {
    return "wrong_governance";
  }
  if (!hasConcreteEndpoints(path, endpoints)) {
    return "missing_endpoint";
  }
  return isSupportedDirection(path.plasticity_state.direction_bias)
    ? "eligible"
    : "unsupported_direction";
}

function hasConcreteEndpoints(
  path: PathRelation,
  endpoints: ReadonlySet<string>
): boolean {
  const source = path.anchors.source_anchor;
  const target = path.anchors.target_anchor;
  return source.kind === "object" &&
    target.kind === "object" &&
    endpoints.has(endpointKey(path.workspace_id, source.object_id)) &&
    endpoints.has(endpointKey(path.workspace_id, target.object_id));
}

function isSupportedDirection(direction: string): boolean {
  return direction === "source_to_target" ||
    direction === "target_to_source" ||
    direction === "bidirectional_asymmetric";
}

function endpointKey(workspaceId: string, objectId: string): string {
  return JSON.stringify([workspaceId, objectId]);
}

function summarizeClassifiedPaths(
  paths: readonly ClassifiedPath[]
): Readonly<SnapshotGraphPreflight> {
  const eligible = paths.filter((path) => path.reason === "eligible");
  const eligibleWorkspaceIds = [...new Set(
    eligible.map((path) => path.workspaceId)
  )].sort();
  return Object.freeze({
    eligibilityBasis: "formation_recall_allowed",
    totalCount: paths.length,
    eligibleCount: eligible.length,
    eligibleWorkspaceCount: eligibleWorkspaceIds.length,
    eligibleWorkspaceIds: Object.freeze(eligibleWorkspaceIds),
    relationKindCounts: countValues(paths, "relationKind"),
    lifecycleStatusCounts: countValues(paths, "lifecycleStatus"),
    rejectedByReason: countRejections(paths)
  });
}

function countValues(
  paths: readonly ClassifiedPath[],
  key: "relationKind" | "lifecycleStatus"
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const path of paths) {
    const value = path[key] ?? "__invalid_or_unparseable__";
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return Object.freeze(counts);
}

function countRejections(
  paths: readonly ClassifiedPath[]
): Readonly<Record<SnapshotGraphRejectionReason, number>> {
  const counts = Object.fromEntries(
    SNAPSHOT_GRAPH_REJECTION_REASONS.map((reason) => [reason, 0])
  ) as Record<SnapshotGraphRejectionReason, number>;
  for (const path of paths) {
    if (path.reason !== "eligible") {
      counts[path.reason] += 1;
    }
  }
  return Object.freeze(counts);
}
