import { describe, expect, it } from "vitest";
import {
  ORDINARY_NATIVE_FIELD_RESULT_VERSION,
  indexEntryCacheKey,
  memoryIndexEntry,
  sourceIndexEntry,
  type InformationIndex
} from "@do-soul/alaya-protocol";
import { encodeIndexResults } from "../../../recall/runtime/recall-page-encoding.js";

function memoryPage(texts: readonly string[]) {
  const entries = texts.map((_text, index) => memoryIndexEntry({
    workspace_id: "workspace", object_id: `memory-${index}`, source_revision: "1",
    association_milligrades: 500
  }));
  const index: InformationIndex = {
    schema_version: 1, query_id: `sha256:${"a".repeat(64)}`, snapshot_id: `sha256:${"b".repeat(64)}`,
    as_of: "2026-09-06T12:00:00.000Z", result_version: ORDINARY_NATIVE_FIELD_RESULT_VERSION,
    entries, continuation: null,
    completeness: { schema_version: 1, logical_index: "open", observed_coverage: "unknown",
      transport: "complete", payload: "complete", representation: "complete" },
    representation: { schema_version: 1, policy: "construct_index_then_page_then_payload",
      page_budget: entries.length, identity_tie_break: "serialization" }
  };
  const previews = new Map(entries.map((entry, offset) => [indexEntryCacheKey(entry), texts[offset]!]));
  return { index, previews };
}

function sourcePage(text: string) {
  const entry = sourceIndexEntry({
    workspace_id: "workspace", root_kind: "source_record", root_id: "source-0",
    source_version: "1", content_digest: `sha256:${"c".repeat(64)}`, evidence_object_id: null,
    association_milligrades: 500, hypothesis_id: "source", output_binding: "source",
    program_state: "matched", time_state: "current"
  });
  const withSpan = { ...entry, target: { ...entry.target, span: { content_start: 0,
    content_end: Buffer.byteLength(text), retained_extent: "body" as const,
    content_complete: true, original_complete: true } } };
  const { index } = memoryPage([]);
  return {
    index: { ...index, entries: [withSpan], representation: { ...index.representation, page_budget: 1 } },
    previews: new Map([[indexEntryCacheKey(withSpan), text]])
  };
}

describe("recall page encoding UTF-8 byte charges", () => {
  it.each([
    ["ascii", "hello"],
    ["cjk", "你好"],
    ["mixed", "café😀"]
  ] as const)("charges %s preview bytes, not JS string length", (_label, text) => {
    const { index, previews } = memoryPage([text]);
    const encoded = encodeIndexResults(index, previews, 2_000);
    expect(encoded).toHaveLength(1);
    const bytes = Buffer.byteLength(text);
    expect(encoded[0]!.content_preview).toBe(text);
    expect(encoded[0]!.budget_state.token_estimate).toBe(bytes);
    if (text.length !== bytes) {
      expect(encoded[0]!.budget_state.token_estimate).not.toBe(text.length);
    }
    expect(encoded[0]!.budget_state.max_total_tokens).toBe(2_000);
    expect(encoded[0]!.budget_state.remaining_tokens).toBe(2_000 - bytes);
    expect(encoded[0]!.budget_state.within_budget).toBe(true);
  });

  it("accumulates diagnostic used_tokens as UTF-8 charges in membership order", () => {
    const texts = ["ab", "你好", "é"];
    const { index, previews } = memoryPage(texts);
    let observed: { used_tokens: number; result_count: number } | undefined;
    const encoded = encodeIndexResults(index, previews, 2_000, {}, undefined, observation => {
      observed = observation;
    });
    expect(encoded.map(row => row.content_preview)).toEqual(texts);
    const charges = encoded.map(row => row.budget_state.token_estimate);
    expect(charges).toEqual(texts.map(text => Buffer.byteLength(text)));
    expect(observed?.result_count).toBe(3);
    expect(observed?.used_tokens).toBe(charges.reduce((sum, value) => sum + value, 0));
    expect(encoded.at(-1)!.budget_state.remaining_tokens).toBe(2_000 - observed!.used_tokens);
    expect(encoded.map(row => row.budget_state.max_total_tokens)).toEqual([2_000, 2_000, 2_000]);
  });

  it("truncates CJK on a UTF-8 boundary without a replacement character", () => {
    const text = "你好世界";
    const { index, previews } = memoryPage([text]);
    const encoded = encodeIndexResults(index, previews, 5);
    expect(encoded).toHaveLength(1);
    expect(encoded[0]!.content_preview).toBe("你");
    expect(encoded[0]!.content_preview).not.toContain("\uFFFD");
    expect(Buffer.byteLength(encoded[0]!.content_preview)).toBe(3);
    expect(encoded[0]!.budget_state.token_estimate).toBe(3);
    expect(encoded[0]!.budget_state.token_estimate).toBeLessThanOrEqual(5);
    expect(encoded[0]!.budget_state.remaining_tokens).toBe(2);
  });

  it("charges four UTF-8 bytes for a fitting emoji, not JS length 2", () => {
    const { index, previews } = memoryPage(["😀"]);
    const encoded = encodeIndexResults(index, previews, 4);
    expect(encoded[0]!.content_preview).toBe("😀");
    expect(encoded[0]!.budget_state.token_estimate).toBe(4);
    expect("😀".length).toBe(2);
  });

  it("defers an emoji when neither the scalar nor the omission marker fits", () => {
    const { index, previews } = memoryPage(["😀"]);
    const encoded = encodeIndexResults(index, previews, 3);
    expect(encoded).toEqual([]);
  });

  it("keeps the default page cap at 2000 encoded bytes", () => {
    const { index, previews } = memoryPage(["x"]);
    const encoded = encodeIndexResults(index, previews);
    expect(encoded[0]!.budget_state.max_total_tokens).toBe(2_000);
    expect(encoded[0]!.budget_state.token_estimate).toBe(1);
  });

  it("charges source disclosure as extra UTF-8 bytes on the same token_estimate field", () => {
    const text = "你好";
    const { index, previews } = sourcePage(text);
    const encoded = encodeIndexResults(index, previews, 2_000);
    expect(encoded).toHaveLength(1);
    expect(encoded[0]!.content_preview).toBe(text);
    expect(encoded[0]!.source_disclosure).toBeDefined();
    const previewBytes = Buffer.byteLength(text);
    expect(encoded[0]!.budget_state.token_estimate).toBeGreaterThan(previewBytes);
    expect(encoded[0]!.budget_state.token_estimate - previewBytes).toBe(
      Buffer.byteLength(JSON.stringify({ source_disclosure: encoded[0]!.source_disclosure }))
    );
    expect(encoded[0]!.budget_state.remaining_tokens).toBe(
      2_000 - encoded[0]!.budget_state.token_estimate
    );
  });
});
