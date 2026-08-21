import type {
  FieldProjectionGeneration,
  ProjectionGenerationPointer
} from "@do-soul/alaya-protocol";
import {
  internProjectionGenerationArtifacts,
  parseProjectionGenerationArtifacts,
  type ProjectionGenerationArtifacts,
  type ProjectionGenerationLifecycleStore
} from "@do-soul/alaya-core";
import {
  generationFromRow,
  generationToRow,
  type FieldProjectionGenerationRepo
} from "@do-soul/alaya-storage";

export function createSqliteProjectionGenerationStore(
  repo: FieldProjectionGenerationRepo
): ProjectionGenerationLifecycleStore {
  const cache = createArtifactsLruCache();
  return Object.freeze({
    snapshot: (generation: FieldProjectionGeneration) =>
      generationFromRow(repo.insert(generationToRow(generation))),
    verify: (generation: FieldProjectionGeneration) => generationFromRow(repo.persistStatus(
      generation.workspace_id,
      generation.generation_id,
      "verified"
    )),
    activatePointer: (pointer: ProjectionGenerationPointer) => repo.activatePointer(pointer),
    putArtifacts: (workspaceId: string, artifacts: ProjectionGenerationArtifacts) =>
      cache.remember(workspaceId, persistArtifacts(repo, workspaceId, artifacts)),
    readArtifacts: (workspaceId: string, generationId: string) => {
      const hit = cache.read(workspaceId, generationId);
      if (hit !== undefined) return hit;
      const loaded = readArtifacts(repo, workspaceId, generationId);
      return loaded === null ? null : cache.remember(workspaceId, loaded);
    }
  });
}

const ARTIFACTS_CACHE_CAP = 32;

function createArtifactsLruCache(cap = ARTIFACTS_CACHE_CAP) {
  // A one-entry cache never hits when consecutive pins change workspace.
  const entries = new Map<string, ProjectionGenerationArtifacts>();
  const keyOf = (workspaceId: string, generationId: string) => `${workspaceId}\0${generationId}`;
  return {
    read(workspaceId: string, generationId: string) {
      const key = keyOf(workspaceId, generationId);
      const hit = entries.get(key);
      if (hit === undefined) return undefined;
      entries.delete(key);
      entries.set(key, hit);
      return hit;
    },
    remember(workspaceId: string, artifacts: ProjectionGenerationArtifacts) {
      const key = keyOf(workspaceId, artifacts.generation_id);
      entries.delete(key);
      if (entries.size >= cap) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
      entries.set(key, artifacts);
      return artifacts;
    }
  };
}

function persistArtifacts(
  repo: FieldProjectionGenerationRepo,
  workspaceId: string,
  artifacts: ProjectionGenerationArtifacts
): ProjectionGenerationArtifacts {
  const generation = requireGeneration(repo, workspaceId, artifacts.generation_id);
  const persisted = repo.putArtifacts({
    workspace_id: workspaceId,
    generation_id: artifacts.generation_id,
    artifact_digest: artifacts.artifact_digest,
    artifacts_json: JSON.stringify(internProjectionGenerationArtifacts(artifacts)),
    recorded_at: generation.recorded_at
  });
  return parseArtifacts(persisted.artifacts_json, artifacts.generation_id, persisted.artifact_digest);
}

function readArtifacts(
  repo: FieldProjectionGenerationRepo,
  workspaceId: string,
  generationId: string
): ProjectionGenerationArtifacts | null {
  const row = repo.readArtifacts(workspaceId, generationId);
  return row === null ? null : parseArtifacts(
    row.artifacts_json,
    generationId,
    row.artifact_digest
  );
}

function parseArtifacts(
  json: string,
  generationId: string,
  digest: string
): ProjectionGenerationArtifacts {
  return parseProjectionGenerationArtifacts(JSON.parse(json), generationId, digest);
}

function requireGeneration(
  repo: FieldProjectionGenerationRepo,
  workspaceId: string,
  generationId: string
): FieldProjectionGeneration {
  const row = repo.readPinned(workspaceId, generationId);
  if (row === null) throw new Error("projection generation is missing");
  return generationFromRow(row);
}
