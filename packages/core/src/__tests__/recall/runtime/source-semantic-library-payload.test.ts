import { expect, it } from "vitest";
import { indexEntryCacheKey } from "@do-soul/alaya-protocol";
import { assembleSourceSemanticLibraryIndex, encodeSourceSemanticLibraryResults, sourceSemanticLibrarySourceEntry } from "../../../recall/runtime/source-semantic-library-recall.js";

function encode(previews: readonly (string | undefined)[], tokens: number) {
  const { index } = assembleSourceSemanticLibraryIndex({
    query_id: "query", snapshot_id: `sha256:${"ab".repeat(32)}`, interpretation_id: "interpretation",
    as_of: "2026-09-22T00:00:00.000Z", proof_groups: [], truncated: false, open_residuals: false,
    source_entries: previews.map((_, offset) => sourceSemanticLibrarySourceEntry({
      workspaceId: "workspace", root_id: `root-${offset}`, source_version: "1",
      content_digest: `sha256:${"cd".repeat(32)}`, evidence_object_id: null, hypothesis_id: "interpretation"
    }))
  });
  const contents = new Map(index.entries.flatMap((entry, offset) => previews[offset] === undefined
    ? [] : [[indexEntryCacheKey(entry), previews[offset]!] as const]));
  return encodeSourceSemanticLibraryResults(index, contents, tokens);
}

it("reserves a late short source before assigning a long first preview its remaining allowance", () => {
  const results = encode(["x".repeat(1000), "Bo repaired the door."], 20);
  expect(results.map(row => row.content_preview)).toEqual(["x".repeat(56), "Bo repaired the door."]);
  expect(results.map(row => row.budget_state.token_estimate)).toEqual([14, 6]);
  expect(results.map(row => row.budget_state.within_budget)).toEqual([false, true]);
  expect(results[1]!.budget_state.remaining_tokens).toBe(0);
});

it("gives equally long occupied slots a share and reports estimates rather than character counts", () => {
  const results = encode(["a".repeat(100), "b".repeat(100), "c".repeat(100)], 12);
  expect(results.map(row => row.content_preview.length)).toEqual([16, 16, 16]);
  expect(results.map(row => row.budget_state.token_estimate)).toEqual([4, 4, 4]);
  expect(results.every(row => row.budget_state.within_budget === false)).toBe(true);
});

it("keeps supplementary source characters whole at an estimated token boundary", () => {
  const [result] = encode(["abc🙂界"], 1);
  expect(result!.content_preview).toBe("abc");
  expect(Buffer.from(result!.content_preview, "utf8").toString("utf8")).toBe(result!.content_preview);
  expect(result!.budget_state.token_estimate).toBe(1);
  expect(result!.budget_state.within_budget).toBe(false);
});

it("distinguishes a hydrated empty source from an unavailable preview", () => {
  const results = encode(["", undefined], 20);
  expect(results.map(row => row.content_preview)).toEqual(["[empty source]", "[payload omitted]"]);
  expect(results.map(row => row.budget_state.within_budget)).toEqual([true, false]);
  expect(results.map(row => row.budget_state.token_estimate)).toEqual([4, 5]);
});

it("does not underreport the omission marker when no preview budget remains", () => {
  const [result] = encode(["source"], 0);
  expect(result!.content_preview).toBe("[payload omitted]");
  expect(result!.budget_state.token_estimate).toBe(5);
  expect(result!.budget_state.within_budget).toBe(false);
  expect(result!.budget_state.remaining_tokens).toBe(0);
});
