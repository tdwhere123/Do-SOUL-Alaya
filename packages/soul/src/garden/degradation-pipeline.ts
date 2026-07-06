import {
  ControlPlaneObjectKind,
  ObjectKind,
  type ContextLens,
  type ContextLensEntry,
  type LensAssemblerDegradationPort,
  type LensDegradationResult,
  type LensDegradationStepRecord,
  type ManifestationState,
  type ProjectionEntry,
  type WorkingProjection
} from "@do-soul/alaya-protocol";

export type DegradationStepKind =
  | "manifestation_downgrade_excerpt"
  | "manifestation_downgrade_hint"
  | "handoff_pointer_ify"
  | "synthesis_ref"
  | "preferred_claim_trim"
  | "soft_global_clean";

export interface DegradationAssessParams {
  readonly contextLens: Readonly<ContextLens>;
  readonly workingProjection: Readonly<WorkingProjection>;
  readonly budgetLimit: number;
  readonly runId: string;
  readonly workspaceId: string;
}

interface IndexedEntryState {
  readonly entry: ContextLensEntry;
  readonly projectionEntry: ProjectionEntry;
}

interface DegradationState {
  readonly entries: readonly IndexedEntryState[];
  readonly totalTokens: number;
  readonly stepsApplied: readonly LensDegradationStepRecord[];
  readonly droppedObjectIds: ReadonlySet<string>;
}

interface ManifestationStepParams {
  readonly kind: DegradationStepKind;
  readonly from: ManifestationState;
  readonly to: ManifestationState;
  readonly ratio: number;
}

interface DropStepParams {
  readonly kind: DegradationStepKind;
  readonly predicate: (entry: Readonly<ContextLensEntry>) => boolean;
}

const EXCERPT_RATIO = 0.35;
const HINT_RATIO = 0.1;

export const DEGRADATION_CONSTANTS = Object.freeze({
  EXCERPT_RATIO,
  HINT_RATIO
});

export class DegradationPipeline implements LensAssemblerDegradationPort {
  public assess(params: DegradationAssessParams): LensDegradationResult {
    const protectedObjectIds = collectProtectedObjectIds(params.contextLens.lens_entries);

    if (params.workingProjection.total_token_estimate <= params.budgetLimit) {
      return freezeResult({
        degraded: false,
        finalLens: params.contextLens,
        stepsApplied: [],
        tokensAfter: params.workingProjection.total_token_estimate,
        stillOverBudget: false,
        protectedObjectIds,
        droppedObjectIds: []
      });
    }

    let state = createDegradationState(params.contextLens, params.workingProjection);

    state = applyManifestationStep(state, {
      kind: "manifestation_downgrade_excerpt",
      from: "full_eligible",
      to: "excerpt",
      ratio: EXCERPT_RATIO
    });
    if (state.totalTokens <= params.budgetLimit) {
      return buildResult(params.contextLens, state, params.budgetLimit, protectedObjectIds);
    }

    state = applyManifestationStep(state, {
      kind: "manifestation_downgrade_hint",
      from: "excerpt",
      to: "hint",
      ratio: HINT_RATIO
    });
    if (state.totalTokens <= params.budgetLimit) {
      return buildResult(params.contextLens, state, params.budgetLimit, protectedObjectIds);
    }

    state = applyDropStep(state, {
      kind: "handoff_pointer_ify",
      predicate: (entry) =>
        entry.object_kind === ControlPlaneObjectKind.HANDOFF_RECORD ||
        entry.object_kind === ControlPlaneObjectKind.GAP_RECORD
    });
    if (state.totalTokens <= params.budgetLimit) {
      return buildResult(params.contextLens, state, params.budgetLimit, protectedObjectIds);
    }

    state = applyDropStep(state, {
      kind: "synthesis_ref",
      predicate: (entry) => entry.object_kind === ObjectKind.SYNTHESIS_CAPSULE
    });
    if (state.totalTokens <= params.budgetLimit) {
      return buildResult(params.contextLens, state, params.budgetLimit, protectedObjectIds);
    }

    state = applyDropStep(state, {
      kind: "preferred_claim_trim",
      predicate: (entry) =>
        entry.object_kind === ObjectKind.CLAIM_FORM &&
        entry.manifestation !== "full_eligible"
    });
    if (state.totalTokens <= params.budgetLimit) {
      return buildResult(params.contextLens, state, params.budgetLimit, protectedObjectIds);
    }

    state = applyDropStep(state, {
      kind: "soft_global_clean",
      predicate: (entry) => entry.scope_class === "global_domain" || entry.scope_class === "global_core"
    });

    return buildResult(params.contextLens, state, params.budgetLimit, protectedObjectIds);
  }
}

