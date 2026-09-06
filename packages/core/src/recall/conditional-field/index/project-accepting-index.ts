import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  MILLIGRADE_BOTTOM,
  type ClaimState,
  type Continuation,
  type FacetMode,
  type FacetVector,
  type FieldSnapshot,
  type FieldValue,
  type IndexEntry,
  type IndexRole,
  type InformationIndex,
  type QueryInterpretationStatus,
  type QueryView,
  type RequestBudget,
  type SupportRecord,
  type Witness
} from "@do-soul/alaya-protocol";
import { compareText } from "../../../shared/compare-text.js";
import { stableStringify } from "../../../shared/stable-stringify.js";
import { facetPathId } from "../engine/path-composition.js";
import {
  admitIndexBudget,
  completenessForInterpretationStatus,
  composeCompleteness,
  continuationInvalidated,
  invalidatedCompleteness,
  resourceRejectedCompleteness,
  type ObserverCoverage
} from "./completeness.js";

export type { ObserverCoverage } from "./completeness.js";

export type AcceptingProjectionInput = Readonly<{
  readonly snapshot: FieldSnapshot;
  readonly view: QueryView;
  readonly query_id: string;
  readonly snapshot_id: string;
  readonly result_version: string;
  readonly budget: RequestBudget;
  readonly roles?: ReadonlyMap<string, IndexRole>;
  readonly claims?: ReadonlyMap<string, ClaimState>;
  readonly support?: readonly SupportRecord[];
  readonly page_offset?: number;
  readonly expires_at?: string;
  readonly as_of?: string;
  readonly prior_continuation?: Continuation | null;
  readonly observer?: ObserverCoverage;
  readonly interpretation_status?: QueryInterpretationStatus;
  readonly relation_facet_modes?: ReadonlyMap<string, FacetMode>;
  readonly expand_payload?: boolean;
  readonly resume_cursors?: Readonly<Record<string, string | null>>;
}>;

const OFFSET_CURSOR = /^offset-(\d+)$/u;
const RESUME_CURSOR = /^o(\d+)(?:\|(.*))?$/u;
const REPRESENTATION_POLICY = "construct_index_then_page_then_payload" as const;

export function evaluateSamePathPredicate(
  vectors: readonly FacetVector[],
  threshold: number
): boolean {
  return vectors.some((vector) => vector.coordinates.every((value) => value > threshold));
}

export function evaluateFacetPredicate(
  mode: FacetMode,
  vectors: readonly FacetVector[],
  threshold: number
): boolean {
  if (mode === "same_path") return evaluateSamePathPredicate(vectors, threshold);
  return independentFacetPredicate(vectors, threshold);
}

export function selectFeasibleWitnesses(
  witnesses: readonly Witness[],
  pageBudget: number
): readonly Witness[] {
  return witnesses.filter((witness) => witness.complete && witness.cost <= pageBudget);
}

export function projectAcceptingIndex(input: AcceptingProjectionInput): InformationIndex {
  const representation = representationDecision(input.budget.page_budget);
  if (continuationInvalidated(input) || continuationCursorInvalid(input)) {
    return closedIndex(input, representation, invalidatedCompleteness());
  }
  const admission = input.interpretation_status === undefined
    ? undefined
    : completenessForInterpretationStatus(input.interpretation_status);
  if (admission !== undefined) return closedIndex(input, representation, admission);
  if (admitIndexBudget(input.budget) === "resource_rejected") {
    return closedIndex(input, representation, resourceRejectedCompleteness());
  }
  return pageAcceptingIndex(input, representation);
}

export function continueAcceptingIndex(
  previous: InformationIndex,
  input: Omit<AcceptingProjectionInput, "query_id" | "snapshot_id" | "result_version" | "prior_continuation">
): InformationIndex {
  if (previous.continuation === null) {
    return closedIndex({
      query_id: previous.query_id,
      snapshot_id: previous.snapshot_id,
      result_version: previous.result_version
    }, previous.representation, invalidatedCompleteness());
  }
  return projectAcceptingIndex({
    ...input,
    query_id: previous.query_id,
    snapshot_id: previous.snapshot_id,
    result_version: previous.result_version,
    prior_continuation: previous.continuation
  });
}

