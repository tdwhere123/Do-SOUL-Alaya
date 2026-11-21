import { CoreError, type EventPublisher } from "@do-soul/alaya-core";
import { GardenEventType, parseGardenEventPayload, type GardenEventPayloadMap } from "@do-soul/alaya-protocol";
import type { GardenTaskRow, SqliteEventLogRepo } from "@do-soul/alaya-storage";

const EXTRACTION_EVENT = GardenEventType.SOUL_GARDEN_STATEMENT_SESSION_EXTRACTED;
export type StatementSessionExtraction = GardenEventPayloadMap[typeof EXTRACTION_EVENT];

export function createStatementSessionExtractionReceipts(
  eventLogRepo: SqliteEventLogRepo,
  eventPublisher: EventPublisher
) {
  return {
    read(row: GardenTaskRow, runId: string): StatementSessionExtraction | null {
      const entries = eventLogRepo.queryByEntityTypeBeforeInCurrentTransaction(
        "garden_task", row.id, EXTRACTION_EVENT, null, 2);
      const entry = entries[0];
      if (entry === undefined) return null;
      if (entries.length !== 1 || entry.workspace_id !== row.workspace_id || entry.run_id !== runId) {
        throw new CoreError("CONFLICT", "Statement session extraction receipt does not match the task.");
      }
      return parseGardenEventPayload(EXTRACTION_EVENT, entry.payload_json);
    },
    async record(row: GardenTaskRow, runId: string, extraction: StatementSessionExtraction, assertClaim: () => void) {
      await eventPublisher.appendManyWithMutation([{
        event_type: EXTRACTION_EVENT, entity_type: "garden_task", entity_id: row.id, workspace_id: row.workspace_id,
        run_id: runId, caused_by: "garden-runtime", payload_json: parseGardenEventPayload(EXTRACTION_EVENT, extraction)
      }], assertClaim);
    }
  };
}

export type StatementSessionExtractionReceipts = ReturnType<typeof createStatementSessionExtractionReceipts>;
