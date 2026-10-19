import { afterAll, describe, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
import { GOLD } from "./source-semantic-library-measurement-fixture.js";
import type { SourceGoldUnit } from "../../../runs/measurement/source-gold-join.js";
import type { AnswerTurnGold, AnswerTurnSpan } from "../../../runs/longmemeval-semantic/answer-spans.js";
import { scoreConsumerMessageVisibility, type ConsumerVisibilityInterval,
  type ConsumerVisibilityPage, type ConsumerVisibilityTerminalTail } from "../../../runs/longmemeval-semantic/message-visibility.js";

afterAll(() => { isolation.restore(); expect(isolation.violations).toEqual([]); });

const body = "User: 東京 café 🐈\nAssistant: 東京有答案";
const answerStart = Buffer.byteLength("User: 東京 café 🐈\nAssistant: ", "utf8");
const answerEnd = Buffer.byteLength(body, "utf8");
const span = (start: number, end: number, target: SourceGoldUnit = GOLD): AnswerTurnSpan =>
  ({ session_index: 0, message_index: 0, source_id: target.root_id, target, start, end });
/** Distinct answer-turn messages inside one question; identity and offsets stay explicit. */
const turn = (messageIndex: number, start: number, end: number,
  target: SourceGoldUnit = GOLD): AnswerTurnSpan => ({ ...span(start, end, target), message_index: messageIndex });
const gold = (spans: readonly AnswerTurnSpan[], complete = true, annotated = spans.length): AnswerTurnGold =>
  ({ unit: "published_body_utf8_bytes", annotated_turns: annotated, spans, complete });
const identity = (overrides: Partial<SourceGoldUnit>): SourceGoldUnit => ({ ...GOLD, ...overrides });
const interval = (rank: number, start: number, end: number, target: SourceGoldUnit = GOLD): ConsumerVisibilityInterval =>
  ({ rank, target, start, end });
const exhaustedTail: ConsumerVisibilityTerminalTail = { status: "exhausted", reason: "logical_index_complete" };
const openTail: ConsumerVisibilityTerminalTail = { status: "open", reason: "occupancy_continuation_present" };
const unknownTail = (reason: string): ConsumerVisibilityTerminalTail => ({ status: "unknown", reason });
const tailFor = (continuation: "none" | "present" | "unknown"): ConsumerVisibilityTerminalTail =>
  continuation === "present" ? openTail : continuation === "none" ? exhaustedTail
    : unknownTail("continuation_state_unknown");
const page = (intervals: readonly ConsumerVisibilityInterval[],
  continuation: "none" | "present" | "unknown" = "none", pageNumber = 1,
  complete = true, occupiedSlots = intervals.length,
  terminalTail: ConsumerVisibilityTerminalTail = tailFor(continuation)): ConsumerVisibilityPage => ({
    page: pageNumber, status: "observed", reason: null, occupied_slots: occupiedSlots,
    complete, continuation, terminal_tail: terminalTail, intervals });
/** A full five-slot first page; ranks not supplied by the case get non-overlapping filler intervals. */
const firstPage = (continuation: "none" | "present" | "unknown",
  intervals: readonly ConsumerVisibilityInterval[] = []): ConsumerVisibilityPage => {
  const used = new Set(intervals.map(entry => entry.rank));
  const fillers = [1, 2, 3, 4, 5].filter(rank => !used.has(rank))
    .map(rank => interval(rank, 1_000 + rank * 10, 1_005 + rank * 10));
  return page([...fillers, ...intervals].sort((left, right) => left.rank - right.rank), continuation);
};
const score = (goldValue: AnswerTurnGold, pages: readonly ConsumerVisibilityPage[]) =>
  scoreConsumerMessageVisibility({ gold: goldValue, pages });

describe("consumer message visibility", () => {
  it("merges adjacent and overlapping UTF-8 byte intervals to prove the whole message", () => {
    const mid = answerStart + 5;
    const merged = score(gold([span(answerStart, answerEnd)]),
      [firstPage("none", [interval(1, answerStart, mid), interval(2, mid - 2, answerEnd)])]);
    expect(merged.any_at_5).toEqual({ status: "hit", reason: null });
    expect(merged.all_at_5).toEqual({ status: "hit", reason: null });
    expect(merged.gold_messages).toEqual({ annotated: 1, mapped: 1, complete: true });
    const adjacent = score(gold([span(answerStart, answerEnd)]),
      [firstPage("none", [interval(1, answerStart, mid), interval(2, mid, answerEnd)])]);
    expect(adjacent.all_at_5.status).toBe("hit");
  });

  it("does not treat partial overlap or a one-byte gap as full exposure", () => {
    expect(score(gold([span(10, 22)]), [firstPage("none", [interval(1, 12, 22)])]).all_at_5)
      .toEqual({ status: "miss", reason: null });
    expect(score(gold([span(10, 22)]), [firstPage("none", [interval(1, 2, 21)])]).all_at_5.status).toBe("miss");
    expect(score(gold([span(10, 22)]),
      [firstPage("none", [interval(1, 10, 15), interval(2, 16, 22)])]).all_at_5.status).toBe("miss");
    expect(score(gold([span(10, 22)]),
      [firstPage("none", [interval(1, 10, 16), interval(2, 16, 22)])]).all_at_5.status).toBe("hit");
  });

  it("never merges matching intervals across source version, digest, workspace or root", () => {
    const expected = gold([span(0, 10)]);
    const wrongVersion = interval(2, 5, 10, identity({ source_version: "2" }));
    const wrongDigest = interval(2, 5, 10, identity({ content_digest: `sha256:${"ef".repeat(32)}` }));
    const wrongWorkspace = interval(2, 5, 10, identity({ workspace_id: "other-workspace" }));
    const wrongRoot = interval(2, 5, 10, identity({ root_id: "other-root" }));
    for (const second of [wrongVersion, wrongDigest, wrongWorkspace, wrongRoot]) {
      const result = score(expected, [firstPage("none", [interval(1, 0, 5), second])]);
      expect(result.any_at_5).toEqual({ status: "miss", reason: null });
      expect(result.all_at_5).toEqual({ status: "miss", reason: null });
    }
    expect(score(expected, [firstPage("none", [interval(1, 0, 5), interval(2, 5, 10)])]).all_at_5.status)
      .toBe("hit");
  });

  it("observes an explicit second page while an unobserved continuation tail stays unknown", () => {
    const twoTurns = gold([span(0, 4), span(8, 12)]);
    const firstPageOnly = score(twoTurns, [firstPage("present", [interval(1, 0, 4)])]);
    expect(firstPageOnly.any_at_5).toEqual({ status: "hit", reason: null });
    expect(firstPageOnly.all_at_5).toEqual({ status: "miss", reason: null });
    expect(firstPageOnly.all_at_10).toEqual({ status: "unknown", reason: "second_page_not_observed" });
    expect(firstPageOnly.observation).toEqual({ observed_pages: 1, observed_through: 5, continuation: "unobserved" });
    const lateTurn = score(gold([span(8, 12)]), [firstPage("present")]);
    expect(lateTurn.any_at_5).toEqual({ status: "miss", reason: null });
    expect(lateTurn.any_at_10).toEqual({ status: "unknown", reason: "second_page_not_observed" });
    const secondPage = score(twoTurns, [firstPage("present", [interval(1, 0, 4)]),
      page([interval(6, 8, 12)], "none", 2)]);
    expect(secondPage.any_at_10).toEqual({ status: "hit", reason: null });
    expect(secondPage.all_at_10).toEqual({ status: "hit", reason: null });
    expect(secondPage.observation).toEqual({ observed_pages: 2, observed_through: 6, continuation: "none" });
  });

  it("keeps first-page positives at @5 without claiming an unobserved @10 continuation", () => {
    const oneTurn = gold([span(0, 10)]);
    const visible = [interval(1, 0, 10)];
    const pending = score(oneTurn, [firstPage("present", visible)]);
    expect(pending.any_at_5).toEqual({ status: "hit", reason: null });
    expect(pending.all_at_5).toEqual({ status: "hit", reason: null });
    expect(pending.any_at_10).toEqual({ status: "unknown", reason: "second_page_not_observed" });
    expect(pending.all_at_10).toEqual({ status: "unknown", reason: "second_page_not_observed" });
    const exhausted = score(oneTurn, [firstPage("none", visible)]);
    expect(exhausted.any_at_10).toEqual({ status: "hit", reason: null });
    expect(exhausted.all_at_10).toEqual({ status: "hit", reason: null });
  });

  it("keeps a continuation pointer out of the evidence and distinguishes unknown page state", () => {
    const oneTurn = gold([span(0, 10)]);
    expect(score(oneTurn, [firstPage("present")]).any_at_5).toEqual({ status: "miss", reason: null });
    expect(score(oneTurn, [firstPage("unknown")]).any_at_10)
      .toEqual({ status: "unknown", reason: "continuation_state_unknown" });
    const incomplete = { ...page([interval(1, 20, 30)], "none"), complete: false };
    expect(score(oneTurn, [incomplete]).any_at_5).toEqual({ status: "unknown", reason: "delivery_page_incomplete" });
    const positiveIncomplete = { ...page([interval(1, 0, 10)], "none"), complete: false };
    expect(score(oneTurn, [positiveIncomplete]).any_at_5).toEqual({ status: "hit", reason: null });
    const unobserved = { page: 1, status: "unobserved" as const, reason: "capture_budget_exhausted",
      occupied_slots: 5, complete: false, continuation: "present" as const, terminal_tail: openTail,
      intervals: [] };
    expect(score(oneTurn, [unobserved]).any_at_5)
      .toEqual({ status: "unknown", reason: "capture_budget_exhausted" });
    expect(score(oneTurn, [page([interval(2, 20, 30)])]).any_at_5)
      .toEqual({ status: "unknown", reason: "delivery_rank_order_invalid" });
    // A valid empty observed delivery is a closed absence, not unknown.
    expect(score(oneTurn, [page([])]).any_at_5).toEqual({ status: "miss", reason: null });
    expect(score(oneTurn, [page([])]).all_at_5).toEqual({ status: "miss", reason: null });
  });

  it("keeps known positives under incomplete mapping while complete coverage cannot claim them", () => {
    const partialGold = gold([span(0, 10)], false, 2);
    const visible = score(partialGold, [firstPage("none", [interval(1, 0, 10)])]);
    expect(visible.any_at_5).toEqual({ status: "hit", reason: null });
    expect(visible.all_at_5).toEqual({ status: "unknown", reason: "answer_turn_mapping_incomplete" });
    expect(visible.gold_messages).toEqual({ annotated: 2, mapped: 1, complete: false });
    const absent = score(partialGold, [firstPage("none")]);
    expect(absent.any_at_5).toEqual({ status: "unknown", reason: "answer_turn_mapping_incomplete" });
    expect(absent.all_at_5).toEqual({ status: "unknown", reason: "answer_turn_mapping_incomplete" });
    const empty = score(gold([], false, 0), [page([])]);
    expect(empty.any_at_5).toEqual({ status: "unknown", reason: "answer_turn_mapping_incomplete" });
    expect(empty.all_at_5).toEqual({ status: "unknown", reason: "answer_turn_mapping_incomplete" });
    expect(empty.all_at_5.status).not.toBe("hit");
  });

  it("proves a five-position miss from captured occupancy without a residual-admission gate", () => {
    const oneTurn = gold([span(0, 10)]);
    expect(score(oneTurn, [firstPage("none")]).any_at_5).toEqual({ status: "miss", reason: null });
    expect(score(oneTurn, [firstPage("none")]).all_at_5).toEqual({ status: "miss", reason: null });
    expect(score(oneTurn, [firstPage("none", [interval(1, 0, 10)])]).any_at_5.status).toBe("hit");
    expect(score(oneTurn, [firstPage("none", [interval(1, 0, 10)])]).all_at_5.status).toBe("hit");
  });

  it("only establishes complete coverage from complete nonempty gold", () => {
    const result = score(gold([span(0, 10)]), [firstPage("none", [interval(1, 0, 10)])]);
    expect(result.all_at_5.status).toBe("hit");
    expect(result.all_at_10.status).toBe("hit");
    expect(score(gold([span(0, 10)]), [firstPage("none")]).all_at_5)
      .toEqual({ status: "miss", reason: null });
  });

  it("accepts occupied non-source gaps without requiring one interval per slot", () => {
    const oneTurn = gold([span(50, 60)]);
    const result = score(oneTurn, [page([interval(3, 50, 60)], "none", 1, true, 5)]);
    expect(result.any_at_5).toEqual({ status: "hit", reason: null });
    expect(result.all_at_5).toEqual({ status: "hit", reason: null });
    expect(result.observation).toEqual({ observed_pages: 1, observed_through: 5, continuation: "none" });
    // A rank outside the page's occupied range is still malformed.
    expect(score(oneTurn, [page([interval(6, 50, 60)], "none", 1, true, 5)]).any_at_5)
      .toEqual({ status: "unknown", reason: "delivery_rank_order_invalid" });
  });

  it("rejects initial-page gaps and a page reached after a terminal page", () => {
    const oneTurn = gold([span(0, 10)]);
    expect(score(oneTurn, [page([interval(1, 0, 10)], "none", 2, true, 1)]).any_at_5)
      .toEqual({ status: "unknown", reason: "delivery_page_order_invalid" });
    expect(score(oneTurn, [firstPage("present"), page([interval(11, 0, 10)], "none", 3, true, 1)]).any_at_5)
      .toEqual({ status: "unknown", reason: "delivery_page_order_invalid" });
    const terminalThenGold = score(oneTurn, [firstPage("none"),
      page([interval(6, 0, 10)], "none", 2, true, 1)]);
    expect(terminalThenGold.any_at_5).toEqual({ status: "unknown", reason: "delivery_page_after_terminal" });
    expect(terminalThenGold.all_at_5).toEqual({ status: "unknown", reason: "delivery_page_after_terminal" });
  });

  it("validates malformed later pages even when an earlier observed page is partial", () => {
    const oneTurn = gold([span(0, 10)]);
    const partial = { ...firstPage("present"), complete: false };
    expect(score(oneTurn, [partial]).any_at_5).toEqual({ status: "unknown", reason: "delivery_page_incomplete" });
    expect(score(oneTurn, [partial, page([interval(7, 0, 10)], "none", 2, true, 1)]).any_at_5)
      .toEqual({ status: "unknown", reason: "delivery_rank_order_invalid" });
    expect(score(oneTurn, [partial, page([interval(6, 20, 30)], "none", 2, true, 1)]).any_at_5)
      .toEqual({ status: "unknown", reason: "delivery_page_incomplete" });
  });

  it("reports distinct per-message states for mixed gold instead of one question aggregate", () => {
    const other = identity({ root_id: "gold-second" });
    const wrongDigest = identity({ content_digest: `sha256:${"ef".repeat(32)}` });
    const result = score(gold([turn(0, 0, 10), turn(1, 20, 30, other)]), [firstPage("none",
      [interval(2, 0, 10), interval(3, 20, 30, wrongDigest)])]);
    expect(result.messages).toEqual([
      { session_index: 0, message_index: 0, source_id: GOLD.root_id, target: GOLD, start: 0, end: 10,
        at_5: { status: "hit", reason: null }, at_10: { status: "hit", reason: null },
        visible_intervals: [interval(2, 0, 10)] },
      { session_index: 0, message_index: 1, source_id: other.root_id, target: other, start: 20, end: 30,
        at_5: { status: "miss", reason: null }, at_10: { status: "miss", reason: null },
        visible_intervals: [] }
    ]);
    // Terminal delivery keeps both aggregates determinate; only the per-message rows carry identity.
    expect(result.any_at_5).toEqual({ status: "hit", reason: null });
    expect(result.all_at_5).toEqual({ status: "miss", reason: null });
  });

  it("keeps per-message states under incomplete mapping and unobserved delivery", () => {
    const other = identity({ root_id: "gold-second" });
    const partial = score(gold([turn(0, 0, 10)], false, 2), [firstPage("none", [interval(1, 0, 10)])]);
    expect(partial.messages).toEqual([{ session_index: 0, message_index: 0, source_id: GOLD.root_id,
      target: GOLD, start: 0, end: 10, at_5: { status: "hit", reason: null },
      at_10: { status: "hit", reason: null }, visible_intervals: [interval(1, 0, 10)] }]);
    expect(partial.all_at_5).toEqual({ status: "unknown", reason: "answer_turn_mapping_incomplete" });
    expect(partial.gold_messages).toEqual({ annotated: 2, mapped: 1, complete: false });
    // No fabricated span stands in for the unmapped annotated turn.
    expect(score(gold([], false, 2), [page([])]).messages).toEqual([]);
    const continued = score(gold([turn(0, 0, 10), turn(1, 20, 30, other)]),
      [firstPage("present", [interval(1, 0, 10)])]);
    expect(continued.messages.map(message => [message.at_5.status, message.at_10.status]))
      .toEqual([["hit", "unknown"], ["miss", "unknown"]]);
    expect(continued.messages[0]!.at_10).toEqual({ status: "unknown", reason: "second_page_not_observed" });
    expect(continued.messages[0]!.visible_intervals).toEqual([interval(1, 0, 10)]);
    expect(continued.messages[1]!.visible_intervals).toEqual([]);
    // A short observed page before a continuation leaves per-message @5 and @10 unknown.
    const short = score(gold([turn(1, 20, 30)]), [page([interval(1, 1_010, 1_020)], "present", 1, true, 3)]);
    expect(short.messages).toEqual([{ session_index: 0, message_index: 1, source_id: GOLD.root_id,
      target: GOLD, start: 20, end: 30,
      at_5: { status: "unknown", reason: "second_page_not_observed" },
      at_10: { status: "unknown", reason: "second_page_not_observed" }, visible_intervals: [] }]);
    // Incomplete mapping does not outrank an unobserved ten-slot prefix; one gate sets both paths.
    const incompleteContinued = score(gold([turn(0, 0, 10)], false, 2),
      [firstPage("present", [interval(1, 0, 10)])]);
    expect(incompleteContinued.any_at_10).toEqual({ status: "unknown", reason: "second_page_not_observed" });
    expect(incompleteContinued.all_at_10).toEqual({ status: "unknown", reason: "second_page_not_observed" });
    expect(incompleteContinued.messages[0]!.at_10)
      .toEqual({ status: "unknown", reason: "second_page_not_observed" });
    expect(incompleteContinued.messages[0]!.at_5).toEqual({ status: "hit", reason: null });
    // Structural invalid and unavailable delivery preserve identity but no interval evidence.
    const malformed = score(gold([turn(0, 0, 10)]), [page([interval(2, 0, 10)])]);
    expect(malformed.messages).toEqual([{ session_index: 0, message_index: 0, source_id: GOLD.root_id,
      target: GOLD, start: 0, end: 10,
      at_5: { status: "unknown", reason: "delivery_rank_order_invalid" },
      at_10: { status: "unknown", reason: "delivery_rank_order_invalid" }, visible_intervals: [] }]);
    const unavailable = scoreConsumerMessageVisibility({ gold: gold([turn(0, 0, 10)]),
      pages: [firstPage("none", [interval(1, 0, 10)])], unavailableReason: "native_delivery_unavailable" });
    expect(unavailable.messages.map(message => [message.start, message.end, message.at_5, message.at_10,
      message.visible_intervals.length])).toEqual([[0, 10,
      { status: "unknown", reason: "native_delivery_unavailable" },
      { status: "unknown", reason: "native_delivery_unavailable" }, 0]]);
  });

  it("keeps a short observed page before a continuation conservative at @5", () => {
    const oneTurn = gold([span(0, 10)]);
    const short = page([interval(1, 20, 30)], "present", 1, true, 3);
    const result = score(oneTurn, [short]);
    expect(result.any_at_5).toEqual({ status: "unknown", reason: "second_page_not_observed" });
    expect(result.all_at_5).toEqual({ status: "unknown", reason: "second_page_not_observed" });
    expect(result.observation).toEqual({ observed_pages: 1, observed_through: 3, continuation: "unobserved" });
  });

  it("keeps a short null-continuation tail unknown without native exhaustion proof", () => {
    const oneTurn = gold([span(0, 10)]);
    const short = page([interval(1, 20, 30)], "none", 1, true, 3, unknownTail("logical_index_partial"));
    const result = score(oneTurn, [short]);
    expect(result.any_at_5).toEqual({ status: "unknown", reason: "logical_index_partial" });
    expect(result.any_at_10).toEqual({ status: "unknown", reason: "logical_index_partial" });
    expect(result.observation).toEqual({ observed_pages: 1, observed_through: 3, continuation: "unknown" });
  });

  it("closes a short exhausted occupancy tail as a miss", () => {
    const oneTurn = gold([span(0, 10)]);
    const short = page([interval(1, 20, 30)], "none", 1, true, 3, exhaustedTail);
    const result = score(oneTurn, [short]);
    expect(result.any_at_5).toEqual({ status: "miss", reason: null });
    expect(result.any_at_10).toEqual({ status: "miss", reason: null });
    expect(result.all_at_5).toEqual({ status: "miss", reason: null });
    expect(result.observation).toEqual({ observed_pages: 1, observed_through: 3, continuation: "none" });
  });

  it("keeps @10 unknown after a first-page hit when the requested continuation is unobserved", () => {
    const oneTurn = gold([span(0, 10)]);
    const result = score(oneTurn, [firstPage("present", [interval(1, 0, 10)])]);
    expect(result.any_at_5).toEqual({ status: "hit", reason: null });
    expect(result.any_at_10).toEqual({ status: "unknown", reason: "second_page_not_observed" });
    expect(result.observation).toEqual({ observed_pages: 1, observed_through: 5, continuation: "unobserved" });
  });

  it("observes ten captured positions across two pages", () => {
    const twoTurns = gold([span(0, 4), span(8, 12)]);
    const result = score(twoTurns, [firstPage("present", [interval(1, 0, 4)]),
      page([interval(6, 8, 12)], "none", 2, true, 5, exhaustedTail)]);
    expect(result.any_at_5).toEqual({ status: "hit", reason: null });
    expect(result.any_at_10).toEqual({ status: "hit", reason: null });
    expect(result.all_at_10).toEqual({ status: "hit", reason: null });
    expect(result.observation).toEqual({ observed_pages: 2, observed_through: 10, continuation: "none" });
  });

  it("rejects a terminal-tail fact that contradicts the public continuation", () => {
    const oneTurn = gold([span(0, 10)]);
    const exhaustedWithPointer = page([interval(1, 0, 10)], "present", 1, true, 5, exhaustedTail);
    expect(score(oneTurn, [exhaustedWithPointer]).any_at_5)
      .toEqual({ status: "unknown", reason: "delivery_page_state_invalid" });
    const openWithoutPointer = page([interval(1, 0, 10)], "none", 1, true, 5, openTail);
    expect(score(oneTurn, [openWithoutPointer]).any_at_5)
      .toEqual({ status: "unknown", reason: "delivery_page_state_invalid" });
    const unobservedExhausted = { page: 1, status: "unobserved" as const, reason: "not_captured",
      occupied_slots: 0, complete: false, continuation: "unknown" as const, terminal_tail: exhaustedTail,
      intervals: [] };
    expect(score(oneTurn, [unobservedExhausted]).any_at_5)
      .toEqual({ status: "unknown", reason: "delivery_page_state_invalid" });
  });
});
