import { sourceRecallTarget, type TypedObservation } from "@do-soul/alaya-protocol";
import { buildTypedObservation, sourceRootEligible } from "./observation-admission.js";
import { sourceHintSketch, takeSourceHintPage } from "./source-hint-observe.js";
import type { ProposalMatchReason } from "./source-proposal-match.js";
import { scanSourceLiterals } from "./source-literal-stream.js";
import {
  DEFAULT_SOURCE_BYTE_LIMIT,
  SOURCE_IDENTITY_HYDRATE_RESERVE,
  type ObserveConditionalFieldInput,
  type ObserverActionResult,
  type ObserverReaders,
  type SourceRootObserverRow
} from "./observe-ports.js";
import {
  collectObserved,
  finish,
  pageLimit,
  unavailableOrNotApplicable,
  workReceipt
} from "./observe-collect.js";

export function sourceFamilySettled(committed: string | null | undefined): boolean {
  return parseSeedCursor(committed ?? null).sourcesDone;
}

export function observeSourceAwareSeed(
  input: ObserveConditionalFieldInput,
  wantMemory: boolean
): ObserverActionResult {
  const sourceRoots = input.readers.sourceRoots;
  if (sourceRoots === undefined) {
    return unavailableOrNotApplicable(input, "unavailable");
  }
  const cursor = parseSeedCursor(input.cursor.committed_through);
  const observations: TypedObservation[] = [];
  const sourceRows: SourceRootObserverRow[] = [];
  let workUnits = 0;
  let bytes = 0;
  let truncated = false;
  let sourcesTruncated = false;
  let hydrationUnavailable = false;
  let resourceLimited = false;
  let sourceCommitted = cursor.source;
  let memoryCommitted = cursor.memory;
  let hintCommitted = cursor.hint;
  const sketch = sourceHintSketch(input);
  let hintsUnavailable = cursor.hintsUnavailable === true;
  let hintsDone = !hintsUnavailable && (sketch === undefined || cursor.hintsDone || cursor.sourcesDone);
  const available = [
    ...(!hintsDone && !hintsUnavailable ? ["hint"] : []),
    ...(!cursor.sourcesDone ? ["source"] : []),
    ...(wantMemory && input.seed_query !== undefined && input.readers.lexical !== undefined ? ["memory"] : [])
  ];
  const laneTurn = cursor.laneTurn ?? 0;
  const lane = available[laneTurn % Math.max(1, available.length)];
  const limit = pageLimit(input);
  const share = { memoryWork: lane === "memory" ? input.action.work_limit : 0,
    memoryLimit: lane === "memory" ? limit : 0 };
  const lanes = { hintWork: lane === "hint" ? input.action.work_limit : 0,
    hintLimit: lane === "hint" ? limit : 0,
    sourceWork: lane === "source" ? input.action.work_limit : 0,
    sourceLimit: lane === "source" ? limit : 0 };
  let exhaustiveWork = lanes.sourceWork;
  let exhaustiveLimit = lanes.sourceLimit;
  let pagedHints = false;
  const lookupReasons: ProposalMatchReason[] = [];
  if (sketch !== undefined && !hintsDone && lanes.hintWork > 0) {
    pagedHints = true;
    const hinted = takeSourceHintPage(input, sketch, lanes.hintLimit, lanes.hintWork, hintCommitted);
    observations.push(...hinted.observations);
    sourceRows.push(...hinted.rows);
    lookupReasons.push(...hinted.reasons);
    workUnits += hinted.workUnits;
    bytes += hinted.bytes;
    truncated = hinted.truncated;
    hintCommitted = hinted.hintCommitted;
    hintsUnavailable = hinted.hydrationUnavailable;
    hintsDone = hinted.hintsDone && !hintsUnavailable;
    if (hinted.resourceLimited) resourceLimited = true;
    if (hintsDone || hintsUnavailable) {
      exhaustiveWork += Math.max(0, lanes.hintWork - hinted.workUnits);
      exhaustiveLimit += Math.max(0, lanes.hintLimit - hinted.observations.length);
    }
  }
  let pagedSources = false;
  if (!cursor.sourcesDone && exhaustiveLimit > 0 && exhaustiveWork > 0) {
    const sourced = takeSourcePage(
      input, sourceRoots, exhaustiveLimit, exhaustiveWork, sourceCommitted, cursor.source
    );
    pagedSources = true;
    const seen = new Set(observations.map((row) => row.object_id));
    observations.push(...sourced.observations.filter((row) => !seen.has(row.object_id)));
    sourceRows.push(...sourced.rows.filter((row) => !seen.has(row.root_id)));
    workUnits += sourced.workUnits;
    bytes += sourced.bytes;
    sourcesTruncated = sourced.sourcesTruncated;
    truncated = sourced.truncated;
    sourceCommitted = sourced.sourceCommitted;
    if (sourced.hydrationUnavailable) hydrationUnavailable = true;
    if (sourced.resourceLimited) resourceLimited = true;
  }
  let memoryIdle = !wantMemory;
  let pagedMemory = false;
  // Source hydration failure is not a lexical skip: mixed seed would fail-close FTS memory.
  if (wantMemory && share.memoryWork > 0) {
    const taken = takeLexicalPage(input, share, memoryCommitted);
    pagedMemory = taken !== null;
    if (taken === null) {
      memoryIdle = true;
    } else {
      observations.push(...taken.observations);
      workUnits += taken.workUnits;
      bytes += taken.bytes;
      truncated = truncated || taken.truncated;
      memoryCommitted = taken.memoryCommitted;
      memoryIdle = taken.ids === 0 && !taken.truncated;
      if (taken.hydrationUnavailable) hydrationUnavailable = true;
      if (taken.resourceLimited) resourceLimited = true;
    }
  }
  if (!cursor.sourcesDone && !pagedSources && memoryIdle && !pagedHints) {
    const sourced = takeSourcePage(
      input, sourceRoots, pageLimit(input), Math.max(0, input.action.work_limit - workUnits), sourceCommitted, cursor.source
    );
    pagedSources = true;
    const seen = new Set(observations.map((row) => row.object_id));
    observations.push(...sourced.observations.filter((row) => !seen.has(row.object_id)));
    sourceRows.push(...sourced.rows.filter((row) => !seen.has(row.root_id)));
    workUnits += sourced.workUnits;
    bytes += sourced.bytes;
    sourcesTruncated = sourced.sourcesTruncated;
    truncated = truncated || sourced.truncated;
    sourceCommitted = sourced.sourceCommitted;
    if (sourced.hydrationUnavailable) hydrationUnavailable = true;
    if (sourced.resourceLimited) resourceLimited = true;
  } else if (!cursor.sourcesDone && !pagedSources) {
    sourcesTruncated = true;
    truncated = true;
  }
  // An empty source inventory must not close the mixed seed before the
  // independently supported memory lane is read. Source membership remains
  // explicit through its own residual; this only refuses to let absence suppress it.
  if (wantMemory && !pagedMemory && input.readers.lexical !== undefined && input.seed_query !== undefined
    && sourceRows.length === 0 && workUnits < input.action.work_limit) {
    const taken = takeLexicalPage(input, {
      memoryWork: input.action.work_limit - workUnits, memoryLimit: pageLimit(input) }, memoryCommitted);
    if (taken !== null) {
      pagedMemory = true;
      observations.push(...taken.observations);
      workUnits += taken.workUnits;
      bytes += taken.bytes;
      truncated = truncated || taken.truncated;
      memoryCommitted = taken.memoryCommitted;
      memoryIdle = taken.ids === 0 && !taken.truncated;
      if (taken.hydrationUnavailable) hydrationUnavailable = true;
      if (taken.resourceLimited) resourceLimited = true;
    }
  }
  const sourcesDone = cursor.sourcesDone || (pagedSources && !sourcesTruncated);
  if (wantMemory && !pagedMemory) truncated = true;
  return finishSourceSeed(input, {
    source: sourceCommitted, memory: memoryCommitted, sourcesDone, hint: hintCommitted,
    hintsDone, hintsUnavailable, persistHint: sketch !== undefined || wantMemory || input.query.view.enumeration_policy === "native_query", laneTurn: laneTurn + 1
  }, { observations, sourceRows, lookupReasons, workUnits, bytes, truncated, hydrationUnavailable, resourceLimited });
}

