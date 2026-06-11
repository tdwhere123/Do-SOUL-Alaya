-- memory_graph_edges is retired. The unified memory graph lives on the
-- path_relations plane; every reader/writer (recall graph_expansion,
-- graph_support, explore_graph, graph-health, librarian, accept->path mint)
-- was repointed to path_relations. This table has no live writer or reader.
--
-- An upgraded database (initialized before the path/edge spine cutover) can
-- still hold durable legacy edges that were never copied into path_relations.
-- Durable graph truth must survive upgrade, so each surviving legacy edge is
-- backfilled into path_relations BEFORE the table is dropped. The per-edge_type
-- seed (relation_kind / signed recall_bias / governance_class / initial
-- strength / evidence_basis) mirrors the seed-profile catalog that the live
-- producer (PathRelationProposalService) mints with, so a backfilled row is
-- numerically the same shape a freshly minted one would be.
-- cross-file ref: packages/core/src/path-graph/path-relation-proposal-service.ts (seed catalog)
-- cross-file ref: packages/protocol/src/soul/path-anchor-identity.ts (anchor JSON shape)
--
-- The backfill is idempotent: path_id is derived deterministically from edge_id
-- so re-running cannot double-insert, and the NOT EXISTS guard skips any edge
-- whose equivalent active path_relation already exists (the cutover may have
-- already produced some). It is safe over an empty memory_graph_edges (the
-- INSERT...SELECT touches no rows); migration 017 always creates the table
-- before this migration runs, so the source table is guaranteed present.
--
-- A legacy `recalls` edge backfills as relation_kind `co_recalled`, the name
-- the live associative co-usage/co-recall seeder mints. Both fold to the same
-- graph edge_type (`recalls`, contribution_weight 0.3) and carry identical
-- recall_bias (+0.5) / strength (0.3) / governance (attention_only), so the
-- rename is recall-behavior-identical. It exists so the dedup NOT EXISTS below
-- matches a cutover-minted `co_recalled` row for the same pair; without it a
-- pre-spine `recalls` edge and the cutover `co_recalled` path would both
-- survive, doubling the associative recall weight for one pair.
-- cross-file ref: packages/core/src/path-graph/path-relation-proposal-service.ts CO_RECALLED_SEED_PROFILE
-- cross-file ref: packages/protocol/src/soul/memory-graph.ts mapRelationKindToGraphEdgeType
--
-- invariant: graph support / recalls counts consume the MAPPED graph edge_type,
-- not the literal relation_kind. SEVERAL relation kinds fold to graph `recalls`
-- (the recalls-tier: recalls / co_recalled / shares_entity / signal_graph_ref).
-- So a legacy `recalls` edge must dedupe against ANY active path in that whole
-- tier for the same pair, not just the literal `co_recalled` rename — otherwise
-- a pre-upgrade active `shares_entity` or `signal_graph_ref` path plus a legacy
-- `recalls` edge for the same pair would both survive and double-count the same
-- semantic edge after cutover. The recalls tier is also SYMMETRIC, so the dedup
-- matches the pair in EITHER orientation (the legacy librarian wrote `recalls`
-- UNSORTED while the live co_recalled producer mints SORTED low->high). Non-
-- recalls edge_types map 1:1 to their own graph edge_type AND are directional,
-- so they keep the narrower same-kind, same-orientation dedup.
-- cross-file ref: packages/core/src/path-graph/graph-explore-service.ts (mapped-type support/recall counts)
--
-- Defensive backfill: a corrupt or externally-mutated local DB (an FK-orphaned
-- legacy row, or an edge_type outside the migration-017 CHECK set that slipped
-- in under PRAGMA foreign_keys=OFF) must not wedge the cutover. The whole file
-- runs in one transaction; an INSERT that trips an FK or the recall_bias CASE
-- would roll back all of 085, the legacy table would never drop, and the DB
-- could fail to upgrade. So the SELECT only backfills rows whose workspace and
-- both memory anchors resolve in the SAME workspace AND whose edge_type is in
-- the known legacy allow-list; invalid/orphaned/malformed rows are skipped
-- (best-effort quarantine, no new table) and the DROP still runs.
-- cross-file ref: packages/storage/src/migrations/017-memory-graph-edges.sql (edge_type CHECK set)

