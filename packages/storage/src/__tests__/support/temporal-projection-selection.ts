import type { StorageDatabase } from "../../sqlite/db.js";

const SELECTED_AT = "2026-07-17T00:00:00.000Z";
const SELECTION_ID = "00000000-0000-4000-8000-000000000108";

// Tests direct legacy-path boundaries after selection without a filesystem cutover.
export function markTemporalProjectionSelectedForTest(database: StorageDatabase): void {
  const result = database.connection.prepare(`
    UPDATE temporal_schema_state
    SET temporal_projection_selected = 1,
        selection_id = ?,
        selected_at = ?,
        updated_at = ?
    WHERE state_id = 1
      AND temporal_projection_selected = 0
  `).run(SELECTION_ID, SELECTED_AT, SELECTED_AT);
  if (result.changes !== 1) {
    throw new Error("Expected an unselected temporal projection state for this test.");
  }
}
