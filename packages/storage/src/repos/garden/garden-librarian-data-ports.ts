import type {
  GardenLibrarianNeighborDetectionPort,
  GardenLibrarianSynthesisThrottlePort
} from "./garden-data-ports.js";
import {
  ACTIVE_STATE,
  buildDerivedKey,
  createPendingCandidateProposal,
  type GardenDataPortFactoryContext
} from "./garden-data-port-shared.js";
import { prepareSynthesisStatements } from "./statements/garden-librarian-statements.js";
import { requirePrivacyWorkspaceAvailable } from "../field/privacy-availability.js";

const NEIGHBOR_GROUP_LIMIT = 120;
const NEIGHBOR_ROW_LIMIT = 1000;

interface SynthesisRow {
  readonly subject: string;
  readonly evidence_id: string;
}

export function createNeighborPort(context: GardenDataPortFactoryContext): GardenLibrarianNeighborDetectionPort {
  const neighborRowsStatement = context.database.connection.prepare(`
    WITH keyed AS (
      SELECT
        object_id,
        COALESCE(
          NULLIF(CASE WHEN json_valid(content) THEN json_extract(content, '$.subject') END, ''),
          lower(trim(substr(content, 1, 80)))
        ) AS subject_key
      FROM memory_entries
      WHERE workspace_id = ?
        AND lifecycle_state = '${ACTIVE_STATE}'
    ),
    candidate_subjects AS (
      SELECT subject_key
      FROM keyed
      WHERE subject_key IS NOT NULL
        AND subject_key <> ''
      GROUP BY subject_key
      HAVING COUNT(*) >= 2
      ORDER BY COUNT(*) DESC, subject_key ASC
      LIMIT ${NEIGHBOR_GROUP_LIMIT}
    )
    SELECT k.subject_key, k.object_id
    FROM keyed k
    JOIN candidate_subjects s ON s.subject_key = k.subject_key
    ORDER BY k.subject_key ASC, k.object_id ASC
    LIMIT ${NEIGHBOR_ROW_LIMIT}
  `);

  return {
    findSubjectNeighbors: async (workspaceId) => {
      requirePrivacyWorkspaceAvailable(context.database, workspaceId, ["memory_entry"]);
      const rows = neighborRowsStatement.all(workspaceId) as readonly {
        readonly subject_key: string;
        readonly object_id: string;
      }[];
      const grouped = groupRows(rows, (row) => row.subject_key, (row) => row.object_id);
      return grouped.map((group) => ({
        subject: group.key,
        object_ids: group.objectIds,
        overlap_basis: "subject_key_overlap"
      }));
    }
  };
}

export function createSynthesisPort(context: GardenDataPortFactoryContext): GardenLibrarianSynthesisThrottlePort {
  const statements = prepareSynthesisStatements(context.database);

  return {
    findSynthesisCandidateClusters: async (workspaceId) => {
      const rows = statements.synthesisStatement.all(workspaceId, workspaceId) as readonly SynthesisRow[];
      const grouped = groupRows(rows, (row) => row.subject, (row) => row.evidence_id);
      return grouped.map((group) => ({
        subject: group.key,
        evidence_ids: group.objectIds
      }));
    },
    hasPendingSynthesisForSubject: async (workspaceId, subject) => {
      const row = statements.hasPendingStatement.get(
        workspaceId,
        buildDerivedKey("synthesis-subject", subject)
      );
      return row !== undefined;
    },
    createSynthesisReviewCandidate: async (workspaceId, subject, evidenceIds) => {
      return await createPendingCandidateProposal(context, {
        workspaceId,
        derivedFrom: buildDerivedKey("synthesis-subject", subject),
        dossierRef: "librarian.synthesis",
        causedBy: "librarian",
        droppedCandidates: evidenceIds
      });
    }
  };
}

function groupRows<Row>(
  rows: readonly Row[],
  keySelector: (row: Row) => string,
  valueSelector: (row: Row) => string
): readonly { readonly key: string; readonly objectIds: readonly string[] }[] {
  const grouped = new Map<string, string[]>();

  for (const row of rows) {
    const key = keySelector(row);
    const value = valueSelector(row);
    const entries = grouped.get(key);
    if (entries === undefined) {
      grouped.set(key, [value]);
      continue;
    }
    if (!entries.includes(value)) {
      entries.push(value);
    }
  }

  return Array.from(grouped, ([key, objectIds]) => ({ key, objectIds }));
}
