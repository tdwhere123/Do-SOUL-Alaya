import {
  getPathAnchorBackingObjectId,
  isPathActiveForRecall,
  serializePathAnchorRef,
  type PathAnchorRef,
  type PathRelation
} from "@do-soul/alaya-protocol";
import { normalizeRecallTimeConcernWindowDigest } from "./garden-compute-support.js";

export type RecallPathProjectionReadOptions = Readonly<{
  readonly asOf?: string;
}>;

export type RecallTemporalProjectionEnsurer = (
  options?: RecallPathProjectionReadOptions
) => Promise<void>;

export function createRecallTemporalProjectionEnsurer(input: Readonly<{
  verifyAndRebuild(asOf?: string): Promise<Readonly<{
    readonly projectionGeneration: string;
    readonly nextProjectionRefreshAt: string | null;
  }>>;
  readActiveProjectionGeneration?(): string | null | undefined;
  readonly clock?: () => number;
}>): RecallTemporalProjectionEnsurer {
  const state: CurrentProjectionEnsureState = {
    pending: false,
    nextRefreshAtMs: null
  };
  const now = input.clock ?? Date.now;
  return async (options: RecallPathProjectionReadOptions = {}) => {
    if (options.asOf !== undefined) {
      await input.verifyAndRebuild(options.asOf);
      return;
    }
    const activeGeneration = input.readActiveProjectionGeneration?.();
    if (shouldRefreshCurrentProjection(state, now(), activeGeneration)) {
      state.pending = true;
      state.promise = Promise.resolve()
        .then(async () => {
          const result = await input.verifyAndRebuild();
          state.projectionGeneration = result.projectionGeneration;
          state.nextRefreshAtMs = parseProjectionRefreshAt(result.nextProjectionRefreshAt);
        })
        .catch((error: unknown) => {
          state.promise = undefined;
          throw error;
        })
        .finally(() => {
          state.pending = false;
        });
    }
    await state.promise;
  };
}

type CurrentProjectionEnsureState = {
  promise?: Promise<void>;
  pending: boolean;
  projectionGeneration?: string;
  nextRefreshAtMs: number | null;
};

function shouldRefreshCurrentProjection(
  state: Readonly<CurrentProjectionEnsureState>,
  nowMs: number,
  activeGeneration: string | null | undefined
): boolean {
  if (state.promise === undefined) return true;
  if (activeGeneration === undefined) return !state.pending;
  if (activeGeneration !== state.projectionGeneration) return !state.pending;
  return !state.pending && state.nextRefreshAtMs !== null && nowMs >= state.nextRefreshAtMs;
}

function parseProjectionRefreshAt(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error("Relation assertion projection returned an invalid refresh boundary.");
  }
  return parsed;
}

export interface LegacyRecallPathReader {
  findByAnchors(
    workspaceId: string,
    anchorRefs: readonly PathAnchorRef[]
  ): Promise<readonly Readonly<PathRelation>[]>;
  findByWorkspaceAll(workspaceId: string): Promise<readonly Readonly<PathRelation>[]>;
  findActiveAll(workspaceId: string): Promise<readonly Readonly<PathRelation>[]>;
}

export interface TemporalRecallPathProjectionReader {
  findByWorkspace(
    workspaceId: string,
    options?: RecallPathProjectionReadOptions
  ): Promise<readonly Readonly<PathRelation>[]>;
  findByAnchors(
    workspaceId: string,
    anchorRefs: readonly PathAnchorRef[],
    options?: RecallPathProjectionReadOptions
  ): Promise<readonly Readonly<PathRelation>[]>;
  findByTimeConcernWindowDigests(
    workspaceId: string,
    windowDigests: readonly string[],
    options?: RecallPathProjectionReadOptions
  ): Promise<readonly Readonly<PathRelation>[]>;
}

export interface TemporalGraphExplorePathReader {
  findByAnchors(
    workspaceId: string,
    anchorRefs: readonly PathAnchorRef[]
  ): Promise<readonly Readonly<PathRelation>[]>;
  findByTargetAnchor(
    workspaceId: string,
    anchorRef: PathAnchorRef
  ): Promise<readonly Readonly<PathRelation>[]>;
  findByBackingObjectId(
    workspaceId: string,
    objectId: string
  ): Promise<readonly Readonly<PathRelation>[]>;
  findByBackingObjectIds(
    workspaceId: string,
    objectIds: readonly string[]
  ): Promise<readonly Readonly<PathRelation>[]>;
}

