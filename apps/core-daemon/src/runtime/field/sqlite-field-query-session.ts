import { randomUUID } from "node:crypto";
import type {
  FieldContractSha256,
  ProjectionPin,
  QueryConditionReceipt
} from "@do-soul/alaya-protocol";
import {
  canonicalProjectionPinTime,
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
      const pinnedAt = canonicalProjectionPinTime(recordedAt);
      input.generations.collectRetired(workspaceId, pinnedAt);
      return input.database.connection.transaction(() => {
        const row = input.generations.readActive(workspaceId);
        if (row === null) throw new Error("active projection generation is missing");
        const generation = generationFromRow(row);
        requirePinnableGeneration(generation);
        return input.generations.pin({
          workspace_id: workspaceId,
          generation_id: generation.generation_id,
          reader_id: randomUUID(),
          pinned_at: pinnedAt,
          expires_at: projectionPinExpiry(pinnedAt),
          released_at: null
        }) as ProjectionPin;
      }).immediate();
    },
    selectCandidates(
      condition: QueryConditionReceipt,
      pin: ProjectionPin,
      selectedAt: string
    ): PinnedProjectionCandidateSelection {
      const canonicalSelectedAt = canonicalProjectionPinTime(selectedAt);
      return input.database.connection.transaction(() => {
        assertLivePin(input.generations, condition, pin, canonicalSelectedAt);
        const artifacts = store.readArtifacts(
          condition.condition.workspace_id,
          condition.generation_id
        );
        if (artifacts === null) throw new Error("pinned projection artifacts are missing");
        return selectPinnedProjectionCandidates({ condition, artifacts, sha256: input.sha256 });
      })();
    },
    renew(pin, renewedAt) {
      const canonicalRenewedAt = canonicalProjectionPinTime(renewedAt);
      return input.database.connection.transaction(() => input.generations.renewPin({
        workspace_id: pin.workspace_id,
        generation_id: pin.generation_id,
        reader_id: pin.reader_id,
        renewed_at: canonicalRenewedAt,
        expires_at: projectionPinExpiry(canonicalRenewedAt)
      }) as ProjectionPin)();
    },
    release(pin, releasedAt) {
      const canonicalReleasedAt = canonicalProjectionPinTime(releasedAt);
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
          released_at: canonicalReleasedAt
        }) as ProjectionPin;
        input.generations.collectRetired(pin.workspace_id, canonicalReleasedAt);
        return released;
      }).immediate();
    }
  };
}

function requirePinnableGeneration(
  generation: ReturnType<typeof generationFromRow>
): void {
  if (generation.status !== "active") {
    throw new Error("active projection pointer targets a non-active generation");
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
  // Store expiry moves on renew; the caller handle snapshot does not.
  if (stored === null || stored.pinned_at !== pin.pinned_at) {
    throw new Error("projection reader pin is missing or mismatched");
  }
  if (stored.released_at !== null) throw new Error("projection reader pin is released");
  if (Date.parse(stored.pinned_at) > Date.parse(selectedAt) ||
      Date.parse(stored.expires_at) <= Date.parse(selectedAt)) {
    throw new Error("projection reader pin is not live");
  }
}
