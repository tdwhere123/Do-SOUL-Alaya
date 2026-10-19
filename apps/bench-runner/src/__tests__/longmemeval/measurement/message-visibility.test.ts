import { afterAll, describe, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
import { GOLD } from "./source-semantic-library-measurement-fixture.js";
import type { SourceGoldUnit } from "../../../runs/measurement/source-gold-join.js";
import type { AnswerTurnGold, AnswerTurnSpan } from "../../../runs/longmemeval-semantic/answer-spans.js";
import { scoreConsumerMessageVisibility, type ConsumerVisibilityInterval,
  type ConsumerVisibilityPage } from "../../../runs/longmemeval-semantic/message-visibility.js";

afterAll(() => { isolation.restore(); expect(isolation.violations).toEqual([]); });

const body = "User: 東京 café 🐈\nAssistant: 東京有答案";
const answerStart = Buffer.byteLength("User: 東京 café 🐈\nAssistant: ", "utf8");
const answerEnd = Buffer.byteLength(body, "utf8");
const closed = { status: "closed" } as const;
const span = (start: number, end: number, target: SourceGoldUnit = GOLD): AnswerTurnSpan =>
  ({ session_index: 0, message_index: 0, source_id: target.root_id, target, start, end });
const gold = (spans: readonly AnswerTurnSpan[], complete = true, annotated = spans.length): AnswerTurnGold =>
  ({ unit: "published_body_utf8_bytes", annotated_turns: annotated, spans, complete });
const identity = (overrides: Partial<SourceGoldUnit>): SourceGoldUnit => ({ ...GOLD, ...overrides });
const interval = (rank: number, start: number, end: number, target: SourceGoldUnit = GOLD): ConsumerVisibilityInterval =>
  ({ rank, target, start, end });
const page = (intervals: readonly ConsumerVisibilityInterval[],
  continuation: "none" | "present" | "unknown" = "none", pageNumber = 1,
  complete = true, occupiedSlots = intervals.length): ConsumerVisibilityPage => ({
    page: pageNumber, status: "observed", reason: null, occupied_slots: occupiedSlots,
    complete, continuation, intervals });
/** A full five-slot first page; ranks not supplied by the case get non-overlapping filler intervals. */
const firstPage = (continuation: "none" | "present" | "unknown",
  intervals: readonly ConsumerVisibilityInterval[] = []): ConsumerVisibilityPage => {
  const used = new Set(intervals.map(entry => entry.rank));
  const fillers = [1, 2, 3, 4, 5].filter(rank => !used.has(rank))
    .map(rank => interval(rank, 1_000 + rank * 10, 1_005 + rank * 10));
  return page([...fillers, ...intervals].sort((left, right) => left.rank - right.rank), continuation);
};
const score = (goldValue: AnswerTurnGold, pages: readonly ConsumerVisibilityPage[],
  admission: { status: "closed" } | { status: "open"; reason: string } = closed) =>
  scoreConsumerMessageVisibility({ gold: goldValue, admission, pages });

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
      occupied_slots: 5, complete: false, continuation: "present" as const, intervals: [] };
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

  it("requires caller admission for an observed absence but never blocks a visible positive", () => {
    const oneTurn = gold([span(0, 10)]);
    const open = { status: "open" as const, reason: "native_access_or_computation_unresolved" };
    expect(score(oneTurn, [firstPage("none")], open).any_at_5).toEqual({ status: "unknown", reason: open.reason });
    expect(score(oneTurn, [firstPage("none")], open).all_at_5).toEqual({ status: "unknown", reason: open.reason });
    expect(score(oneTurn, [firstPage("none", [interval(1, 0, 10)])], open).any_at_5.status).toBe("hit");
    expect(score(oneTurn, [firstPage("none", [interval(1, 0, 10)])], open).all_at_5.status).toBe("hit");
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

  it("keeps a short observed page before a continuation conservative at @5", () => {
    const oneTurn = gold([span(0, 10)]);
    const short = page([interval(1, 20, 30)], "present", 1, true, 3);
    const result = score(oneTurn, [short]);
    expect(result.any_at_5).toEqual({ status: "unknown", reason: "second_page_not_observed" });
    expect(result.all_at_5).toEqual({ status: "unknown", reason: "second_page_not_observed" });
    expect(result.observation).toEqual({ observed_pages: 1, observed_through: 3, continuation: "unobserved" });
  });
});
