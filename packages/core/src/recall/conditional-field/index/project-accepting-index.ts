import { createHash } from "node:crypto";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  MILLIGRADE_BOTTOM,
  type ClaimState,
  type Continuation,
  type Derivation,
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
  type SupportRecord
} from "@do-soul/alaya-protocol";
import { compareText } from "../../../shared/compare-text.js";
import { stableStringify } from "../../../shared/stable-stringify.js";
import { facetBelongsToOutput } from "../engine/path-composition.js";
import {
  admitIndexBudget,
  completenessForInterpretationStatus,
  composeCompleteness,
  continuationInvalidated,
  invalidatedCompleteness,
  resourceRejectedCompleteness,
  type ObserverCoverage
} from "./completeness.js";
import {
  explanationIdsForEntry,
  mixedPayloadGeneration,
  omittedStructuredPayload
} from "./explanation.js";

export type { ObserverCoverage } from "./completeness.js";
export {
  outputAttributionHandle,
  selectFeasibleWitnesses,
  witnessAttributionHandle
} from "./explanation.js";

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
  readonly interpretation_id?: string;
  readonly interpretation_clock?: string;
  readonly model_id?: string;
  readonly derivations?: readonly Derivation[];
  readonly payload_generation?: string;
  readonly relation_facet_modes?: ReadonlyMap<string, FacetMode>;
  readonly expand_payload?: boolean;
  readonly resume_cursors?: Readonly<Record<string, string | null>>;
  readonly support_work_status?: "complete" | "open";
  readonly remaining_reserve?: number;
  readonly resource_work?: "complete" | "open";
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

export function projectAcceptingIndex(input: AcceptingProjectionInput): InformationIndex {
  const representation = representationDecision(input.budget.page_budget);
  const interpretationId = resolveInterpretationId(input);
  const epochInput = { ...input, interpretation_id: interpretationId };
  if (continuationInvalidated(epochInput) || continuationCursorInvalid(input)) {
    return closedIndex(epochInput, representation, invalidatedCompleteness());
  }
  const admission = input.interpretation_status === undefined
    ? undefined
    : completenessForInterpretationStatus(input.interpretation_status);
  if (admission !== undefined) return closedIndex(epochInput, representation, admission);
  if (admitIndexBudget(input.budget) === "resource_rejected") {
    return closedIndex(epochInput, representation, resourceRejectedCompleteness());
  }
  return pageAcceptingIndex(epochInput, representation);
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
    prior_continuation: previous.continuation,
    interpretation_id: input.interpretation_id ?? previous.continuation.interpretation_id
  });
}

function pageAcceptingIndex(
  input: AcceptingProjectionInput,
  representation: InformationIndex["representation"]
): InformationIndex {
  const projected = acceptingEntries(input);
  const entries = sortEntries(projected.entries);
  if (continuationSetMismatch(input, entries)) {
    return closedIndex(input, representation, invalidatedCompleteness());
  }
  const offset = resolvePageOffset(input, entries.length);
  const page = entries.slice(offset, offset + input.budget.page_budget);
  const remaining = Math.max(0, entries.length - offset - page.length);
  const mixedPayload = mixedPayloadGeneration(input.snapshot_id, input.payload_generation);
  const expandPayload = input.expand_payload !== false && !mixedPayload;
  const omittedPayload = mixedPayload
    || (expandPayload && omittedStructuredPayload(
      input.support,
      input.derivations,
      input.budget.page_budget
    ));
  const resourceOpen = projected.truncated || input.resource_work === "open";
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
      omitted_payload: omittedPayload,
      expand_payload: expandPayload,
      ...(mixedPayload ? { mixed_generation: true } : {}),
      ...(input.support_work_status === undefined ? {} : { explanation_work: input.support_work_status }),
      ...(resourceOpen ? { resource_work: "open" as const } : {})
    }),
    continuation: nextContinuation(input, remaining, offset + page.length, entries),
    representation
  };
}

