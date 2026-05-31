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
-- cross-file ref: packages/core/src/path-relation-proposal-service.ts (seed catalog)
-- cross-file ref: packages/protocol/src/soul/path-anchor-identity.ts (anchor JSON shape)
--
-- The backfill is idempotent: path_id is derived deterministically from edge_id
-- so re-running cannot double-insert, and the NOT EXISTS guard skips any edge
-- whose equivalent active path_relation already exists (the cutover may have
-- already produced some). It is safe over an empty memory_graph_edges (the
-- INSERT...SELECT touches no rows); migration 017 always creates the table
-- before this migration runs, so the source table is guaranteed present.

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
    'relation_kind', e.edge_type,
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
FROM memory_graph_edges AS e
WHERE NOT EXISTS (
  SELECT 1
  FROM path_relations AS p
  WHERE p.workspace_id = e.workspace_id
    AND json_extract(p.constitution_json, '$.relation_kind') = e.edge_type
    AND json_extract(p.anchors_json, '$.source_anchor.kind') = 'object'
    AND json_extract(p.anchors_json, '$.source_anchor.object_id') = e.source_memory_id
    AND json_extract(p.anchors_json, '$.target_anchor.kind') = 'object'
    AND json_extract(p.anchors_json, '$.target_anchor.object_id') = e.target_memory_id
    AND COALESCE(json_extract(p.lifecycle_json, '$.status'), 'active') = 'active'
);

DROP INDEX IF EXISTS idx_memory_graph_edges_source;
DROP INDEX IF EXISTS idx_memory_graph_edges_target;
DROP INDEX IF EXISTS idx_memory_graph_edges_workspace;

DROP TABLE IF EXISTS memory_graph_edges;
