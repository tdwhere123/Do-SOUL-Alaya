import { afterAll, expect, it, vi } from "vitest";
const boundary = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterAll(() => { expect(boundary.violations).toEqual([]); boundary.restore(); });
import { scoreOrdinaryByteVisibility, type OrdinaryLiteralWindow } from "../../../runs/recall-measurement/ordinary/ordinary-byte-visibility.js";
import type { ConsumerVisibilityPage } from "../../../runs/longmemeval-semantic/message-visibility.js";
import type { AnswerTurnGold } from "../../../runs/longmemeval-semantic/answer-spans.js";

const window = (root: string, rank: number, text: string, start = 0): OrdinaryLiteralWindow => ({
  rank, text, start, end: start + Buffer.byteLength(text), target: { workspace_id: "workspace",
    root_kind: "source_record", root_id: root, source_version: "1", content_digest: `sha256:${"a".repeat(64)}` }
});
const page = (windows: readonly OrdinaryLiteralWindow[], exhausted = true): ConsumerVisibilityPage => ({
  page: 1, status: "observed", reason: null, occupied_slots: windows.at(-1)?.rank ?? 0, complete: true,
  continuation: exhausted ? "none" : "present", terminal_tail: { status: exhausted ? "exhausted" : "open", reason: "fixture" },
  intervals: windows.map(({ text: _text, ...interval }) => interval)
});
const gold = (windows: readonly OrdinaryLiteralWindow[]): AnswerTurnGold => ({ unit: "published_body_utf8_bytes",
  annotated_turns: windows.length, complete: true, spans: windows.map((value, index) => ({
    session_index: index, message_index: 0, source_id: value.target.root_id, target: value.target, start: value.start, end: value.end
  })) });
it("scores fixed source-byte prefixes and thresholds without renumbering mixed occupied slots", () => {
  const windows = [window("first", 2, "a".repeat(2048)), window("second", 5, "京".repeat(683))];
  const result = scoreOrdinaryByteVisibility({ windows, pages: [page(windows)], gold: gold(windows) });
  expect(result.budgets.map(row => [row.any_at_budget.status, row.all_at_budget.status, row.source_utf8_bytes]))
    .toEqual([["hit", "miss", 2048], ["hit", "miss", 4094], ["hit", "hit", 4097]]);
  expect(result.first_hit_byte).toEqual({ status: "visible", bytes: 2048, reason: null });
  expect(result.last_hit_byte).toEqual({ status: "visible", bytes: 4097, reason: null });
  expect(windows.map(value => value.rank)).toEqual([2, 5]);
});
it("stops at a clipped UTF-8 unit instead of spending boundary slack on later roots", () => {
  const windows = [window("first", 1, "a".repeat(2047) + "京"), window("second", 2, "x")];
  const result = scoreOrdinaryByteVisibility({ windows, pages: [page(windows)], gold: gold([windows[1]!]) });
  expect(result.budgets[0]!.any_at_budget.status).toBe("miss");
  expect(result.first_hit_byte.bytes).toBe(2051);
});
it("distinguishes an uncaptured tail from not visible in the complete bounded capture", () => {
  const windows = [window("first", 1, "x")], absent = gold([window("absent", 2, "yes")]);
  const partial = scoreOrdinaryByteVisibility({ windows, pages: [page(windows, false)], gold: absent });
  expect(partial.budgets.every(row => row.any_at_budget.status === "unknown")).toBe(true);
  expect(partial.first_hit_byte.status).toBe("unknown");
  const terminal = scoreOrdinaryByteVisibility({ windows, pages: [page(windows)], gold: absent });
  expect(terminal.first_hit_byte.status).toBe("not_visible");
  expect(terminal.budgets.every(row => row.any_at_budget.status === "miss")).toBe(true);
});
it("keeps budget positives but not exact thresholds when an unmapped answer turn may precede the mapped hit", () => {
  const windows = [window("earlier", 1, "x"), window("later", 2, "hello", 17)];
  const result = scoreOrdinaryByteVisibility({ windows, pages: [page(windows)],
    gold: { ...gold([windows[1]!]), complete: false, annotated_turns: 2 } });
  expect(result.first_hit_byte).toEqual({ status: "unknown", bytes: null, reason: "answer_turn_mapping_incomplete" });
  expect(result.last_hit_byte.status).toBe("unknown");
  expect(result.budgets[0]!.any_at_budget.status).toBe("hit");
  const resolved = scoreOrdinaryByteVisibility({ windows, pages: [page(windows)], gold: gold(windows) });
  expect(resolved.first_hit_byte.bytes).toBe(1);
  expect(resolved.last_hit_byte.bytes).toBe(6);
});
it("refuses duplicate-root fragments, literal mismatch, malformed pages and unobserved delivery", () => {
  const windows = [window("first", 1, "x"), window("first", 2, "y", 3)];
  const duplicate = scoreOrdinaryByteVisibility({ windows, pages: [page(windows)], gold: gold(windows) });
  expect(duplicate.first_hit_byte.status).toBe("unknown");
  expect(duplicate.captured_stream_complete).toBeNull();
  const valid = [windows[0]!];
  for (const input of [
    { windows: [{ ...valid[0]!, text: "longer" }], pages: [page(valid)] },
    { windows: valid, pages: [{ ...page(valid), page: 2 }] },
    { windows: [], pages: [] }
  ]) expect(scoreOrdinaryByteVisibility({ ...input, gold: gold(valid) }).budgets.every(row =>
    row.any_at_budget.status === "unknown" && row.all_at_budget.status === "unknown")).toBe(true);
});
it("does not turn an observed empty terminal page into unobserved delivery", () => {
  const result = scoreOrdinaryByteVisibility({ windows: [], pages: [page([])], gold: gold([window("absent", 1, "x")]) });
  expect(result.first_hit_byte.status).toBe("not_visible");
  expect(result.budgets.every(row => row.any_at_budget.status === "miss")).toBe(true);
});
