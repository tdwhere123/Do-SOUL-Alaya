import { CoreError } from "../../shared/errors.js";

// One demand, four views/operators. This is not a caller-configurable strategy registry.
const OPPORTUNITY_CYCLE = ["original-lexical", "original-vector", "hint-lexical", "hint-vector"] as const;
type LaneId = typeof OPPORTUNITY_CYCLE[number];

/** Omission means unprovided, not an empty hit or an inferred window. */
export type NativeRoutePosition = Readonly<
  { status: "unavailable"; reason: string } |
  { status: "captured"; reference: string; start: number; end: number }
>;
export type NativeRouteOccurrence = Readonly<{
  reference: string; root_key: string; native_rank: number;
  window?: NativeRoutePosition; hit?: NativeRoutePosition;
}>;
export type NativeRouteLane = Readonly<{ lane: LaneId; scope: string } & (
  { state: "absent" | "disabled" | "measured-empty" } |
  { state: "unavailable"; reason: string } |
  { state: "exact-captured"; occurrences: readonly NativeRouteOccurrence[] }
)>;
export type NativeRoutePending = Readonly<{
  ordinal: number; lane: LaneId; scope: string; occurrence: NativeRouteOccurrence;
}>;
/** The caller owns admission, effects and metering. Phase names are caller facts, not receipts. */
export type NativeRouteAdmission = Readonly<
  { status: "admitted"; started_phase: string } |
  { status: "denied" | "unknown"; started_phase: string; reason: string } |
  { status: "resource_refused"; started_phase: string | null; reason: string }
>;
type NominationDecision = "admitted_new_root" | "admitted_duplicate" | "nomination_limit" |
  "denied" | "admission_unknown" | "resource_refused";
type NominationStop = "attempt_limit" | "captured_pages_exhausted" | "resource_refused_before_start" |
  "resource_refused_after_start" | "admission_unknown";
type NominationTrace = Readonly<{
  pending: NativeRoutePending; outcome: NativeRouteAdmission; decision: NominationDecision;
}>;

