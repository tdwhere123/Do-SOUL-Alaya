import type { OpenSemanticFactorGraph } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../../sqlite/db.js";
import { prepareQualifiedEvidenceStatements } from "../statements/qualification/qualified-evidence-statements.js";
import { readStoredFactFrameFormation } from "./qualification/fact-frame-formation-read.js";
import { readStoredSemanticFactorFormation } from "./qualification/semantic-factor-formation-read.js";
import { parseRows } from "../../shared/parse-row.js";
import type { EvidenceQualificationRow } from "./qualification/recall-qualified-evidence-types.js";
import { readCurrentStoredFactKeyContents, readQualifiedProjectionIndex,
  type StoredProjectionRow } from "./qualification/qualified-evidence-projection.js";

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
  const ids = [...new Set(evidenceIds.filter((id) => id.trim().length > 0))];
  if (ids.length === 0) return Object.freeze([]);
  const statements = prepareQualifiedEvidenceStatements(db);
  const rows = parseRows(
    statements.findEvidenceRows.all(workspaceId, JSON.stringify(ids)),
    { parse: (value: unknown) => value as EvidenceQualificationRow },
    "evidence qualification row"
  );
  const projections = parseRows(
    statements.findProjectionRows.all(workspaceId, JSON.stringify(ids)),
    { parse: (value: unknown) => value as StoredProjectionRow },
    "stored projection row"
  );
  const byId = new Map(rows.map((row) => [row.object_id, row]));
  return Object.freeze(ids.flatMap((id) => {
    const row = byId.get(id);
    if (row === undefined) return [];
    return [{ object_id: id, gist: row.gist, ...readCurrentDerivedSources(row,
      projections.filter((projection) => projection.evidence_object_id === id)) }];
  }));
}

function readCurrentDerivedSources(row: EvidenceQualificationRow, projections: readonly StoredProjectionRow[]):
Pick<StoredObjectKeyEvidenceSource, "fact_key_contents" | "osf_graph"> {
  // Unqualified history supplies no derived authority. Malformed storage remains
  // an observable integrity error from the shared owners, never cached absence.
  const factKeys = readCurrentStoredFactKeyContents(row, readQualifiedProjectionIndex(projections));
  const frame = readStoredFactFrameFormation(row, row.workspace_id, row.source_hash ?? "", row.excerpt);
  const graph = frame?.status === "formed"
    ? readStoredSemanticFactorFormation(row, row.workspace_id, row.excerpt, frame)?.graph ?? null : null;
  return { fact_key_contents: factKeys, osf_graph: graph };
}
