import type { EvidenceCapsule } from "@do-soul/alaya-protocol";
import { parseRows } from "../../shared/parse-row.js";
import { EvidenceProjectionIntegrityError } from
  "./qualification/qualified-evidence-projection.js";
import {
  EvidenceCapsuleRowParser,
  EvidenceSourceAnchorRowParser,
  FactKeyProjectionIdentityRowParser,
  sortSourceAnchors,
  uniqueNonEmptyEvidenceIds,
  wrapEvidenceCapsuleQueryError,
  type EvidenceSourceAnchorRow
} from "../mappers/evidence-capsule-mappers.js";
import type { EvidenceCapsuleStatements } from "../statements/evidence-capsule-statements.js";
import type {
  EvidenceSearchMatch,
  RecallQualifiedEvidence
} from "../evidence-recall-types.js";
import type { EvidenceSourceAnchor } from "../evidence-capsule-repo-port.js";
import type { RecallQualifiedEvidenceReader } from "./recall-qualified-evidence-reader.js";

export function loadEvidenceCapsulesByIds(
  statements: EvidenceCapsuleStatements,
  workspaceId: string,
  objectIds: readonly string[]
): readonly Readonly<EvidenceCapsule>[] {
  const uniqueIds = [...new Set(objectIds.map((objectId) => objectId.trim()).filter((objectId) => objectId.length > 0))];
  if (uniqueIds.length === 0) {
    return [];
  }
  try {
    const capsules: Readonly<EvidenceCapsule>[] = [];
    for (let offset = 0; offset < uniqueIds.length; offset += 500) {
      const chunk = uniqueIds.slice(offset, offset + 500);
      capsules.push(...parseRows(
        statements.findByIdsStatement.all(workspaceId, JSON.stringify(chunk)),
        EvidenceCapsuleRowParser,
        "evidence capsule row"
      ));
    }
    capsules.sort((left, right) =>
      left.created_at.localeCompare(right.created_at) || left.object_id.localeCompare(right.object_id)
    );
    return capsules;
  } catch (error) {
    throw wrapEvidenceCapsuleQueryError("Failed to load evidence capsules by ids.", error);
  }
}

export function loadRecallQualifiedFactKeysByIds(
  statements: EvidenceCapsuleStatements,
  reader: RecallQualifiedEvidenceReader,
  workspaceId: string,
  evidenceObjectIds: readonly string[]
): readonly RecallQualifiedEvidence[] {
  const ids = uniqueNonEmptyEvidenceIds(evidenceObjectIds);
  if (ids.length === 0) return [];
  try {
    const matches: EvidenceSearchMatch[] = [];
    for (let offset = 0; offset < ids.length; offset += 500) {
      const rows = parseRows(
        statements.findFactKeyProjectionIdentitiesByIdsStatement.all(
          workspaceId,
          JSON.stringify(ids.slice(offset, offset + 500))
        ),
        FactKeyProjectionIdentityRowParser,
        "fact key projection identity row"
      );
      matches.push(...rows.map((row) => Object.freeze({
        object_id: row.object_id,
        matched_projection: Object.freeze({
          projection_id: row.projection_id,
          projection_kind: row.projection_kind
        })
      })));
    }
    return reader.find(workspaceId, matches);
  } catch (error) {
    if (error instanceof EvidenceProjectionIntegrityError) throw error;
    throw wrapEvidenceCapsuleQueryError("Failed to load recall-qualified fact-key projections.", error);
  }
}

export function loadEvidenceSourceAnchorsByIds(
  statements: EvidenceCapsuleStatements,
  workspaceId: string,
  evidenceObjectIds: readonly string[]
): readonly EvidenceSourceAnchor[] {
  const ids = uniqueNonEmptyEvidenceIds(evidenceObjectIds);
  if (ids.length === 0) return [];
  try {
    const rows: EvidenceSourceAnchorRow[] = [];
    for (let offset = 0; offset < ids.length; offset += 500) {
      const chunk = ids.slice(offset, offset + 500);
      rows.push(...parseRows(
        statements.findSourceAnchorsByIdsStatement.all(workspaceId, JSON.stringify(chunk)),
        EvidenceSourceAnchorRowParser,
        "evidence source anchor row"
      ));
    }
    return sortSourceAnchors(rows.filter(
      (row): row is EvidenceSourceAnchor => row.artifact_ref !== null
    ));
  } catch (error) {
    throw wrapEvidenceCapsuleQueryError("Failed to load evidence source anchors by ids.", error);
  }
}
