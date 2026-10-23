import { sourceGoldRootIdentity, sourceRecallTarget } from "@do-soul/alaya-protocol";
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

/** Label-independent occupancy-tail proof. A null public continuation is not exhaustion. */
export type ConsumerVisibilityTerminalTail = Readonly<{
  status: "exhausted" | "open" | "unknown";
  reason: string;
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
  /** Actual public continuation pointer; not the occupancy-tail proof. */
  continuation: "none" | "present" | "unknown";
  /** Native completion-owner tail fact. Producers must supply it; missing is not exhaustion. */
  terminal_tail: ConsumerVisibilityTerminalTail;
  /** Source-body intervals only; this array need not have one entry per occupied slot. */
  intervals: readonly ConsumerVisibilityInterval[];
}>;

export type ConsumerVisibilityMetric = Readonly<{
  status: "hit" | "miss" | "unknown";
  reason: string | null;
}>;

/** One mapped gold message. Only gold.spans produce an entry; an unmapped annotated turn stays
 * mapping-incomplete rather than becoming a fabricated span. */
export type ConsumerVisibilityMessage = Readonly<{
  session_index: number;
  message_index: number;
  source_id: string;
  target: SourceGoldUnit;
  /** Half-open UTF-8 byte offsets of this message inside the published source body. */
  start: number;
  end: number;
  at_5: ConsumerVisibilityMetric;
  at_10: ConsumerVisibilityMetric;
  /** Observed intervals of this exact source identity that overlap this message body, sorted by
   * delivery rank then offset. Sibling-turn intervals are not attributed; nothing is clamped. */
  visible_intervals: readonly ConsumerVisibilityInterval[];
}>;

export type ConsumerVisibilityScore = Readonly<{
  contract: typeof CONSUMER_MESSAGE_VISIBILITY_CONTRACT;
  any_at_5: ConsumerVisibilityMetric;
  any_at_10: ConsumerVisibilityMetric;
  /** Every annotated answer-turn message is visible; never vacuous on zero gold. */
  all_at_5: ConsumerVisibilityMetric;
  all_at_10: ConsumerVisibilityMetric;
  gold_messages: Readonly<{ annotated: number; mapped: number; complete: boolean }>;
  /** One entry per mapped gold span in gold.spans order, matched by full identity and span. */
  messages: readonly ConsumerVisibilityMessage[];
  observation: Readonly<{
    observed_pages: number;
    /** Fully observed delivery positions (occupied slots), or null when no page was observed. */
    observed_through: number | null;
    continuation: "none" | "present" | "unobserved" | "unknown";
  }>;
}>;

