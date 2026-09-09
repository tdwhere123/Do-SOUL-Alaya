import { sourceRecallTarget, type TypedObservation } from "@do-soul/alaya-protocol";
import { buildTypedObservation, sourceRootEligible } from "./observation-admission.js";
import {
  collectObserved,
  DEFAULT_SOURCE_BYTE_LIMIT,
  finish,
  pageLimit,
  SOURCE_IDENTITY_HYDRATE_RESERVE,
  unavailableOrNotApplicable,
  workReceipt,
  type ObserveConditionalFieldInput,
  type ObserverActionResult,
  type ObserverReaders,
  type SourceRootObserverRow
} from "./observe.js";

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
  let workUnits = 0;
  let bytes = 0;
  let truncated = false;
  let sourcesTruncated = false;
  let hydrationUnavailable = false;
  let resourceLimited = false;
  let sourceCommitted = cursor.source;
  let memoryCommitted = cursor.memory;
  const share = seedFamilyShare(input, wantMemory, cursor.sourcesDone);
  let pagedSources = false;
  if (!cursor.sourcesDone && share.sourceLimit > 0 && share.sourceWork > 0) {
    const sourced = takeSourcePage(
      input, sourceRoots, share.sourceLimit, share.sourceWork, sourceCommitted, cursor.source
    );
    pagedSources = true;
    observations.push(...sourced.observations);
    workUnits += sourced.workUnits;
    bytes += sourced.bytes;
    sourcesTruncated = sourced.sourcesTruncated;
    truncated = sourced.truncated;
    sourceCommitted = sourced.sourceCommitted;
    if (sourced.hydrationUnavailable) hydrationUnavailable = true;
    if (sourced.resourceLimited) resourceLimited = true;
  }
  let memoryIdle = !wantMemory;
  if (wantMemory && !hydrationUnavailable && share.memoryWork > 0) {
    const taken = takeLexicalPage(input, share, memoryCommitted);
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
      input, sourceRoots, pageLimit(input), input.action.work_limit, sourceCommitted, cursor.source
    );
    pagedSources = true;
    observations.push(...sourced.observations);
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
  const sourcesDone = cursor.sourcesDone || (pagedSources && !sourcesTruncated);
  const committed = encodeSeedCursor({
    source: sourceCommitted,
    memory: memoryCommitted,
    sourcesDone
  });
  const cursorOut = committed === null
    ? input.cursor
    : { ...input.cursor, position: committed, committed_through: committed };
  return finish({
    input,
    cursor: cursorOut,
    observations,
    ids: observations.map((row) => row.object_id),
    truncated,
    readerAvailable: true,
    ...(hydrationUnavailable
      ? { status: resourceLimited ? "interrupted" as const : "unavailable" as const }
      : resourceLimited
        ? { status: "interrupted" as const }
        : {}),
    work: workReceipt(workUnits, workUnits, bytes, truncated || hydrationUnavailable || resourceLimited)
  });
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
    afterCursor,
    byteLimit: input.source_byte_limit ?? DEFAULT_SOURCE_BYTE_LIMIT
  });
  const observations: TypedObservation[] = [];
  let truncated = page.truncated;
  let sourcesTruncated = page.truncated;
  let sourceCommitted = page.committedThrough ?? afterCursor;
  let resourceLimited = false;
  for (const row of page.rows) {
    if (!sourceRootEligible(input, row)) continue;
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
    if (row.content_complete === false && observation.applicability.verdict === "unresolved") {
      resourceLimited = true;
      truncated = true;
      sourcesTruncated = true;
      sourceCommitted = encodeContentCursor(row, nextContentOffset(pinCursor, row));
    }
    observations.push(observation);
    if (sourceCommitted !== null && sourceCommitted.startsWith("o:")) break;
  }
  return {
    observations,
    workUnits: page.nativeVisits,
    bytes: page.bytesRead,
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

function seedFamilyShare(
  input: ObserveConditionalFieldInput,
  wantMemory: boolean,
  sourcesDone: boolean
): Readonly<{
  readonly sourceLimit: number;
  readonly sourceWork: number;
  readonly memoryLimit: number;
  readonly memoryWork: number;
}> {
  const limit = pageLimit(input);
  const work = input.action.work_limit;
  if (!wantMemory) {
    return { sourceLimit: limit, sourceWork: work, memoryLimit: 0, memoryWork: 0 };
  }
  if (sourcesDone) {
    return { sourceLimit: 0, sourceWork: 0, memoryLimit: Math.max(1, limit), memoryWork: work };
  }
  const hasLexical = input.seed_query !== undefined && input.readers.lexical !== undefined;
  if (!hasLexical) {
    return { sourceLimit: limit, sourceWork: work, memoryLimit: 0, memoryWork: 0 };
  }
  const hydrateReserve = input.readers.source === undefined ? 0 : SOURCE_IDENTITY_HYDRATE_RESERVE;
  const memoryNeed = 1 + hydrateReserve;
  const memoryWork = Math.min(work, Math.max(memoryNeed, Math.floor(work / 2)));
  const sourceWork = Math.max(0, work - memoryWork);
  const memoryLimit = hydrateReserve === 0
    ? Math.max(1, limit - Math.max(1, Math.floor(limit / 2)))
    : Math.max(1, Math.min(limit, memoryWork - hydrateReserve));
  return {
    sourceLimit: sourceWork === 0 ? 0 : Math.max(1, Math.floor(limit / 2)),
    sourceWork,
    memoryLimit,
    memoryWork
  };
}

function parseSeedCursor(committed: string | null): Readonly<{
  readonly source: string | null;
  readonly memory: string | null;
  readonly sourcesDone: boolean;
}> {
  if (committed === null || committed === "") {
    return { source: null, memory: null, sourcesDone: false };
  }
  if (committed.startsWith("s:")) return parseBundledSeedCursor(committed.slice(2));
  if (committed.startsWith("r:") || committed.startsWith("c:") || committed.startsWith("o:")) {
    return { source: committed, memory: null, sourcesDone: false };
  }
  if (committed.startsWith("m:")) {
    const memory = committed.slice(2);
    return { source: null, memory: memory === "" ? null : memory, sourcesDone: true };
  }
  return { source: null, memory: committed, sourcesDone: true };
}

function parseBundledSeedCursor(payload: string): Readonly<{
  readonly source: string | null;
  readonly memory: string | null;
  readonly sourcesDone: boolean;
}> {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (parsed === null || typeof parsed !== "object") {
      return { source: null, memory: null, sourcesDone: false };
    }
    const record = parsed as Record<string, unknown>;
    return {
      source: typeof record.source === "string" && record.source.length > 0 ? record.source : null,
      memory: typeof record.memory === "string" && record.memory.length > 0 ? record.memory : null,
      sourcesDone: record.sourcesDone === true
    };
  } catch {
    return { source: null, memory: null, sourcesDone: false };
  }
}

function encodeSeedCursor(input: Readonly<{
  readonly source: string | null;
  readonly memory: string | null;
  readonly sourcesDone: boolean;
}>): string | null {
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

function encodeContentCursor(row: SourceRootObserverRow, offset: number): string {
  return `o:${row.kind}\t${row.root_id}\t${offset}`;
}

function nextContentOffset(sourceCommitted: string | null, row: SourceRootObserverRow): number {
  const prior = parseContentOffset(sourceCommitted, row.root_id);
  return prior + Buffer.byteLength(row.content ?? "", "utf8");
}

function parseContentOffset(cursor: string | null, rootId: string): number {
  if (cursor === null || !cursor.startsWith("o:")) return 0;
  const payload = cursor.slice(2);
  const first = payload.indexOf("\t");
  const second = first < 0 ? -1 : payload.indexOf("\t", first + 1);
  if (first <= 0 || second <= first) return 0;
  if (payload.slice(first + 1, second) !== rootId) return 0;
  const offset = Number(payload.slice(second + 1));
  return Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
}
