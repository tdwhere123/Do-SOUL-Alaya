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
  sourceTextContainsPhrases,
  type ProposalMatchReason
} from "./source-proposal-match.js";
import {
  DEFAULT_SOURCE_BYTE_LIMIT,
  type ObserveConditionalFieldInput,
  type SourceRootObserverRow
} from "./observe-ports.js";

// Native sourceRoot reads reserve metadata, retained chunk and evidence-link work.
const HYDRATE_WORK_RESERVE = 5;

export type SourceHintLaneResult = Readonly<{
  readonly observations: readonly TypedObservation[];
  readonly rows: readonly SourceRootObserverRow[];
  readonly reasons: readonly ProposalMatchReason[];
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
  if (nativeLimit <= HYDRATE_WORK_RESERVE || limit <= 0) {
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
  const contextLimit = Math.min(limit, Math.floor(nativeLimit / (HYDRATE_WORK_RESERVE + 1)));
  const scopeUnsupported = proposalScopeUnsupported(input.query);
  const page = reader({
    workspaceId: input.workspace_id,
    limit: contextLimit,
    nativeLimit: nativeLimit - contextLimit * HYDRATE_WORK_RESERVE,
    afterCursor,
    matches: (gist) => {
      const bound = parseBoundInterpretationGist(gist);
      return !scopeUnsupported && bound !== null && matchBoundInterpretation(bound, sketch) !== undefined;
    }
  });
  if (page.unavailable === true) {
    return {
      ...emptyHint(afterCursor, true, false),
      hydrationUnavailable: true,
      resourceLimited: page.resourceLimited === true,
      workUnits: page.nativeWork ?? page.nativeVisits,
      bytes: page.bytesRead
    };
  }
  const observations: TypedObservation[] = [];
  const rows: SourceRootObserverRow[] = [];
  const reasons: ProposalMatchReason[] = [];
  let committed = afterCursor;
  let pending = false;
  let hydrateWork = 0;
  let hydrateBytes = 0;
  for (const item of page.rows) {
    const bound = parseBoundInterpretationGist(item.gist);
    if (bound === null) continue;
    const reason = scopeUnsupported ? undefined : matchBoundInterpretation(bound, sketch);
    if (reason === undefined) continue;
    const hydrated = hydrateHintTarget(input, bound.source_target.root_kind, bound.source_target.root_id,
      bound.source_target.source_version, bound.source_target.content_digest,
      bound.source_target.evidence_object_id);
    hydrateWork += hydrated.workUnits;
    hydrateBytes += hydrated.bytes;
    if (hydrated.resourceLimited) { pending = true; break; }
    committed = item.object_id;
    if (hydrated.observation === undefined || hydrated.row === undefined) continue;
    observations.push(hydrated.observation);
    rows.push({ ...hydrated.row, source_lookup_reasons: [reason] });
    reasons.push(reason);
    if (observations.length >= contextLimit) break;
  }
  return {
    observations, rows, reasons,
    workUnits: (page.nativeWork ?? page.nativeVisits) + hydrateWork,
    bytes: page.bytesRead + (page.nativeBytes ?? 0) + hydrateBytes,
    truncated: page.truncated || pending,
    hintCommitted: pending ? committed : page.committedThrough ?? committed,
    hintsDone: !page.truncated && !pending,
    hydrationUnavailable: false, resourceLimited: page.resourceLimited === true || pending
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
  const contextLimit = Math.min(limit, Math.floor(nativeLimit / (HYDRATE_WORK_RESERVE + 1)));
  const page = reader({
    workspaceId: input.workspace_id,
    phrases,
    limit: contextLimit,
    nativeLimit: contextLimit,
    afterCursor,
    byteLimit: input.source_byte_limit ?? DEFAULT_SOURCE_BYTE_LIMIT
  });
  if (page.unavailable === true) {
    return {
      ...emptyHint(afterCursor, true, false),
      hydrationUnavailable: true,
      resourceLimited: page.resourceLimited === true,
      workUnits: page.nativeWork ?? page.nativeVisits,
      bytes: page.bytesRead
    };
  }
  const observations: TypedObservation[] = [];
  const rows: SourceRootObserverRow[] = [];
  let hydrateWork = 0;
  let hydrateBytes = 0;
  let committed = afterCursor;
  let pending = false;
  const scopeUnsupported = proposalScopeUnsupported(input.query);
  for (const nativeRow of page.rows) {
    const hydrated = hydrateHintTarget(input, nativeRow.kind, nativeRow.root_id,
      nativeRow.revision, nativeRow.digest, nativeRow.evidence_object_id);
    hydrateWork += hydrated.workUnits;
    hydrateBytes += hydrated.bytes;
    if (hydrated.resourceLimited) { pending = true; break; }
    committed = nativeRow.root_id;
    if (hydrated.row === undefined || hydrated.observation === undefined) continue;
    if (scopeUnsupported || !sourceTextContainsPhrases(hydrated.row.content, phrases)) continue;
    observations.push(hydrated.observation);
    rows.push(hydrated.row);
  }
  return {
    observations, rows, reasons: [],
    workUnits: (page.nativeWork ?? page.nativeVisits) + hydrateWork,
    bytes: page.bytesRead + (page.nativeBytes ?? 0) + hydrateBytes,
    truncated: page.truncated || pending,
    hintCommitted: pending ? committed : page.committedThrough ?? committed,
    hintsDone: !page.truncated && !pending,
    hydrationUnavailable: false, resourceLimited: page.resourceLimited === true || pending
  };
}

function hydrateHintTarget(
  input: ObserveConditionalFieldInput,
  rootKind: SourceRootObserverRow["kind"],
  rootId: string,
  revision: string,
  digest: string,
  evidenceObjectId: string | null
): Readonly<{
  readonly observation?: TypedObservation;
  readonly row?: SourceRootObserverRow;
  readonly workUnits: number;
  readonly bytes: number;
  readonly resourceLimited?: boolean;
}> {
  const hydrate = input.readers.sourceRoot;
  if (hydrate === undefined) return { workUnits: 1, bytes: 0 };
  const page = hydrate({
    workspaceId: input.workspace_id,
    rootKind,
    rootId,
    revision,
    digest,
    evidenceObjectId,
    byteLimit: input.source_byte_limit ?? DEFAULT_SOURCE_BYTE_LIMIT
  });
  const workUnits = Math.max(1, page.nativeWork ?? page.rowsRead);
  const bytes = page.bytesRead + (page.metadataBytes ?? 0);
  if (page.resourceLimited && page.row === null) return { workUnits, bytes, resourceLimited: true };
  if (page.unavailable || page.row === null) return { workUnits, bytes };
  if (page.row.revision !== revision || page.row.digest !== digest) return { workUnits, bytes };
  if (!sourceRootEligible(input, page.row)) return { workUnits, bytes };
  const observation = observationFromRoot(input, page.row);
  return observation === null ? { workUnits, bytes } : { observation, row: page.row, workUnits, bytes };
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

function proposalScopeUnsupported(query: ObserveConditionalFieldInput["query"]): boolean {
  return query.holes.some((hole) =>
    hole.status === "unresolved" && hole.hole_id.startsWith("hole.query.alternative"));
}

function emptyHint(
  afterCursor: string | null,
  hintsDone: boolean,
  truncated: boolean
): SourceHintLaneResult {
  return {
    observations: [], rows: [], reasons: [], workUnits: 0, bytes: 0, truncated,
    hintCommitted: afterCursor, hintsDone, hydrationUnavailable: false, resourceLimited: false
  };
}
