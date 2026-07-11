import type { RecallCandidate, TaskObjectSurface } from "@do-soul/alaya-protocol";
import type { ManifestationBiasSidecarEntry } from "../../../manifestation/manifestation-resolver.js";
import { errorNameOf, toErrorMessage } from "../recall-service-helpers.js";
import type { RecallServiceDependencies, RecallServiceWarnPort } from "../recall-service-types.js";

type ManifestationBiasSidecarLoadParams = Readonly<{
  readonly sidecarPort: NonNullable<RecallServiceDependencies["manifestationSidecarPort"]>;
  readonly warn: RecallServiceWarnPort;
  readonly workspaceId: string;
  readonly runId: string;
  readonly taskSurfaceRef: Readonly<TaskObjectSurface>;
  readonly anchorMemoryObjectIds: readonly string[];
}>;

export function collectManifestationAnchorMemoryObjectIds(
  candidates: readonly Readonly<RecallCandidate>[]
): readonly string[] {
  return Object.freeze([...new Set(candidates.map((candidate) => candidate.object_id))]);
}

export async function loadManifestationBiasSidecar(
  params: ManifestationBiasSidecarLoadParams
): Promise<readonly Readonly<ManifestationBiasSidecarEntry>[] | null> {
  try {
    return await params.sidecarPort.buildBiasSidecar({
      workspaceId: params.workspaceId,
      runId: params.runId,
      anchorMemoryObjectIds: params.anchorMemoryObjectIds,
      taskSurfaceRef: params.taskSurfaceRef
    });
  } catch (error) {
    params.warn("manifestation bias sidecar build failed", {
      workspace_id: params.workspaceId,
      run_id: params.runId,
      operation: "manifestation_bias_sidecar_build",
      errorName: errorNameOf(error),
      error: toErrorMessage(error)
    });
    return null;
  }
}

export function collectManifestationBiasEntriesByMemoryId(
  sidecarEntries: readonly Readonly<ManifestationBiasSidecarEntry>[]
): ReadonlyMap<string, Readonly<ManifestationBiasSidecarEntry>> {
  const byMemoryId = new Map<string, Readonly<ManifestationBiasSidecarEntry>>();
  const sortedEntries = [...sidecarEntries].sort((left, right) => {
    if (right.unfinishedness_bias !== left.unfinishedness_bias) {
      return right.unfinishedness_bias - left.unfinishedness_bias;
    }
    return left.candidate_id.localeCompare(right.candidate_id);
  });

  for (const entry of sortedEntries) {
    if (entry.target_memory_object_id !== null && !byMemoryId.has(entry.target_memory_object_id)) {
      byMemoryId.set(entry.target_memory_object_id, entry);
    }
  }

  return byMemoryId;
}

export function applyManifestationBiasEntries(
  candidates: readonly Readonly<RecallCandidate>[],
  byMemoryId: ReadonlyMap<string, Readonly<ManifestationBiasSidecarEntry>>
): readonly Readonly<RecallCandidate>[] {
  return Object.freeze(
    candidates.map((candidate) => {
      const sidecar = byMemoryId.get(candidate.object_id);
      if (sidecar === undefined) {
        return candidate;
      }
      return Object.freeze({
        ...candidate,
        pending_incomplete: sidecar.pending_incomplete,
        unfinishedness_bias: sidecar.unfinishedness_bias
      });
    })
  );
}
