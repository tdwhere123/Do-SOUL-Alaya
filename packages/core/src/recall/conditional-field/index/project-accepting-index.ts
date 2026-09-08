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
  type Proposition,
  type RequestBudget,
  type SupportRecord
} from "@do-soul/alaya-protocol";
import { compareText } from "../../../shared/compare-text.js";
import { stableStringify } from "../../../shared/stable-stringify.js";
import { composedFacetPathId, facetBelongsToOutput } from "../engine/path-composition.js";
import { groundedOutputDerivations, type GroundingProgress } from "../engine/output-derivations.js";
import type { BoundSourceFacts } from "../engine/binding-environment.js";
import { productStateNodeId } from "../reference/bind-max-min.js";
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
  recoverExplanationForest,
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
  readonly projection_scan_offset?: number;
  readonly projection_generation?: number;
  readonly delivered_product_ids?: ReadonlySet<string>;
  readonly delivered_entry_revisions?: Readonly<Record<string, string>>;
  readonly on_projection_progress?: (offset: number) => void;
  readonly expires_at?: string;
  readonly as_of?: string;
  readonly lifetime_now?: string;
  readonly prior_continuation?: Continuation | null;
  readonly observer?: ObserverCoverage;
  readonly interpretation_status?: QueryInterpretationStatus;
  readonly interpretation_id?: string;
  readonly interpretation_clock?: string;
  readonly model_id?: string;
  readonly derivations?: readonly Derivation[];
  readonly output_derivations?: Readonly<Record<string, readonly string[]>>;
  readonly transition_derivations?: Readonly<Record<string, string>>;
  readonly source_facts?: Readonly<Record<string, BoundSourceFacts>>;
  readonly grounding_progress?: GroundingProgress;
  readonly grounding_complete?: boolean;
  readonly remaining_memory_bytes?: number;
  readonly on_grounding_progress?: (progress: GroundingProgress, retainedBytes: number) => void;
  readonly claim_propositions?: ReadonlyMap<string, Proposition>;
  readonly on_remaining_reserve?: (remaining: number) => void;
  readonly finalize_payload?: (entries: readonly IndexEntry[], remaining: number) => {
    readonly remaining: number; readonly complete: boolean; readonly retryable?: boolean };
  readonly payload_work_per_entry?: number;
  readonly payload_generation?: string;
  readonly relation_facet_modes?: ReadonlyMap<string, FacetMode>;
  readonly expand_payload?: boolean;
  readonly resume_cursors?: Readonly<Record<string, string | null>>;
  readonly support_work_status?: "complete" | "open";
  readonly remaining_reserve?: number;
  readonly resource_work?: "complete" | "open";
  readonly payload_work?: "complete" | "open";
}>;

