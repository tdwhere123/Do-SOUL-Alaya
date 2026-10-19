import { canonicalJson } from "@do-soul/alaya-protocol";
import type { SourceSemanticObservation } from "../../../../core-daemon/src/runtime/recall-read-worker/source-semantic-observation.js";
import type { SourceSemanticNativeFacts } from "../../../../core-daemon/src/runtime/recall-read-worker/source-semantic-provenance.js";
import type { FrozenSourceIndexQualifications, FrozenSourceIndexQualificationPage } from "../recall-measurement/index-qualification.js";
import { frozenIndexMetadataMatchesNativeBinding } from "../recall-measurement/index-qualification.js";
import { sourceTargetJoinsGold } from "../measurement/source-gold-join.js";
import type { AnswerTurnSpan } from "./answer-spans.js";

/** Archive-owned, label-free call context. snapshot_id is the sealed file digest bound to the
 * restored native session, not a public recall snapshot/revision or a matching index label. */
export type ObservationCallScope = Readonly<{
  kind: "prepare_query" | "recall" | "continuation";
  request_id: number | null; session_id: string | null; query_key: string;
  snapshot_id: string | null; workspace_id: string; as_of: string;
}>;
export type ObservationCapturedFrame = Readonly<{ call: ObservationCallScope; observation: SourceSemanticObservation }>;
export type ObservationFrozenIndex = Readonly<{
  header: FrozenSourceIndexQualifications; pages: readonly FrozenSourceIndexQualificationPage[];
}>;
export type ObservationEvent = SourceSemanticObservation["events"][number] & Readonly<{
  request_id: number; session_id: string | null; call_kind: ObservationCallScope["kind"]; event_position: number;
}>;
export type ObservationAncestry = Readonly<{
  target: SourceSemanticObservation | null; frames: readonly ObservationCapturedFrame[];
  events: readonly ObservationEvent[]; complete: boolean; snapshot_bound: boolean;
  status: "usable" | "missing" | "ambiguous" | "unavailable"; issues: readonly string[];
}>;
type Origin = NonNullable<SourceSemanticNativeFacts["pool"]>["origin"];
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const originEqual = (a: Origin, b: Origin) => a !== null && b !== null && same(a, b);
const sealedSnapshot = (identity: string | null) => identity !== null && /^sha256:[a-f0-9]{64}$/.test(identity);

function sameCall(a: ObservationCallScope, b: ObservationCallScope): boolean {
  return a.request_id === b.request_id && a.kind === b.kind && a.query_key === b.query_key
    && a.snapshot_id === b.snapshot_id && a.session_id === b.session_id
    && a.workspace_id === b.workspace_id && a.as_of === b.as_of;
}
function bound(frame: ObservationCapturedFrame): boolean {
  const { call, observation } = frame, binding = observation.facts?.binding;
  return call.request_id !== null && observation.request_id === call.request_id && binding != null
    && call.session_id !== null && binding.session_id === call.session_id && binding.request_id === call.request_id
    && binding.operation === (call.kind === "continuation" ? "recall" : call.kind)
    && binding.workspace_id === call.workspace_id && binding.as_of === call.as_of;
}
function compatible(a: ObservationCapturedFrame, b: ObservationCapturedFrame): boolean {
  const x = a.call, y = b.call, ab = a.observation.facts?.binding, bb = b.observation.facts?.binding;
  return bound(a) && bound(b) && x.query_key === y.query_key && x.session_id === y.session_id
    && sealedSnapshot(x.snapshot_id) && x.snapshot_id === y.snapshot_id && x.workspace_id === y.workspace_id
    && x.as_of === y.as_of && ab?.snapshot_revision != null && ab.snapshot_revision === bb?.snapshot_revision
    && ab.index !== null && bb?.index != null && same(ab.index, bb.index);
}
export function observationFrameComplete(frame: SourceSemanticObservation): boolean {
  return frame.status === "observed" && frame.execution === "success" && frame.dropped_events === 0
    && frame.aggregates_complete && frame.issues.length === 0;
}

/** A target is selected by the full archived scope. Ancestors require actual object/lease
 * ancestry AND compatible query/snapshot bindings. Equal request numbers or pool labels never join. */