function pageAcceptingIndex(
  input: AcceptingProjectionInput,
  representation: InformationIndex["representation"]
): InformationIndex {
  const entries = sortEntries(acceptingEntries(input));
  const offset = resolvePageOffset(input, entries.length);
  const page = entries.slice(offset, offset + input.budget.page_budget);
  const remaining = Math.max(0, entries.length - offset - page.length);
  const expandPayload = input.expand_payload !== false;
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    query_id: input.query_id,
    snapshot_id: input.snapshot_id,
    result_version: input.result_version,
    entries: page,
    completeness: composeCompleteness({
      observer: input.observer,
      interpretation_status: input.interpretation_status,
      total: entries.length,
      remaining,
      omitted_payload: expandPayload && omittedPayload(input.support, input.budget.page_budget),
      expand_payload: expandPayload
    }),
    continuation: nextContinuation(input, remaining, offset + page.length),
    representation
  };
}

function acceptingEntries(input: AcceptingProjectionInput): IndexEntry[] {
  const entries: IndexEntry[] = [];
  for (const value of input.snapshot.values) {
    const entry = indexEntryForValue(value, input);
    if (entry !== null) entries.push(entry);
  }
  return entries;
}

function indexEntryForValue(
  value: FieldValue,
  input: AcceptingProjectionInput
): IndexEntry | null {
  if (!value.accepting) return null;
  if (value.milligrades <= input.view.threshold_milligrades) return null;
  if (!facetsAccept(value, input)) return null;
  const role = input.roles?.get(value.state.object_id) ?? "associated";
  if (role === "routing_only" && !input.view.include_routing_only) return null;
  if (!input.view.requested_roles.includes(role)) return null;
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    object_id: value.state.object_id,
    hypothesis_id: value.state.hypothesis_id,
    output_binding: value.state.binding_context,
    role,
    association_milligrades: value.milligrades,
    claim: input.claims?.get(value.state.object_id) ?? "unknown",
    explanation_ids: explanationIdsForEntry(value, input)
  };
}

function facetsAccept(value: FieldValue, input: AcceptingProjectionInput): boolean {
  if (input.snapshot.facets.length === 0) return true;
  const vectors = facetsForCandidate(value, input);
  if (vectors.length === 0) return false;
  return evaluateFacetPredicate(
    facetModeForValue(value, input),
    vectors,
    input.view.threshold_milligrades
  );
}

function facetsForCandidate(
  value: FieldValue,
  input: AcceptingProjectionInput
): readonly FacetVector[] {
  const facets = input.snapshot.facets;
  if (facets.length === 0) return [];
  const identity = facetPathId(value.state);
  return facets.filter((vector) => vector.path_id === identity);
}

function facetModeForValue(value: FieldValue, input: AcceptingProjectionInput): FacetMode {
  for (const transition of input.snapshot.retained_transitions) {
    if (transition.to.object_id !== value.state.object_id) continue;
    const override = input.relation_facet_modes?.get(transition.relation_kind);
    if (override !== undefined) return override;
  }
  return input.view.facet_mode;
}

function explanationIdsForEntry(
  value: FieldValue,
  input: AcceptingProjectionInput
): readonly string[] {
  if (input.expand_payload === false || input.support === undefined) return [];
  const ids: string[] = [];
  for (const record of input.support) {
    if (!supportBelongsTo(record, value)) continue;
    for (const witness of selectFeasibleWitnesses(record.witnesses, input.budget.page_budget)) {
      ids.push(witness.witness_id);
    }
  }
  return ids;
}

function supportBelongsTo(
  record: SupportRecord,
  value: FieldValue
): boolean {
  const named = [record.proposition_id, ...record.witnesses.flatMap((witness) => [...witness.premises])];
  return named.includes(value.state.object_id) || named.includes(value.state.hypothesis_id);
}

