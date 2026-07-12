export const PATH_RELATION_SELECT_COLUMNS = `
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
`;

function anchorKeySql(anchorPath: "source_anchor" | "target_anchor"): string {
  return `CASE json_extract(anchors_json, '$.${anchorPath}.kind')
      WHEN 'object' THEN json_array('object', json_extract(anchors_json, '$.${anchorPath}.object_id'))
      WHEN 'object_facet' THEN json_array(
        'object_facet',
        json_extract(anchors_json, '$.${anchorPath}.object_id'),
        json_extract(anchors_json, '$.${anchorPath}.facet_key')
      )
      WHEN 'obligation' THEN json_array(
        'obligation',
        json_extract(anchors_json, '$.${anchorPath}.source_object_id'),
        json_extract(anchors_json, '$.${anchorPath}.obligation_digest')
      )
      WHEN 'risk_concern' THEN json_array(
        'risk_concern',
        json_extract(anchors_json, '$.${anchorPath}.source_object_id'),
        json_extract(anchors_json, '$.${anchorPath}.concern_digest')
      )
      WHEN 'time_concern' THEN json_array(
        'time_concern',
        json_extract(anchors_json, '$.${anchorPath}.source_object_id'),
        json_extract(anchors_json, '$.${anchorPath}.window_digest')
      )
    END`;
}

export const PATH_RELATION_SOURCE_ANCHOR_KEY_SQL = anchorKeySql("source_anchor");
export const PATH_RELATION_TARGET_ANCHOR_KEY_SQL = anchorKeySql("target_anchor");
export const SOURCE_ANCHOR_KEY_SQL = PATH_RELATION_SOURCE_ANCHOR_KEY_SQL;
export const TARGET_ANCHOR_KEY_SQL = PATH_RELATION_TARGET_ANCHOR_KEY_SQL;

function anchorBackingObjectIdSql(anchorPath: "source_anchor" | "target_anchor"): string {
  return `CASE json_extract(anchors_json, '$.${anchorPath}.kind')
      WHEN 'object' THEN json_extract(anchors_json, '$.${anchorPath}.object_id')
      WHEN 'object_facet' THEN json_extract(anchors_json, '$.${anchorPath}.object_id')
      WHEN 'obligation' THEN json_extract(anchors_json, '$.${anchorPath}.source_object_id')
      WHEN 'risk_concern' THEN json_extract(anchors_json, '$.${anchorPath}.source_object_id')
      WHEN 'time_concern' THEN json_extract(anchors_json, '$.${anchorPath}.source_object_id')
    END`;
}

export const PATH_RELATION_SOURCE_BACKING_OBJECT_ID_SQL = anchorBackingObjectIdSql("source_anchor");
export const PATH_RELATION_TARGET_BACKING_OBJECT_ID_SQL = anchorBackingObjectIdSql("target_anchor");

export function findByAnchorsSql(keyCount: number): string {
  const placeholders = Array.from({ length: keyCount }, () => "?").join(", ");
  return `
      SELECT${PATH_RELATION_SELECT_COLUMNS}
      FROM path_relations
      WHERE workspace_id = ?
        AND (
          ${SOURCE_ANCHOR_KEY_SQL} IN (${placeholders})
          OR ${TARGET_ANCHOR_KEY_SQL} IN (${placeholders})
        )
      ORDER BY created_at ASC, path_id ASC
    `;
}

export function findByBackingObjectIdSql(): string {
  return `
      SELECT${PATH_RELATION_SELECT_COLUMNS}
      FROM path_relations
      WHERE workspace_id = ?
        AND ${PATH_RELATION_SOURCE_BACKING_OBJECT_ID_SQL} = ?
      UNION ALL
      SELECT${PATH_RELATION_SELECT_COLUMNS}
      FROM path_relations
      WHERE workspace_id = ?
        AND ${PATH_RELATION_TARGET_BACKING_OBJECT_ID_SQL} = ?
      ORDER BY created_at ASC, path_id ASC
    `;
}

export function findByBackingObjectIdsSql(objectIdCount: number): string {
  const placeholders = Array.from({ length: objectIdCount }, () => "?").join(", ");
  return `
      SELECT${PATH_RELATION_SELECT_COLUMNS}
      FROM path_relations
      WHERE workspace_id = ?
        AND ${PATH_RELATION_SOURCE_BACKING_OBJECT_ID_SQL} IN (${placeholders})
      UNION ALL
      SELECT${PATH_RELATION_SELECT_COLUMNS}
      FROM path_relations
      WHERE workspace_id = ?
        AND ${PATH_RELATION_TARGET_BACKING_OBJECT_ID_SQL} IN (${placeholders})
      ORDER BY created_at ASC, path_id ASC
    `;
}

export const WAVE_1_ACTIVE_LIFECYCLE_SQL = `CASE
      WHEN json_valid(lifecycle_json) = 0 THEN 0
      WHEN json_type(lifecycle_json, '$.retirement_rule') IS NULL
        OR json_type(lifecycle_json, '$.retirement_rule') != 'text' THEN 0
      WHEN json_type(lifecycle_json, '$.cooldown_rule') IS NOT NULL
        AND json_type(lifecycle_json, '$.cooldown_rule') != 'text' THEN 0
      WHEN json_type(lifecycle_json, '$.override_rule') IS NOT NULL
        AND json_type(lifecycle_json, '$.override_rule') != 'text' THEN 0
      WHEN json_type(lifecycle_json, '$.status') IS NOT NULL
        AND json_type(lifecycle_json, '$.status') != 'text' THEN 0
      WHEN COALESCE(json_extract(lifecycle_json, '$.status'), 'active') != 'active' THEN 0
      WHEN EXISTS (
        SELECT 1
        FROM json_each(lifecycle_json)
        WHERE key NOT IN ('status', 'retirement_rule', 'cooldown_rule', 'override_rule')
      ) THEN 0
      ELSE 1
    END`;

export const WAVE_1_DORMANT_LIFECYCLE_SQL = `CASE
      WHEN json_valid(lifecycle_json) = 0 THEN 0
      WHEN json_type(lifecycle_json, '$.retirement_rule') IS NULL
        OR json_type(lifecycle_json, '$.retirement_rule') != 'text' THEN 0
      WHEN json_type(lifecycle_json, '$.cooldown_rule') IS NOT NULL
        AND json_type(lifecycle_json, '$.cooldown_rule') != 'text' THEN 0
      WHEN json_type(lifecycle_json, '$.override_rule') IS NOT NULL
        AND json_type(lifecycle_json, '$.override_rule') != 'text' THEN 0
      WHEN json_type(lifecycle_json, '$.status') IS NULL
        OR json_type(lifecycle_json, '$.status') != 'text' THEN 0
      WHEN json_extract(lifecycle_json, '$.status') != 'dormant' THEN 0
      WHEN EXISTS (
        SELECT 1
        FROM json_each(lifecycle_json)
        WHERE key NOT IN ('status', 'retirement_rule', 'cooldown_rule', 'override_rule')
      ) THEN 0
      ELSE 1
    END`;
