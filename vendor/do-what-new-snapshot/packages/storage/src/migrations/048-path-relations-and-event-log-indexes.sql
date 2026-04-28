CREATE INDEX idx_event_log_workspace_id ON event_log(workspace_id);

CREATE INDEX idx_path_relations_source_anchor_key
ON path_relations(
  workspace_id,
  CASE json_extract(anchors_json, '$.source_anchor.kind')
    WHEN 'object' THEN json_array('object', json_extract(anchors_json, '$.source_anchor.object_id'))
    WHEN 'object_facet' THEN json_array(
      'object_facet',
      json_extract(anchors_json, '$.source_anchor.object_id'),
      json_extract(anchors_json, '$.source_anchor.facet_key')
    )
    WHEN 'obligation' THEN json_array(
      'obligation',
      json_extract(anchors_json, '$.source_anchor.source_object_id'),
      json_extract(anchors_json, '$.source_anchor.obligation_digest')
    )
    WHEN 'risk_concern' THEN json_array(
      'risk_concern',
      json_extract(anchors_json, '$.source_anchor.source_object_id'),
      json_extract(anchors_json, '$.source_anchor.concern_digest')
    )
    WHEN 'time_concern' THEN json_array(
      'time_concern',
      json_extract(anchors_json, '$.source_anchor.source_object_id'),
      json_extract(anchors_json, '$.source_anchor.window_digest')
    )
  END
);

CREATE INDEX idx_path_relations_target_anchor_key
ON path_relations(
  workspace_id,
  CASE json_extract(anchors_json, '$.target_anchor.kind')
    WHEN 'object' THEN json_array('object', json_extract(anchors_json, '$.target_anchor.object_id'))
    WHEN 'object_facet' THEN json_array(
      'object_facet',
      json_extract(anchors_json, '$.target_anchor.object_id'),
      json_extract(anchors_json, '$.target_anchor.facet_key')
    )
    WHEN 'obligation' THEN json_array(
      'obligation',
      json_extract(anchors_json, '$.target_anchor.source_object_id'),
      json_extract(anchors_json, '$.target_anchor.obligation_digest')
    )
    WHEN 'risk_concern' THEN json_array(
      'risk_concern',
      json_extract(anchors_json, '$.target_anchor.source_object_id'),
      json_extract(anchors_json, '$.target_anchor.concern_digest')
    )
    WHEN 'time_concern' THEN json_array(
      'time_concern',
      json_extract(anchors_json, '$.target_anchor.source_object_id'),
      json_extract(anchors_json, '$.target_anchor.window_digest')
    )
  END
);
