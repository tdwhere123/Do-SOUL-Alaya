import { expect, it } from "vitest";
import { SOURCE_DISCLOSURE_CODEC_VERSION, SOURCE_DISCLOSURE_DELTA_CODEC_VERSION, SourceDisclosureDeltaSchema,
  SourceDisclosureSchema, SourceDisclosureSemanticSchema, decodeHistoricalSourceDisclosure, decodePageSourceDisclosure,
  encodePageSourceDisclosure, encodeSourceDisclosure, qualifySourceDisclosure, sourceDisclosure,
  sourceDisclosureFieldByteSavings, type SourceDisclosureSemantic } from "../../recall/source-disclosure.js";
import { SoulMemorySearchResponseSchema, SoulMemorySearchResponseWireSchema } from "../../surfaces/mcp-memory-search-types.js";

const original: SourceDisclosureSemantic = {
  material_kind: "original_body", source_binding: "checked_record", evaluated_as_of: "2026-09-25T10:00:00.0000002Z",
  validity: { kind: "bounded", from: "2026-09-25T10:00:00.0000001Z", to_exclusive: "2026-09-25T10:00:00.0000003Z" },
  temporal_state: "within_interval", proof_use: { kind: "source_only", qualification: "not_current_proof" }
};

it("has one tuple version and preserves precise times, absence, unknown and qualified lineage", () => {
  const variants: SourceDisclosureSemantic[] = [original,
    { ...original, source_time: { kind: "unknown", reason: "not_recorded" } },
    { ...original, source_time: { kind: "known", at: "2024-02-03T04:05:06.0000007Z" } },
    { ...original, material_kind: "canonical_projection", source_representation: {
      kind: "canonical_projection", source_record_ids: [`sha256:${"a".repeat(64)}`, `sha256:${"b".repeat(64)}`]
    }, proof_use: { kind: "conditional_support", qualification: "not_world_claim" } }
  ];
  for (const semantic of variants) {
    const wire = JSON.parse(JSON.stringify(encodeSourceDisclosure(semantic)));
    expect(wire).toHaveLength(9);
    expect(wire[0]).toBe(SOURCE_DISCLOSURE_CODEC_VERSION);
    expect(sourceDisclosure(SourceDisclosureSchema.parse(wire))).toEqual(semantic);
    expect(encodeSourceDisclosure(sourceDisclosure(SourceDisclosureSchema.parse(wire)))).toEqual(wire);
  }
  expect(encodeSourceDisclosure(original)[5]).toBeNull();
  expect(sourceDisclosure(encodeSourceDisclosure(variants[1]!)).source_time).not.toBeUndefined();
});

it("rejects legacy objects, unknown versions, malformed tuples and invalid source qualification", () => {
  expect(SourceDisclosureSchema.safeParse(original).success).toBe(false);
  const wire = encodeSourceDisclosure(original);
  expect(SourceDisclosureSchema.safeParse([2, ...wire.slice(1)]).success).toBe(false);
  const unknownVersion = [2, ...wire.slice(1)] as unknown as typeof wire;
  expect(() => sourceDisclosure(unknownVersion)).toThrow("unsupported source disclosure codec");
  expect(() => qualifySourceDisclosure(unknownVersion, "source_only")).toThrow("unsupported source disclosure codec");
  expect(SourceDisclosureSchema.safeParse(wire.slice(0, 8)).success).toBe(false);
  expect(SourceDisclosureSchema.safeParse([...wire, "extra"]).success).toBe(false);
  expect(SourceDisclosureSchema.safeParse([1, "canonical_projection", "checked_record", null, ...wire.slice(4)]).success).toBe(false);
  expect(SourceDisclosureSemanticSchema.safeParse({ ...original, source_binding: "unbound" }).success).toBe(false);
});

it("keeps historical omitted time and lineage lossless only under the explicit old protocol reader", () => {
  expect(decodeHistoricalSourceDisclosure(original, 14)).toEqual(original);
  expect(decodeHistoricalSourceDisclosure({ ...original, source_time: { kind: "unknown", reason: "not_recorded" } }, 18))
    .toEqual({ ...original, source_time: { kind: "unknown", reason: "not_recorded" } });
  const lineage = { ...original, material_kind: "canonical_projection", source_representation: {
    kind: "canonical_projection", source_record_ids: [`sha256:${"c".repeat(64)}`]
  } };
  expect(decodeHistoricalSourceDisclosure(lineage, 18)).toEqual(lineage);
  expect(() => decodeHistoricalSourceDisclosure(original, 19 as 18)).toThrow("unsupported historical");
});

