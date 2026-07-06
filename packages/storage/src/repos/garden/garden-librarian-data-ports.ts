import type {
  GardenLibrarianMergeDetectionPort,
  GardenLibrarianNeighborDetectionPort,
  GardenLibrarianPathCompressionPort,
  GardenLibrarianSynthesisThrottlePort
} from "./garden-data-ports.js";
import {
  ACTIVE_STATE,
  buildDerivedKey,
  createPendingCandidateProposal,
  type GardenDataPortFactoryContext
} from "./garden-data-port-shared.js";
import {
  prepareCompressionStatements,
  prepareMergeStatements,
  prepareSynthesisStatements,
  type MergeStatements
} from "./garden-librarian-statements.js";

const NEIGHBOR_GROUP_LIMIT = 120;
const NEIGHBOR_ROW_LIMIT = 1000;

interface SubjectRow {
  readonly subject_key: string;
  readonly object_id: string;
  readonly object_kind: string;
}

interface ChainRow {
  readonly chain_start: string;
  readonly chain_end: string;
  readonly intermediate_id: string;
}

interface SynthesisRow {
  readonly subject: string;
  readonly evidence_id: string;
}

export function createMergePort(context: GardenDataPortFactoryContext): GardenLibrarianMergeDetectionPort {
  const statements = prepareMergeStatements(context.database);

  return {
    findMergeCandidates: async (workspaceId) => findMergeCandidates(statements, workspaceId),
    hasPendingMergeProposal: async (primaryId) => {
      const row = statements.hasPendingStatement.get(buildDerivedKey("merge-primary", primaryId));
      return row !== undefined;
    },
    createMergeProposal: async (workspaceId, candidate) => {
      const proposalId = createPendingCandidateProposal(context, {
        workspaceId,
        derivedFrom: buildDerivedKey("merge-primary", candidate.primary_id),
        dossierRef: "librarian.merge",
        droppedCandidates: candidate.duplicate_ids
      });
      return { proposal_id: proposalId };
    },
    findTemplateClusters: async (workspaceId, minClusterSize) =>
      findTemplateClusters(statements, workspaceId, minClusterSize),
    hasPendingTemplateProposal: async (representativeId) => {
      const row = statements.hasPendingStatement.get(
        buildDerivedKey("template-representative", representativeId)
      );
      return row !== undefined;
    },
    createTemplateCandidate: async (workspaceId, cluster) => {
      const candidateId = createPendingCandidateProposal(context, {
        workspaceId,
        derivedFrom: buildDerivedKey("template-representative", cluster.representative_id),
        dossierRef: "librarian.template",
        droppedCandidates: cluster.member_ids.slice(1)
      });
      return { candidate_id: candidateId };
    }
  };
}

function findMergeCandidates(
  statements: MergeStatements,
  workspaceId: string
): readonly {
  readonly primary_id: string;
  readonly duplicate_ids: readonly string[];
  readonly object_kind: string;
  readonly similarity_score: number;
}[] {
  const rows = statements.mergeRowsStatement.all(workspaceId) as readonly SubjectRow[];
  return groupBySubject(rows).flatMap((group) => {
    const primary = group.objectIds[0];
    if (primary === undefined) {
      return [];
    }
    const duplicates = group.objectIds.slice(1);
    return [{
      primary_id: primary,
      duplicate_ids: duplicates,
      object_kind: group.objectKind,
      similarity_score: Math.min(0.99, 0.8 + duplicates.length * 0.05)
    }];
  });
}

function findTemplateClusters(
  statements: MergeStatements,
  workspaceId: string,
  minClusterSize: number
): readonly {
  readonly representative_id: string;
  readonly member_ids: readonly string[];
  readonly pattern_description: string;
}[] {
  const rows = statements.templateRowsStatement.all(workspaceId, Math.max(2, minClusterSize)) as readonly {
    readonly pattern_description: string;
    readonly object_id: string;
  }[];
  return groupRows(rows, (row) => row.pattern_description, (row) => row.object_id).flatMap((group) => {
    const representativeId = group.objectIds[0];
    return representativeId === undefined
      ? []
      : [{
          representative_id: representativeId,
          member_ids: group.objectIds,
          pattern_description: group.key
        }];
  });
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

export function createCompressionPort(context: GardenDataPortFactoryContext): GardenLibrarianPathCompressionPort {
  const statements = prepareCompressionStatements(context.database);

  return {
    findCompressiblePaths: async (workspaceId) => {
      const rows = statements.chainStatement.all(workspaceId) as readonly ChainRow[];
      const grouped = groupChains(rows);
      return grouped.map((entry) => ({
        chain_start: entry.chainStart,
        chain_end: entry.chainEnd,
        intermediate_ids: entry.intermediateIds
      }));
    },
    createCompressionCandidate: async (workspaceId, candidate) => {
      const candidateId = createPendingCandidateProposal(context, {
        workspaceId,
        derivedFrom: buildDerivedKey("compression", `${candidate.chain_start}->${candidate.chain_end}`),
        dossierRef: "librarian.compression",
        droppedCandidates: candidate.intermediate_ids
      });
      return { candidate_id: candidateId };
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
      const candidateId = createPendingCandidateProposal(context, {
        workspaceId,
        derivedFrom: buildDerivedKey("synthesis-subject", subject),
        dossierRef: "librarian.synthesis",
        droppedCandidates: evidenceIds
      });
      return { candidate_id: candidateId };
    }
  };
}

function groupBySubject(rows: readonly SubjectRow[]): readonly {
  readonly subject: string;
  readonly objectIds: readonly string[];
  readonly objectKind: string;
}[] {
  const grouped = new Map<string, { objectIds: string[]; objectKind: string }>();

  for (const row of rows) {
    const existing = grouped.get(row.subject_key);
    if (existing === undefined) {
      grouped.set(row.subject_key, { objectIds: [row.object_id], objectKind: row.object_kind });
      continue;
    }
    existing.objectIds.push(row.object_id);
  }

  return Array.from(grouped, ([subject, value]) => ({
    subject,
    objectIds: value.objectIds,
    objectKind: value.objectKind
  }));
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

function groupChains(rows: readonly ChainRow[]): readonly {
  readonly chainStart: string;
  readonly chainEnd: string;
  readonly intermediateIds: readonly string[];
}[] {
  const grouped = new Map<string, string[]>();

  for (const row of rows) {
    const chainKey = `${row.chain_start}|${row.chain_end}`;
    const candidates = grouped.get(chainKey);
    if (candidates === undefined) {
      grouped.set(chainKey, [row.intermediate_id]);
      continue;
    }
    if (!candidates.includes(row.intermediate_id)) {
      candidates.push(row.intermediate_id);
    }
  }

  return Array.from(grouped, ([chainKey, intermediateIds]) => {
    const [chainStart, chainEnd] = chainKey.split("|");
    if (chainStart === undefined || chainEnd === undefined) {
      throw new Error("Garden librarian chain invariant violated: malformed chain key.");
    }
    return {
      chainStart,
      chainEnd,
      intermediateIds
    };
  });
}
