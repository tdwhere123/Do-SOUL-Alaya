import { createHash } from "node:crypto";
import { AlayaError } from "@do-soul/alaya-protocol";
import { DEFAULT_ANSWER_OVERLAP_BAR, type AnswersWithEdgeProducerService } from "@do-soul/alaya-core";
import type { StorageDatabase } from "@do-soul/alaya-storage";
import { loadBackfillFormationObjects } from "../daemon/support/path-formation-order.js";

type MemoryReader = Parameters<typeof loadBackfillFormationObjects>[0];

/** Pins only a digest; source text stays in its existing governed storage. */
export function createAnswersWithBackfillPort(database: StorageDatabase, memoryRepo: MemoryReader,
  crystallizer: AnswersWithEdgeProducerService | undefined) {
  if (crystallizer === undefined) return undefined;
  return {
    prepareForBackfill: async (params: {
      readonly workspaceId: string; readonly runId: string | null; readonly objectIds: readonly string[];
    }) => {
      const before = formationSnapshot(database.connection, params.workspaceId, params.objectIds);
      const objects = await loadBackfillFormationObjects(memoryRepo, params.workspaceId, params.objectIds);
      const plan = await crystallizer.prepare({ workspaceId: params.workspaceId, runId: params.runId,
        objects, bar: DEFAULT_ANSWER_OVERLAP_BAR, capPerNode: 3, crossSessionOnly: false });
      if (before !== formationSnapshot(database.connection, params.workspaceId, params.objectIds)) {
        throw new AlayaError("CONFLICT", "Garden formation inputs changed while preparing the follow-up.");
      }
      const digest = createHash("sha256").update(JSON.stringify([before, plan.digest]), "utf8").digest("hex");
      return {
        digest,
        execute: async (assertClaim: () => undefined) => {
          const assertCurrent = (): undefined => {
            assertClaim();
            if (before !== formationSnapshot(database.connection, params.workspaceId, params.objectIds)) {
              throw new AlayaError("CONFLICT", "Garden formation inputs changed before assertion admission.");
            }
            return undefined;
          };
          assertCurrent();
          await plan.execute(assertCurrent);
        }
      };
    }
  };
}

function formationSnapshot(connection: StorageDatabase["connection"], workspaceId: string,
  objectIds: readonly string[]): string {
  const read = connection.prepare(`SELECT m.object_id, m.workspace_id, m.content, m.created_at,
    m.surface_id, m.run_id, m.created_by, m.source_kind, m.formation_kind, m.dimension, m.scope_class,
    m.lifecycle_state, h.observation_id, h.hqs_json, o.observation_sha256
    FROM memory_entries m LEFT JOIN memory_hq h ON h.workspace_id = m.workspace_id AND h.object_id = m.object_id
    LEFT JOIN memory_hq_observations o ON o.workspace_id = h.workspace_id AND o.observation_id = h.observation_id
    WHERE m.workspace_id = ? AND m.object_id = ? AND m.lifecycle_state != 'tombstone'
      AND (h.object_id IS NULL OR (h.observation_id IS NOT NULL AND o.observation_sha256 IS NOT NULL
        AND o.observation_sha256 NOT LIKE 'erased%'))
      AND NOT EXISTS (SELECT 1 FROM privacy_current_quarantine q WHERE q.workspace_id = m.workspace_id AND
        ((q.object_kind IN ('memory_entry', 'memory_hq_projection') AND q.object_id = m.object_id)
          OR (q.object_kind = 'memory_hq_observation' AND q.object_id = h.observation_id)))`);
  const rows = objectIds.map(objectId => {
    const row = read.get(workspaceId, objectId);
    if (row === undefined) throw new AlayaError("CONFLICT", "Garden formation source is unavailable.");
    return row;
  });
  return JSON.stringify(rows);
}
