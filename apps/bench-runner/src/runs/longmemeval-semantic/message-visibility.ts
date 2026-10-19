import { sourceRecallTarget } from "@do-soul/alaya-protocol";
import { sourceTargetJoinsGold, type SourceGoldUnit } from "../measurement/source-gold-join.js";
import type { AnswerTurnGold, AnswerTurnSpan } from "./answer-spans.js";

export const CONSUMER_MESSAGE_VISIBILITY_CONTRACT = "consumer-message-visibility-v1" as const;

/** One consumer-visible UTF-8 interval after caller-owned delivery admission. */
export type ConsumerVisibilityInterval = Readonly<{
  /** Frozen global delivery rank occupied by this source result. Ranks of non-source results may be skipped. */
  rank: number;
  /** Full source identity. Intervals never merge across a different version, digest or workspace. */
  target: SourceGoldUnit;
  /** Half-open UTF-8 byte offsets in the published body. */
  start: number;
  end: number;
}>;

/** One delivery page. A continuation pointer is not evidence of the next page's content. */
export type ConsumerVisibilityPage = Readonly<{
  /** 1-based frozen page order; the caller must provide the complete sequence from page 1. */
  page: number;
  status: "observed" | "unobserved" | "not_run";
  reason: string | null;
  /** Caller-admitted delivery slots occupied on this page, including memory and non-body results. */
  occupied_slots: number;
  /** True only when every admitted slot on this page was captured, including a terminal empty page. */
  complete: boolean;
  continuation: "none" | "present" | "unknown";
  /** Source-body intervals only; this array need not have one entry per occupied slot. */
  intervals: readonly ConsumerVisibilityInterval[];
}>;

/** Caller-owned admission: an observed absence may close as a miss only when the caller can prove it. */
export type ConsumerVisibilityAdmission =
  | Readonly<{ status: "closed" }>
  | Readonly<{ status: "open"; reason: string }>;

export type ConsumerVisibilityMetric = Readonly<{
  status: "hit" | "miss" | "unknown";
  reason: string | null;
}>;

export type ConsumerVisibilityScore = Readonly<{
  contract: typeof CONSUMER_MESSAGE_VISIBILITY_CONTRACT;
  any_at_5: ConsumerVisibilityMetric;
  any_at_10: ConsumerVisibilityMetric;
  /** Every annotated answer-turn message is visible; never vacuous on zero gold. */
  all_at_5: ConsumerVisibilityMetric;
  all_at_10: ConsumerVisibilityMetric;
  gold_messages: Readonly<{ annotated: number; mapped: number; complete: boolean }>;
  observation: Readonly<{
    observed_pages: number;
    /** Fully observed delivery positions (occupied slots), or null when no page was observed. */
    observed_through: number | null;
    continuation: "none" | "present" | "unobserved" | "unknown";
  }>;
}>;

export type ConsumerVisibilityInput = Readonly<{
  gold: AnswerTurnGold | undefined;
  /** Caller-owned proof that an observed absence may close as a miss. */
  admission: ConsumerVisibilityAdmission;
  /** Omit only when delivery was not observed; pass one observed terminal page to express a valid empty delivery. */
  pages?: readonly ConsumerVisibilityPage[];
  /** Delivery itself was not admitted or observed; every visibility metric stays unknown. */
  unavailableReason?: string;
}>;

type ObservationState = Readonly<{
  observedThrough: number;
  exhausted: boolean;
  observedPages: number;
  continuation: "none" | "present" | "unobserved" | "unknown";
  reason: string | null;
}>;

const hit: ConsumerVisibilityMetric = { status: "hit", reason: null };
const miss: ConsumerVisibilityMetric = { status: "miss", reason: null };
const unknown = (reason: string): ConsumerVisibilityMetric => ({ status: "unknown", reason });
const MAPPING_INCOMPLETE = "answer_turn_mapping_incomplete";
/** Malformed page/rank/interval facts cannot define any @k position, not even a positive. */
const STRUCTURAL_REASONS = new Set(["delivery_page_order_invalid", "delivery_page_after_terminal",
  "delivery_page_slots_invalid", "delivery_page_state_invalid", "delivery_rank_order_invalid",
  "delivery_interval_invalid"]);

