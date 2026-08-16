import type {
  FieldContractSha256,
  FieldProjectionGeneration,
  ProjectionPin
} from "@do-soul/alaya-protocol";
import {
  activateProjectionGeneration,
  buildProjectionGeneration,
  verifyProjectionGeneration
} from "../../field/retrieval/projection/generation-lifecycle.js";
import { InMemoryProjectionGenerationStore } from
  "../../field/retrieval/projection/generation-store.js";

export const SEALED_EMPTY_FRONTIER = "sealed:empty";

export interface RecallFieldQuerySession {
  pinActiveGeneration(workspaceId: string, recordedAt: string): ProjectionPin;
}

export function createInMemoryFieldQuerySession(
  sha256: FieldContractSha256
): RecallFieldQuerySession {
  const store = new InMemoryProjectionGenerationStore(sha256);
  return {
    pinActiveGeneration(workspaceId, recordedAt) {
      const active = store.readActive(workspaceId) ??
        activateEmptyGeneration(store, sha256, workspaceId, recordedAt);
      return store.pin({
        workspace_id: workspaceId,
        generation_id: active.generation_id,
        pinned_at: recordedAt
      });
    }
  };
}

function activateEmptyGeneration(
  store: InMemoryProjectionGenerationStore,
  sha256: FieldContractSha256,
  workspaceId: string,
  recordedAt: string
): FieldProjectionGeneration {
  const built = buildProjectionGeneration({
    store,
    sha256,
    workspace_id: workspaceId,
    input_event_frontier: SEALED_EMPTY_FRONTIER,
    governance_frontier: SEALED_EMPTY_FRONTIER,
    recorded_at: recordedAt,
    sliceKeys: []
  });
  const verified = verifyProjectionGeneration(store, built.generation, sha256);
  activateProjectionGeneration(store, {
    workspace_id: workspaceId,
    active_generation_id: verified.generation.generation_id,
    activated_at: recordedAt
  });
  return verified.generation;
}
