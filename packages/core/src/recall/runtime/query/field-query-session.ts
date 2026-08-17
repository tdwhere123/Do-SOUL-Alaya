import { randomUUID } from "node:crypto";
import type {
  FieldContractSha256,
  FieldProjectionGeneration,
  ProjectionPin,
  QueryConditionReceipt
} from "@do-soul/alaya-protocol";
import {
  activateProjectionGeneration,
  buildProjectionGeneration,
  verifyProjectionGeneration
} from "../../field/retrieval/projection/generation-lifecycle.js";
import {
  InMemoryProjectionGenerationStore,
  type ProjectionGenerationLifecycleStore
} from "../../field/retrieval/projection/generation-store.js";
import {
  selectPinnedProjectionCandidates,
  type PinnedProjectionCandidateSelection
} from "../../field/retrieval/projection/pinned-projection-selection.js";
import { projectionPinExpiry } from "./projection-pin-lease.js";
export const SEALED_EMPTY_FRONTIER = "sealed:empty";

export interface RecallFieldQuerySession {
  pinActiveGeneration(workspaceId: string, recordedAt: string): ProjectionPin;
  selectCandidates(
    condition: QueryConditionReceipt,
    pin: ProjectionPin,
    selectedAt: string
  ): PinnedProjectionCandidateSelection;
  renew(pin: ProjectionPin, renewedAt: string): ProjectionPin;
  release(pin: ProjectionPin, releasedAt: string): ProjectionPin;
}

export interface TestOnlyInMemoryFieldQuerySession extends RecallFieldQuerySession {
  activateEmptyGeneration(workspaceId: string, recordedAt: string): FieldProjectionGeneration;
}

export function createTestOnlyInMemoryFieldQuerySession(
  sha256: FieldContractSha256
): TestOnlyInMemoryFieldQuerySession {
  const store = new InMemoryProjectionGenerationStore(sha256);
  return {
    activateEmptyGeneration(workspaceId, recordedAt) {
      return activateTestOnlyEmptyGeneration(store, sha256, workspaceId, recordedAt);
    },
    pinActiveGeneration(workspaceId, recordedAt) {
      const active = store.readActive(workspaceId);
      if (active === null) throw new Error("active projection generation is missing");
      return store.pin({
        workspace_id: workspaceId,
        generation_id: active.generation_id,
        reader_id: randomUUID(),
        pinned_at: recordedAt,
        expires_at: projectionPinExpiry(recordedAt),
        released_at: null
      });
    },
    selectCandidates(condition, pin, selectedAt) {
      assertPinMatchesCondition(condition, pin);
      store.requireActivePin(pin, selectedAt);
      const artifacts = store.readArtifacts(
        condition.condition.workspace_id,
        condition.generation_id
      );
      if (artifacts === null) throw new Error("pinned projection artifacts are missing");
      return selectPinnedProjectionCandidates({ condition, artifacts, sha256 });
    },
    renew(pin, renewedAt) {
      const existing = store.readPin(pin.workspace_id, pin.generation_id, pin.reader_id);
      if (existing === null || existing.released_at !== null) {
        throw new Error("projection pin is missing or released");
      }
      return store.renew(pin, renewedAt, projectionPinExpiry(renewedAt));
    },
    release(pin, releasedAt) {
      const existing = store.readPin(pin.workspace_id, pin.generation_id, pin.reader_id);
      if (existing === null) throw new Error("projection pin is missing");
      const released = store.release({
        workspace_id: pin.workspace_id,
        generation_id: pin.generation_id,
        reader_id: pin.reader_id,
        released_at: releasedAt
      });
      store.collectRetired(pin.workspace_id, releasedAt);
      return released;
    }
  };
}

export function createSeededTestOnlyInMemoryFieldQuerySession(
  sha256: FieldContractSha256,
  workspaceId: string,
  recordedAt = "1970-01-01T00:00:00.000Z"
): TestOnlyInMemoryFieldQuerySession {
  const session = createTestOnlyInMemoryFieldQuerySession(sha256);
  session.activateEmptyGeneration(workspaceId, recordedAt);
  return session;
}

function assertPinMatchesCondition(condition: QueryConditionReceipt, pin: ProjectionPin): void {
  if (condition.condition.workspace_id !== pin.workspace_id ||
      condition.generation_id !== pin.generation_id) {
    throw new Error("projection reader pin does not match the query condition");
  }
}

export function activateTestOnlyEmptyGeneration(
  store: ProjectionGenerationLifecycleStore,
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