/** Pure consumer-visibility score. Page-chain and native admission belong to the caller; this
 * function only proves whole-message UTF-8 visibility from already admitted intervals and gold. */
export function scoreConsumerMessageVisibility(input: ConsumerVisibilityInput): ConsumerVisibilityScore {
  const gold = input.gold;
  const observation = deriveObservation(input.pages);
  const intervals = (input.pages ?? []).flatMap(page => page.status === "observed" ? page.intervals : []);
  const result = (anyAt5: ConsumerVisibilityMetric, anyAt10: ConsumerVisibilityMetric,
    allAt5: ConsumerVisibilityMetric, allAt10: ConsumerVisibilityMetric): ConsumerVisibilityScore => ({
      contract: CONSUMER_MESSAGE_VISIBILITY_CONTRACT, any_at_5: anyAt5, any_at_10: anyAt10,
      all_at_5: allAt5, all_at_10: allAt10,
      gold_messages: gold === undefined ? { annotated: 0, mapped: 0, complete: false }
        : { annotated: gold.annotated_turns, mapped: gold.spans.length, complete: gold.complete },
      observation: { observed_pages: observation.observedPages,
        observed_through: observation.observedPages === 0 ? null : observation.observedThrough,
        continuation: observation.continuation }
    });
  if (input.unavailableReason !== undefined) {
    const unavailable = unknown(input.unavailableReason);
    return result(unavailable, unavailable, unavailable, unavailable);
  }
  if (observation.reason !== null && STRUCTURAL_REASONS.has(observation.reason)) {
    const malformed = unknown(observation.reason);
    return result(malformed, malformed, malformed, malformed);
  }
  // A first-page positive does not establish an observed ten-slot prefix.
  // An explicitly terminal page does establish its absent tail.
  const unobservedAt10 = observedAt(observation, 10) ? null
    : unknown(observation.reason ?? "delivery_position_not_observed");
  return result(anyMetric(gold, intervals, observation, input.admission, 5),
    unobservedAt10 ?? anyMetric(gold, intervals, observation, input.admission, 10),
    allMetric(gold, intervals, observation, input.admission, 5),
    unobservedAt10 ?? allMetric(gold, intervals, observation, input.admission, 10));
}

/** A known visible positive survives incomplete gold mapping; absence needs complete page state. */
function anyMetric(gold: AnswerTurnGold | undefined, intervals: readonly ConsumerVisibilityInterval[],
  observation: ObservationState, admission: ConsumerVisibilityAdmission, k: number): ConsumerVisibilityMetric {
  if (gold?.spans.some(span => spanVisible(intervals, span, k)) === true) return hit;
  if (!observedAt(observation, k)) return unknown(observation.reason ?? "delivery_position_not_observed");
  if (gold === undefined || !gold.complete) return unknown(MAPPING_INCOMPLETE);
  if (admission.status !== "closed") return unknown(admission.reason);
  return miss;
}

/** Complete coverage cannot claim a hit without complete nonempty annotation and mapping. */
function allMetric(gold: AnswerTurnGold | undefined, intervals: readonly ConsumerVisibilityInterval[],
  observation: ObservationState, admission: ConsumerVisibilityAdmission, k: number): ConsumerVisibilityMetric {
  if (gold === undefined || !gold.complete) return unknown(MAPPING_INCOMPLETE);
  if (gold.spans.length === 0) return unknown("no_annotated_answer_turn");
  if (gold.spans.every(span => spanVisible(intervals, span, k))) return hit;
  if (!observedAt(observation, k)) return unknown(observation.reason ?? "delivery_position_not_observed");
  if (admission.status !== "closed") return unknown(admission.reason);
  return miss;
}

function observedAt(observation: ObservationState, k: number): boolean {
  return observation.exhausted || observation.observedThrough >= k;
}

export type MessageByteInterval = Readonly<{ start: number; end: number }>;

/** One interval-union authority for visibility and read coverage. Callers must first bind all
 * intervals to the same full source identity; a one-byte gap never proves a whole message. */
