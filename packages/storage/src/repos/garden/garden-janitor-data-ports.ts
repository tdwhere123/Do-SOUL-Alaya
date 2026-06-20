import { DYNAMICS_CONSTANTS } from "@do-soul/alaya-protocol";
import {
  BOUNDARY_COLD_TIER,
  HOT_DEMOTION_LIMIT
} from "./garden-background-port-constants.js";
import type {
  GardenJanitorDormantDemotionPort,
  GardenJanitorMemoryTieringPort,
  GardenLowActivityMemoryRecord
} from "./garden-background-port-types.js";
import {
  ACTIVE_STATE,
  addMilliseconds,
  type GardenDataPortFactoryContext
} from "./garden-data-port-shared.js";

export function createTieringPort(
  context: GardenDataPortFactoryContext
): GardenJanitorMemoryTieringPort {
  const findHotDemotionCandidatesStatement = context.database.connection.prepare(`
    SELECT
      object_id AS memory_entry_id,
      COALESCE(last_hit_at, last_used_at) AS last_access_at,
      activation_score
    FROM memory_entries
    WHERE workspace_id = ?
      AND lifecycle_state = '${ACTIVE_STATE}'
      AND storage_tier = 'hot'
      AND activation_score IS NOT NULL
      AND activation_score < ?
      AND COALESCE(last_hit_at, last_used_at, created_at) <= ?
    ORDER BY activation_score ASC, COALESCE(last_hit_at, last_used_at, created_at) ASC, object_id ASC
    LIMIT ${HOT_DEMOTION_LIMIT}
  `);

  return {
    findHotDemotionCandidates: async (workspaceId, criteria) => {
      const staleBefore = addMilliseconds(context.now(), -Math.max(0, criteria.maxLastHitAgeMs));
      const rows = findHotDemotionCandidatesStatement.all(
        workspaceId,
        criteria.minActivationScore,
        staleBefore
      ) as readonly { readonly memory_entry_id: string; readonly last_access_at: string | null; readonly activation_score: number }[];
      return rows;
    },
    demoteToWarm: (workspaceId, memoryEntryIds) => {
      const uniqueIds = Array.from(new Set(memoryEntryIds.filter((entryId) => entryId.length > 0)));
      if (uniqueIds.length === 0) {
        return;
      }

      const placeholders = uniqueIds.map(() => "?").join(", ");
      context.database.connection
        .prepare(
          `UPDATE memory_entries
           SET storage_tier = '${BOUNDARY_COLD_TIER}', updated_at = ?
           WHERE workspace_id = ?
             AND object_id IN (${placeholders})
             AND lifecycle_state = '${ACTIVE_STATE}'`
        )
        .run(context.now(), workspaceId, ...uniqueIds);
    }
  };
}

export function createDormantDemotionPort(
  context: GardenDataPortFactoryContext
): GardenJanitorDormantDemotionPort {
  const SILENT_ACTIVATION_BAND = DYNAMICS_CONSTANTS.manifestation_thresholds.hint_max;
  const IDLE_WINDOW_MS = DYNAMICS_CONSTANTS.path_plasticity.retirement_inactivity_ms;
  const DORMANT_DEMOTION_LIMIT = 120;

  const findLowActivityStatement = context.database.connection.prepare(`
    SELECT object_id AS memory_id
    FROM memory_entries
    WHERE workspace_id = ?
      AND lifecycle_state = '${ACTIVE_STATE}'
      AND storage_tier = 'hot'
      AND COALESCE(activation_score, 0.0) <= ?
      AND COALESCE(last_hit_at, last_used_at, created_at) <= ?
    ORDER BY COALESCE(activation_score, 0.0) ASC,
             COALESCE(last_hit_at, last_used_at, created_at) ASC,
             object_id ASC
    LIMIT ${DORMANT_DEMOTION_LIMIT}
  `);

  const setDormantStatement = context.database.connection.prepare(`
    UPDATE memory_entries
    SET lifecycle_state = 'dormant', updated_at = ?
    WHERE object_id = ?
      AND lifecycle_state = '${ACTIVE_STATE}'
  `);

  return {
    findLowActivityActiveMemories: async (workspaceId) => {
      const idleBefore = addMilliseconds(context.now(), -Math.max(0, IDLE_WINDOW_MS));
      return findLowActivityStatement.all(
        workspaceId,
        SILENT_ACTIVATION_BAND,
        idleBefore
      ) as readonly GardenLowActivityMemoryRecord[];
    },
    setLifecycleDormant: async (memoryId) => {
      const result = setDormantStatement.run(context.now(), memoryId);
      return result.changes === 0 ? "skipped" : "demoted";
    }
  };
}