function createDegradationState(
  contextLens: Readonly<ContextLens>,
  workingProjection: Readonly<WorkingProjection>
): DegradationState {
  const pairedState = pairEntryState(contextLens, workingProjection);
  return {
    entries: Object.freeze(pairedState.entries),
    totalTokens: pairedState.totalTokens,
    stepsApplied: Object.freeze([]),
    droppedObjectIds: new Set<string>()
  };
}

function applyManifestationStep(
  state: Readonly<DegradationState>,
  params: ManifestationStepParams
): DegradationState {
  const affectedEntries = state.entries.filter(({ entry }) =>
    isEligibleForDegradation(entry, (candidate) => candidate.manifestation === params.from)
  );

  if (affectedEntries.length === 0) {
    return state;
  }

  const objectIdsAffected = affectedEntries.map(({ entry }) => entry.object_id);
  const tokensFreed = affectedEntries.reduce(
    (sum, indexed) =>
      sum +
      indexed.projectionEntry.token_estimate -
        downgradeTokenEstimate(indexed.projectionEntry.token_estimate, params.ratio),
    0
  );
  const nextEntries = state.entries.map((indexed) => {
    if (!isEligibleForDegradation(indexed.entry, (candidate) => candidate.manifestation === params.from)) {
      return indexed;
    }

    const nextTokenEstimate = downgradeTokenEstimate(indexed.projectionEntry.token_estimate, params.ratio);
    return {
      entry: Object.freeze({
        ...indexed.entry,
        manifestation: params.to
      }),
      projectionEntry: Object.freeze({
        ...indexed.projectionEntry,
        token_estimate: nextTokenEstimate
      })
    };
  });

  return appendStep(state, {
    entries: nextEntries,
    kind: params.kind,
    objectIdsAffected,
    tokensFreed
  });
}

function applyDropStep(
  state: Readonly<DegradationState>,
  params: DropStepParams
): DegradationState {
  const droppedEntries = state.entries.filter(({ entry }) => isEligibleForDegradation(entry, params.predicate));

  if (droppedEntries.length === 0) {
    return state;
  }

  const objectIdsAffected = droppedEntries.map(({ entry }) => entry.object_id);
  const tokensFreed = droppedEntries.reduce((sum, indexed) => sum + indexed.projectionEntry.token_estimate, 0);
  const nextEntries = state.entries.filter(({ entry }) => !isEligibleForDegradation(entry, params.predicate));
  const nextDroppedObjectIds = new Set([...state.droppedObjectIds, ...objectIdsAffected]);

  return appendStep(state, {
    entries: nextEntries,
    kind: params.kind,
    objectIdsAffected,
    tokensFreed,
    droppedObjectIds: nextDroppedObjectIds
  });
}

function appendStep(
  state: Readonly<DegradationState>,
  params: {
    readonly entries: readonly IndexedEntryState[];
    readonly kind: DegradationStepKind;
    readonly objectIdsAffected: readonly string[];
    readonly tokensFreed: number;
    readonly droppedObjectIds?: ReadonlySet<string>;
  }
): DegradationState {
  return {
    entries: Object.freeze([...params.entries]),
    totalTokens: state.totalTokens - params.tokensFreed,
    stepsApplied: Object.freeze([
      ...state.stepsApplied,
      freezeStep({
        kind: params.kind,
        object_ids_affected: params.objectIdsAffected,
        tokens_freed: params.tokensFreed
      })
    ]),
    droppedObjectIds: params.droppedObjectIds ?? state.droppedObjectIds
  };
}