export interface RecallPathReadPorts {
  readonly pathExpansionPort: {
    findByAnchors(
      workspaceId: string,
      anchorRefs: readonly PathAnchorRef[],
      options?: RecallPathProjectionReadOptions
    ): Promise<readonly Readonly<PathRelation>[]>;
    findByTimeConcernWindowDigests(
      workspaceId: string,
      windowDigests: readonly string[],
      options?: RecallPathProjectionReadOptions
    ): Promise<readonly Readonly<PathRelation>[]>;
  };
  readonly pathPlasticityPort: {
    getStrengthByMemoryId(
      workspaceId: string,
      memoryIds: readonly string[],
      options?: RecallPathProjectionReadOptions
    ): Promise<ReadonlyMap<string, number>>;
  };
  findActiveByWorkspace(
    workspaceId: string,
    options?: RecallPathProjectionReadOptions
  ): Promise<readonly Readonly<PathRelation>[]>;
  readonly ensureTemporalProjection: RecallTemporalProjectionEnsurer;
}

type SelectedPathReader = Readonly<{
  readonly kind: "selected";
  readonly reader: TemporalRecallPathProjectionReader;
  readonly ensureTemporalProjection: RecallTemporalProjectionEnsurer;
}>;

type LegacyPathReader = Readonly<{
  readonly kind: "legacy";
  readonly reader: LegacyRecallPathReader;
}>;

type PathReaderMode = SelectedPathReader | LegacyPathReader;

export function createRecallPathReadPorts(input: {
  readonly temporalProjectionSelected?: boolean;
  readonly legacyPathReader?: LegacyRecallPathReader;
  readonly temporalPathProjectionReader?: TemporalRecallPathProjectionReader;
  readonly ensureTemporalProjection?: RecallTemporalProjectionEnsurer;
}): RecallPathReadPorts {
  const mode = selectPathReader(input);
  const findByAnchors = async (
    workspaceId: string,
    anchorRefs: readonly PathAnchorRef[],
    options: RecallPathProjectionReadOptions = {}
  ): Promise<readonly Readonly<PathRelation>[]> => {
    if (mode.kind === "selected") {
      await mode.ensureTemporalProjection(options);
      return await mode.reader.findByAnchors(workspaceId, anchorRefs, options);
    }
    return await mode.reader.findByAnchors(workspaceId, anchorRefs);
  };
  const findByTimeConcernWindowDigests = async (
    workspaceId: string,
    windowDigests: readonly string[],
    options: RecallPathProjectionReadOptions = {}
  ): Promise<readonly Readonly<PathRelation>[]> => {
    const normalizedWindowDigests = windowDigests.map(normalizeRecallTimeConcernWindowDigest);
    if (mode.kind === "selected") {
      await mode.ensureTemporalProjection(options);
      const paths = await mode.reader.findByTimeConcernWindowDigests(
        workspaceId,
        normalizedWindowDigests,
        options
      );
      return paths.filter((path) => isPathActiveForRecall(path.lifecycle.status));
    }
    const normalized = new Set(normalizedWindowDigests);
    const paths = await mode.reader.findByWorkspaceAll(workspaceId);
    return paths.filter((path) =>
      isPathActiveForRecall(path.lifecycle.status) &&
      [path.anchors.source_anchor, path.anchors.target_anchor].some((anchor) =>
        anchor.kind === "time_concern" &&
        normalized.has(normalizeRecallTimeConcernWindowDigest(anchor.window_digest))
      )
    );
  };
  const findActiveByWorkspace = async (
    workspaceId: string,
    options: RecallPathProjectionReadOptions = {}
  ): Promise<readonly Readonly<PathRelation>[]> => {
    if (mode.kind === "selected") {
      await mode.ensureTemporalProjection(options);
      const paths = await mode.reader.findByWorkspace(workspaceId, options);
      return paths.filter((path) => isPathActiveForRecall(path.lifecycle.status));
    }
    return await mode.reader.findActiveAll(workspaceId);
  };
  return Object.freeze({
    pathExpansionPort: Object.freeze({
      findByAnchors,
      findByTimeConcernWindowDigests
    }),
    pathPlasticityPort: Object.freeze({
      getStrengthByMemoryId: async (
        workspaceId: string,
        memoryIds: readonly string[],
        options: RecallPathProjectionReadOptions = {}
      ): Promise<ReadonlyMap<string, number>> =>
        await findPathPlasticityStrengths({ workspaceId, memoryIds, options, findByAnchors })
    }),
    findActiveByWorkspace,
    ensureTemporalProjection:
      mode.kind === "selected" ? mode.ensureTemporalProjection : async () => undefined
  });
}