WITH ranked_edges AS (
  SELECT
    e.*,
    ROW_NUMBER() OVER (
      PARTITION BY
        e.workspace_id,
        CASE WHEN e.edge_type = 'recalls' THEN 'recalls-tier' ELSE e.edge_type END,
        CASE
          WHEN e.edge_type = 'recalls' AND e.source_memory_id > e.target_memory_id THEN e.target_memory_id
          ELSE e.source_memory_id
        END,
        CASE
          WHEN e.edge_type = 'recalls' AND e.source_memory_id > e.target_memory_id THEN e.source_memory_id
          ELSE e.target_memory_id
        END
      ORDER BY e.created_at ASC, e.edge_id ASC
    ) AS backfill_rank
  FROM memory_graph_edges AS e
  WHERE e.edge_type IN (
      'supports',
      'derives_from',
      'contradicts',
      'supersedes',
      'recalls',
      'exception_to',
      'incompatible_with'
    )
    AND EXISTS (
      SELECT 1 FROM workspaces AS w WHERE w.workspace_id = e.workspace_id
    )
    AND EXISTS (
      SELECT 1 FROM memory_entries AS sm
      WHERE sm.object_id = e.source_memory_id AND sm.workspace_id = e.workspace_id
    )
    AND EXISTS (
      SELECT 1 FROM memory_entries AS tm
      WHERE tm.object_id = e.target_memory_id AND tm.workspace_id = e.workspace_id
    )
)
INSERT INTO path_relations (
  path_id,
  workspace_id,
  anchors_json,
  constitution_json,
  effect_vector_json,
  plasticity_state_json,
  lifecycle_json,
  legitimacy_json,
  created_at,
  updated_at
)
SELECT
  'legacy-edge:' || e.edge_id,
  e.workspace_id,
  json_object(
    'source_anchor', json_object('kind', 'object', 'object_id', e.source_memory_id),
    'target_anchor', json_object('kind', 'object', 'object_id', e.target_memory_id)
  ),
  json_object(
    'relation_kind',
      CASE e.edge_type
        WHEN 'recalls' THEN 'co_recalled'
        ELSE e.edge_type
      END,
    'why_this_relation_exists', json_array('legacy_memory_graph_edge:' || e.edge_id)
  ),
  json_object(
    'salience', 0.5,
    'recall_bias',
      CASE e.edge_type
        WHEN 'supports' THEN 0.5
        WHEN 'derives_from' THEN 0.5
        WHEN 'recalls' THEN 0.5
        WHEN 'exception_to' THEN 0.0
        WHEN 'supersedes' THEN -0.5
        WHEN 'contradicts' THEN -0.4
        WHEN 'incompatible_with' THEN -0.3
      END,
    'verification_bias', 0.0,
    'unfinishedness_bias', 0.0,
    'default_manifestation_preference', 'lens_entry'
  ),
  json_object(
    'strength',
      CASE e.edge_type
        WHEN 'recalls' THEN 0.3
        WHEN 'supports' THEN 0.5
        WHEN 'derives_from' THEN 0.5
        ELSE 0.9
      END,
    'direction_bias', 'bidirectional_asymmetric',
    'stability_class', 'stable',
    'support_events_count', 0,
    'contradiction_events_count', 0
  ),
  json_object('status', 'active', 'retirement_rule', 'manual'),
  json_object(
    'evidence_basis', json_array('legacy_memory_graph_edge:' || e.edge_id),
    'governance_class',
      CASE e.edge_type
        WHEN 'supports' THEN 'attention_only'
        WHEN 'derives_from' THEN 'attention_only'
        WHEN 'recalls' THEN 'attention_only'
        ELSE 'recall_allowed'
      END
  ),
  e.created_at,
  e.created_at
FROM ranked_edges AS e
WHERE e.backfill_rank = 1
  AND NOT EXISTS (
    SELECT 1
    FROM path_relations AS p
    WHERE p.workspace_id = e.workspace_id
      AND (
        CASE WHEN e.edge_type = 'recalls'
          -- recalls-tier: every relation_kind that maps to graph `recalls`.
          THEN json_extract(p.constitution_json, '$.relation_kind')
            IN ('recalls', 'co_recalled', 'shares_entity', 'signal_graph_ref')
          ELSE json_extract(p.constitution_json, '$.relation_kind') = e.edge_type
        END
      )
      AND (
        e.edge_type <> 'recalls'
        OR COALESCE(json_extract(p.effect_vector_json, '$.recall_bias'), 0) > 0
      )
      AND json_extract(p.anchors_json, '$.source_anchor.kind') = 'object'
      AND json_extract(p.anchors_json, '$.target_anchor.kind') = 'object'
      -- invariant: the recalls-tier is the SYMMETRIC associative family — a
      -- reverse-oriented path is the SAME semantic edge, so a legacy `recalls`
      -- edge (the only legacy edge_type in that tier; the live co_recalled
      -- producer mints SORTED low->high while the legacy librarian wrote
      -- UNSORTED) must dedup against an existing tier path in EITHER
      -- orientation, or a reverse-oriented legacy edge backfills a SECOND
      -- associative path and graph_support double-counts the recall weight.
      -- The DIRECTIONAL kinds keep same-orientation-only dedup: for them a
      -- reverse-oriented path is a DISTINCT edge, not a duplicate.
      -- cross-file ref: packages/storage/src/repos/edge-proposal-repo.ts listAcceptedAwaitingPath (matches either orientation)
      -- cross-file ref: packages/core/src/path-graph/path-relation-proposal-service.ts anchorPointsAt / accrueCoOccurrence
      AND (
        (
          json_extract(p.anchors_json, '$.source_anchor.object_id') = e.source_memory_id
          AND json_extract(p.anchors_json, '$.target_anchor.object_id') = e.target_memory_id
        )
        OR (
          e.edge_type = 'recalls'
          AND json_extract(p.anchors_json, '$.source_anchor.object_id') = e.target_memory_id
          AND json_extract(p.anchors_json, '$.target_anchor.object_id') = e.source_memory_id
        )
      )
      AND COALESCE(json_extract(p.lifecycle_json, '$.status'), 'active') = 'active'
  );

DROP INDEX IF EXISTS idx_memory_graph_edges_source;
DROP INDEX IF EXISTS idx_memory_graph_edges_target;
DROP INDEX IF EXISTS idx_memory_graph_edges_workspace;

DROP TABLE IF EXISTS memory_graph_edges;
