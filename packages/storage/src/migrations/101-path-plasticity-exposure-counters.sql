UPDATE path_relations
SET plasticity_state_json = json_set(
  plasticity_state_json,
  '$.support_exposure_count',
  COALESCE(
    json_extract(plasticity_state_json, '$.support_exposure_count'),
    json_extract(plasticity_state_json, '$.support_events_count'),
    0
  ),
  '$.contradiction_exposure_count',
  COALESCE(
    json_extract(plasticity_state_json, '$.contradiction_exposure_count'),
    json_extract(plasticity_state_json, '$.contradiction_events_count'),
    0
  )
)
WHERE json_valid(plasticity_state_json)
  AND (
    json_extract(plasticity_state_json, '$.support_exposure_count') IS NULL
    OR json_extract(plasticity_state_json, '$.contradiction_exposure_count') IS NULL
  );