const OFFSET_CURSOR = /^offset-(\d+)$/u;
const RESUME_CURSOR = /^o(\d+)(?:\|(.*))?$/u;
const PROJECTION_CURSOR = /^p(\d+)(?:g(\d+))?(?:r(\d+))?$/u;
const REPRESENTATION_POLICY = "construct_index_then_page_then_payload" as const;
const MAX_PAYLOAD_MEMORY_BYTES = 16_384;

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
  if (input.transition_derivations !== undefined && input.output_derivations === undefined) {
    const availableMemory = input.remaining_memory_bytes ?? input.budget.memory_bytes;
    const payloadMemory = input.finalize_payload === undefined ? 0
      : Math.min(MAX_PAYLOAD_MEMORY_BYTES, Math.floor(availableMemory / 4));
    const grounded = groundedOutputDerivations({ seeds: input.snapshot.seeds,
      transitions: input.snapshot.retained_transitions, derivations: input.derivations ?? [],
      transition_derivations: input.transition_derivations, source_facts: input.source_facts,
      progress: input.grounding_progress, memory_bytes: availableMemory - payloadMemory,
      allowance: input.remaining_reserve ?? input.budget.finalization_reserve });
    input.on_grounding_progress?.(grounded.progress, grounded.retained_bytes);
    input = { ...input, derivations: grounded.derivations, output_derivations: grounded.roots, grounding_progress: grounded.progress,
      grounding_complete: grounded.complete,
      ...(grounded.work > 0 && input.delivered_product_ids !== undefined ? { projection_scan_offset: 0 } : {}),
      remaining_reserve: Math.max(0, (input.remaining_reserve ?? input.budget.finalization_reserve) - grounded.work),
      ...(!grounded.complete ? { resource_work: "open" } : {}) };
  }
  const projected = acceptingEntries(input);
  input.on_projection_progress?.(projected.next);
  const entries = sortEntries(projected.entries);
  if (continuationSetMismatch(input, entries)) {
    return closedIndex(input, representation, invalidatedCompleteness());
  }
  const offset = resolvePageOffset(input, entries.length);
  const page = entries.slice(offset, offset + input.budget.page_budget);
  const remaining = Math.max(projected.truncated ? 1 : 0, entries.length - offset - page.length);
  const finalized = input.finalize_payload?.(page, projected.remaining);
  const retryPayload = finalized !== undefined && !finalized.complete && finalized.retryable !== false;
  if (finalized !== undefined) input = { ...input, payload_work: finalized.complete ? "complete" : "open" };
  input.on_remaining_reserve?.(finalized?.remaining ?? projected.remaining);
  const mixedPayload = mixedPayloadGeneration(input.snapshot_id, input.payload_generation);
  const expandPayload = input.expand_payload !== false && !mixedPayload;
  const omittedPayload = mixedPayload || input.payload_work === "open"
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
    explanations: recoverExplanationForest(page.flatMap((entry) => entry.explanation_ids), input.derivations ?? []),
    completeness: composeCompleteness({
      observer: input.observer,
      interpretation_status: input.interpretation_status,
      total: entries.length + (input.delivered_product_ids?.size
        ?? Number(PROJECTION_CURSOR.exec(input.prior_continuation?.cursor ?? "")?.[1] ?? 0)),
      remaining,
      omitted_payload: omittedPayload,
      expand_payload: expandPayload,
      ...(mixedPayload ? { mixed_generation: true } : {}),
      ...(input.support_work_status === undefined ? {} : { explanation_work: input.support_work_status }),
      ...(resourceOpen ? { resource_work: "open" as const } : {})
    }),
    continuation: nextContinuation({ ...input, ...(resourceOpen || omittedPayload ? { resource_work: "open" } : {}) },
      remaining, retryPayload ? offset : offset + page.length, entries,
      retryPayload ? Number(PROJECTION_CURSOR.exec(input.prior_continuation?.cursor ?? "")?.[1] ?? 0)
        : projected.truncated || input.delivered_product_ids !== undefined ? projected.next : undefined),
    representation
  };
}

function acceptingEntries(
  input: AcceptingProjectionInput
): { readonly entries: IndexEntry[]; readonly truncated: boolean; readonly next: number; readonly remaining: number } {
  const entries: IndexEntry[] = [];
  let allowance = input.remaining_reserve;
  let truncated = false;
  let groundingDeferred = false;
  const start = input.projection_scan_offset
    ?? Number(PROJECTION_CURSOR.exec(input.prior_continuation?.cursor ?? "")?.[1] ?? 0);
  const values = [...input.snapshot.values].sort((a, b) => compareText(valueSortKey(a), valueSortKey(b)));
  let next = start;
  for (const value of values.slice(start)) {
    if (input.delivered_entry_revisions === undefined && input.delivered_product_ids?.has(productStateNodeId(value.state))) { next += 1; continue; }
    const grounded = input.grounding_complete !== false || groundedSeedAccepts(value, input);
    const entry = grounded ? indexEntryForValue(value, input) : null;
    if (entry !== null && input.delivered_entry_revisions?.[productStateNodeId(value.state)] === indexEntryRevision(entry)) {
      next += 1;
      continue;
    }
    if (allowance !== undefined) {
      const payloadReserve = input.finalize_payload === undefined ? 0
        : (input.payload_work_per_entry ?? 1) * (entries.length + (value.accepting && grounded ? 1 : 0));
      if (allowance < 1 + payloadReserve) {
        truncated = true;
        break;
      }
      allowance -= 1;
    }
    if (!grounded) {
      groundingDeferred ||= value.accepting;
      next += 1;
      continue;
    }
    if (entry !== null) entries.push(entry);
    next += 1;
    if (input.remaining_reserve !== undefined && entries.length >= input.budget.page_budget && next < values.length) { truncated = true; break; }
  }
  return { entries, truncated: truncated || groundingDeferred, next, remaining: allowance ?? input.budget.finalization_reserve };
}