/** Commit lane progress and report required source work separately from optional hint failure. */
function finishSourceSeed(
  input: ObserveConditionalFieldInput,
  progress: Parameters<typeof encodeSeedCursor>[0],
  collected: Readonly<{
    observations: readonly TypedObservation[]; sourceRows: readonly SourceRootObserverRow[];
    lookupReasons: readonly ProposalMatchReason[]; workUnits: number; bytes: number;
    truncated: boolean; hydrationUnavailable: boolean; resourceLimited: boolean;
  }>
): ObserverActionResult {
  const { observations, sourceRows, lookupReasons, workUnits, bytes, truncated, hydrationUnavailable, resourceLimited } = collected;
  const committed = encodeSeedCursor(progress);
  const cursorOut = committed === null
    ? input.cursor
    : { ...input.cursor, position: committed, committed_through: committed };
  const finished = finish({
    input,
    cursor: cursorOut,
    observations,
    ids: observations.map((row) => row.object_id),
    truncated,
    readerAvailable: true,
    ...(hydrationUnavailable && observations.length === 0
      ? { status: resourceLimited ? "interrupted" as const : "unavailable" as const }
      : resourceLimited
        ? { status: "interrupted" as const }
        : {}),
    work: workReceipt(workUnits, workUnits, bytes, truncated || hydrationUnavailable || resourceLimited)
  });
  // Hint failure abandons optional lookup explanations, not exhaustive membership.
  // Persist it independently so later source pages do not erase the failed attempt.
  const page = !progress.hintsUnavailable ? finished.page : {
    ...finished.page,
    open_regions: [...finished.page.open_regions, {
      schema_version: 1 as const, region_id: `${input.action.region_id}:source_hint`,
      kind: "discovery" as const, status: "unavailable" as const,
      coverage_role: "optional_accelerator" as const, semantic_effects: ["explanation" as const]
    }]
  };
  return { ...finished, page, source_roots: sourceRows,
  ...(lookupReasons.length === 0 ? {} : { lookup_reasons: lookupReasons }) };
}

