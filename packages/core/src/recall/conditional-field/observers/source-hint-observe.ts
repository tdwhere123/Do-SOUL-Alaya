import { sourceRecallTarget, type TypedObservation } from "@do-soul/alaya-protocol";
import {
  adoptedSourceProposal,
  sourceProposalPhrases,
  type AdoptedSourceProposal
} from "../query/query-source-proposal.js";
import { buildTypedObservation, sourceRootEligible } from "./observation-admission.js";
import {
  matchBoundInterpretation,
  parseBoundInterpretationGist,
  sourceTextContainsPhrases
} from "./source-proposal-match.js";
import {
  DEFAULT_SOURCE_BYTE_LIMIT,
  type ObserveConditionalFieldInput,
  type SourceRootObserverRow
} from "./observe-ports.js";

export type SourceHintLaneResult = Readonly<{
  readonly observations: readonly TypedObservation[];
  readonly rows: readonly SourceRootObserverRow[];
  readonly workUnits: number;
  readonly bytes: number;
  readonly truncated: boolean;
  readonly hintCommitted: string | null;
  readonly hintsDone: boolean;
  readonly hydrationUnavailable: boolean;
  readonly resourceLimited: boolean;
}>;

export function sourceHintSketch(
  input: ObserveConditionalFieldInput
): AdoptedSourceProposal | undefined {
  return adoptedSourceProposal(input.query);
}

export function takeSourceHintPage(
  input: ObserveConditionalFieldInput,
  sketch: AdoptedSourceProposal,
  limit: number,
  nativeLimit: number,
  afterCursor: string | null
): SourceHintLaneResult {
  if (nativeLimit <= 0 || limit <= 0) {
    return emptyHint(afterCursor, false, true);
  }
  try {
    return sketch.lookup_mode === "source_text"
      ? takeTextHintPage(input, sketch, limit, nativeLimit, afterCursor)
      : takeProposalHintPage(input, sketch, limit, nativeLimit, afterCursor);
  } catch {
    return emptyHint(afterCursor, true, false);
  }
}

function takeProposalHintPage(
  input: ObserveConditionalFieldInput,
  sketch: AdoptedSourceProposal,
  limit: number,
  nativeLimit: number,
  afterCursor: string | null
): SourceHintLaneResult {
  const reader = input.readers.boundInterpretations;
  if (reader === undefined) return emptyHint(afterCursor, true, false);
  const page = reader({
    workspaceId: input.workspace_id,
    limit,
    nativeLimit,
    afterCursor
  });
  if (page.unavailable === true) {
    return { ...emptyHint(afterCursor, false, true), hydrationUnavailable: true,
      resourceLimited: page.resourceLimited === true, workUnits: page.nativeVisits, bytes: page.bytesRead };
  }
  const observations: TypedObservation[] = [];
  const rows: SourceRootObserverRow[] = [];
  let committed = page.committedThrough ?? afterCursor;
  for (const item of page.rows) {
    committed = item.object_id;
    const bound = parseBoundInterpretationGist(item.gist);
    if (bound === null) continue;
    if (matchBoundInterpretation(bound, sketch) === undefined) continue;
    const hydrated = hydrateHintTarget(input, bound.source_target.root_kind, bound.source_target.root_id,
      bound.source_target.source_version, bound.source_target.content_digest,
      bound.source_target.evidence_object_id);
    if (hydrated === undefined) continue;
    observations.push(hydrated.observation);
    rows.push(hydrated.row);
    if (observations.length >= limit) break;
  }
  return {
    observations, rows,
    workUnits: page.nativeVisits, bytes: page.bytesRead + (page.nativeBytes ?? 0),
    truncated: page.truncated, hintCommitted: committed,
    hintsDone: !page.truncated && page.rows.length === 0,
    hydrationUnavailable: false, resourceLimited: page.resourceLimited === true
  };
}

function takeTextHintPage(
  input: ObserveConditionalFieldInput,
  sketch: AdoptedSourceProposal,
  limit: number,
  nativeLimit: number,
  afterCursor: string | null
): SourceHintLaneResult {
  const reader = input.readers.sourceTextHints;
  if (reader === undefined) return emptyHint(afterCursor, true, false);
  const phrases = sourceProposalPhrases(sketch);
  const page = reader({
    workspaceId: input.workspace_id,
    phrases,
    limit,
    nativeLimit,
    afterCursor,
    byteLimit: input.source_byte_limit ?? DEFAULT_SOURCE_BYTE_LIMIT
  });
  if (page.unavailable === true) {
    return { ...emptyHint(afterCursor, false, true), hydrationUnavailable: true,
      resourceLimited: page.resourceLimited === true, workUnits: page.nativeVisits, bytes: page.bytesRead };
  }
  const observations: TypedObservation[] = [];
  const rows: SourceRootObserverRow[] = [];
  let committed = page.committedThrough ?? afterCursor;
  for (const nativeRow of page.rows) {
    committed = nativeRow.root_id;
    if (!sourceRootEligible(input, nativeRow)) continue;
    if (!sourceTextContainsPhrases(nativeRow.content, phrases)) continue;
    const observation = observationFromRoot(input, nativeRow);
    if (observation === null) continue;
    observations.push(observation);
    rows.push(nativeRow);
    if (observations.length >= limit) break;
  }
  return {
    observations, rows,
    workUnits: page.nativeWork ?? page.nativeVisits, bytes: page.bytesRead,
    truncated: page.truncated, hintCommitted: committed,
    hintsDone: !page.truncated && page.rows.length === 0,
    hydrationUnavailable: false, resourceLimited: page.resourceLimited === true
  };
}

function hydrateHintTarget(
  input: ObserveConditionalFieldInput,
  rootKind: SourceRootObserverRow["kind"],
  rootId: string,
  revision: string,
  digest: string,
  evidenceObjectId: string | null
): Readonly<{ observation: TypedObservation; row: SourceRootObserverRow }> | undefined {
  const hydrate = input.readers.sourceRoot;
  if (hydrate === undefined) return undefined;
  const page = hydrate({
    workspaceId: input.workspace_id,
    rootKind,
    rootId,
    revision,
    digest,
    evidenceObjectId,
    byteLimit: input.source_byte_limit ?? DEFAULT_SOURCE_BYTE_LIMIT
  });
  if (page.unavailable || page.row === null) return undefined;
  if (page.row.revision !== revision || page.row.digest !== digest) return undefined;
  if (!sourceRootEligible(input, page.row)) return undefined;
  const observation = observationFromRoot(input, page.row);
  return observation === null ? undefined : { observation, row: page.row };
}

function observationFromRoot(
  input: ObserveConditionalFieldInput,
  row: SourceRootObserverRow
): TypedObservation | null {
  return buildTypedObservation(input, {
    objectId: row.root_id,
    sourceRevision: row.revision,
    observationKey: `src:${row.kind}:${row.root_id}`,
    observedAt: row.event_time ?? undefined,
    sourceRoot: row,
    identityKind: "object",
    target: sourceRecallTarget({
      workspace_id: row.workspace_id,
      root_kind: row.kind,
      root_id: row.root_id,
      source_version: row.revision,
      content_digest: row.digest,
      evidence_object_id: row.evidence_object_id
    })
  });
}

function emptyHint(
  afterCursor: string | null,
  hintsDone: boolean,
  truncated: boolean
): SourceHintLaneResult {
  return {
    observations: [], rows: [], workUnits: 0, bytes: 0, truncated,
    hintCommitted: afterCursor, hintsDone, hydrationUnavailable: false, resourceLimited: false
  };
}
