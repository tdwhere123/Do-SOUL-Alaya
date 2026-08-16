import type {
  FieldContractSha256,
  FieldProjectionGeneration,
  ProjectionEraseBarrier,
  ProjectionGenerationPointer,
  ProjectionPin
} from "@do-soul/alaya-protocol";

import type { SelectedSliceKeyV2 } from "../../../flood/slice-key-contract.js";
import { materializeSliceKeyL1Postings } from "../../../flood/slice-key-l1-postings.js";
import {
  assertProjectionBundleLevelDag,
  materializeSliceKeyL2Bundles,
  type L2MaterializationPolicy,
  type PlantedBundleFrontier,
  type ProjectionL2Bundle
} from "../../../flood/slice-key-l2-bundles.js";
import type { RecallFiniteFieldChannelCapture } from "../../finite-field-capture.js";
import {
  createProjectionGenerationArtifacts,
  digestProjectionArtifacts,
  type ProjectionGenerationArtifacts
} from "./generation-artifacts.js";
import { createProjectionGenerationReceipt } from "./generation-identity.js";
import type {
  InMemoryProjectionGenerationStore,
  ProjectionGenerationLifecycleStore
} from "./generation-store.js";
import {
  assertSingleGeneration,
  materializeRetrievalL1Postings,
  mergeProjectionL1Postings,
  type ProjectionL1Posting
} from "./l1-postings.js";

export type ProjectionCatchUpEvent = Readonly<
  | { readonly kind: "slice_key"; readonly key: SelectedSliceKeyV2 }
  | { readonly kind: "erase"; readonly barrier: ProjectionEraseBarrier }
>;

export type BuiltProjectionGeneration = Readonly<{
  readonly generation: FieldProjectionGeneration;
  readonly postings: readonly ProjectionL1Posting[];
  readonly bundles: readonly ProjectionL2Bundle[];
}>;

export type ProjectionBuildRequest = Readonly<{
  readonly store: ProjectionGenerationLifecycleStore;
  readonly sha256: FieldContractSha256;
  readonly workspace_id: string;
  readonly input_event_frontier: string;
  readonly governance_frontier: string;
  readonly recorded_at: string;
  readonly sliceKeys: readonly SelectedSliceKeyV2[];
  readonly captures?: readonly Readonly<RecallFiniteFieldChannelCapture>[];
  readonly l2Policy?: L2MaterializationPolicy;
  readonly plantedFrontiers?: readonly PlantedBundleFrontier[];
}>;

export function buildProjectionGeneration(
  request: ProjectionBuildRequest
): BuiltProjectionGeneration {
  const generation = createProjectionGenerationReceipt({
    workspace_id: request.workspace_id,
    input_event_frontier: request.input_event_frontier,
    governance_frontier: request.governance_frontier,
    status: "shadow",
    recorded_at: request.recorded_at
  }, request.sha256);
  return persistBuilt(request, generation, request.sliceKeys);
}

export function catchUpProjectionGeneration(params: Omit<ProjectionBuildRequest, "store"> & Readonly<{
  readonly store: InMemoryProjectionGenerationStore;
  readonly source_generation_id: string;
  readonly events: readonly ProjectionCatchUpEvent[];
}>): BuiltProjectionGeneration {
  const source = requireArtifacts(params.store, params.workspace_id, params.source_generation_id);
  const keys = [
    ...source.slice_keys,
    ...params.events.flatMap((event) => event.kind === "slice_key" ? [event.key] : [])
  ];
  const generation = createProjectionGenerationReceipt({
    workspace_id: params.workspace_id,
    input_event_frontier: params.input_event_frontier,
    governance_frontier: params.governance_frontier,
    status: "shadow",
    recorded_at: params.recorded_at
  }, params.sha256);
  const built = persistBuilt({ ...params, l2Policy: params.l2Policy ?? source.policy }, generation, keys);
  applyCatchUpErases(params.store, params.events);
  return built;
}

