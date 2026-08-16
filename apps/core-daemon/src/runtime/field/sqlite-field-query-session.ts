import type { FieldContractSha256, ProjectionPin } from "@do-soul/alaya-protocol";
import {
  SEALED_EMPTY_FRONTIER,
  type RecallFieldQuerySession
} from "@do-soul/alaya-core";
import type { FieldProjectionGenerationRepo } from "@do-soul/alaya-storage";
import { rebuildAndActivateProjectionGeneration } from "./shadow-rebuild.js";
import type { EventLogEntry } from "@do-soul/alaya-protocol";

export function createSqliteFieldQuerySession(input: Readonly<{
  readonly generations: FieldProjectionGenerationRepo;
  readonly eventLog: {
    append(event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">):
      EventLogEntry | Promise<EventLogEntry>;
  };
  readonly sha256: FieldContractSha256;
}>): RecallFieldQuerySession {
  return {
    pinActiveGeneration(workspaceId, recordedAt) {
      const active = input.generations.readActive(workspaceId) ??
        rebuildAndActivateProjectionGeneration({
          workspaceId,
          inputEventFrontier: SEALED_EMPTY_FRONTIER,
          governanceFrontier: SEALED_EMPTY_FRONTIER,
          recordedAt,
          generations: input.generations,
          eventLog: input.eventLog,
          sha256: input.sha256
        });
      return input.generations.pin({
        workspace_id: workspaceId,
        generation_id: active.generation_id,
        pinned_at: recordedAt
      }) as ProjectionPin;
    }
  };
}
