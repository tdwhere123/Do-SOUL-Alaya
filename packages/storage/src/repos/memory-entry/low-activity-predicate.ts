// Shared by candidate selection and the final guarded demotion.
export const LOW_ACTIVITY_MEMORY_SQL = `storage_tier = 'hot'
  AND COALESCE(activation_score, 0.0) <= ?
  AND alaya_utc_compare(COALESCE(last_hit_at, last_used_at, created_at), ?) <= 0`;