function takeSourcePage(
  input: ObserveConditionalFieldInput,
  sourceRoots: NonNullable<ObserverReaders["sourceRoots"]>,
  limit: number,
  nativeLimit: number,
  afterCursor: string | null,
  pinCursor: string | null
): Readonly<{
  readonly observations: readonly TypedObservation[];
  readonly rows: readonly SourceRootObserverRow[];
  readonly workUnits: number;
  readonly bytes: number;
  readonly truncated: boolean;
  readonly sourcesTruncated: boolean;
  readonly sourceCommitted: string | null;
  readonly hydrationUnavailable: boolean;
  readonly resourceLimited: boolean;
}> {
  const page = sourceRoots({
    workspaceId: input.workspace_id,
    query: input.seed_query,
    limit,
    nativeLimit,
    workLimit: nativeLimit,
    afterCursor,
    byteLimit: input.source_byte_limit ?? DEFAULT_SOURCE_BYTE_LIMIT
  });
  const observations: TypedObservation[] = [];
  const rows: SourceRootObserverRow[] = [];
  let truncated = page.truncated;
  let sourcesTruncated = page.truncated;
  let sourceCommitted = page.committedThrough ?? afterCursor;
  let resourceLimited = page.resourceLimited === true
    || (page.unavailable !== true && page.rows.length === 0 && page.truncated
      && page.committedThrough === afterCursor);
  for (const nativeRow of page.rows) {
    if (!sourceRootEligible(input, nativeRow)) continue;
    const scanned = scanSourceLiterals(input.query, nativeRow, pinCursor, sourceCommitted);
    if (scanned.limited) {
      observations.length = 0;
      rows.length = 0;
      sourceCommitted = pinCursor;
      truncated = true;
      sourcesTruncated = true;
      resourceLimited = true;
      break;
    }
    const row = scanned.row;
    rows.push(row);
    sourceCommitted = scanned.cursor;
    if (scanned.needsContent) {
      resourceLimited = true;
      truncated = true;
      sourcesTruncated = true;
      sourceCommitted = scanned.cursor;
    }
    const observation = buildTypedObservation(input, {
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
    if (observation === null) continue;
    observations.push(observation);
  }
  return {
    observations,
    rows,
    workUnits: page.nativeWork ?? page.nativeVisits,
    bytes: page.bytesRead + (page.metadataBytes ?? 0),
    truncated,
    sourcesTruncated,
    sourceCommitted,
    hydrationUnavailable: page.unavailable === true,
    resourceLimited
  };
}

function takeLexicalPage(
  input: ObserveConditionalFieldInput,
  share: Readonly<{ readonly memoryLimit: number; readonly memoryWork: number }>,
  memoryCommitted: string | null
): Readonly<{
  readonly observations: readonly TypedObservation[];
  readonly workUnits: number;
  readonly bytes: number;
  readonly truncated: boolean;
  readonly memoryCommitted: string | null;
  readonly ids: number;
  readonly hydrationUnavailable: boolean;
  readonly resourceLimited: boolean;
}> | null {
  const queryText = input.seed_query;
  const lexical = input.readers.lexical;
  if (queryText === undefined || lexical === undefined) return null;
  const hydrateReserve = input.readers.source === undefined ? 0 : SOURCE_IDENTITY_HYDRATE_RESERVE;
  const nativeLimit = Math.max(1, share.memoryWork - hydrateReserve);
  const page = lexical({
    workspaceId: input.workspace_id,
    query: queryText,
    limit: Math.max(1, Math.min(share.memoryLimit, nativeLimit)),
    nativeLimit,
    afterObjectId: memoryCommitted
  });
  const collected = collectObserved({
    ...input,
    action: { ...input.action, work_limit: share.memoryWork }
  }, {
    identities: page.ids,
    truncated: page.truncated,
    nativeVisits: page.nativeVisits,
    bytesRead: page.bytesRead,
    identityKind: "object",
    commitThrough: page.committedThrough ?? page.ids.at(-1) ?? memoryCommitted
  });
  return {
    observations: collected.page.observations,
    workUnits: collected.work.work_units,
    bytes: collected.work.bytes_read,
    truncated: page.truncated || collected.page.outcome.status === "interrupted",
    memoryCommitted: collected.page.cursor.committed_through,
    ids: page.ids.length,
    hydrationUnavailable: collected.page.outcome.status === "unavailable",
    resourceLimited: collected.page.outcome.status === "interrupted"
  };
}

function parseSeedCursor(committed: string | null): Readonly<{
  readonly hintsUnavailable?: boolean;
  readonly laneTurn?: number;
  readonly source: string | null;
  readonly memory: string | null;
  readonly sourcesDone: boolean;
  readonly hint: string | null;
  readonly hintsDone: boolean;
}> {
  if (committed === null || committed === "") {
    return { source: null, memory: null, sourcesDone: false, hint: null, hintsDone: false };
  }
  if (committed.startsWith("s:")) return parseBundledSeedCursor(committed.slice(2));
  // `f:` is dual-family source progress; treating it as a memory id would skip remaining roots.
  if (
    committed.startsWith("r:")
    || committed.startsWith("c:")
    || committed.startsWith("o:")
    || committed.startsWith("f:")
  ) {
    return { source: committed, memory: null, sourcesDone: false, hint: null, hintsDone: false };
  }
  if (committed.startsWith("m:")) {
    const memory = committed.slice(2);
    return { source: null, memory: memory === "" ? null : memory, sourcesDone: true, hint: null, hintsDone: true };
  }
  return { source: null, memory: committed, sourcesDone: true, hint: null, hintsDone: true };
}

function parseBundledSeedCursor(payload: string): Readonly<{
  readonly hintsUnavailable?: boolean;
  readonly laneTurn?: number;
  readonly source: string | null;
  readonly memory: string | null;
  readonly sourcesDone: boolean;
  readonly hint: string | null;
  readonly hintsDone: boolean;
}> {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (parsed === null || typeof parsed !== "object") {
      return { source: null, memory: null, sourcesDone: false, hint: null, hintsDone: true };
    }
    const record = parsed as Record<string, unknown>;
    return {
      laneTurn: Number.isSafeInteger(record.laneTurn) && (record.laneTurn as number) >= 0 ? record.laneTurn as number : 0,
      source: typeof record.source === "string" && record.source.length > 0 ? record.source : null,
      memory: typeof record.memory === "string" && record.memory.length > 0 ? record.memory : null,
      sourcesDone: record.sourcesDone === true,
      hint: typeof record.hint === "string" && record.hint.length > 0 ? record.hint : null,
      hintsDone: record.hintsDone === true,
      hintsUnavailable: record.hintsUnavailable === true
    };
  } catch {
    return { source: null, memory: null, sourcesDone: false, hint: null, hintsDone: true };
  }
}

function encodeSeedCursor(input: Readonly<{
  readonly hintsUnavailable: boolean;
  readonly laneTurn: number;
  readonly source: string | null;
  readonly memory: string | null;
  readonly sourcesDone: boolean;
  readonly hint: string | null;
  readonly hintsDone: boolean;
  readonly persistHint: boolean;
}>): string | null {
  if (input.persistHint) {
    return `s:${JSON.stringify({
      laneTurn: input.laneTurn,
      source: input.source,
      memory: input.memory,
      sourcesDone: input.sourcesDone,
      hint: input.hint,
      hintsDone: input.hintsDone,
      ...(input.hintsUnavailable ? { hintsUnavailable: true } : {})
    })}`;
  }
  if (!input.sourcesDone && (input.memory === null || input.memory === "")) {
    return input.source;
  }
  if (input.sourcesDone) {
    if (input.memory !== null && input.memory !== "") return `m:${input.memory}`;
    return "m:";
  }
  return `s:${JSON.stringify({
    source: input.source,
    memory: input.memory,
    sourcesDone: false
  })}`;
}