export function verifyProjectionGeneration(
  store: ProjectionGenerationLifecycleStore,
  generation: FieldProjectionGeneration,
  _sha256: FieldContractSha256
): BuiltProjectionGeneration {
  const artifacts = requireArtifacts(store, generation.workspace_id, generation.generation_id);
  if (digestProjectionArtifacts(artifacts.postings, artifacts.bundles) !==
      artifacts.artifact_digest) {
    throw new Error("projection generation artifact digest mismatch");
  }
  assertSingleGeneration(artifacts.postings);
  assertProjectionBundleLevelDag(artifacts.bundles);
  return toBuilt(store.verify(generation), artifacts);
}

export function activateProjectionGeneration(
  store: ProjectionGenerationLifecycleStore,
  pointer: ProjectionGenerationPointer
): ProjectionGenerationPointer {
  return store.activatePointer(pointer);
}

export function pinProjectionReader(
  store: InMemoryProjectionGenerationStore,
  pin: ProjectionPin
): PinnedProjectionReader {
  store.pin(pin);
  return Object.freeze({
    workspace_id: pin.workspace_id,
    generation_id: pin.generation_id,
    readGeneration: () => requireGeneration(store, pin.workspace_id, pin.generation_id),
    readPostings: () => requireArtifacts(store, pin.workspace_id, pin.generation_id).postings,
    readBundles: () => requireArtifacts(store, pin.workspace_id, pin.generation_id).bundles
  });
}

export type PinnedProjectionReader = Readonly<{
  readonly workspace_id: string;
  readonly generation_id: string;
  readonly readGeneration: () => FieldProjectionGeneration;
  readonly readPostings: () => readonly ProjectionL1Posting[];
  readonly readBundles: () => readonly ProjectionL2Bundle[];
}>;

function persistBuilt(
  request: ProjectionBuildRequest,
  generation: FieldProjectionGeneration,
  sliceKeys: readonly SelectedSliceKeyV2[]
): BuiltProjectionGeneration {
  const artifacts = materializeArtifacts(request, generation, sliceKeys);
  request.store.snapshot(generation);
  request.store.putArtifacts(request.workspace_id, artifacts);
  return toBuilt(generation, artifacts);
}

function materializeArtifacts(
  request: ProjectionBuildRequest,
  generation: FieldProjectionGeneration,
  sliceKeys: readonly SelectedSliceKeyV2[]
): ProjectionGenerationArtifacts {
  const policy = request.l2Policy ?? defaultPolicy();
  const postings = mergeProjectionL1Postings(
    materializeSliceKeyL1Postings(generation.generation_id, sliceKeys, request.sha256),
    materializeRetrievalL1Postings(generation.generation_id, request.captures ?? [], request.sha256)
  );
  const bundles = materializeSliceKeyL2Bundles({
    generationId: generation.generation_id,
    postings,
    sha256: request.sha256,
    policy,
    scope: request.workspace_id,
    plantedFrontiers: request.plantedFrontiers
  });
  return createProjectionGenerationArtifacts({
    generation_id: generation.generation_id,
    postings,
    bundles,
    slice_keys: sliceKeys,
    policy
  });
}

function applyCatchUpErases(
  store: InMemoryProjectionGenerationStore,
  events: readonly ProjectionCatchUpEvent[]
): void {
  for (const event of events) {
    if (event.kind === "erase") store.erase(event.barrier);
  }
}

function requireArtifacts(
  store: ProjectionGenerationLifecycleStore,
  workspaceId: string,
  generationId: string
): ProjectionGenerationArtifacts {
  const artifacts = store.readArtifacts(workspaceId, generationId);
  if (artifacts === null) throw new Error("projection generation artifacts are missing");
  return artifacts;
}

function requireGeneration(
  store: InMemoryProjectionGenerationStore,
  workspaceId: string,
  generationId: string
): FieldProjectionGeneration {
  const generation = store.readPinned(workspaceId, generationId);
  if (generation === null) throw new Error("projection generation is missing");
  return generation;
}

function toBuilt(
  generation: FieldProjectionGeneration,
  artifacts: ProjectionGenerationArtifacts
): BuiltProjectionGeneration {
  return Object.freeze({
    generation,
    postings: artifacts.postings,
    bundles: artifacts.bundles
  });
}

function defaultPolicy(): L2MaterializationPolicy {
  return Object.freeze({
    materialize: true,
    maxLevel: 2,
    maxMembers: 32,
    minMembers: 1
  });
}
