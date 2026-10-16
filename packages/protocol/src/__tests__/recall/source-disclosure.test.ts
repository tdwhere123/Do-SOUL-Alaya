import { expect, it } from "vitest";
import { SOURCE_DISCLOSURE_CODEC_VERSION, SourceDisclosureSchema, SourceDisclosureSemanticSchema,
  decodeHistoricalSourceDisclosure, encodeSourceDisclosure, qualifySourceDisclosure, sourceDisclosure,
  type SourceDisclosureSemantic } from "../../recall/source-disclosure.js";

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