function buildResult(
  contextLens: Readonly<ContextLens>,
  state: Readonly<DegradationState>,
  budgetLimit: number,
  protectedObjectIds: readonly string[]
): LensDegradationResult {
  const finalLens = Object.freeze({
    ...contextLens,
    lens_entries: Object.freeze(state.entries.map((indexed) => indexed.entry))
  });

  return freezeResult({
    degraded: state.stepsApplied.length > 0,
    finalLens,
    stepsApplied: state.stepsApplied,
    tokensAfter: state.totalTokens,
    stillOverBudget: state.totalTokens > budgetLimit,
    protectedObjectIds,
    droppedObjectIds: [...state.droppedObjectIds]
  });
}

function pairEntryState(
  contextLens: Readonly<ContextLens>,
  workingProjection: Readonly<WorkingProjection>
): { entries: IndexedEntryState[]; totalTokens: number } {
  if (contextLens.lens_entries.length !== workingProjection.entries.length) {
    throw new Error("ContextLens and WorkingProjection entries must align for degradation assessment");
  }

  const entries = contextLens.lens_entries.map((entry, index) => ({
    entry: Object.freeze({ ...entry }),
    projectionEntry: cloneProjectionEntry(readProjectionEntry(workingProjection.entries, index), entry, index)
  }));

  return {
    entries,
    totalTokens: workingProjection.total_token_estimate
  };
}

function readProjectionEntry(
  entries: Readonly<WorkingProjection>["entries"],
  index: number
): Readonly<WorkingProjection["entries"][number]> {
  const entry = entries[index];
  if (entry === undefined) {
    throw new Error("ContextLens and WorkingProjection entries must align for degradation assessment");
  }
  return entry;
}

function cloneProjectionEntry(
  projectionEntry: Readonly<ProjectionEntry>,
  lensEntry: Readonly<ContextLensEntry>,
  index: number
): ProjectionEntry {
  if (
    projectionEntry.object_id !== lensEntry.object_id ||
    projectionEntry.object_kind !== lensEntry.object_kind
  ) {
    throw new Error(`Projection entry mismatch at index ${index}`);
  }

  return Object.freeze({ ...projectionEntry });
}

function isEligibleForDegradation(
  entry: Readonly<ContextLensEntry>,
  predicate: (entry: Readonly<ContextLensEntry>) => boolean
): boolean {
  return !isProtectedLensEntry(entry) && predicate(entry);
}

function isProtectedLensEntry(entry: Readonly<ContextLensEntry>): boolean {
  if (
    entry.object_kind === ControlPlaneObjectKind.SESSION_OVERRIDE ||
    entry.object_kind === ControlPlaneObjectKind.TASK_OBJECT_SURFACE
  ) {
    return true;
  }

  if (entry.source_enforcement === "strict") {
    return true;
  }

  return (
    entry.object_kind === ObjectKind.CLAIM_FORM &&
    entry.relevance_score === 1 &&
    entry.manifestation === "full_eligible"
  );
}

function collectProtectedObjectIds(entries: readonly Readonly<ContextLensEntry>[]): readonly string[] {
  return Object.freeze(
    [...new Set(entries.filter((entry) => isProtectedLensEntry(entry)).map((entry) => entry.object_id))]
  );
}

function downgradeTokenEstimate(tokenEstimate: number, ratio: number): number {
  return Math.max(1, Math.ceil(tokenEstimate * ratio));
}

function freezeStep(step: {
  kind: string;
  object_ids_affected: readonly string[];
  tokens_freed: number;
}): LensDegradationStepRecord {
  return Object.freeze({
    kind: step.kind,
    object_ids_affected: Object.freeze([...step.object_ids_affected]),
    tokens_freed: step.tokens_freed
  });
}

function freezeResult(result: {
  degraded: boolean;
  finalLens: Readonly<ContextLens>;
  stepsApplied: readonly LensDegradationStepRecord[];
  tokensAfter: number;
  stillOverBudget: boolean;
  protectedObjectIds: readonly string[];
  droppedObjectIds: readonly string[];
}): LensDegradationResult {
  return Object.freeze({
    degraded: result.degraded,
    finalLens: result.finalLens,
    stepsApplied: Object.freeze([...result.stepsApplied]),
    tokensAfter: result.tokensAfter,
    stillOverBudget: result.stillOverBudget,
    protectedObjectIds: Object.freeze([...result.protectedObjectIds]),
    droppedObjectIds: Object.freeze([...result.droppedObjectIds])
  });
}
