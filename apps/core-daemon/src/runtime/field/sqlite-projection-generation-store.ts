import type {
  FieldProjectionGeneration,
  ProjectionGenerationPointer
} from "@do-soul/alaya-protocol";
import type { ProjectionGenerationLifecycleStore } from "@do-soul/alaya-core";
import {
  generationFromRow,
  generationToRow,
  type FieldProjectionGenerationRepo
} from "@do-soul/alaya-storage";

export function createSqliteProjectionGenerationStore(
  repo: FieldProjectionGenerationRepo
): ProjectionGenerationLifecycleStore {
  return Object.freeze({
    snapshot: (generation: FieldProjectionGeneration) =>
      generationFromRow(repo.insert(generationToRow(generation))),
    verify: (generation: FieldProjectionGeneration) => generationFromRow(repo.persistStatus(
      generation.workspace_id, generation.generation_id, "verified"
    )),
    activatePointer: (pointer: ProjectionGenerationPointer) => repo.activatePointer(pointer),
    readGeneration(workspaceId: string, generationId: string) {
      const row = repo.readPinned(workspaceId, generationId);
      return row === null ? null : generationFromRow(row);
    }
  });
}