function acceptingEntries(
  input: AcceptingProjectionInput
): { readonly entries: IndexEntry[]; readonly truncated: boolean } {
  const entries: IndexEntry[] = [];
  let allowance = input.remaining_reserve;
  let truncated = false;
  for (const value of input.snapshot.values) {
    if (allowance !== undefined) {
      if (allowance < 1) {
        truncated = true;
        break;
      }
      allowance -= 1;
    }
    const entry = indexEntryForValue(value, input);
    if (entry !== null) entries.push(entry);
  }
  return { entries, truncated };
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
  const mixedPayload = mixedPayloadGeneration(input.snapshot_id, input.payload_generation);
  const expandPayload = input.expand_payload !== false && !mixedPayload;
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    object_id: value.state.object_id,
    hypothesis_id: value.state.hypothesis_id,
    output_binding: value.state.binding_context,
    program_state: value.state.program_state,
    time_state: value.state.time_state,
    role,
    association_milligrades: value.milligrades,
    claim: input.claims?.get(value.state.object_id) ?? "unknown",
    explanation_ids: explanationIdsForEntry({
      value,
      support: input.support,
      derivations: input.derivations,
      page_budget: input.budget.page_budget,
      expand_payload: expandPayload
    })
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
  return facets.filter((vector) => facetBelongsToOutput(vector.path_id, value.state));
}

function facetModeForValue(value: FieldValue, input: AcceptingProjectionInput): FacetMode {
  for (const transition of input.snapshot.retained_transitions) {
    if (transition.to.object_id !== value.state.object_id) continue;
    const override = input.relation_facet_modes?.get(transition.relation_kind);
    if (override !== undefined) return override;
  }
  return input.view.facet_mode;
}

function sortEntries(entries: readonly IndexEntry[]): IndexEntry[] {
  // Identity serialization is presentation only; milligrades and fusion ranks are not keys.
  return [...entries].sort((left, right) => compareText(entrySortKey(left), entrySortKey(right)));
}

function entrySortKey(entry: IndexEntry): string {
  return stableStringify({
    object_id: entry.object_id,
    hypothesis_id: entry.hypothesis_id,
    output_binding: entry.output_binding,
    program_state: entry.program_state ?? "",
    time_state: entry.time_state ?? ""
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

function continuationSetMismatch(
  input: AcceptingProjectionInput,
  entries: readonly IndexEntry[]
): boolean {
  if (input.page_offset !== undefined) return false;
  const cursor = input.prior_continuation?.cursor;
  if (cursor === undefined) return false;
  const offset = resolvePageOffset(input, entries.length);
  if (offset === 0) return false;
  if (entries.length < offset) return true;
  const digest = resumeDigest(cursor);
  if (digest === undefined) return false;
  return digest !== identityDigest(entries.slice(0, offset).map(entrySortKey));
}

function nextContinuation(
  input: AcceptingProjectionInput,
  remaining: number,
  nextOffset: number,
  entries: readonly IndexEntry[]
): Continuation | null {
  if (input.expires_at === undefined) return null;
  const observerOpen = input.observer?.outcome.status === "open"
    || input.observer?.outcome.status === "interrupted";
  if (remaining <= 0 && !observerOpen) return null;
  const cursor = encodeResumeCursor(nextOffset, entries.slice(0, nextOffset).map(entrySortKey));
  if (cursor === null) return null;
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    continuation_id: `page-${nextOffset}`,
    query_id: input.query_id,
    snapshot_id: input.snapshot_id,
    result_version: input.result_version,
    expires_at: input.expires_at,
    cursor,
    ...(input.interpretation_id === undefined ? {} : { interpretation_id: input.interpretation_id })
  };
}

function encodeResumeCursor(offset: number, prefixKeys: readonly string[]): string | null {
  const cursor = `o${String(offset)}|${identityDigest(prefixKeys)}`;
  return cursor.length >= 1 && cursor.length <= 256 ? cursor : null;
}

function resumeDigest(cursor: string): string | undefined {
  const resume = RESUME_CURSOR.exec(cursor);
  const suffix = resume?.[2];
  return suffix === undefined || suffix.length === 0 ? undefined : suffix;
}

function identityDigest(keys: readonly string[]): string {
  return createHash("sha256").update(keys.join("\n")).digest("hex");
}

function resolveInterpretationId(input: AcceptingProjectionInput): string | undefined {
  if (input.interpretation_id !== undefined) return input.interpretation_id;
  const clock = input.interpretation_clock;
  const model = input.model_id;
  if (clock !== undefined && model !== undefined) {
    const joined = `${clock}+${model}`;
    return joined.length <= 256 ? joined : identityDigest([clock, model]);
  }
  return clock ?? model;
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