it("captures caller-owned nested lineage and time before emitting a disclosure", () => {
  const source_record_ids = [`sha256:${"a".repeat(64)}`];
  const source_time = { kind: "known" as const, at: "2024-02-03T04:05:06.0000007Z" };
  const semantic = { ...original, material_kind: "canonical_projection" as const,
    source_representation: { kind: "canonical_projection" as const, source_record_ids }, source_time };
  const wire = encodeSourceDisclosure(semantic);
  source_record_ids.push(`sha256:${"b".repeat(64)}`);
  source_time.at = "2025-01-01T00:00:00Z";
  expect(sourceDisclosure(wire)).toMatchObject({
    source_representation: { source_record_ids: [`sha256:${"a".repeat(64)}`] },
    source_time: { kind: "known", at: "2024-02-03T04:05:06.0000007Z" }
  });
});

it("sizes optional source time from the actual codec as 96 bytes across both copies", () => {
  const without = encodeSourceDisclosure(original);
  const withTime = encodeSourceDisclosure({ ...original, source_time: { kind: "known", at: "2024-02-03T04:05:06.0000007Z" } });
  expect(2 * (Buffer.byteLength(JSON.stringify(withTime)) - Buffer.byteLength(JSON.stringify(without)))).toBe(96);
});

it("losslessly encodes and decodes Codec v2 page-local deltas across all slots including explicit null overrides", () => {
  const anchor = encodeSourceDisclosure({
    ...original,
    material_kind: "canonical_projection",
    source_representation: {
      kind: "canonical_projection",
      source_record_ids: [`sha256:${"a".repeat(64)}`, `sha256:${"b".repeat(64)}`]
    },
    source_time: { kind: "known", at: "2024-02-03T04:05:06.0000007Z" },
    proof_use: { kind: "conditional_support", qualification: "not_world_claim" }
  });

  // Identical disclosure collapses to { v: 2 }.
  const identicalEncoded = encodePageSourceDisclosure(anchor, anchor);
  expect(identicalEncoded).toEqual({ v: 2 });
  expect(decodePageSourceDisclosure(identicalEncoded, anchor)).toEqual(anchor);
  expect(sourceDisclosureFieldByteSavings(anchor, anchor)).toBeGreaterThan(0);

  // Explicit null overrides on optional slots 3 (source_representation) and 5 (source_time), plus slot 1 and slot 8.
  const nulledTimeAndRep = encodeSourceDisclosure({
    ...original,
    material_kind: "retained_excerpt"
  });
  const deltaEncoded = encodePageSourceDisclosure(nulledTimeAndRep, anchor);
  expect(deltaEncoded).toEqual({
    v: SOURCE_DISCLOSURE_DELTA_CODEC_VERSION,
    "1": "retained_excerpt",
    "3": null,
    "5": null,
    "8": { kind: "source_only", qualification: "not_current_proof" }
  });
  expect(decodePageSourceDisclosure(deltaEncoded, anchor)).toEqual(nulledTimeAndRep);

  // Individual changes across slots 2, 4, 6, 7.
  const unbound = encodeSourceDisclosure({
    material_kind: "unknown",
    source_binding: "unbound",
    evaluated_as_of: "2026-09-25T11:00:00.000Z",
    validity: { kind: "unknown", reason: "unbound" },
    temporal_state: "unknown",
    proof_use: { kind: "source_only", qualification: "not_current_proof" }
  });
  const unboundDelta = encodePageSourceDisclosure(unbound, encodeSourceDisclosure(original));
  expect(decodePageSourceDisclosure(unboundDelta, encodeSourceDisclosure(original))).toEqual(unbound);

  // Falls back to literal tuple when delta is not strictly shorter in UTF-8 field bytes.
  const compactAnchor = encodeSourceDisclosure({
    material_kind: "unknown",
    source_binding: "unbound",
    evaluated_as_of: "2026-09-25T10:00:00Z",
    validity: { kind: "unknown", reason: "unbound" },
    temporal_state: "unknown",
    proof_use: { kind: "source_only", qualification: "not_current_proof" }
  });
  expect(encodePageSourceDisclosure(anchor, compactAnchor)).toEqual(anchor);
  expect(sourceDisclosureFieldByteSavings(anchor, compactAnchor)).toBe(0);
});

