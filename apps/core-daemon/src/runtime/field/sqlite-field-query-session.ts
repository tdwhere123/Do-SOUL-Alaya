import { randomUUID } from "node:crypto";
import type {
  FieldContractSha256,
  ProjectionPin,
  QueryConditionReceipt
} from "@do-soul/alaya-protocol";
import {
  projectionPinExpiry,
  selectPinnedProjectionCandidates,
  type PinnedProjectionCandidateSelection,
  type RecallFieldQuerySession
} from "@do-soul/alaya-core";
import {
  generationFromRow,
  type FieldProjectionGenerationRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { createSqliteProjectionGenerationStore } from
  "./sqlite-projection-generation-store.js";

type SqliteFieldQuerySessionInput = Readonly<{
  readonly generations: FieldProjectionGenerationRepo;
  readonly database: StorageDatabase;
  readonly sha256: FieldContractSha256;
}>;

export function createSqliteFieldQuerySession(
  input: SqliteFieldQuerySessionInput
): RecallFieldQuerySession {
  const store = createSqliteProjectionGenerationStore(input.generations);
  return {
    pinActiveGeneration(workspaceId, recordedAt) {
      input.generations.collectRetired(workspaceId, recordedAt);
      const row = input.generations.readActive(workspaceId);
      if (row === null) throw new Error("active projection generation is missing");
      const generation = generationFromRow(row);
      requirePinnableGeneration(store, generation);
      return input.database.connection.transaction(() => {
        return input.generations.pin({
          workspace_id: workspaceId,
          generation_id: generation.generation_id,
          reader_id: randomUUID(),
          pinned_at: recordedAt,
          expires_at: projectionPinExpiry(recordedAt),
          released_at: null
        }) as ProjectionPin;
      }).immediate();
    },
    selectCandidates(
      condition: QueryConditionReceipt,
      pin: ProjectionPin,
      selectedAt: string
    ): PinnedProjectionCandidateSelection {
      return input.database.connection.transaction(() => {
        assertLivePin(input.generations, condition, pin, selectedAt);
        const artifacts = store.readArtifacts(
          condition.condition.workspace_id,
          condition.generation_id
        );
        if (artifacts === null) throw new Error("pinned projection artifacts are missing");
        return selectPinnedProjectionCandidates({ condition, artifacts, sha256: input.sha256 });
      })();
    },
    renew(pin, renewedAt) {
      return input.database.connection.transaction(() => input.generations.renewPin({
        workspace_id: pin.workspace_id,
        generation_id: pin.generation_id,
        reader_id: pin.reader_id,
        renewed_at: renewedAt,
        expires_at: projectionPinExpiry(renewedAt)
      }) as ProjectionPin)();
    },
    release(pin, releasedAt) {
      return input.database.connection.transaction(() => {
        const existing = input.generations.readPin(
          pin.workspace_id,
          pin.generation_id,
          pin.reader_id
        );
        if (existing === null) throw new Error("projection pin is missing");
        const released = input.generations.releasePin({
          workspace_id: pin.workspace_id,
          generation_id: pin.generation_id,
          reader_id: pin.reader_id,
          released_at: releasedAt
        }) as ProjectionPin;
        input.generations.collectRetired(pin.workspace_id, releasedAt);
        return released;
      }).immediate();
    }
  };
}

function requirePinnableGeneration(
  store: ReturnType<typeof createSqliteProjectionGenerationStore>,
  generation: ReturnType<typeof generationFromRow>
): void {
  if (generation.status !== "active") {
    throw new Error("active projection pointer targets a non-active generation");
  }
  if (store.readArtifacts(generation.workspace_id, generation.generation_id) === null) {
    throw new Error("active projection generation artifacts are missing");
  }
}

function assertLivePin(
  repo: FieldProjectionGenerationRepo,
  condition: QueryConditionReceipt,
  pin: ProjectionPin,
  selectedAt: string
): void {
  if (condition.condition.workspace_id !== pin.workspace_id ||
      condition.generation_id !== pin.generation_id) {
    throw new Error("projection reader pin does not match the query condition");
  }
  const stored = repo.readPin(pin.workspace_id, pin.generation_id, pin.reader_id);
  if (stored === null || stored.pinned_at !== pin.pinned_at ||
      stored.expires_at !== pin.expires_at) {
    throw new Error("projection reader pin is missing or mismatched");
  }
  if (stored.released_at !== null) throw new Error("projection reader pin is released");
  if (stored.pinned_at > selectedAt || stored.expires_at <= selectedAt) {
    throw new Error("projection reader pin is not live");
  }
}