export function joinObservationFrames(call: ObservationCallScope, captured: readonly ObservationCapturedFrame[]): ObservationAncestry {
  const matches = captured.filter(row => sameCall(row.call, call));
  const empty = (status: ObservationAncestry["status"], issue: string): ObservationAncestry =>
    ({ target: null, frames: [], events: [], complete: false, snapshot_bound: false, status, issues: [issue] });
  if (call.request_id === null) return empty("missing", "observation_request_unscoped");
  if (matches.length !== 1) return empty(matches.length > 1 ? "ambiguous" : "missing",
    matches.length > 1 ? "ambiguous_observation_request" : "observation_missing_for_request");
  const target = matches[0]!, issues = new Set<string>(), selected = new Set<ObservationCapturedFrame>();
  if (target.observation.request_id !== call.request_id || target.observation.facts?.binding != null && !bound(target)) {
    return empty("unavailable", "native_call_binding_mismatch");
  }
  if (captured.filter(row => row.call.session_id === call.session_id && row.observation.request_id === call.request_id).length !== 1) {
    return empty("ambiguous", "ambiguous_native_request_identity");
  }
  const visiting = new Set<ObservationCapturedFrame>();
  const visit = (child: ObservationCapturedFrame): void => {
    if (selected.has(child)) return;
    if (visiting.has(child)) { issues.add("cyclic_native_ancestry"); return; }
    visiting.add(child);
    const facts = child.observation.facts;
    if (!bound(child)) issues.add("native_call_binding_unavailable");
    if (!sealedSnapshot(child.call.snapshot_id)) issues.add("sealed_snapshot_binding_unavailable");
    if (facts === undefined || !facts.complete || facts.issues.length > 0) issues.add("native_ancestry_detail_incomplete");
    for (const issue of facts?.issues ?? []) issues.add(`native_fact:${issue}`);
    const parentFor = (origin: Origin, predicate: (row: ObservationCapturedFrame) => boolean): void => {
      if (origin === null) { issues.add("native_origin_unknown"); return; }
      if (origin.session_id === child.call.session_id && origin.request_id === child.call.request_id) {
        if (!predicate(child)) issues.add("native_local_origin_unverified");
        return;
      }
      const parents = captured.filter(row => row.call.session_id === origin.session_id && row.call.request_id === origin.request_id);
      if (parents.length !== 1) { issues.add(parents.length === 0 ? "native_ancestor_missing" : "native_ancestor_ambiguous"); return; }
      const parent = parents[0]!;
      if (!predicate(parent) || !compatible(parent, child) || parent.call.kind === "continuation" && child.call.kind !== "continuation"
        || child.call.kind === "prepare_query" || parent.call.kind === "recall" && child.call.kind === "recall") {
        issues.add("native_ancestor_binding_mismatch"); return;
      }
      visit(parent);
    };
    if (facts?.pool != null) {
      if (facts.pool.use === "created") {
        const origin = facts.pool.origin;
        if (origin === null || origin.session_id !== child.call.session_id || origin.request_id !== child.call.request_id) {
          issues.add("created_pool_origin_mismatch");
        }
      } else parentFor(facts.pool.origin, row => row.observation.facts?.pool?.use === "created"
        && originEqual(row.observation.facts.pool.origin, facts.pool!.origin));
    }
    for (const read of facts?.lease_reads ?? []) {
      if (read.pool_origin !== null && facts?.pool != null && !originEqual(read.pool_origin, facts.pool.origin)) {
        issues.add("lease_pool_origin_mismatch"); continue;
      }
      if (read.plan_origin !== null && read.plan_origin.session_id !== child.call.session_id) {
        issues.add("lease_plan_origin_mismatch"); continue;
      }
      parentFor(read.origin, row => row.observation.facts?.lease_issues.some(issue => issue.handle_digest === read.handle_digest
        && issue.kind === read.kind && originEqual(issue.origin, read.origin)
        && same(issue.pool_origin, read.pool_origin) && same(issue.plan_origin, read.plan_origin)) === true
        && (row.observation.facts?.pool == null || originEqual(row.observation.facts.pool.origin, read.pool_origin)));
      if (read.origin === null || read.pool_origin === null && (read.kind === "library" || facts?.pool?.use === "reused")) {
        issues.add("native_origin_unknown");
      }
    }
    if (child.call.kind === "continuation" && !(facts?.lease_reads.some(read => read.plan_origin !== null) ?? false)) {
      issues.add("continuation_plan_ancestry_unknown");
    }
    if (child.call.kind === "recall" && facts?.pool?.use === "reused"
      && !facts.lease_reads.some(read => read.kind === "query")) issues.add("prepared_query_ancestry_unknown");
    visiting.delete(child); selected.add(child);
  };
  visit(target);
  const frames = [...selected];
  return { target: target.observation, frames, status: "usable", issues: [...issues],
    snapshot_bound: bound(target) && sealedSnapshot(call.snapshot_id), complete: issues.size === 0 && frames.every(row => observationFrameComplete(row.observation)),
    events: frames.flatMap(({ call: scope, observation }) => observation.events.map((event, event_position) =>
      ({ ...event, event_position, request_id: observation.request_id, session_id: scope.session_id, call_kind: scope.kind }))) };
}

/** Capture completeness describes the finite native union, not source census or legal-delivery optimum. */
export function observedFiniteUnion(joined: ObservationAncestry): Readonly<{
  complete: boolean; pool: NonNullable<SourceSemanticNativeFacts["pool"]> | null;
}> {
  const direct = joined.target?.facts?.pool;
  const origins = joined.target?.facts?.lease_reads.flatMap(read => read.pool_origin === null ? [] : [read.pool_origin]) ?? [];
  const candidates = joined.frames.flatMap(row => row.observation.facts?.pool == null ? [] : [row.observation.facts.pool])
    .filter(pool => origins.some(origin => originEqual(origin, pool.origin)));
  const pool = direct ?? (candidates.length > 0 && candidates.every(row => originEqual(row.origin, candidates[0]!.origin)
    && same(row.union, candidates[0]!.union)) ? candidates[0]! : null);
  const members = pool?.union.members ?? [];
  const unique = new Set(members.map(member => canonicalJson(member)));
  return { pool, complete: joined.target?.facts?.binding != null && pool !== null && pool.union.capture === "complete"
    && members.length === pool.union.source_count && unique.size === members.length };
}

