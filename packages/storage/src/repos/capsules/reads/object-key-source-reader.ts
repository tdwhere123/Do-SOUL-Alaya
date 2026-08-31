import {
  OpenSemanticFactorGraphSchema,
  type OpenSemanticFactorGraph
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../../sqlite/db.js";
import { parseNullableJsonColumn } from "../../shared/parse-json-column.js";

export interface StoredObjectKeyEvidenceSource {
  readonly object_id: string;
  readonly gist: string;
  readonly fact_key_contents: readonly string[];
  readonly osf_graph: Readonly<OpenSemanticFactorGraph> | null;
}

export function readObjectKeyEvidenceSources(
  db: StorageDatabase,
  workspaceId: string,
  evidenceIds: readonly string[]
): readonly StoredObjectKeyEvidenceSource[] {
  const ids = uniqueIds(evidenceIds);
  if (ids.length === 0) return Object.freeze([]);
  const placeholders = ids.map(() => "?").join(", ");
  const gists = readGists(db, workspaceId, placeholders, ids);
  const factKeys = readFactKeys(db, placeholders, ids);
  const graphs = readOsfGraphs(db, placeholders, ids);
  return Object.freeze(ids.flatMap((objectId) => {
    const gist = gists.get(objectId);
    return gist === undefined
      ? []
      : [{
        object_id: objectId,
        gist,
        fact_key_contents: factKeys.get(objectId) ?? [],
        osf_graph: graphs.get(objectId) ?? null
      }];
  }));
}

function readGists(
  db: StorageDatabase,
  workspaceId: string,
  placeholders: string,
  ids: readonly string[]
): ReadonlyMap<string, string> {
  const rows = db.connection.prepare(`
    SELECT object_id, gist FROM evidence_capsules
    WHERE workspace_id = ? AND object_id IN (${placeholders})
  `).all(workspaceId, ...ids) as ReadonlyArray<{ readonly object_id: string; readonly gist: string }>;
  return new Map(rows.map((row) => [row.object_id, row.gist]));
}

function readFactKeys(
  db: StorageDatabase,
  placeholders: string,
  ids: readonly string[]
): ReadonlyMap<string, readonly string[]> {
  const rows = db.connection.prepare(`
    SELECT evidence_object_id, content FROM evidence_search_projections
    WHERE projection_kind = 'fact_key' AND evidence_object_id IN (${placeholders})
    ORDER BY evidence_object_id ASC, projection_id ASC
  `).all(...ids) as ReadonlyArray<{ readonly evidence_object_id: string; readonly content: string }>;
  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    const current = grouped.get(row.evidence_object_id) ?? [];
    current.push(row.content);
    grouped.set(row.evidence_object_id, current);
  }
  return grouped;
}

function readOsfGraphs(
  db: StorageDatabase,
  placeholders: string,
  ids: readonly string[]
): ReadonlyMap<string, OpenSemanticFactorGraph> {
  const rows = db.connection.prepare(`
    SELECT evidence_object_id, graph_json FROM evidence_semantic_factor_formations
    WHERE status = 'formed' AND evidence_object_id IN (${placeholders})
  `).all(...ids) as ReadonlyArray<{
    readonly evidence_object_id: string;
    readonly graph_json: string | null;
  }>;
  const graphs = new Map<string, OpenSemanticFactorGraph>();
  for (const row of rows) {
    const parsed = OpenSemanticFactorGraphSchema.safeParse(parseGraphJson(row.graph_json));
    if (parsed.success) graphs.set(row.evidence_object_id, parsed.data);
  }
  return graphs;
}

function uniqueIds(ids: readonly string[]): readonly string[] {
  return [...new Set(ids.filter((id) => id.trim().length > 0))];
}

function parseGraphJson(value: string | null): unknown {
  return parseNullableJsonColumn(value, "graph_json");
}
