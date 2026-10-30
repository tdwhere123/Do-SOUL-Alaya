import { afterAll, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const boundaries = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  const { installStrictProviderFreeBoundary } = await import("../../support/strict-provider-free-boundary.js");
  return [installProviderFreeBoundary(), installStrictProviderFreeBoundary()] as const;
});
afterAll(() => { expect(boundaries[0].violations).toEqual([]); expect(boundaries[1].forbidden).toEqual([]);
  boundaries[1].restore(); boundaries[0].restore(); });
import { solveConditionalNavigation, type NavigationCondition } from "../../../runs/source-access-diagnostic/conditional-navigation.js";
import { FieldDeliverySchema, packFieldWindows, selectFieldDelivery, type FieldDelivery, type LiteralDeliveryWindow } from "../../../runs/source-access-diagnostic/field-delivery.js";
import { scoreConsumerByteVisibility } from "../../../runs/longmemeval-semantic/message-visibility.js";
import { readFieldAnchor } from "../../../runs/source-access-diagnostic/field-delivery-read.js";
import { anchorAccounting } from "../../../runs/source-access-diagnostic/navigation-read-budget.js";
import { sourceIndexTarget, type SourceSemanticNominationOccurrence } from "@do-soul/alaya-protocol";
import { fixture, publishSource, fieldSha256, WORKSPACE } from "../../../../../../packages/storage/src/__tests__/repos/source-index/source-index-fixture.js";
const policy: FieldDelivery = { contract: "benchmark-field-delivery.v1", selection: "condition-cover", windows: "prefix", byte_budget: 8192 };
const condition = (id: string): NavigationCondition => ({ id, query: id, object: "object", hypothesis: "hypothesis",
  status: "ready", residual: null, provenance: "authored" });
function solved(status: NavigationCondition["status"] = "ready") {
  const ids = ["first", "redundant", "complementary", "unknown"];
  return solveConditionalNavigation({ original: "original", conditions: [condition("original"), { ...condition("extra"), status,
    residual: status === "partial" ? "unresolved" : null }], branches: [["extra"]],
  pool: ids.map((record_id, catalog_position) => ({ record_id, catalog_position })), occurrences: [
    ...["first", "redundant"].map((record_id, i) => ({ condition: "original", channel: i === 0 ? "lexical" as const : "vector" as const,
      native_rank: 1, reference: `original-${i}`, root_key: record_id, record_id })),
    { condition: "extra", channel: "vector", native_rank: 1, reference: "extra-1", root_key: "complementary", record_id: "complementary" }
  ] });
}
const window = (root: string, text: string, start = 0): LiteralDeliveryWindow => ({ rank: 1, source_id: root,
  target: { kind: "source_evidence", root_kind: "source_record", root_id: root, workspace_id: "workspace",
    source_version: "1", content_digest: `sha256:${"a".repeat(64)}`, evidence_object_id: null }, start,
  end: start + Buffer.byteLength(text), text });

