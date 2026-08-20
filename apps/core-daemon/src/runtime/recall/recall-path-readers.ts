import {
  isPathActiveForRecall,
  timeConcernWindowDigestsMatch,
  type PathAnchorRef,
  type PathRelation
} from "@do-soul/alaya-protocol";
import { normalizeRecallTimeConcernWindowDigest } from "../garden-wiring/garden-compute-support.js";
import { mergePathRelationsByIdentity } from "./path-relation-identity-merge.js";

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

export interface SoftAssociationRecallPathReader {
  findByAnchors(
    workspaceId: string,
    anchorRefs: readonly PathAnchorRef[],
    options?: RecallPathProjectionReadOptions
  ): Promise<readonly Readonly<PathRelation>[]>;
  findActiveByWorkspace(
    workspaceId: string,
    options?: RecallPathProjectionReadOptions
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
  readonly softAssociationReader?: SoftAssociationRecallPathReader;
  readonly ensureTemporalProjection: RecallTemporalProjectionEnsurer;
}>;

type LegacyPathReader = Readonly<{
  readonly kind: "legacy";
  readonly reader: LegacyRecallPathReader;
  readonly softAssociationReader?: SoftAssociationRecallPathReader;
}>;

type PathReaderMode = SelectedPathReader | LegacyPathReader;
type FindByAnchors = RecallPathReadPorts["pathExpansionPort"]["findByAnchors"];
type FindByTimeConcernWindowDigests =
  RecallPathReadPorts["pathExpansionPort"]["findByTimeConcernWindowDigests"];
type FindActiveByWorkspace = RecallPathReadPorts["findActiveByWorkspace"];
const projectionAlreadyPrepared: RecallTemporalProjectionEnsurer = async () => undefined;

export function createRecallPathReadPorts(input: {
  readonly temporalProjectionSelected?: boolean;
  readonly legacyPathReader?: LegacyRecallPathReader;
  readonly softAssociationPathReader?: SoftAssociationRecallPathReader;
  readonly temporalPathProjectionReader?: TemporalRecallPathProjectionReader;
  readonly ensureTemporalProjection?: RecallTemporalProjectionEnsurer;
}): RecallPathReadPorts {
  const mode = selectPathReader(input);
  return mode.kind === "selected"
    ? createSelectedRecallPathReadPorts(mode)
    : createLegacyRecallPathReadPorts(mode);
}

function createSelectedRecallPathReadPorts(mode: SelectedPathReader): RecallPathReadPorts {
  const findByAnchors: FindByAnchors = async (
    workspaceId: string,
    anchorRefs: readonly PathAnchorRef[],
    options: RecallPathProjectionReadOptions = {}
  ) => {
    await mode.ensureTemporalProjection(options);
    const temporal = await mode.reader.findByAnchors(workspaceId, anchorRefs, options);
    if (mode.softAssociationReader === undefined) return temporal;
    const associative = await mode.softAssociationReader.findByAnchors(
      workspaceId,
      anchorRefs,
      options
    );
    return mergePathRelationsByIdentity(temporal, eligibleAssociativePaths(associative, options));
  };
  const findByTimeConcernWindowDigests: FindByTimeConcernWindowDigests = async (
    workspaceId: string,
    windowDigests: readonly string[],
    options: RecallPathProjectionReadOptions = {}
  ) => {
    const normalizedWindowDigests = windowDigests.map(normalizeRecallTimeConcernWindowDigest);
    await mode.ensureTemporalProjection(options);
    const paths = await mode.reader.findByTimeConcernWindowDigests(
      workspaceId,
      normalizedWindowDigests,
      options
    );
    return paths.filter((path) => isPathActiveForRecall(path.lifecycle.status));
  };
  const findActiveByWorkspace: FindActiveByWorkspace = async (workspaceId, options = {}) => {
    await mode.ensureTemporalProjection(options);
    const paths = await mode.reader.findByWorkspace(workspaceId, options);
    const temporal = paths.filter((path) => isPathActiveForRecall(path.lifecycle.status));
    if (mode.softAssociationReader === undefined) return temporal;
    const associative = await mode.softAssociationReader.findActiveByWorkspace(
      workspaceId,
      options
    );
    return mergePathRelationsByIdentity(temporal, eligibleAssociativePaths(associative, options));
  };
  return buildRecallPathReadPorts({
    findByAnchors,
    findByTimeConcernWindowDigests,
    findActiveByWorkspace,
    ensureTemporalProjection: mode.ensureTemporalProjection
  });
}

function createLegacyRecallPathReadPorts(mode: LegacyPathReader): RecallPathReadPorts {
  const findByAnchors: FindByAnchors = async (workspaceId, anchorRefs, options = {}) => {
    const legacy = (await mode.reader.findByAnchors(workspaceId, anchorRefs))
      .filter((path) => isPathActiveForRecall(path.lifecycle.status));
    if (mode.softAssociationReader === undefined) return legacy;
    const associative = await mode.softAssociationReader.findByAnchors(
      workspaceId,
      anchorRefs,
      options
    );
    return mergePathRelationsByIdentity(legacy, eligibleAssociativePaths(associative, options));
  };
  const findByTimeConcernWindowDigests: FindByTimeConcernWindowDigests = async (
    workspaceId,
    windowDigests
  ) => {
    const normalizedWindowDigests = windowDigests.map(normalizeRecallTimeConcernWindowDigest);
    const paths = await mode.reader.findByWorkspaceAll(workspaceId);
    return paths.filter((path) =>
      isPathActiveForRecall(path.lifecycle.status) &&
      [path.anchors.source_anchor, path.anchors.target_anchor].some((anchor) =>
        anchor.kind === "time_concern" &&
        normalizedWindowDigests.some((digest) =>
          timeConcernWindowDigestsMatch(anchor.window_digest, digest))
      )
    );
  };
  const findActiveByWorkspace: FindActiveByWorkspace = async (workspaceId, options = {}) => {
    const legacy = await mode.reader.findActiveAll(workspaceId);
    if (mode.softAssociationReader === undefined) return legacy;
    const associative = await mode.softAssociationReader.findActiveByWorkspace(
      workspaceId,
      options
    );
    return mergePathRelationsByIdentity(legacy, eligibleAssociativePaths(associative, options));
  };
  return buildRecallPathReadPorts({
    findByAnchors,
    findByTimeConcernWindowDigests,
    findActiveByWorkspace,
    ensureTemporalProjection: projectionAlreadyPrepared
  });
}

function buildRecallPathReadPorts(input: Readonly<{
  readonly findByAnchors: FindByAnchors;
  readonly findByTimeConcernWindowDigests: FindByTimeConcernWindowDigests;
  readonly findActiveByWorkspace: FindActiveByWorkspace;
  readonly ensureTemporalProjection: RecallTemporalProjectionEnsurer;
}>): RecallPathReadPorts {
  return Object.freeze({
    pathExpansionPort: Object.freeze({
      findByAnchors: input.findByAnchors,
      findByTimeConcernWindowDigests: input.findByTimeConcernWindowDigests
    }),
    pathPlasticityPort: Object.freeze({
      getStrengthByMemoryId: async (
        workspaceId: string,
        memoryIds: readonly string[],
        options: RecallPathProjectionReadOptions = {}
      ): Promise<ReadonlyMap<string, number>> =>
        await findPathPlasticityStrengths({
          workspaceId,
          memoryIds,
          options,
          findByAnchors: input.findByAnchors
        })
    }),
    findActiveByWorkspace: input.findActiveByWorkspace,
    ensureTemporalProjection: input.ensureTemporalProjection
  });
}

export function createPreparedTemporalRecallPathReadPorts(
  temporalPathProjectionReader: TemporalRecallPathProjectionReader,
  softAssociationPathReader?: SoftAssociationRecallPathReader
): RecallPathReadPorts {
  // The daemon parent prepares the projection before dispatch, so a worker
  // connection stays query-only while reusing the canonical read transforms.
  return createSelectedRecallPathReadPorts({
    kind: "selected",
    reader: temporalPathProjectionReader,
    softAssociationReader: softAssociationPathReader,
    ensureTemporalProjection: projectionAlreadyPrepared
  });
}

function selectPathReader(input: {
  readonly temporalProjectionSelected?: boolean;
  readonly legacyPathReader?: LegacyRecallPathReader;
  readonly softAssociationPathReader?: SoftAssociationRecallPathReader;
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
      softAssociationReader: input.softAssociationPathReader,
      ensureTemporalProjection: input.ensureTemporalProjection
    });
  }
  if (input.legacyPathReader === undefined) {
    throw new Error("legacy recall requires a legacy path reader");
  }
  return Object.freeze({
    kind: "legacy",
    reader: input.legacyPathReader,
    softAssociationReader: input.softAssociationPathReader
  });
}

function eligibleAssociativePaths(
  paths: readonly Readonly<PathRelation>[],
  options: RecallPathProjectionReadOptions
): readonly Readonly<PathRelation>[] {
  const asOfMs = options.asOf === undefined ? Number.POSITIVE_INFINITY : Date.parse(options.asOf);
  return paths.filter((path) =>
    path.constitution.relation_kind === "co_recalled" &&
    path.anchors.source_anchor.kind === "object" &&
    path.anchors.target_anchor.kind === "object" &&
    path.effect_vector.recall_bias > 0 &&
    isPathActiveForRecall(path.lifecycle.status) &&
    path.legitimacy.governance_class === "attention_only" &&
    path.legitimacy.evidence_basis.length === 1 &&
    path.legitimacy.evidence_basis[0] === "recalls_edge_co_usage" &&
    Date.parse(path.created_at) <= asOfMs &&
    Date.parse(path.updated_at) <= asOfMs
  );
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
