import { sourceRecallTarget, type TypedObservation } from "@do-soul/alaya-protocol";
import { sourceLiteralOccurs } from "../../../memory/evidence-create/source-utf8-hydrate.js";
import { buildTypedObservation, sourceRootEligible } from "./observation-admission.js";
import {
  collectObserved,
  DEFAULT_SOURCE_BYTE_LIMIT,
  finish,
  pageLimit,
  unavailableOrNotApplicable,
  workReceipt,
  type ObserveConditionalFieldInput,
  type ObserverActionResult
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
  if (!cursor.sourcesDone) {
    const page = sourceRoots({
      workspaceId: input.workspace_id,
      query: input.seed_query,
      limit: pageLimit(input),
      nativeLimit: input.action.work_limit,
      afterCursor: sourceCommitted,
      byteLimit: input.source_byte_limit ?? DEFAULT_SOURCE_BYTE_LIMIT
    });
    workUnits += page.nativeVisits;
    bytes += page.bytesRead;
    sourcesTruncated = page.truncated;
    truncated = page.truncated;
    sourceCommitted = page.committedThrough ?? sourceCommitted;
    if (page.unavailable === true) hydrationUnavailable = true;
    const needle = input.seed_query ?? "";
    for (const row of page.rows) {
      if (!sourceRootEligible(input, row)) continue;
      if (needle.length > 0 && row.content !== undefined && !sourceLiteralOccurs(row.content, needle)) {
        continue;
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
      if (observation !== null) observations.push(observation);
    }
  }
  const sourcesDone = cursor.sourcesDone || !sourcesTruncated;
  if (wantMemory && sourcesDone && !hydrationUnavailable) {
    const queryText = input.seed_query;
    const lexical = input.readers.lexical;
    if (queryText !== undefined && lexical !== undefined) {
      const remaining = Math.max(0, pageLimit(input) - observations.length);
      const page = lexical({
        workspaceId: input.workspace_id,
        query: queryText,
        limit: remaining,
        nativeLimit: Math.max(0, input.action.work_limit - workUnits),
        afterObjectId: memoryCommitted
      });
      const collected = collectObserved({
        ...input,
        action: { ...input.action, work_limit: Math.max(0, input.action.work_limit - workUnits) }
      }, {
        identities: page.ids,
        truncated: page.truncated,
        nativeVisits: page.nativeVisits,
        bytesRead: page.bytesRead,
        identityKind: "object",
        commitThrough: page.committedThrough ?? page.ids.at(-1) ?? memoryCommitted
      });
      observations.push(...collected.page.observations);
      workUnits += collected.work.work_units;
      bytes += collected.work.bytes_read;
      truncated = page.truncated || collected.page.outcome.status === "interrupted";
      memoryCommitted = collected.page.cursor.committed_through;
      if (collected.page.outcome.status === "unavailable") hydrationUnavailable = true;
      if (collected.page.outcome.status === "interrupted") resourceLimited = true;
    }
  }
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
      : {}),
    work: workReceipt(workUnits, workUnits, bytes, truncated || hydrationUnavailable)
  });
}

function parseSeedCursor(committed: string | null): Readonly<{
  readonly source: string | null;
  readonly memory: string | null;
  readonly sourcesDone: boolean;
}> {
  if (committed === null || committed === "") {
    return { source: null, memory: null, sourcesDone: false };
  }
  if (committed.startsWith("r:") || committed.startsWith("c:")) {
    return { source: committed, memory: null, sourcesDone: false };
  }
  if (committed.startsWith("m:")) {
    const memory = committed.slice(2);
    return { source: null, memory: memory === "" ? null : memory, sourcesDone: true };
  }
  return { source: null, memory: committed, sourcesDone: true };
}

function encodeSeedCursor(input: Readonly<{
  readonly source: string | null;
  readonly memory: string | null;
  readonly sourcesDone: boolean;
}>): string | null {
  if (!input.sourcesDone && input.source !== null) return input.source;
  if (input.memory !== null && input.memory !== "") return `m:${input.memory}`;
  if (input.sourcesDone) return "m:";
  return input.source;
}