export function createTemporalGraphExplorePathReader(
  reader: TemporalRecallPathProjectionReader,
  ensureTemporalProjection: RecallTemporalProjectionEnsurer,
  options: RecallPathProjectionReadOptions = {}
): TemporalGraphExplorePathReader {
  return Object.freeze({
    findByAnchors: async (
      workspaceId: string,
      anchorRefs: readonly PathAnchorRef[]
    ) => {
      await ensureTemporalProjection(options);
      return await reader.findByAnchors(workspaceId, anchorRefs, options);
    },
    findByTargetAnchor: async (workspaceId: string, anchorRef: PathAnchorRef) => {
      await ensureTemporalProjection(options);
      const anchorKey = serializePathAnchorRef(anchorRef);
      const paths = await reader.findByAnchors(workspaceId, [anchorRef], options);
      return paths.filter((path) =>
        serializePathAnchorRef(path.anchors.target_anchor) === anchorKey
      );
    },
    findByBackingObjectId: async (workspaceId: string, objectId: string) => {
      await ensureTemporalProjection(options);
      return await findTemporalPathsByBackingObjectIds(reader, workspaceId, new Set([objectId]), options);
    },
    findByBackingObjectIds: async (workspaceId: string, objectIds: readonly string[]) => {
      await ensureTemporalProjection(options);
      return await findTemporalPathsByBackingObjectIds(reader, workspaceId, new Set(objectIds), options);
    }
  });
}

function selectPathReader(input: {
  readonly temporalProjectionSelected?: boolean;
  readonly legacyPathReader?: LegacyRecallPathReader;
  readonly temporalPathProjectionReader?: TemporalRecallPathProjectionReader;
  readonly ensureTemporalProjection?: RecallTemporalProjectionEnsurer;
}): PathReaderMode {
  if (input.temporalProjectionSelected === true) {
    if (input.temporalPathProjectionReader === undefined) {
      throw new Error("selected temporal projection requires a temporal path reader");
    }
    if (input.ensureTemporalProjection === undefined) {
      throw new Error("selected temporal projection requires an assertion projection ensurer");
    }
    return Object.freeze({
      kind: "selected",
      reader: input.temporalPathProjectionReader,
      ensureTemporalProjection: input.ensureTemporalProjection
    });
  }
  if (input.legacyPathReader === undefined) {
    throw new Error("legacy recall requires a legacy path reader");
  }
  return Object.freeze({ kind: "legacy", reader: input.legacyPathReader });
}

async function findPathPlasticityStrengths(input: {
  readonly workspaceId: string;
  readonly memoryIds: readonly string[];
  readonly options: RecallPathProjectionReadOptions;
  readonly findByAnchors: (
    workspaceId: string,
    anchorRefs: readonly PathAnchorRef[],
    options?: RecallPathProjectionReadOptions
  ) => Promise<readonly Readonly<PathRelation>[]>;
}): Promise<ReadonlyMap<string, number>> {
  const result = new Map<string, number>();
  const uniqueMemoryIds = [...new Set(input.memoryIds)];
  if (uniqueMemoryIds.length === 0) {
    return result;
  }
  const requestedMemoryIds = new Set(uniqueMemoryIds);
  const paths = await input.findByAnchors(
    input.workspaceId,
    uniqueMemoryIds.map((objectId) => ({ kind: "object", object_id: objectId })),
    input.options
  );
  for (const path of paths) {
    if (!isPathActiveForRecall(path.lifecycle.status)) {
      continue;
    }
    for (const memoryId of getDirectionEligibleObjectAnchorMemoryIds(path, requestedMemoryIds)) {
      const strongest = result.get(memoryId) ?? 0;
      if (path.plasticity_state.strength > strongest) {
        result.set(memoryId, path.plasticity_state.strength);
      }
    }
  }
  return result;
}

function getDirectionEligibleObjectAnchorMemoryIds(
  path: Readonly<PathRelation>,
  requestedMemoryIds: ReadonlySet<string>
): readonly string[] {
  const memoryIds = new Set<string>();
  const sourceAnchor = path.anchors.source_anchor;
  const targetAnchor = path.anchors.target_anchor;
  if (
    (path.plasticity_state.direction_bias === "target_to_source" ||
      path.plasticity_state.direction_bias === "bidirectional_asymmetric") &&
    sourceAnchor.kind === "object" &&
    requestedMemoryIds.has(sourceAnchor.object_id)
  ) {
    memoryIds.add(sourceAnchor.object_id);
  }
  if (
    (path.plasticity_state.direction_bias === "source_to_target" ||
      path.plasticity_state.direction_bias === "bidirectional_asymmetric") &&
    targetAnchor.kind === "object" &&
    requestedMemoryIds.has(targetAnchor.object_id)
  ) {
    memoryIds.add(targetAnchor.object_id);
  }
  return [...memoryIds];
}

async function findTemporalPathsByBackingObjectIds(
  reader: TemporalRecallPathProjectionReader,
  workspaceId: string,
  objectIds: ReadonlySet<string>,
  options: RecallPathProjectionReadOptions
): Promise<readonly Readonly<PathRelation>[]> {
  if (objectIds.size === 0) {
    return Object.freeze([]);
  }
  const paths = await reader.findByWorkspace(workspaceId, options);
  return paths.filter((path) =>
    objectIds.has(getPathAnchorBackingObjectId(path.anchors.source_anchor)) ||
    objectIds.has(getPathAnchorBackingObjectId(path.anchors.target_anchor))
  );
}
