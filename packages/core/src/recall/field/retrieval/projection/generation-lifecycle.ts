import type {
  FieldContractSha256,
  FieldProjectionGeneration,
  ProjectionGenerationPointer
} from "@do-soul/alaya-protocol";
import { createProjectionGenerationReceipt, verifyConditionalProjectionGeneration } from "./generation-identity.js";

export interface ProjectionGenerationLifecycleStore {
  snapshot(input: FieldProjectionGeneration): FieldProjectionGeneration;
  verify(input: FieldProjectionGeneration): FieldProjectionGeneration;
  activatePointer(pointer: ProjectionGenerationPointer): ProjectionGenerationPointer;
  readGeneration(workspaceId: string, generationId: string): FieldProjectionGeneration | null;
}

export function buildProjectionGeneration(request: Readonly<{
  readonly store: ProjectionGenerationLifecycleStore;
  readonly sha256: FieldContractSha256;
  readonly workspace_id: string;
  readonly input_event_frontier: string;
  readonly governance_frontier: string;
  readonly recorded_at: string;
}>): Readonly<{ readonly generation: FieldProjectionGeneration }> {
  const generation = createProjectionGenerationReceipt({
    workspace_id: request.workspace_id,
    input_event_frontier: request.input_event_frontier,
    governance_frontier: request.governance_frontier,
    status: "shadow",
    recorded_at: request.recorded_at
  }, request.sha256);
  return Object.freeze({ generation: request.store.snapshot(generation) });
}

export function verifyProjectionGeneration(
  store: ProjectionGenerationLifecycleStore,
  generation: FieldProjectionGeneration,
  sha256: FieldContractSha256
): Readonly<{ readonly generation: FieldProjectionGeneration }> {
  verifyConditionalProjectionGeneration(generation, sha256);
  return Object.freeze({ generation: store.verify(generation) });
}

export function activateProjectionGeneration(
  store: ProjectionGenerationLifecycleStore,
  pointer: ProjectionGenerationPointer,
  sha256: FieldContractSha256
): ProjectionGenerationPointer {
  const generation = store.readGeneration(pointer.workspace_id, pointer.active_generation_id);
  if (generation === null) throw new Error("projection generation is missing");
  if (generation.workspace_id !== pointer.workspace_id || generation.generation_id !== pointer.active_generation_id) {
    throw new Error("projection generation does not match its activation pointer");
  }
  verifyConditionalProjectionGeneration(generation, sha256);
  return store.activatePointer(pointer);
}
