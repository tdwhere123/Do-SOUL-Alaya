import type { SelectedSliceKeyV2 } from "../../../flood/slice-key-contract.js";
import type {
  L2MaterializationPolicy,
  ProjectionL2Bundle
} from "../../../flood/slice-key-l2-bundles.js";
import { digestRecallFieldIdentity } from "../../field-identity.js";
import { compareText } from "../../../../shared/compare-text.js";
import type { ProjectionL1Posting } from "./l1-postings.js";
import type { SourceProjectionState } from "./source-projection.js";

export const INTERNED_SOURCE_STATE_ARTIFACTS_FORMAT = "interned_source_state_v1" as const;

export type InternedProjectionSliceKey = SelectedSliceKeyV2 & Readonly<{
  readonly source_state_id?: string;
}>;

export type InternedProjectionGenerationArtifacts = Readonly<{
  readonly artifacts_format: typeof INTERNED_SOURCE_STATE_ARTIFACTS_FORMAT;
  readonly generation_id: string;
  readonly postings: readonly ProjectionL1Posting[];
  readonly bundles: readonly ProjectionL2Bundle[];
  readonly policy: L2MaterializationPolicy;
  readonly source_states: Readonly<Record<string, SourceProjectionState>>;
  readonly slice_keys: readonly InternedProjectionSliceKey[];
}>;

export type RehydratedProjectionGenerationArtifacts = Readonly<{
  readonly generation_id: string;
  readonly postings: readonly ProjectionL1Posting[];
  readonly bundles: readonly ProjectionL2Bundle[];
  readonly slice_keys: readonly SelectedSliceKeyV2[];
  readonly policy: L2MaterializationPolicy;
}>;

type ArtifactsGraph = Record<string, unknown> & Readonly<{
  readonly generation_id: string;
  readonly postings: readonly unknown[];
  readonly bundles: readonly unknown[];
  readonly slice_keys: readonly unknown[];
  readonly policy: Record<string, unknown>;
}>;

export function internProjectionGenerationArtifacts(
  input: unknown
): InternedProjectionGenerationArtifacts {
  const graph = requireArtifactsGraph(input);
  return graph.artifacts_format === INTERNED_SOURCE_STATE_ARTIFACTS_FORMAT
    ? internAlreadyInterned(graph)
    : internExpanded(graph);
}

export function rehydrateProjectionGenerationArtifacts(
  interned: InternedProjectionGenerationArtifacts
): RehydratedProjectionGenerationArtifacts {
  return Object.freeze({
    generation_id: interned.generation_id,
    postings: interned.postings,
    bundles: interned.bundles,
    slice_keys: Object.freeze(interned.slice_keys.map((key) =>
      rehydrateSliceKey(key, interned.source_states)
    )),
    policy: interned.policy
  });
}

function internExpanded(graph: ArtifactsGraph): InternedProjectionGenerationArtifacts {
  const collected = new Map<string, SourceProjectionState>();
  const slice_keys = graph.slice_keys.map((key) => internExpandedSliceKey(key, collected));
  return freezeInterned(graph, sortedSourceStates(collected), slice_keys);
}

function internAlreadyInterned(graph: ArtifactsGraph): InternedProjectionGenerationArtifacts {
  if (!isRecord(graph.source_states)) invalidArtifacts();
  const collected = new Map<string, SourceProjectionState>();
  const sourceStates = graph.source_states;
  const slice_keys = graph.slice_keys.map((key) =>
    internInternedSliceKey(key, sourceStates, collected)
  );
  return freezeInterned(graph, sortedSourceStates(collected), slice_keys);
}

function internExpandedSliceKey(
  key: unknown,
  collected: Map<string, SourceProjectionState>
): InternedProjectionSliceKey {
  const record = requireRecord(key);
  const rest = omitStateFields(record);
  const sourceState = readSourceState(record);
  if (sourceState === undefined) {
    return freezeInternedSliceKey(rest);
  }
  const id = digestRecallFieldIdentity(sourceState);
  if (!collected.has(id)) collected.set(id, Object.freeze(sourceState));
  return freezeInternedSliceKey({ ...rest, source_state_id: id });
}

function internInternedSliceKey(
  key: unknown,
  sourceStates: Record<string, unknown>,
  collected: Map<string, SourceProjectionState>
): InternedProjectionSliceKey {
  const record = requireRecord(key);
  const rest = omitStateFields(record);
  const id = record.source_state_id;
  if (typeof id !== "string") return freezeInternedSliceKey(rest);
  const state = sourceStates[id];
  if (!isRecord(state)) invalidArtifacts();
  if (!collected.has(id)) collected.set(id, Object.freeze(state) as SourceProjectionState);
  return freezeInternedSliceKey({ ...rest, source_state_id: id });
}

function rehydrateSliceKey(
  key: InternedProjectionSliceKey,
  states: Readonly<Record<string, SourceProjectionState>>
): SelectedSliceKeyV2 {
  const id = key.source_state_id;
  if (typeof id !== "string") return Object.freeze({ ...key });
  const source_state = states[id];
  if (source_state === undefined) invalidArtifacts();
  const { source_state_id: _sourceStateId, ...rest } = key;
  return Object.freeze({ ...rest, source_state });
}

function freezeInterned(
  graph: ArtifactsGraph,
  source_states: Readonly<Record<string, SourceProjectionState>>,
  slice_keys: readonly InternedProjectionSliceKey[]
): InternedProjectionGenerationArtifacts {
  return Object.freeze({
    artifacts_format: INTERNED_SOURCE_STATE_ARTIFACTS_FORMAT,
    generation_id: graph.generation_id,
    postings: Object.freeze([...graph.postings]) as readonly ProjectionL1Posting[],
    bundles: Object.freeze([...graph.bundles]) as readonly ProjectionL2Bundle[],
    policy: Object.freeze({ ...graph.policy }) as L2MaterializationPolicy,
    source_states,
    slice_keys: Object.freeze([...slice_keys])
  });
}

function sortedSourceStates(
  collected: Map<string, SourceProjectionState>
): Readonly<Record<string, SourceProjectionState>> {
  // JSON.stringify keeps insertion order; digest sorts separately via stableStringify.
  return Object.freeze(Object.fromEntries(
    [...collected.entries()].sort(([left], [right]) => compareText(left, right))
  ));
}

function requireArtifactsGraph(input: unknown): ArtifactsGraph {
  if (
    !isRecord(input) ||
    typeof input.generation_id !== "string" ||
    !Array.isArray(input.postings) ||
    !Array.isArray(input.bundles) ||
    !Array.isArray(input.slice_keys) ||
    !isRecord(input.policy)
  ) {
    invalidArtifacts();
  }
  return input as ArtifactsGraph;
}

function freezeInternedSliceKey(
  record: Record<string, unknown>
): InternedProjectionSliceKey {
  if (typeof record.key_id !== "string" || typeof record.schema_version !== "number") {
    invalidArtifacts();
  }
  return Object.freeze({ ...record }) as unknown as InternedProjectionSliceKey;
}

function omitStateFields(key: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...key };
  delete rest.source_state;
  delete rest.source_state_id;
  return rest;
}

function readSourceState(key: Record<string, unknown>): SourceProjectionState | undefined {
  const value = key.source_state;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as SourceProjectionState;
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) invalidArtifacts();
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidArtifacts(): never {
  throw new Error("persisted projection generation artifacts are invalid");
}
