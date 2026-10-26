import { describe, expect, it } from "vitest";
import { ORDINARY_NATIVE_FIELD_RESULT_VERSION, indexEntryCacheKey, sourceIndexEntry,
  type InformationIndex } from "@do-soul/alaya-protocol";
import { encodeIndexResults } from "../../../recall/runtime/recall-page-encoding.js";
import { completeSourceDeliveryEnd } from "../../../recall/runtime/source-delivery-prefix.js";

function sourcePage(texts: readonly string[], recorded = true) {
  const entries = texts.map((text, index) => {
    const entry = sourceIndexEntry({
      workspace_id: "workspace", root_kind: "source_record", root_id: `source-${index}`,
      source_version: "1", content_digest: `sha256:${String(index).repeat(64)}`, evidence_object_id: null,
      association_milligrades: 500, hypothesis_id: "source", output_binding: "source",
      program_state: "matched", time_state: "current"
    });
    return { ...entry, target: { ...entry.target, span: { content_start: 0,
      content_end: Buffer.byteLength(text), retained_extent: "body" as const,
      content_complete: true, original_complete: true } } };
  });
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
  const metadata = Object.fromEntries(entries.map((entry, offset) => [indexEntryCacheKey(entry), recorded
    ? { delivery_boundaries: { status: "available" as const,
      spans: [{ purpose: "message" as const, end_offset: Buffer.byteLength(texts[offset]!) }] } } : {}]));
  return { index, previews, metadata };
}

const first = "a".repeat(300), second = "b".repeat(300);

describe("source structural membership fitting", () => {
  it.each([744, 800])("defers an omitted or fragmented tail unit that fits a fresh %s-byte page", budget => {
    const { index, previews, metadata } = sourcePage([first, second]);
    const wide = encodeIndexResults(index, previews, budget, metadata);
    expect(wide).toHaveLength(1);
    expect(wide[0]!.content_preview).toBe(first);
    // The codec has not acknowledged either membership. Its owner must refit a
    // shorter prefix; the pending entry is still available for the next page.
    expect(index.entries).toHaveLength(2);
    const next = encodeIndexResults({ ...index, entries: index.entries.slice(1),
      representation: { ...index.representation, page_budget: 1 } }, previews, budget, metadata);
    expect(next).toHaveLength(1);
    expect(next[0]!.content_preview).toBe(second);
    expect(next[0]!.target).toEqual(index.entries[1]!.target);
  });

  it("does not defer an oversized first unit or invent an empty page", () => {
    const { index, previews, metadata } = sourcePage(["猫".repeat(400)]);
    const encoded = encodeIndexResults(index, previews, 800, metadata);
    expect(encoded).toHaveLength(1);
    expect(encoded[0]!.content_preview.length).toBeGreaterThan(0);
    expect(encoded[0]!.content_preview).not.toContain("�");
    expect(Buffer.byteLength(encoded[0]!.content_preview)).toBeLessThan(1200);
    expect(encoded[0]!.target).toMatchObject({ span: { content_start: 0, content_complete: false } });
  });

  it("keeps UTF-8 progress without recorded structural boundaries", () => {
    const { index, previews, metadata } = sourcePage([first, second], false);
    const encoded = encodeIndexResults(index, previews, 800, metadata);
    expect(encoded).toHaveLength(2);
    expect(encoded[0]!.content_preview).toBe(first);
    expect(encoded[1]!.content_preview.length).toBeGreaterThan(0);
    expect(encoded[1]!.content_preview.length).toBeLessThan(second.length);
  });

  it("retains a fitting complete unit even when later units are truncated", () => {
    const { index, previews, metadata } = sourcePage([first, second]);
    metadata[indexEntryCacheKey(index.entries[1]!)] = { delivery_boundaries: {
      status: "available", spans: [{ purpose: "message", end_offset: 5 }, { purpose: "message", end_offset: 300 }]
    } };
    const encoded = encodeIndexResults(index, previews, 800, metadata);
    expect(encoded).toHaveLength(2);
    expect(encoded[1]!.content_preview).toBe("bbbbb");
  });

  it("distinguishes unknown, empty and invalid ends from a complete UTF-8 unit", () => {
    expect(completeSourceDeliveryEnd("猫", undefined)).toBeUndefined();
    expect(completeSourceDeliveryEnd("猫", [])).toBeUndefined();
    expect(completeSourceDeliveryEnd("猫", [-1, 0, 1, 2, 1.5, NaN, 4])).toBeUndefined();
    expect(completeSourceDeliveryEnd("猫tail", [3, 7])).toBe(7);
  });
});