it("rejects malformed v2 deltas, missing anchors, and delta on first disclosed page row", () => {
  const wire = encodeSourceDisclosure(original);
  expect(() => decodePageSourceDisclosure({ v: 2 }, undefined))
    .toThrow("source disclosure delta requires a preceding full disclosure on the page");
  expect(SourceDisclosureDeltaSchema.safeParse({ v: 1 }).success).toBe(false);
  expect(SourceDisclosureDeltaSchema.safeParse({ v: 3 }).success).toBe(false);
  expect(SourceDisclosureDeltaSchema.safeParse({ v: 2, "9": "extra" }).success).toBe(false);
  expect(SourceDisclosureDeltaSchema.safeParse({ v: 2, extra: true }).success).toBe(false);

  const memoryRow = {
    object_id: "mem-1",
    object_kind: "memory_entry",
    target: { kind: "memory_entry" as const, workspace_id: "ws", object_id: "mem-1", source_revision: "rev-1" },
    relevance_score: 0.9,
    content_preview: "memory text",
    evidence_pointers: [],
    selection_reason: "Associated.",
    source_channels: ["conditional_field"],
    score_factors: { activation: 0.9, relevance: 0.9 },
    budget_state: { token_estimate: 20, max_entries: 10, max_total_tokens: 2000, remaining_entries: 9,
      remaining_tokens: 1980, within_budget: true }
  };
  const sourceRowBase = {
    object_kind: "source_evidence",
    target: {
      kind: "source_evidence" as const, workspace_id: "ws", root_kind: "source_record" as const,
      root_id: "rec-1", source_version: "v1", content_digest: `sha256:${"a".repeat(64)}`, evidence_object_id: null
    },
    relevance_score: 0.8,
    content_preview: "source text",
    payload_available: true,
    evidence_pointers: [],
    selection_reason: "Associated.",
    source_channels: ["conditional_field"],
    score_factors: { activation: 0.8, relevance: 0.8 },
    budget_state: { token_estimate: 50, max_entries: 10, max_total_tokens: 2000, remaining_entries: 8,
      remaining_tokens: 1930, within_budget: true }
  };

  // First disclosed row cannot be a delta, even after memory rows.
  expect(SoulMemorySearchResponseWireSchema.safeParse({
    delivery_id: "d1", total_count: 2,
    results: [memoryRow, { ...sourceRowBase, source_disclosure: { v: 2 } }]
  }).success).toBe(false);

  // Proof-use mismatch caught after decoding delta.
  expect(SoulMemorySearchResponseSchema.safeParse({
    delivery_id: "d2", total_count: 2,
    results: [
      { ...sourceRowBase, source_disclosure: wire },
      { ...sourceRowBase,
        target: { ...sourceRowBase.target, root_id: "rec-2" },
        source_disclosure: { v: 2, "8": { kind: "conditional_support", qualification: "not_world_claim" } } }
    ]
  }).success).toBe(false);

  // Valid multi-row page with memory_entry + anchor + delta decodes back to full v1 9-tuples.
  const secondWire = encodeSourceDisclosure({ ...original, material_kind: "retained_excerpt" });
  const parsed = SoulMemorySearchResponseSchema.parse({
    delivery_id: "d3", total_count: 3,
    results: [
      memoryRow,
      { ...sourceRowBase, source_disclosure: wire },
      { ...sourceRowBase,
        target: { ...sourceRowBase.target, root_id: "rec-2" },
        source_disclosure: encodePageSourceDisclosure(secondWire, wire) }
    ]
  });
  expect(parsed.results[1]!.source_disclosure).toEqual(wire);
  expect(parsed.results[2]!.source_disclosure).toEqual(secondWire);
  expect(Array.isArray(parsed.results[2]!.source_disclosure)).toBe(true);
});
