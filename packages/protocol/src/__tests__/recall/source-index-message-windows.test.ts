import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { prepareSourceIndexDocument, sourceIndexTarget, sourceIndexProfileId,
  type SourceIndexMessageStructure, type SourceIndexProfile } from "../../recall/source-index.js";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const profile: SourceIndexProfile = { provider_kind: "fixture", model_id: "authored", model_revision: "1",
  artifact_digest: `sha256:${"a".repeat(64)}`, tokenizer_revision: "1", dimensions: 3,
  preprocessing: "raw", normalization: "none", max_input_tokens: 16,
  windowing: "recorded-message-windows.v1", window_bytes: 8 };
const captured = (...spans: (readonly [number, number])[]): SourceIndexMessageStructure => ({ status: "captured",
  occurrences: spans.map(utf8_span => ({ utf8_span, completeness: "complete" })) });
function plan(body: string, structure: SourceIndexMessageStructure, selected = profile) {
  const source = sourceIndexTarget({ kind: "source_evidence", workspace_id: "workspace-1", root_kind: "source_record",
    root_id: "source-1", source_version: "1", content_digest: `sha256:${sha256(body)}`, evidence_object_id: null },
  "source", Buffer.byteLength(body));
  return prepareSourceIndexDocument({ source, body, profile: selected, message_structure: structure }, sha256);
}
function windows(body: string, structure: SourceIndexMessageStructure, selected = profile) {
  const document = plan(body, structure, selected);
  expect(document.windows.map(row => row.text).join("")).toBe(body);
  expect(document.windows.every(row => row.end_byte - row.start_byte <= selected.window_bytes)).toBe(true);
  return document.windows.map(row => [row.start_byte, row.end_byte, row.text]);
}

it("protects multiline messages at recorded end bytes, not newlines or role markers", () => {
  expect(windows("a\nbcDEFGHI", captured([0, 4], [4, 10])))
    .toEqual([[0, 4, "a\nbc"], [4, 10, "DEFGHI"]]);
  expect(windows("User: x y", captured([0, 9])))
    .toEqual([[0, 4, "User"], [4, 9, ": x y"]]);
});

it("splits oversized messages with balanced final UTF-8 fragments, without loss or overlap", () => {
  expect(windows("猫🙂abcd", captured([0, 11])))
    .toEqual([[0, 7, "猫🙂"], [7, 11, "abcd"]]);
  expect(windows("abcdefghijklmnopq", captured([0, 17])))
    .toEqual([[0, 8, "abcdefgh"], [8, 12, "ijkl"], [12, 17, "mnopq"]]);
  expect(windows("猫🙂", captured([0, 7]), { ...profile, window_bytes: 4 }))
    .toEqual([[0, 3, "猫"], [3, 7, "🙂"]]);
});

it("moves whole units to avoid a tiny tail where legal and retains an unavoidable short message", () => {
  expect(windows("abcdefghij", captured([0, 4], [4, 8], [8, 10])))
    .toEqual([[0, 4, "abcd"], [4, 10, "efghij"]]);
  expect(windows("abcdefghi", captured([0, 8], [8, 9])))
    .toEqual([[0, 8, "abcdefgh"], [8, 9, "i"]]);
  expect(windows("<>hello!", captured([2, 7])))
    .toEqual([[0, 8, "<>hello!"]]);
});

it("retains explicit empty, excerpt and unknown facts and uses fallback only for admitted non-message bytes", () => {
  const variants: SourceIndexMessageStructure[] = [{ status: "unknown" }, { status: "not_applicable" }, captured(),
    captured([0, 0]), { status: "captured", occurrences: [{ utf8_span: [0, 9], completeness: "excerpt" }] }];
  for (const structure of variants) {
    expect(windows("abcdefghi", structure)).toEqual([[0, 4, "abcd"], [4, 9, "efghi"]]);
    expect(plan("abcdefghi", structure).message_structure).toEqual(structure);
  }
  expect(windows("", captured([0, 0]))).toEqual([]);
  expect(() => plan("猫🙂", captured([1, 7]))).toThrow(/extent/);
  expect(() => plan("猫🙂", captured([0, 6]))).toThrow(/extent/);
  expect(() => plan("abc", captured([0, 4]))).toThrow(/extent/);
  expect(() => plan("abcd", captured([0, 3], [2, 4]))).toThrow(/extent/);
  expect(() => plan("abc", undefined as never)).toThrow();
});

it("keeps raw manifests unchanged while the new strategy has a distinct profile and window identity", () => {
  const rawProfile = { ...profile, windowing: "utf8-byte-windows.v1" as const };
  const raw = plan("abcdefghi", captured([0, 9]), rawProfile), next = plan("abcdefghi", captured([0, 9]));
  expect(raw.windows.map(row => [row.start_byte, row.end_byte])).toEqual([[0, 8], [8, 9]]);
  expect(raw).not.toHaveProperty("message_structure");
  expect(next.profile_id).not.toBe(raw.profile_id);
  expect(next.windows[0]!.window_id).not.toBe(raw.windows[0]!.window_id);
  expect(sourceIndexProfileId(rawProfile, sha256)).toBe(raw.profile_id);
});