export function byteIntervalsCoverSpan(intervals: readonly MessageByteInterval[], span: MessageByteInterval): boolean {
  const candidates = intervals.filter(interval => Number.isInteger(interval.start) && Number.isInteger(interval.end)
    && interval.start >= 0 && interval.end > interval.start && interval.start < span.end && interval.end > span.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  let covered = span.start;
  for (const interval of candidates) {
    if (interval.start > covered) return false;
    if (interval.end > covered) covered = interval.end;
    if (covered >= span.end) return true;
  }
  return covered >= span.end;
}

/** Partial overlap is not whole-message exposure; identity mismatches never join. */
function spanVisible(intervals: readonly ConsumerVisibilityInterval[], span: AnswerTurnSpan, k: number): boolean {
  return byteIntervalsCoverSpan(intervals.filter(interval => interval.rank <= k
    && sourceTargetJoinsGold({ rank: interval.rank, object_kind: "source_evidence", target: sourceRecallTarget({
      ...interval.target, evidence_object_id: null }) }, span.target)), span);
}

/** Validate every page fact first, then count only the leading complete observed pages.
 * Occupied slots define @k positions; source intervals may skip non-source or non-body slots.
 * A short complete page before a continuation cannot prove @5, so its unresolved tail stays unknown. */
function deriveObservation(pages: readonly ConsumerVisibilityPage[] | undefined): ObservationState {
  if (pages === undefined || pages.length === 0) return {
    observedThrough: 0, exhausted: false, observedPages: 0, continuation: "unknown", reason: "delivery_not_observed" };
  const ordered = [...pages].sort((left, right) => left.page - right.page);
  const structural = validatePageFacts(ordered);
  if (structural !== null) return { observedThrough: 0, exhausted: false, observedPages: 0,
    continuation: "unknown", reason: structural };
  const endRanks = slotEndRanks(ordered);
  let observedThrough = 0;
  let observedPages = 0;
  for (const [offset, page] of ordered.entries()) {
    if (page.status !== "observed" || !page.complete) {
      return { observedThrough, exhausted: false, observedPages,
        continuation: page.status === "unobserved" ? "unobserved"
          : page.status === "not_run" ? "unknown" : page.continuation === "none" ? "none" : "unknown",
        reason: page.reason ?? (page.status === "unobserved" ? "delivery_page_not_observed"
          : page.status === "not_run" ? "delivery_not_run" : "delivery_page_incomplete") };
    }
    observedThrough = endRanks[offset]!;
    observedPages += 1;
    if (page.continuation === "none") return {
      observedThrough, exhausted: true, observedPages, continuation: "none", reason: null };
    if (page.continuation === "unknown") return { observedThrough, exhausted: false, observedPages,
      continuation: "unknown", reason: "continuation_state_unknown" };
  }
  return { observedThrough, exhausted: false, observedPages, continuation: "unobserved",
    reason: "second_page_not_observed" };
}

function validatePageFacts(ordered: readonly ConsumerVisibilityPage[]): string | null {
  let occupied = 0;
  let terminal = false;
  for (const [offset, page] of ordered.entries()) {
    if (!Number.isInteger(page.page) || page.page !== offset + 1) return "delivery_page_order_invalid";
    if (terminal) return "delivery_page_after_terminal";
    if (!Number.isInteger(page.occupied_slots) || page.occupied_slots < 0) return "delivery_page_slots_invalid";
    const start = occupied + 1;
    const end = occupied + page.occupied_slots;
    if (page.status !== "observed") {
      if (page.intervals.length > 0 || page.complete) return "delivery_page_state_invalid";
    } else {
      if (page.intervals.some(interval => !validInterval(interval))) return "delivery_interval_invalid";
      const ranks = page.intervals.map(interval => interval.rank).sort((left, right) => left - right);
      if (ranks.some((rank, index) => rank < start || rank > end
        || (index > 0 && ranks[index - 1] === rank))) return "delivery_rank_order_invalid";
    }
    occupied = end;
    if (page.continuation === "none") terminal = true;
  }
  return null;
}

function slotEndRanks(ordered: readonly ConsumerVisibilityPage[]): number[] {
  const ends: number[] = [];
  let occupied = 0;
  for (const page of ordered) {
    occupied += page.occupied_slots;
    ends.push(occupied);
  }
  return ends;
}

function validInterval(interval: ConsumerVisibilityInterval): boolean {
  return Number.isInteger(interval.rank) && interval.rank >= 1
    && Number.isInteger(interval.start) && Number.isInteger(interval.end)
    && interval.start >= 0 && interval.end >= interval.start;
}