it("covers only existing known branches, preserves field ties and leaves unknown support unknown", () => {
  const result = selectFieldDelivery(solved(), policy);
  expect(result.rows.map(r => r.record_id)).toEqual(["first", "complementary", "redundant", "unknown"]);
  expect(result.steps.map(s => s.newly_covered)).toEqual([['["original"]'], ['["extra"]'], [], []]);
  expect(result.conditional_support).toBe("unknown");
  expect(selectFieldDelivery(solved(), { ...policy, selection: "field-order" }).rows.map(r => r.record_id))
    .toEqual(["first", "redundant", "complementary", "unknown"]);
  expect(result.status).toBe("changed");
});
it.each(["unknown", "partial", "unsupported", "rejected"] as const)("does not count %s evidence as coverage or absence", status => {
  const result = selectFieldDelivery(solved(status), policy);
  expect(result.status).toBe("no_op");
  expect(result.steps.flatMap(s => s.newly_covered)).toEqual(['["original"]']);
});
it("first-fits actual literal UTF-8 bytes, never a source-id whole-message proxy", () => {
  const result = packFieldWindows([window("a", "A京都🙂Z"), window("b", "ok")], 8);
  expect(result.windows.map(w => [w.text, w.start, w.end])).toEqual([["A京都", 0, 7], ["o", 0, 1]]);
  expect(result.unique_utf8_bytes).toBe(8);
  expect(result.input_utf8_bytes).toBe(14);
  const gold = { unit: "published_body_utf8_bytes" as const, annotated_turns: 1, complete: true,
    spans: [{ session_index: 0, message_index: 0, source_id: "a", target: window("a", "").target, start: 0, end: 12 }] };
  expect(scoreConsumerByteVisibility({ gold, windows: result.windows, unique_utf8_bytes: 8, byte_budget: 8 }))
    .toEqual({ any_at_budget: { status: "miss", reason: null }, all_at_budget: { status: "miss", reason: null } });
});
it("counts duplicate/overlap bytes once and enforces the single-message slot", () => {
  const result = packFieldWindows([window("a", "abcdef"), window("a", "cdefgh", 2), window("b", "京都")], 30);
  expect(result.windows.map(w => w.text)).toEqual(["abcdef", "京都"]);
  expect(result.unique_utf8_bytes).toBe(12); expect(result.duplicate_input_bytes).toBe(4);
});
it("preserves zero delivery and under-codepoint remainder without replacement characters", () => {
  expect(packFieldWindows([window("a", "京都")], 0).windows).toEqual([]);
  expect(packFieldWindows([window("a", "京都")], 2).windows).toEqual([]);
  expect(packFieldWindows([window("a", "京都")], 3).windows[0]!.text).toBe("京");
  expect(() => packFieldWindows([window("a", "x")], -1)).toThrow();
});
it("equal shares broaden prefixes but can lose late detail, without changing the input", () => {
  const input = [window("a", "abcLATE!"), window("b", "USEFUL!!"), window("c", "USEFUL!!")];
  const before = structuredClone(input), ordered = packFieldWindows(input, 9), balanced = packFieldWindows(input, 9, "equal-share-prefix");
  expect(input).toEqual(before);
  expect(ordered.windows.map(w => w.text)).toEqual(["abcLATE!", "U"]);
  expect(balanced.windows.map(w => [w.source_id, w.start, w.end, w.text])).toEqual([
    ["a", 0, 3, "abc"], ["b", 0, 3, "USE"], ["c", 0, 3, "USE"]]);
  expect(balanced.input_utf8_bytes).toBe(24); expect(balanced.unique_utf8_bytes).toBe(9);
  expect(packFieldWindows(input, 9, undefined)).toEqual(ordered);
  expect(balanced.windows[0]!.target).toEqual(input[0]!.target);
});
it("redistributes short-prefix capacity and stable integer remainders", () => {
  const input = [window("a", "x"), window("b", "abcdefgh"), window("c", "ABCDEFGH")];
  expect(packFieldWindows(input, 10, "equal-share-prefix").windows.map(w => w.text)).toEqual(["x", "abcde", "ABCD"]);
  expect(packFieldWindows(input, 30, "equal-share-prefix").unique_utf8_bytes).toBe(17);
  expect(packFieldWindows([input[1]!, input[0]!, input[2]!], 5, "equal-share-prefix").windows.map(w => w.text)).toEqual(["ab", "x", "AB"]);
  expect(packFieldWindows([], 10, "equal-share-prefix").windows).toEqual([]);
});
it("redistributes UTF-8 slack only in whole codepoints with stable least-filled ties", () => {
  const input = [window("a", "京都"), window("b", "🙂🙂"), window("c", "abc")];
  expect(packFieldWindows(input, 8, "equal-share-prefix").windows.map(w => w.text)).toEqual(["京", "abc"]);
  expect(packFieldWindows(input, 9, "equal-share-prefix").windows.map(w => w.text)).toEqual(["京都", "abc"]);
  expect(packFieldWindows(input, 10, "equal-share-prefix").windows.map(w => w.text)).toEqual(["京", "🙂", "abc"]);
  for (const budget of [0, 1, 2]) expect(packFieldWindows([window("a", "京都")], budget, "equal-share-prefix").windows).toEqual([]);
  expect(packFieldWindows([window("a", "京都"), window("b", "abc")], 2, "equal-share-prefix").windows.map(w => w.text)).toEqual(["ab"]);
});
it("keeps one prefix per root, ten slots, per-source cap, and explicit omitted extents", () => {
  const input = [window("a", "abcdef"), window("a", "abcdefgh"), window("b", "0123456789")];
  const packed = packFieldWindows(input, 8, "equal-share-prefix");
  expect(packed.windows.map(w => w.text)).toEqual(["abcd", "0123"]);
  expect(packed.duplicate_input_bytes).toBe(4); expect(packed.input_utf8_bytes).toBe(24);
  const many = Array.from({ length: 11 }, (_, i) => window(String(i), "x".repeat(5000)));
  const capped = packFieldWindows(many, 40960, "equal-share-prefix");
  expect(capped.windows.map(w => [w.source_id, w.end])).toEqual(Array.from({ length: 10 }, (_, i) => [String(i), 4096]));
  expect(capped.unique_utf8_bytes).toBe(40960);
  expect(capped.prefix_packing?.[10]).toEqual({ record_id: "10", status: "omitted", read_start: 0, read_end: 5000, delivered_start: null, delivered_end: null });
  expect(packFieldWindows([window("a", ""), window("b", "ok")], 1, "equal-share-prefix").windows.map(w => w.text)).toEqual(["o"]);
  expect(() => packFieldWindows([window("a", "x", 1)], 1, "equal-share-prefix")).toThrow(/prefix/);
  expect(() => packFieldWindows([{ ...window("a", "京都"), end: 2 }], 1, "equal-share-prefix")).toThrow(/extent/);
  expect(() => packFieldWindows([window("a", "\ud800")], 1, "equal-share-prefix")).toThrow(/extent/);
  expect(FieldDeliverySchema.safeParse({ ...policy, windows: "native-anchor", packing: "equal-share-prefix" }).success).toBe(false);
});
it("reuses actual SQLite containment for a non-prefix UTF-8 anchor, missing locations and identity/scope failures", () => {
  const db = fixture(), body = "前🙂".repeat(1000) + "京都🙂", start = 7000, end = 7010;
  try {
    const record = publishSource(db, body, "bound-message", { scope_class: "project" });
    const source = sourceIndexTarget({ kind: "source_evidence", workspace_id: WORKSPACE, root_kind: "source_record",
      root_id: record.record_id, source_version: record.source_version, content_digest: record.content_digest,
      evidence_object_id: null }, record.source_id, Buffer.byteLength(body));
    const witness: SourceSemanticNominationOccurrence = { reference: "authored-reader-only", attempt: 1, view: "original", source,
      route: { kind: "vector", native_rank: 1, cosine: 1, window: { status: "available", window: {
        window_id: `sha256:${fieldSha256("authored-window")}`, start_byte: start, end_byte: end,
        content_digest: `sha256:${fieldSha256("京都🙂")}` } } } };
    const meter = anchorAccounting();
    const input = { database: db.database, workspace: WORKSPACE, clock: "2026-09-22T00:00:00.000Z",
      original_query: "authored", scopes: ["project"], witnesses: [witness], record_id: record.record_id, rank: 1, accounting: meter };
    expect(readFieldAnchor(input)).toMatchObject({ status: "available", window: { start, end, text: "京都🙂" } });
    expect(meter.status).toBe("complete"); expect(meter.native_bytes_including_metadata).toBeGreaterThan(10);
    expect(meter.physical_reads).toBeNull();
    const missing = anchorAccounting();
    expect(readFieldAnchor({ ...input, accounting: missing, witnesses: [{ ...witness,
      route: { kind: "vector", native_rank: 1, cosine: 1, window: { status: "unavailable", reason: "not_retained" } } }] }))
      .toEqual({ status: "unavailable", reason: "native_location_missing" });
    expect(missing.attempts).toBe(0);
    for (const change of [{ source_version: "changed" }, { content_digest: `sha256:${"0".repeat(64)}` }]) {
      const target = { ...source.target, ...change };
      const mismatch = { ...witness, source: sourceIndexTarget(target, source.source_id, source.body_bytes) };
      expect(() => readFieldAnchor({ ...input, witnesses: [mismatch], accounting: anchorAccounting() })).toThrow(/current source/);
    }
    const denied = anchorAccounting();
    expect(() => readFieldAnchor({ ...input, scopes: [], accounting: denied })).toThrow(/authorized scopes/);
    expect(denied.native_bytes_including_metadata).toBeGreaterThan(0); expect(denied.status).toBe("partial");
    for (const [from, to] of [[7001, 7010], [7000, 7008], [0, 5000]]) {
      const invalid: SourceSemanticNominationOccurrence = { ...witness, route: { kind: "vector", native_rank: 1, cosine: 1,
        window: { status: "available", window: { window_id: `sha256:${fieldSha256("invalid-window")}`,
          start_byte: from!, end_byte: to!, content_digest: `sha256:${fieldSha256("invalid")}` } } } };
      expect(() => readFieldAnchor({ ...input, witnesses: [invalid], accounting: anchorAccounting() })).toThrow();
    }
  } finally { db.database.close({ optimize: false }); }
});

