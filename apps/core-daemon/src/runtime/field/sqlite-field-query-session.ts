import type { FieldContractSha256, ProjectionPin } from "@do-soul/alaya-protocol";
import {
  activateEmptyGeneration,
  createPortBackedGenerationStore,
  type RecallFieldQuerySession
} from "@do-soul/alaya-core";
import {
  generationFromRow,
  type FieldProjectionGenerationRepo
} from "@do-soul/alaya-storage";
import {
  appendGenerationActivated,
  appendGenerationRebuildStarted,
  type FieldEventLogPort
} from "./generation-audit.js";

export function createSqliteFieldQuerySession(input: Readonly<{
  readonly generations: FieldProjectionGenerationRepo;
  readonly eventLog: FieldEventLogPort;
  readonly sha256: FieldContractSha256;
}>): RecallFieldQuerySession {
  const store = createPortBackedGenerationStore(input.generations.asGenerationPort());
  return {
    pinActiveGeneration(workspaceId, recordedAt) {
      const previous = input.generations.readActive(workspaceId);
      const generation = previous === null
        ? activateEmptyGeneration(store, input.sha256, workspaceId, recordedAt)
        : generationFromRow(previous);
      if (previous === null) {
        appendGenerationRebuildStarted(input.eventLog, generation);
        appendGenerationActivated(input.eventLog, generation, null);
      }
      return input.generations.pin({
        workspace_id: workspaceId,
        generation_id: generation.generation_id,
        pinned_at: recordedAt
      }) as ProjectionPin;
    }
  };
}
