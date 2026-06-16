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

const MERGE_GROUP_LIMIT = 60;
const MERGE_ROW_LIMIT = 600;
const TEMPLATE_GROUP_LIMIT = 60;
const TEMPLATE_ROW_LIMIT = 600;
const NEIGHBOR_GROUP_LIMIT = 120;
const NEIGHBOR_ROW_LIMIT = 1000;
const COMPRESSION_CHAIN_LIMIT = 300;
const SYNTHESIS_CLUSTER_LIMIT = 80;
const SYNTHESIS_CLUSTER_ROW_LIMIT = 800;

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
  const mergeRowsStatement = context.database.connection.prepare(`
    WITH keyed AS (
      SELECT
        object_id,
        object_kind,
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
      LIMIT ${MERGE_GROUP_LIMIT}
    )
    SELECT k.subject_key, k.object_id, k.object_kind
    FROM keyed k
    JOIN candidate_subjects s ON s.subject_key = k.subject_key
    ORDER BY k.subject_key ASC, k.object_id ASC
    LIMIT ${MERGE_ROW_LIMIT}
  `);

  const templateRowsStatement = context.database.connection.prepare(`
    WITH templated AS (
      SELECT
        object_id,
        dimension || ':' || COALESCE(
          NULLIF(CASE WHEN json_valid(content) THEN json_extract(content, '$.subject') END, ''),
          lower(trim(substr(content, 1, 60)))
        ) AS pattern_description
      FROM memory_entries
      WHERE workspace_id = ?
        AND lifecycle_state = '${ACTIVE_STATE}'
    ),
    candidate_clusters AS (
      SELECT pattern_description
      FROM templated
      WHERE pattern_description IS NOT NULL
        AND pattern_description <> ''
      GROUP BY pattern_description
      HAVING COUNT(*) >= ?
      ORDER BY COUNT(*) DESC, pattern_description ASC
      LIMIT ${TEMPLATE_GROUP_LIMIT}
    )
    SELECT t.pattern_description, t.object_id
    FROM templated t
    JOIN candidate_clusters c ON c.pattern_description = t.pattern_description
    ORDER BY t.pattern_description ASC, t.object_id ASC
    LIMIT ${TEMPLATE_ROW_LIMIT}
  `);

  const hasPendingStatement = context.database.connection.prepare(`
    SELECT 1
    FROM proposals
    WHERE resolution_state = 'pending'
      AND derived_from = ?
    LIMIT 1
  `);

  return {
    findMergeCandidates: async (workspaceId) => {
      const rows = mergeRowsStatement.all(workspaceId) as readonly SubjectRow[];
      const grouped = groupBySubject(rows);
      return grouped.map((group) => {
        const primary = group.objectIds[0];
        const duplicates = group.objectIds.slice(1);
        return {
          primary_id: primary,
          duplicate_ids: duplicates,
          object_kind: group.objectKind,
          similarity_score: Math.min(0.99, 0.8 + duplicates.length * 0.05)
        };
      });
    },
    hasPendingMergeProposal: async (primaryId) => {
      const row = hasPendingStatement.get(buildDerivedKey("merge-primary", primaryId));
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
    findTemplateClusters: async (workspaceId, minClusterSize) => {
      const rows = templateRowsStatement.all(workspaceId, Math.max(2, minClusterSize)) as readonly {
        readonly pattern_description: string;
        readonly object_id: string;
      }[];
      const grouped = groupRows(rows, (row) => row.pattern_description, (row) => row.object_id);

      return grouped.map((group) => ({
        representative_id: group.objectIds[0],
        member_ids: group.objectIds,
        pattern_description: group.key
      }));
    },
    hasPendingTemplateProposal: async (representativeId) => {
      const row = hasPendingStatement.get(buildDerivedKey("template-representative", representativeId));
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
  // anchor object_id / relation_kind / recall_bias / lifecycle.status live in the
  // path_relations JSON columns; see packages/protocol/src/soul/path-relation.ts.
  // recall-eligible chain link = relation_kind 'recalls' AND active lifecycle AND
  // recall_bias > 0 (mirrors isPathRecallEligible in the protocol).
  const chainStatement = context.database.connection.prepare(`
    WITH recalls_links AS (
      SELECT
        json_extract(anchors_json, '$.source_anchor.object_id') AS source_object_id,
        json_extract(anchors_json, '$.target_anchor.object_id') AS target_object_id
      FROM path_relations
      WHERE workspace_id = ?
        AND json_valid(constitution_json) = 1
        AND json_valid(effect_vector_json) = 1
        AND json_valid(lifecycle_json) = 1
        AND json_extract(constitution_json, '$.relation_kind') = 'recalls'
        AND COALESCE(json_extract(lifecycle_json, '$.status'), 'active') = 'active'
        AND json_extract(effect_vector_json, '$.recall_bias') > 0
        AND json_extract(anchors_json, '$.source_anchor.object_id') IS NOT NULL
        AND json_extract(anchors_json, '$.target_anchor.object_id') IS NOT NULL
    )
    SELECT
      l1.source_object_id AS chain_start,
      l2.target_object_id AS chain_end,
      l1.target_object_id AS intermediate_id
    FROM recalls_links l1
    JOIN recalls_links l2
      ON l1.target_object_id = l2.source_object_id
    WHERE l1.source_object_id <> l2.target_object_id
    ORDER BY chain_start ASC, chain_end ASC, intermediate_id ASC
    LIMIT ${COMPRESSION_CHAIN_LIMIT}
  `);

  return {
    findCompressiblePaths: async (workspaceId) => {
      const rows = chainStatement.all(workspaceId) as readonly ChainRow[];
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
  const synthesisStatement = context.database.connection.prepare(`
    WITH keyed AS (
      SELECT
        object_id AS evidence_id,
        COALESCE(
          NULLIF(CASE WHEN json_valid(semantic_anchor) THEN json_extract(semantic_anchor, '$.subject') END, ''),
          NULLIF(CASE WHEN json_valid(semantic_anchor) THEN json_extract(semantic_anchor, '$.topic') END, ''),
          lower(trim(substr(gist, 1, 80)))
        ) AS subject
      FROM evidence_capsules
      WHERE workspace_id = ?
        AND lifecycle_state = '${ACTIVE_STATE}'
      UNION ALL
      SELECT
        object_id AS evidence_id,
        COALESCE(
          NULLIF(lower(trim(topic_key)), ''),
          NULLIF(lower(trim(summary)), ''),
          lower(trim(substr(object_id, 1, 80)))
        ) AS subject
      FROM synthesis_capsules
      WHERE workspace_id = ?
        AND lifecycle_state = '${ACTIVE_STATE}'
    ),
    candidate_subjects AS (
      SELECT subject
      FROM keyed
      WHERE subject IS NOT NULL
        AND subject <> ''
      GROUP BY subject
      HAVING COUNT(*) >= 2
      ORDER BY COUNT(*) DESC, subject ASC
      LIMIT ${SYNTHESIS_CLUSTER_LIMIT}
    )
    SELECT k.subject, k.evidence_id
    FROM keyed k
    JOIN candidate_subjects s ON s.subject = k.subject
    ORDER BY k.subject ASC, k.evidence_id ASC
    LIMIT ${SYNTHESIS_CLUSTER_ROW_LIMIT}
  `);

  const hasPendingStatement = context.database.connection.prepare(`
    SELECT 1
    FROM proposals
    WHERE workspace_id = ?
      AND resolution_state = 'pending'
      AND derived_from = ?
    LIMIT 1
  `);

  return {
    findSynthesisCandidateClusters: async (workspaceId) => {
      const rows = synthesisStatement.all(workspaceId, workspaceId) as readonly SynthesisRow[];
      const grouped = groupRows(rows, (row) => row.subject, (row) => row.evidence_id);
      return grouped.map((group) => ({
        subject: group.key,
        evidence_ids: group.objectIds
      }));
    },
    hasPendingSynthesisForSubject: async (workspaceId, subject) => {
      const row = hasPendingStatement.get(workspaceId, buildDerivedKey("synthesis-subject", subject));
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
    return {
      chainStart,
      chainEnd,
      intermediateIds
    };
  });
}