export type ConsumerVisibilityInput = Readonly<{
  gold: AnswerTurnGold | undefined;
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

/** Pure consumer-visibility score. Page-chain and native tail proof belong to the caller; this
 * function proves whole-message UTF-8 visibility from admitted intervals, occupied positions,
 * terminal_tail, and gold. Acquisition residuals do not reopen a complete cutoff prefix. */
export function scoreConsumerMessageVisibility(input: ConsumerVisibilityInput): ConsumerVisibilityScore {
  const gold = input.gold;
  const observation = deriveObservation(input.pages);
  // Unavailable delivery and malformed page facts invalidate their own interval claims, so a
  // per-message state must stay unknown with no attributable evidence.
  const malformed = input.unavailableReason ?? (observation.reason !== null
    && STRUCTURAL_REASONS.has(observation.reason) ? observation.reason : null);
  const intervals = malformed === null
    ? (input.pages ?? []).flatMap(page => page.status === "observed" ? page.intervals : [])
    : [];
  // One unobserved-@10 gate serves the aggregates and every message row. An unobserved ten-slot
  // prefix is unknown even for a visible first-page message, and its reason outranks incomplete gold.
  const unobservedAt10 = malformed === null && !observedAt(observation, 10)
    ? unknown(observation.reason ?? "delivery_position_not_observed") : null;
  const messages = (gold?.spans ?? []).map(span =>
    messageVisibility(span, intervals, observation, malformed, unobservedAt10));
  const result = (anyAt5: ConsumerVisibilityMetric, anyAt10: ConsumerVisibilityMetric,
    allAt5: ConsumerVisibilityMetric, allAt10: ConsumerVisibilityMetric): ConsumerVisibilityScore => ({
      contract: CONSUMER_MESSAGE_VISIBILITY_CONTRACT, any_at_5: anyAt5, any_at_10: anyAt10,
      all_at_5: allAt5, all_at_10: allAt10,
      gold_messages: gold === undefined ? { annotated: 0, mapped: 0, complete: false }
        : { annotated: gold.annotated_turns, mapped: gold.spans.length, complete: gold.complete },
      messages,
      observation: { observed_pages: observation.observedPages,
        observed_through: observation.observedPages === 0 ? null : observation.observedThrough,
        continuation: observation.continuation }
    });
  if (malformed !== null) {
    const unavailable = unknown(malformed);
    return result(unavailable, unavailable, unavailable, unavailable);
  }
  // These aggregates restate the per-message states; no per-message state is inferred from them.
  const anyAt = (k: number): ConsumerVisibilityMetric => {
    if (statesAt(messages, k).some(state => state.status === "hit")) return hit;
    if (!observedAt(observation, k)) return unknown(observation.reason ?? "delivery_position_not_observed");
    if (gold === undefined || !gold.complete) return unknown(MAPPING_INCOMPLETE);
    return miss;
  };
  // Complete coverage cannot claim a hit without complete nonempty annotation and mapping.
  const allAt = (k: number): ConsumerVisibilityMetric => {
    if (gold === undefined || !gold.complete) return unknown(MAPPING_INCOMPLETE);
    const states = statesAt(messages, k);
    if (states.length === 0) return unknown("no_annotated_answer_turn");
    if (states.every(state => state.status === "hit")) return hit;
    if (!observedAt(observation, k)) return unknown(observation.reason ?? "delivery_position_not_observed");
    return miss;
  };
  // A first-page positive does not establish an observed ten-slot prefix; the terminal case is in
  // the shared gate above and any terminal delivery still proves its absent tail below.
  return result(anyAt(5), unobservedAt10 ?? anyAt(10), allAt(5), unobservedAt10 ?? allAt(10));
}

/** Evaluator-only fixed-byte page. A complete packed page closes this B comparison,
 * not the native source inventory or a later slot prefix. Byte counts come from
 * admitted literal UTF-8 intervals; whole-message visibility is not answerability. */
export function scoreConsumerByteVisibility(input: {
  gold: AnswerTurnGold | undefined; windows: readonly (ConsumerVisibilityInterval & { text: string })[];
  byte_budget: number; unique_utf8_bytes: number; unavailableReason?: string;
}) {
  // This private page protocol admits one contiguous window per full source identity.
  // Callers cannot substitute an estimated size or count the same bytes twice.
  const roots = input.windows.map(w => sourceGoldRootIdentity({ ...w.target, kind: "source_evidence", evidence_object_id: null }));
  const bytes = input.windows.reduce((n, w) => n + Buffer.byteLength(w.text), 0);
  const invalid = input.unavailableReason ?? (!Number.isSafeInteger(input.byte_budget) || input.byte_budget < 0
    || input.unique_utf8_bytes !== bytes || bytes > input.byte_budget || new Set(roots).size !== roots.length
    || input.windows.some(w => !Number.isSafeInteger(w.start) || w.start < 0 || w.end - w.start !== Buffer.byteLength(w.text))
    ? "invalid_byte_page" : null);
  if (invalid) return { any_at_budget: unknown(invalid), all_at_budget: unknown(invalid) };
  const gold = input.gold, states = (gold?.spans ?? []).map(span => spanVisible(input.windows, span, Infinity));
  return { any_at_budget: states.some(Boolean) ? hit : gold?.complete ? miss : unknown(MAPPING_INCOMPLETE),
    all_at_budget: !gold?.complete ? unknown(MAPPING_INCOMPLETE) : states.length === 0
      ? unknown("no_annotated_answer_turn") : states.every(Boolean) ? hit : miss };
}

function statesAt(messages: readonly ConsumerVisibilityMessage[], k: number): readonly ConsumerVisibilityMetric[] {
  return messages.map(message => k === 5 ? message.at_5 : message.at_10);
}

/** Identity and span of one mapped gold message plus its own @5/@10 states. */
function messageVisibility(span: AnswerTurnSpan, intervals: readonly ConsumerVisibilityInterval[],
  observation: ObservationState, malformed: string | null, unobservedAt10: ConsumerVisibilityMetric | null):
  ConsumerVisibilityMessage {
  const mapped = { session_index: span.session_index, message_index: span.message_index,
    source_id: span.source_id, target: span.target, start: span.start, end: span.end };
  if (malformed !== null) return { ...mapped, at_5: unknown(malformed), at_10: unknown(malformed),
    visible_intervals: [] };
  return { ...mapped,
    at_5: messageMetric(span, intervals, observation, 5),
    at_10: unobservedAt10 ?? messageMetric(span, intervals, observation, 10),
    visible_intervals: intervalsJoining(intervals, span)
      .filter(interval => interval.start < span.end && interval.end > span.start)
      .sort((left, right) => left.rank - right.rank || left.start - right.start || left.end - right.end) };
}

/** A known visible positive survives incomplete gold mapping; only this message's own absence needs
 * a complete cutoff prefix. Unmapped answer turns belong to gold_messages. */
function messageMetric(span: AnswerTurnSpan, intervals: readonly ConsumerVisibilityInterval[],
  observation: ObservationState, k: number): ConsumerVisibilityMetric {
  if (spanVisible(intervals, span, k)) return hit;
  if (!observedAt(observation, k)) return unknown(observation.reason ?? "delivery_position_not_observed");
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

/** Full source identity join; intervals never merge across version, digest, workspace or root. */
function intervalsJoining(intervals: readonly ConsumerVisibilityInterval[],
  span: AnswerTurnSpan): ConsumerVisibilityInterval[] {
  return intervals.filter(interval => sourceTargetJoinsGold({ rank: interval.rank, object_kind: "source_evidence",
    target: sourceRecallTarget({ ...interval.target, evidence_object_id: null }) }, span.target));
}

/** Partial overlap is not whole-message exposure; identity mismatches never join. */
function spanVisible(intervals: readonly ConsumerVisibilityInterval[], span: AnswerTurnSpan, k: number): boolean {
  return byteIntervalsCoverSpan(intervalsJoining(intervals, span).filter(interval => interval.rank <= k), span);
}

/** Validate every page fact first, then count only the leading complete observed pages.
 * Occupied slots define @k positions; source intervals may skip non-source or non-body slots.
 * A short complete page before an open or unknown tail cannot prove @5. Exhaustion requires
 * the native terminal-tail fact, not a null public continuation. */
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
    if (page.terminal_tail.status === "exhausted") return {
      observedThrough, exhausted: true, observedPages, continuation: "none", reason: null };
    if (page.terminal_tail.status === "unknown") return { observedThrough, exhausted: false, observedPages,
      continuation: "unknown", reason: page.terminal_tail.reason };
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
    if (page.terminal_tail.status === "open" && page.continuation !== "present") return "delivery_page_state_invalid";
    if (page.continuation === "present" && page.terminal_tail.status !== "open") return "delivery_page_state_invalid";
    if (page.continuation === "unknown" && page.terminal_tail.status !== "unknown") return "delivery_page_state_invalid";
    if (page.status !== "observed") {
      if (page.intervals.length > 0 || page.complete || page.terminal_tail.status === "exhausted") {
        return "delivery_page_state_invalid";
      }
    } else {
      if (page.terminal_tail.status === "exhausted" && page.continuation !== "none") {
        return "delivery_page_state_invalid";
      }
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