export type ObservationIndexEligibility = Readonly<{
  status: "passed" | "failed" | "unknown"; lexical: "passed" | "failed" | "unknown";
  vector: "passed" | "failed" | "unknown"; reason: string;
  lexical_intervals: readonly Readonly<{ start: number; end: number }>[];
  vector_windows: FrozenSourceIndexQualificationPage["qualification"]["vector"]["windows"];
}>;
/** Exact row/window facts are useful only when both the sealed file AND native metadata bind.
 * A partial corpus census cannot invalidate a captured root, or close an absent one. */
export function observationIndexEligibility(span: AnswerTurnSpan, call: ObservationCallScope,
  joined: ObservationAncestry, frozen: ObservationFrozenIndex | null): ObservationIndexEligibility {
  const unknown = (reason: string): ObservationIndexEligibility => ({ status: "unknown", lexical: "unknown", vector: "unknown",
    reason, lexical_intervals: [], vector_windows: [] });
  if (frozen === null) return unknown("frozen_index_qualifications_unavailable");
  const { header, pages } = frozen, binding = joined.target?.facts?.binding;
  if (!joined.snapshot_bound || call.snapshot_id !== header.snapshot_identity || header.workspace_id !== call.workspace_id || binding == null
    || !frozenIndexMetadataMatchesNativeBinding(header, binding.index)) return unknown("frozen_index_file_or_metadata_binding_mismatch");
  const boundPages = pages.filter(page => page.snapshot_identity === header.snapshot_identity && page.index_identity === header.index_identity);
  const matching = boundPages.filter(page => page.qualification.source_id === span.source_id);
  if (matching.length === 0) {
    // Census closes root absence only if the complete archived page set was supplied.
    const full = header.source_census === "complete" && boundPages.length === header.pages && pages.length === header.pages
      && new Set(boundPages.map(page => page.qualification.source_id)).size === header.roots;
    return full ? { ...unknown("source_not_in_frozen_index_census"), status: "failed", lexical: "failed", vector: "failed" }
      : unknown("root_qualification_unobserved");
  }
  const roots = matching.map(page => page.qualification), first = roots[0]!;
  if (roots.some(root => !same(root.source, first.source) || !same(root.lexical, first.lexical)
    || root.currentness !== first.currentness) || first.source === null
    || !sourceTargetJoinsGold({ rank: 0, object_kind: "source_evidence", target: first.source.target }, span.target)) {
    return unknown("root_qualification_identity_or_page_conflict");
  }
  if (first.currentness !== "ready") return unknown(`root_currentness_${first.currentness}`);
  const covers = (start: number | null, end: number | null) => start !== null && end !== null && start <= span.start && end >= span.end;
  const lexical = first.lexical.status === "ready" && covers(first.lexical.start_byte, first.lexical.end_byte) ? "passed"
    : first.lexical.status === "not_indexed" || first.lexical.status === "ready" ? "failed" : "unknown";
  const windows = roots.flatMap(root => root.vector.windows);
  const ordinals = new Set(windows.map(window => window.ordinal));
  const pageConflict = ordinals.size !== windows.length || roots.some(root => root.vector.expected_windows !== first.vector.expected_windows
    || root.vector.generation_member !== first.vector.generation_member || root.vector.coverage_complete !== first.vector.coverage_complete);
  const missingPage = roots.some(root => root.vector.next_ordinal !== null
    && !roots.some(next => next.vector.windows[0]?.ordinal === root.vector.next_ordinal! + 1));
  const expected = first.vector.expected_windows;
  const exhaustive = !pageConflict && !missingPage && roots.some(root => root.vector.capture === "complete" && root.vector.next_ordinal === null)
    && (first.vector.generation_member === false || expected !== null && windows.length === expected
      && windows.every((_, i) => ordinals.has(i)));
  const vector = pageConflict ? "unknown" : windows.some(window => window.status === "ready" && covers(window.start_byte, window.end_byte)) ? "passed"
    : first.vector.status === "not_indexed" || exhaustive && windows.every(window => window.status !== "unknown") ? "failed" : "unknown";
  return { status: lexical === "passed" || vector === "passed" ? "passed"
    : lexical === "failed" && vector === "failed" ? "failed" : "unknown", lexical, vector,
    reason: pageConflict ? "vector_page_ancestry_conflict" : missingPage ? "vector_pages_incomplete" : "frozen_native_row_and_window_qualification",
    lexical_intervals: first.lexical.status === "ready" && first.lexical.start_byte !== null && first.lexical.end_byte !== null
      ? [{ start: first.lexical.start_byte, end: first.lexical.end_byte }] : [], vector_windows: windows };
}