function requireFact(condition: boolean, message: string): asserts condition {
  if (!condition) throw new CoreError("VALIDATION", message);
}
function nonempty(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function integer(value: number, minimum = 0): boolean { return Number.isSafeInteger(value) && value >= minimum; }

function validatePosition(position: NativeRoutePosition | undefined): void {
  if (position === undefined) return;
  requireFact(position !== null && typeof position === "object", "invalid native position");
  if (position.status === "unavailable") requireFact(nonempty(position.reason), "missing native position reason");
  else {
    requireFact(position.status === "captured" && nonempty(position.reference) && integer(position.start) &&
      integer(position.end) && position.end > position.start, "invalid captured native position");
  }
  Object.freeze(position);
}

/** Validate only the owned clone; never freeze or retain caller-owned objects. */
function validateLanes(lanes: readonly NativeRouteLane[]): void {
  requireFact(Array.isArray(lanes) && lanes.length === OPPORTUNITY_CYCLE.length, "four ordered native lanes required");
  const references = new Set<string>();
  for (let index = 0; index < lanes.length; index++) {
    const lane = lanes[index]!;
    requireFact(lane !== null && typeof lane === "object" && lane.lane === OPPORTUNITY_CYCLE[index] &&
      nonempty(lane.scope), "invalid native lane order or scope");
    requireFact(["absent", "disabled", "unavailable", "measured-empty", "exact-captured"].includes(lane.state),
      "invalid native lane state");
    if (lane.state !== "exact-captured") {
      requireFact(!("occurrences" in lane), "uncaptured lane cannot contain occurrences");
      if (lane.state === "unavailable") requireFact(nonempty(lane.reason), "missing native lane reason");
      continue;
    }
    requireFact(Array.isArray(lane.occurrences) && lane.occurrences.length > 0, "exact capture must be nonempty");
    let priorRank = 0;
    for (const occurrence of lane.occurrences) {
      requireFact(occurrence !== null && typeof occurrence === "object" && nonempty(occurrence.reference) &&
        nonempty(occurrence.root_key) && integer(occurrence.native_rank, 1) && occurrence.native_rank > priorRank,
      "native occurrences require increasing factual ranks and opaque identities");
      requireFact(!references.has(occurrence.reference), "ambiguous native occurrence reference");
      references.add(occurrence.reference); priorRank = occurrence.native_rank;
      validatePosition(occurrence.window); validatePosition(occurrence.hit); Object.freeze(occurrence);
    }
  }
}

/** Only captured pages are walked. End-of-capture says nothing about the full corpus. */
function capturedWalk(lanes: readonly NativeRouteLane[]) {
  const cursors = [0, 0, 0, 0];
  let turn = 0;
  return {
    peek: (): Omit<NativeRoutePending, "ordinal"> | null => {
      for (let skipped = 0; skipped < OPPORTUNITY_CYCLE.length; skipped++) {
        const index = (turn + skipped) % OPPORTUNITY_CYCLE.length, lane = lanes[index]!;
        if (lane.state !== "exact-captured") continue;
        const occurrence = lane.occurrences[cursors[index]!];
        if (occurrence !== undefined) return { lane: lane.lane, scope: lane.scope, occurrence };
      }
      return null;
    },
    advance: (lane: LaneId): void => {
      const index = OPPORTUNITY_CYCLE.indexOf(lane);
      cursors[index] = cursors[index]! + 1; turn = (index + 1) % OPPORTUNITY_CYCLE.length;
    },
    trace: () => lanes.map((lane, index) => {
      const consumed = cursors[index]!, occurrences = lane.state === "exact-captured" ? lane.occurrences : [];
      return { ...lane, consumed_occurrences: consumed, remaining_captured_occurrences: occurrences.length - consumed,
        last_native_rank: consumed === 0 ? null : occurrences[consumed - 1]!.native_rank };
    })
  };
}

function validateAdmission(outcome: NativeRouteAdmission): void {
  requireFact(outcome !== null && typeof outcome === "object" &&
    ["admitted", "denied", "unknown", "resource_refused"].includes(outcome.status), "invalid admission outcome");
  requireFact(nonempty(outcome.started_phase) || outcome.status === "resource_refused" && outcome.started_phase === null,
    "admission requires the caller's started phase");
  if (outcome.status !== "admitted") requireFact(nonempty(outcome.reason), "missing admission outcome reason");
}

/** Unwired request-local nomination. Acquisition's envelope owner must already admit these ceilings.
 * Resource refusal terminates even before start; only started opportunities advance the cursor.
 * Counters below are scheduling facts, never native debits; unknown native cost stays outside this kernel.
 */
export function createNativeRouteNomination(input: Readonly<{
  lanes: readonly NativeRouteLane[]; max_attempts: number; max_roots: number;
}>) {
  const captured = structuredClone(input);
  validateLanes(captured.lanes);
  requireFact(integer(captured.max_attempts, 1) && integer(captured.max_roots, 1) &&
    captured.max_roots <= captured.max_attempts, "invalid nomination ceilings");
  const walk = capturedWalk(captured.lanes), roots = new Map<string, NativeRoutePending[]>();
  const trace: NominationTrace[] = [];
  const counts = { attempts_consumed: 0, admitted_roots: 0, duplicate_occurrences: 0, denied: 0,
    nomination_limit: 0, unknown: 0, resource_refused_before_start: 0, resource_refused_after_start: 0 };
  let pending: NativeRoutePending | null = null, ordinal = 0, stop: NominationStop | null = null;

  const settle = (offered: NativeRoutePending, outcome: NativeRouteAdmission): NominationDecision => {
    if (outcome.status === "resource_refused") {
      const reason = outcome.started_phase === null ? "resource_refused_before_start" : "resource_refused_after_start";
      counts[reason]++; stop = reason; return "resource_refused";
    }
    if (outcome.status === "unknown") { counts.unknown++; stop = "admission_unknown"; return "admission_unknown"; }
    if (outcome.status === "denied") { counts.denied++; return "denied"; }
    const key = offered.occurrence.root_key, existing = roots.get(key);
    if (existing !== undefined) { existing.push(offered); counts.duplicate_occurrences++; return "admitted_duplicate"; }
    // Continue walking after this ceiling: later duplicates can still retain useful factual hits.
    if (roots.size === captured.max_roots) { counts.nomination_limit++; return "nomination_limit"; }
    roots.set(key, [offered]); counts.admitted_roots++; return "admitted_new_root";
  };

  return {
    next: (): NativeRoutePending | null => {
      if (pending !== null) return pending;
      if (stop !== null) return null;
      // Never even pull a captured occurrence after the attempt ceiling.
      if (counts.attempts_consumed === captured.max_attempts) { stop = "attempt_limit"; return null; }
      const next = walk.peek();
      if (next === null) { stop = "captured_pages_exhausted"; return null; }
      pending = Object.freeze({ ordinal: ++ordinal, ...next }); return pending;
    },
    commit: (pendingOrdinal: number, supplied: NativeRouteAdmission): NominationDecision => {
      const outcome = structuredClone(supplied);
      requireFact(pending !== null && pending.ordinal === pendingOrdinal, "stale or already settled nomination");
      validateAdmission(outcome);
      const offered = pending;
      if (outcome.started_phase !== null) { counts.attempts_consumed++; walk.advance(offered.lane); }
      const decision = settle(offered, outcome);
      trace.push({ pending: offered, outcome, decision }); pending = null;
      return decision;
    },
    snapshot: () => structuredClone({ stop, pending, counts, lanes: walk.trace(), trace,
      roots: [...roots].map(([root_key, occurrences]) => ({ root_key, occurrences })) })
  };
}

export type NativeRoutePoolMember = Readonly<{
  record_id: string;
  /** Captured catalog position; null is genuinely unavailable, not array index. */
  catalog_position: number | null;
}>;
export type NativeRouteAssociation = Readonly<{
  occurrence_reference: string; root_key: string; record_id: string;
}>;
type AccessTrace = Readonly<{
  lane: LaneId; scope: string; occurrence: NativeRouteOccurrence; record_id: string; decision: "placed" | "duplicate";
}>;

function validateAccessMembership(input: Readonly<{
  pool: readonly NativeRoutePoolMember[]; acquired_root_keys: readonly string[];
  associations: readonly NativeRouteAssociation[];
}>, lanes: readonly NativeRouteLane[]) {
  const members = new Set<string>(), positions = new Set<number>();
  for (const member of input.pool) {
    requireFact(nonempty(member.record_id) && !members.has(member.record_id), "invalid closed pool membership");
    members.add(member.record_id);
    if (member.catalog_position === null) continue;
    requireFact(integer(member.catalog_position) && !positions.has(member.catalog_position), "ambiguous catalog position");
    positions.add(member.catalog_position);
  }
  const acquired = new Set(input.acquired_root_keys);
  requireFact(acquired.size === input.acquired_root_keys.length && input.acquired_root_keys.every(nonempty),
    "invalid acquired nomination membership");
  const occurrences = new Map(lanes.flatMap(lane => lane.state === "exact-captured" ?
    lane.occurrences.map(occurrence => [occurrence.reference, occurrence] as const) : []));
  const associations = new Map<string, NativeRouteAssociation>(), rootRecords = new Map<string, string>();
  for (const association of input.associations) {
    const occurrence = occurrences.get(association.occurrence_reference), prior = rootRecords.get(association.root_key);
    requireFact(occurrence !== undefined && occurrence.root_key === association.root_key && acquired.has(association.root_key) &&
      members.has(association.record_id), "association is outside captured or acquired membership");
    requireFact(!associations.has(association.occurrence_reference) && (prior === undefined || prior === association.record_id),
      "ambiguous supplied native association");
    associations.set(association.occurrence_reference, association); rootRecords.set(association.root_key, association.record_id);
  }
  requireFact(associations.size === occurrences.size, "every eligible occurrence requires a verified association");
  return associations;
}

/** Access-only permutation over the baseline's exact closed pool, not a receipt or a completeness certificate.
 * The bridge supplies only eligible occurrences and verified associations. No source-id join or identity derivation occurs.
 * Global unvisited sources do not invalidate a total order over this independently closed pool.
 */
export function orderNativeRouteAccess(input: Readonly<{
  lanes: readonly NativeRouteLane[]; pool: readonly NativeRoutePoolMember[];
  acquired_root_keys: readonly string[]; associations: readonly NativeRouteAssociation[]; unvisited_sources: boolean;
}>) {
  const captured = structuredClone(input);
  validateLanes(captured.lanes);
  requireFact(typeof captured.unvisited_sources === "boolean", "missing global source residual state");
  const associations = validateAccessMembership(captured, captured.lanes), walk = capturedWalk(captured.lanes);
  const recordIds: string[] = [], placed = new Set<string>(), trace: AccessTrace[] = [];
  for (let next = walk.peek(); next !== null; next = walk.peek()) {
    const recordId = associations.get(next.occurrence.reference)!.record_id;
    const decision = placed.has(recordId) ? "duplicate" : "placed";
    trace.push({ ...next, record_id: recordId, decision });
    if (decision === "placed") { placed.add(recordId); recordIds.push(recordId); }
    walk.advance(next.lane);
  }
  const tail = captured.pool.filter(member => !placed.has(member.record_id));
  const missing = tail.filter(member => member.catalog_position === null).map(member => member.record_id);
  const local = { pool_record_ids: captured.pool.map(member => member.record_id), acquired_root_keys: captured.acquired_root_keys,
    unvisited_sources: captured.unvisited_sources, lanes: walk.trace(), trace };
  if (missing.length > 0) return { ...local, status: "non_total" as const,
    reason: "missing_catalog_position" as const, missing_record_ids: missing };
  tail.sort((left, right) => left.catalog_position! - right.catalog_position!);
  return { ...local, status: "ordered" as const, record_ids: [...recordIds, ...tail.map(member => member.record_id)] };
}