export function indexEntryRevision(entry: IndexEntry): string {
  return createHash("sha256").update(stableStringify(entry)).digest("hex");
}

function groundedSeedAccepts(value: FieldValue, input: AcceptingProjectionInput): boolean {
  const key = productStateNodeId(value.state);
  const roots = new Set(input.output_derivations?.[key] ?? []);
  return input.derivations?.some((root) => roots.has(root.derivation_id) && root.kind === "leaf"
      && root.observation_ids.includes(value.state.object_id)
      && (root.association_milligrades ?? 0) >= value.milligrades) === true
    && input.snapshot.seeds.some((seed) => productStateNodeId(seed.state) === key
      && seed.milligrades >= value.milligrades);
}

function indexEntryForValue(
  value: FieldValue,
  input: AcceptingProjectionInput
): IndexEntry | null {
  if (!value.accepting) return null;
  if (value.milligrades <= input.view.threshold_milligrades) return null;
  if (!facetsAccept(value, input)) return null;
  const key = productStateNodeId(value.state);
  const role = input.roles?.get(key) ?? "associated";
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
    claim: input.claims?.get(key) ?? "unknown",
    ...(input.claim_propositions?.get(key) === undefined ? {} : {
      claim_proposition_id: input.claim_propositions.get(key)!.proposition_id,
      claim_proposition: input.claim_propositions.get(key)
    }),
    explanation_ids: explanationIdsForEntry({
      value,
      support: input.support,
      derivations: input.derivations,
      output_derivations: input.output_derivations,
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
  const seeds = input.snapshot.seeds.filter((seed) => productStateNodeId(seed.state) === productStateNodeId(value.state));
  return [...facets.filter((vector) => facetBelongsToOutput(vector.path_id, value.state)),
    ...seeds.map((seed) => ({ schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      path_id: composedFacetPathId(seed.state, "seed"), coordinates: [seed.milligrades] }))];
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

function valueSortKey(value: FieldValue): string {
  return entrySortKey({ object_id: value.state.object_id, hypothesis_id: value.state.hypothesis_id,
    output_binding: value.state.binding_context, program_state: value.state.program_state, time_state: value.state.time_state });
}

function entrySortKey(entry: Pick<IndexEntry, "object_id" | "hypothesis_id" | "output_binding" | "program_state" | "time_state">): string {
  return stableStringify({
    object_id: entry.object_id,
    hypothesis_id: entry.hypothesis_id,
    output_binding: entry.output_binding,
    program_state: entry.program_state ?? "",
    time_state: entry.time_state ?? ""
  });
}

function resolvePageOffset(input: AcceptingProjectionInput, total: number): number {
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

function continuationCursorInvalid(input: AcceptingProjectionInput): boolean {
  if (input.page_offset !== undefined) return false;
  const cursor = input.prior_continuation?.cursor;
  if (cursor === undefined) return false;
  return !OFFSET_CURSOR.test(cursor) && !RESUME_CURSOR.test(cursor) && !PROJECTION_CURSOR.test(cursor);
}

function continuationSetMismatch(
  input: AcceptingProjectionInput,
  entries: readonly IndexEntry[]
): boolean {
  if (input.delivered_product_ids !== undefined) return false;
  if (input.page_offset !== undefined) return false;
  const cursor = input.prior_continuation?.cursor;
  if (cursor === undefined) return false;
  if (PROJECTION_CURSOR.test(cursor)) return false;
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
  entries: readonly IndexEntry[],
  projectionOffset?: number
): Continuation | null {
  if (input.expires_at === undefined) return null;
  const observerOpen = input.observer?.outcome.status === "open"
    || input.observer?.outcome.status === "interrupted";
  if (remaining <= 0 && !observerOpen && input.resource_work !== "open" && input.support_work_status !== "open") return null;
  const cursor = projectionOffset === undefined
    ? encodeResumeCursor(nextOffset, entries.slice(0, nextOffset).map(entrySortKey))
    : `p${projectionOffset}g${input.grounding_progress?.completed_work ?? 0}`
      + (input.projection_generation === undefined ? "" : `r${input.projection_generation}`);
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
