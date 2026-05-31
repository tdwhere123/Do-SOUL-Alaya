CREATE INDEX IF NOT EXISTS idx_path_relations_source_backing_object_id
ON path_relations(
  CASE json_extract(anchors_json, '$.source_anchor.kind')
    WHEN 'object' THEN json_extract(anchors_json, '$.source_anchor.object_id')
    WHEN 'object_facet' THEN json_extract(anchors_json, '$.source_anchor.object_id')
    WHEN 'obligation' THEN json_extract(anchors_json, '$.source_anchor.source_object_id')
    WHEN 'risk_concern' THEN json_extract(anchors_json, '$.source_anchor.source_object_id')
    WHEN 'time_concern' THEN json_extract(anchors_json, '$.source_anchor.source_object_id')
  END,
  workspace_id
);

CREATE INDEX IF NOT EXISTS idx_path_relations_target_backing_object_id
ON path_relations(
  CASE json_extract(anchors_json, '$.target_anchor.kind')
    WHEN 'object' THEN json_extract(anchors_json, '$.target_anchor.object_id')
    WHEN 'object_facet' THEN json_extract(anchors_json, '$.target_anchor.object_id')
    WHEN 'obligation' THEN json_extract(anchors_json, '$.target_anchor.source_object_id')
    WHEN 'risk_concern' THEN json_extract(anchors_json, '$.target_anchor.source_object_id')
    WHEN 'time_concern' THEN json_extract(anchors_json, '$.target_anchor.source_object_id')
  END,
  workspace_id
);

WITH recalls_tier_ranked AS (
  SELECT
    path_id,
    ROW_NUMBER() OVER (
      PARTITION BY
        workspace_id,
        CASE
          WHEN source_backing_object_id > target_backing_object_id THEN target_backing_object_id
          ELSE source_backing_object_id
        END,
        CASE
          WHEN source_backing_object_id > target_backing_object_id THEN source_backing_object_id
          ELSE target_backing_object_id
        END
      ORDER BY created_at ASC, path_id ASC
    ) AS duplicate_rank
  FROM (
    SELECT
      path_id,
      workspace_id,
      created_at,
      CASE json_extract(anchors_json, '$.source_anchor.kind')
        WHEN 'object' THEN json_extract(anchors_json, '$.source_anchor.object_id')
        WHEN 'object_facet' THEN json_extract(anchors_json, '$.source_anchor.object_id')
        WHEN 'obligation' THEN json_extract(anchors_json, '$.source_anchor.source_object_id')
        WHEN 'risk_concern' THEN json_extract(anchors_json, '$.source_anchor.source_object_id')
        WHEN 'time_concern' THEN json_extract(anchors_json, '$.source_anchor.source_object_id')
      END AS source_backing_object_id,
      CASE json_extract(anchors_json, '$.target_anchor.kind')
        WHEN 'object' THEN json_extract(anchors_json, '$.target_anchor.object_id')
        WHEN 'object_facet' THEN json_extract(anchors_json, '$.target_anchor.object_id')
        WHEN 'obligation' THEN json_extract(anchors_json, '$.target_anchor.source_object_id')
        WHEN 'risk_concern' THEN json_extract(anchors_json, '$.target_anchor.source_object_id')
        WHEN 'time_concern' THEN json_extract(anchors_json, '$.target_anchor.source_object_id')
      END AS target_backing_object_id
	    FROM path_relations
	    WHERE json_extract(constitution_json, '$.relation_kind')
	        IN ('recalls', 'co_recalled', 'shares_entity', 'signal_graph_ref')
	      AND COALESCE(json_extract(effect_vector_json, '$.recall_bias'), 0) > 0
	      AND COALESCE(json_extract(lifecycle_json, '$.status'), 'active') = 'active'
	  )
  WHERE source_backing_object_id IS NOT NULL
    AND target_backing_object_id IS NOT NULL
)
UPDATE path_relations
SET lifecycle_json = CASE
      WHEN json_valid(lifecycle_json) THEN json_set(
        lifecycle_json,
        '$.status', 'dormant',
        '$.retirement_rule', COALESCE(json_extract(lifecycle_json, '$.retirement_rule'), 'manual')
      )
      ELSE json_object('status', 'dormant', 'retirement_rule', 'manual')
    END
WHERE path_id IN (
  SELECT path_id
  FROM recalls_tier_ranked
  WHERE duplicate_rank > 1
);