it("publishes independent metrics but no paired deltas when either delivered arm is unavailable", () => {
  const proof = fileURLToPath(new URL("../../support/field-delivery-proof.mjs", import.meta.url));
  // Full replay starts roughly 98 bounded CLI children, including failure arms
  // and frozen evaluations; their cumulative startup time can exceed two minutes.
  const output = execFileSync(process.execPath, [proof], { encoding: "utf8", timeout: 300_000, stdio: "pipe" });
  expect(JSON.parse(output)).toMatchObject({ status: "complete", comparisons: 5 });
}, 310_000);

it("fixed byte visibility requires a whole message and keeps unavailable distinct from miss", () => {
  const w = window("a", "abc", 20);
  const gold = { unit: "published_body_utf8_bytes" as const, annotated_turns: 1, complete: true,
    spans: [{ session_index: 0, message_index: 0, source_id: "a", target: w.target, start: 20, end: 23 }] };
  const input = { gold, windows: [w], unique_utf8_bytes: 3, byte_budget: 3 };
  expect(scoreConsumerByteVisibility(input).all_at_budget.status).toBe("hit");
  expect(scoreConsumerByteVisibility({ ...input, unavailableReason: "native_location_missing" }).any_at_budget.status).toBe("unknown");
  expect(scoreConsumerByteVisibility({ ...input, windows: [], unique_utf8_bytes: 0 }).any_at_budget.status).toBe("miss");
  expect(scoreConsumerByteVisibility({ ...input, windows: [] }).any_at_budget.status).toBe("unknown");
});
