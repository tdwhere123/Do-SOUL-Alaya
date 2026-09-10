import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  canonicalIndexEntryIdentity,
  reachableMilligradesOf,
  type Continuation,
  type EnumerationPolicy,
  type FieldValue,
  type IndexEntry
} from "@do-soul/alaya-protocol";
import { compareText } from "../../../shared/compare-text.js";
import { stableStringify } from "../../../shared/stable-stringify.js";
import { productStateNodeId } from "../reference/bind-max-min.js";
import {
  OFFSET_CURSOR,
  PROJECTION_CURSOR,
  RESUME_CURSOR,
  encodeResumeCursor,
  identityDigest,
  resumeDigest,
  type EmittedRevisions
} from "../../runtime/index-continuation.js";
import type { AcceptingProjectionInput } from "./project-accepting-index.js";
import { facetModeForValue, facetsForCandidate } from "./project-accepting-entries.js";

export function usesEmittedSet(input: AcceptingProjectionInput, policy: EnumerationPolicy): boolean {
  // Offset into a resorted list drops late stronger members; the continuation's
  // emitted_revisions ledger is the projector's own resume state for every policy.
  return policy === "associative"
    || input.delivered_product_ids !== undefined
    || input.delivered_entry_revisions !== undefined
    || input.prior_continuation?.emitted_revisions !== undefined;
}

export function resolvePageOffset(input: AcceptingProjectionInput, total: number): number {
  if (input.delivered_product_ids !== undefined) return 0;
  if (input.page_offset !== undefined) return Math.max(0, input.page_offset);
  const cursor = input.prior_continuation?.cursor;
  if (cursor === undefined) return 0;
  if (PROJECTION_CURSOR.test(cursor)) return 0;
  const resume = RESUME_CURSOR.exec(cursor);
  if (resume !== null) return Number(resume[1]);
  const matched = OFFSET_CURSOR.exec(cursor);
  if (matched === null) return total;
  return Number(matched[1]);
}

export function continuationSetMismatch(
  input: AcceptingProjectionInput,
  entries: readonly IndexEntry[]
): boolean {
  if (input.delivered_product_ids !== undefined) return false;
  if (input.page_offset !== undefined) return false;
  const cursor = input.prior_continuation?.cursor;
  if (cursor === undefined) return false;
  const projection = PROJECTION_CURSOR.exec(cursor);
  if (projection !== null) {
    const offset = Number(projection[1]);
    return offset > input.snapshot.values.length
      || input.prior_continuation?.continuation_id !== projectionPrefixIdentity(input, offset);
  }
  const offset = resolvePageOffset(input, entries.length);
  if (offset === 0) return false;
  if (entries.length < offset) return true;
  const digest = resumeDigest(cursor);
  if (digest === undefined) return false;
  return digest !== identityDigest(entries.slice(0, offset).map(entrySortKey));
}

export function continuationPrefixUnverified(
  input: AcceptingProjectionInput,
  entries: readonly IndexEntry[],
  truncated: boolean
): boolean {
  if (!truncated || input.delivered_product_ids !== undefined || input.page_offset !== undefined) return false;
  const cursor = input.prior_continuation?.cursor;
  return cursor !== undefined && !PROJECTION_CURSOR.test(cursor)
    && entries.length < resolvePageOffset(input, entries.length);
}

function projectionPrefixIdentity(input: AcceptingProjectionInput, offset: number): string {
  const prefix = [...input.snapshot.values].sort((a, b) => compareText(valueSortKey(a), valueSortKey(b)))
    .slice(0, offset).map((value) => stableStringify([value,
      input.roles?.get(productStateNodeId(value.state)) ?? "associated",
      facetsForCandidate(value, input), facetModeForValue(value, input)]));
  return `projection-${identityDigest([stableStringify(input.view), ...prefix])}`;
}

export function nextContinuation(
  input: AcceptingProjectionInput,
  remaining: number,
  nextOffset: number,
  entries: readonly IndexEntry[],
  projectionOffset: number | undefined,
  committed: EmittedRevisions,
  useEmittedSet: boolean
): Continuation | null {
  if (input.expires_at === undefined) return null;
  const observerOpen = input.observer?.outcome.status === "open"
    || input.observer?.outcome.status === "interrupted";
  if (remaining <= 0 && !observerOpen && input.resource_work !== "open" && input.support_work_status !== "open") return null;
  const emittedKeys = Object.keys(committed).sort(compareText);
  const cursor = projectionOffset === undefined
    ? encodeResumeCursor(
      useEmittedSet ? emittedKeys.length : nextOffset,
      useEmittedSet ? emittedKeys : entries.slice(0, nextOffset).map(entrySortKey)
    )
    : `p${projectionOffset}g${input.grounding_progress?.completed_work ?? 0}`
      + (input.projection_generation === undefined ? "" : `r${input.projection_generation}`)
      + ((input.projection_facet_offset ?? 0) > 0 ? `e${input.projection_facet_offset}` : "");
  if (cursor === null) return null;
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    continuation_id: projectionOffset !== undefined && input.delivered_product_ids === undefined
      ? projectionPrefixIdentity(input, projectionOffset) : `page-${nextOffset}`,
    query_id: input.query_id,
    snapshot_id: input.snapshot_id,
    result_version: input.result_version,
    expires_at: input.expires_at,
    cursor,
    ...(input.interpretation_id === undefined ? {} : { interpretation_id: input.interpretation_id }),
    enumeration_policy: input.view.enumeration_policy ?? "canonical",
    result_kind_view: input.view.result_kind_view ?? "mixed",
    ...(input.authorized_scopes === undefined ? {} : { authorized_scopes: input.authorized_scopes }),
    ...(input.view.cap_contracts === undefined ? {} : { cap_contracts: input.view.cap_contracts }),
    ...(input.view.claim_demands === undefined ? {} : { claim_demands: input.view.claim_demands }),
    ...wireEmittedRevisions(committed)
  };
}

function wireEmittedRevisions(committed: EmittedRevisions): { readonly emitted_revisions: EmittedRevisions } | {} {
  const next: Record<string, string> = {};
  for (const [id, revision] of Object.entries(committed)) {
    if (revision.length > 0) next[id] = revision;
  }
  return Object.keys(next).length === 0 ? {} : { emitted_revisions: next };
}

function valueSortKey(value: FieldValue): string {
  return canonicalIndexEntryIdentity({
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    target: value.state.target,
    ...(value.state.target.kind === "memory_entry" ? { object_id: value.state.target.object_id } : {}),
    hypothesis_id: value.state.hypothesis_id,
    output_binding: value.state.binding_context,
    program_state: value.state.program_state,
    time_state: value.state.time_state,
    role: "associated",
    association_milligrades: reachableMilligradesOf(value) ?? 0,
    claim: "unknown",
    explanation_ids: []
  });
}

function entrySortKey(entry: IndexEntry): string {
  return canonicalIndexEntryIdentity(entry);
}
