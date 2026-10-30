import { sourceRecallTarget, type TypedObservation } from "@do-soul/alaya-protocol";
import { buildTypedObservation, sourceRootEligible } from "./observation-admission.js";
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

export function sourceSeedCursorAdvanced(before: string | null, after: string | null): boolean {
  const prior = parseSeedCursor(before), next = parseSeedCursor(after);
  return prior.source !== next.source || prior.memory !== next.memory || prior.sourcesDone !== next.sourcesDone;
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
  const available = [
    ...(!cursor.sourcesDone ? ["source"] : []),
    ...(wantMemory && input.seed_query !== undefined && input.readers.lexical !== undefined ? ["memory"] : [])
  ];
  const laneTurn = cursor.laneTurn ?? 0;
  const lane = available[laneTurn % Math.max(1, available.length)];
  const limit = pageLimit(input);
  const share = { memoryWork: lane === "memory" ? input.action.work_limit : 0,
    memoryLimit: lane === "memory" ? limit : 0 };
  const exhaustiveWork = lane === "source" ? input.action.work_limit : 0;
  const exhaustiveLimit = lane === "source" ? limit : 0;
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
    const taken = takeLexicalPage(input, share, memoryCommitted, { workUnits, bytes });
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
  if (!cursor.sourcesDone && !pagedSources && memoryIdle) {
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
      memoryWork: input.action.work_limit - workUnits, memoryLimit: pageLimit(input) }, memoryCommitted, { workUnits, bytes });
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
    source: sourceCommitted, memory: memoryCommitted, sourcesDone,
    persist: wantMemory || input.query.view.enumeration_policy === "native_query", laneTurn: laneTurn + 1
  }, { observations, sourceRows, workUnits, bytes, truncated, hydrationUnavailable, resourceLimited });
}

/** Native source and memory lanes retain independent progress and availability. */
function finishSourceSeed(
  input: ObserveConditionalFieldInput,
  progress: Parameters<typeof encodeSeedCursor>[0],
  collected: Readonly<{
    observations: readonly TypedObservation[]; sourceRows: readonly SourceRootObserverRow[];
    workUnits: number; bytes: number;
    truncated: boolean; hydrationUnavailable: boolean; resourceLimited: boolean;
  }>
): ObserverActionResult {
  const { observations, sourceRows, workUnits, bytes, truncated, hydrationUnavailable, resourceLimited } = collected;
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
  return { ...finished, source_roots: sourceRows };
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
  memoryCommitted: string | null,
  prior: Readonly<{ workUnits: number; bytes: number }>
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
  try {
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
  } catch (error) {
    input.on_failure_work?.({ native_visits: prior.workUnits, native_bytes: prior.bytes });
    throw error;
  }
}

type SeedCursor = Readonly<{ laneTurn?: number; source: string | null; memory: string | null; sourcesDone: boolean }>;
function parseSeedCursor(committed: string | null): SeedCursor {
  if (committed === null || committed === "") return { source: null, memory: null, sourcesDone: false };
  if (committed.startsWith("s:")) return parseBundledSeedCursor(committed.slice(2));
  // Family cursors are source progress, never memory identifiers.
  if (["r:", "c:", "o:", "f:"].some(prefix => committed.startsWith(prefix))) {
    return { source: committed, memory: null, sourcesDone: false };
  }
  const memory = committed.startsWith("m:") ? committed.slice(2) : committed;
  return { source: null, memory: memory === "" ? null : memory, sourcesDone: true };
}
function parseBundledSeedCursor(payload: string): SeedCursor {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (parsed === null || typeof parsed !== "object") throw new TypeError("invalid seed cursor");
    const record = parsed as Record<string, unknown>;
    return { laneTurn: Number.isSafeInteger(record.laneTurn) && (record.laneTurn as number) >= 0 ? record.laneTurn as number : 0,
      source: typeof record.source === "string" && record.source.length > 0 ? record.source : null,
      memory: typeof record.memory === "string" && record.memory.length > 0 ? record.memory : null,
      sourcesDone: record.sourcesDone === true };
  } catch { return { source: null, memory: null, sourcesDone: false }; }
}
function encodeSeedCursor(input: SeedCursor & Readonly<{ persist: boolean }>): string | null {
  if (input.persist) return `s:${JSON.stringify({ laneTurn: input.laneTurn, source: input.source,
    memory: input.memory, sourcesDone: input.sourcesDone })}`;
  if (!input.sourcesDone && (input.memory === null || input.memory === "")) return input.source;
  if (input.sourcesDone) return `m:${input.memory ?? ""}`;
  return `s:${JSON.stringify({ source: input.source, memory: input.memory, sourcesDone: false })}`;
}
