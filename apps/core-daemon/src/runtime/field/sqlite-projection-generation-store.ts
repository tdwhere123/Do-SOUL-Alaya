import type {
  FieldProjectionGeneration,
  ProjectionGenerationPointer
} from "@do-soul/alaya-protocol";
import {
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
      persistArtifacts(repo, workspaceId, artifacts),
    readArtifacts: (workspaceId: string, generationId: string) =>
      readArtifacts(repo, workspaceId, generationId)
  });
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
    artifacts_json: JSON.stringify(artifacts),
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