function omittedPayload(
  support: readonly SupportRecord[] | undefined,
  pageBudget: number
): boolean {
  if (support === undefined) return false;
  let complete = 0;
  let feasible = 0;
  for (const record of support) {
    for (const witness of record.witnesses) {
      if (!witness.complete) continue;
      complete += 1;
      if (witness.cost <= pageBudget) feasible += 1;
    }
  }
  return complete > 0 && feasible === 0;
}

function sortEntries(entries: readonly IndexEntry[]): IndexEntry[] {
  // Identity serialization is presentation only; milligrades and fusion ranks are not keys.
  return [...entries].sort((left, right) => compareText(entrySortKey(left), entrySortKey(right)));
}

function entrySortKey(entry: IndexEntry): string {
  return stableStringify({
    object_id: entry.object_id,
    hypothesis_id: entry.hypothesis_id,
    output_binding: entry.output_binding
  });
}

function resolvePageOffset(input: AcceptingProjectionInput, total: number): number {
  if (input.page_offset !== undefined) return Math.max(0, input.page_offset);
  const cursor = input.prior_continuation?.cursor;
  if (cursor === undefined) return 0;
  const resume = RESUME_CURSOR.exec(cursor);
  if (resume !== null) return Number(resume[1]);
  const matched = OFFSET_CURSOR.exec(cursor);
  if (matched === null) return total;
  return Number(matched[1]);
}

function continuationCursorInvalid(input: AcceptingProjectionInput): boolean {
  if (input.page_offset !== undefined) return false;
  const cursor = input.prior_continuation?.cursor;
  if (cursor === undefined) return false;
  return !OFFSET_CURSOR.test(cursor) && !RESUME_CURSOR.test(cursor);
}

function nextContinuation(
  input: AcceptingProjectionInput,
  remaining: number,
  nextOffset: number
): Continuation | null {
  if (input.expires_at === undefined) return null;
  const observerOpen = input.observer?.outcome.status === "open"
    || input.observer?.outcome.status === "interrupted";
  if (remaining <= 0 && !observerOpen) return null;
  const cursor = encodeResumeCursor(nextOffset, input.resume_cursors);
  if (cursor === null) return null;
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    continuation_id: `page-${nextOffset}`,
    query_id: input.query_id,
    snapshot_id: input.snapshot_id,
    result_version: input.result_version,
    expires_at: input.expires_at,
    cursor
  };
}

function encodeResumeCursor(
  offset: number,
  resume: Readonly<Record<string, string | null>> | undefined
): string | null {
  const parts = [`o${String(offset)}`];
  if (resume !== undefined) {
    for (const [key, value] of Object.entries(resume)) {
      if (value === null) continue;
      parts.push(`${key}:${value}`);
    }
  }
  const cursor = parts.join("|");
  return cursor.length >= 1 && cursor.length <= 256 ? cursor : null;
}

function representationDecision(pageBudget: number): InformationIndex["representation"] {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    policy: REPRESENTATION_POLICY,
    page_budget: pageBudget,
    identity_tie_break: "serialization"
  };
}

function closedIndex(
  input: Readonly<{
    readonly query_id: string;
    readonly snapshot_id: string;
    readonly result_version: string;
  }>,
  representation: InformationIndex["representation"],
  completeness: InformationIndex["completeness"]
): InformationIndex {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    query_id: input.query_id,
    snapshot_id: input.snapshot_id,
    result_version: input.result_version,
    entries: [],
    completeness,
    continuation: null,
    representation
  };
}

function independentFacetPredicate(vectors: readonly FacetVector[], threshold: number): boolean {
  if (vectors.length === 0) return false;
  const width = Math.max(...vectors.map((vector) => vector.coordinates.length));
  for (let index = 0; index < width; index += 1) {
    let best = MILLIGRADE_BOTTOM;
    for (const vector of vectors) {
      const value = vector.coordinates[index] ?? MILLIGRADE_BOTTOM;
      if (value > best) best = value;
    }
    if (best <= threshold) return false;
  }
  return true;
}
