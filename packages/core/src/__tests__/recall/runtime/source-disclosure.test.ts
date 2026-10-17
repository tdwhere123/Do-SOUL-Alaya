import { describe, expect, it } from "vitest";
import { sourceDisclosure } from "@do-soul/alaya-protocol";
import { projectSourceDisclosure as projectWire } from "../../../recall/runtime/source-disclosure.js";
const projectSourceDisclosure = (input: Parameters<typeof projectWire>[0]) => sourceDisclosure(projectWire(input));
import { projectEvidenceRead } from "../../../memory/evidence-read-projection.js";

const source = { valid_from: "2026-09-25T10:00:00.0000001Z",
  valid_to: "2026-09-25T10:00:00.0000003Z" };

describe("source disclosure", () => {
  it("derives source material from checked representation while preserving exact projection lineage", () => {
    const evaluated_as_of = "2026-09-25T10:00:00Z";
    const source_record_ids = [`sha256:${"a".repeat(64)}`, `sha256:${"b".repeat(64)}`];
    expect(projectSourceDisclosure({ material_kind: "original_body", evaluated_as_of, source }))
      .toMatchObject({ material_kind: "unknown" });
    for (const kind of ["original_body", "retained_excerpt"] as const) {
      expect(projectSourceDisclosure({ material_kind: "original_body", evaluated_as_of,
        source: { ...source, source_representation: { kind } } })).toMatchObject({ material_kind: kind, source_representation: { kind } });
    }
    expect(projectSourceDisclosure({ material_kind: "original_body", evaluated_as_of,
      source: { ...source, source_representation: { kind: "canonical_projection", source_record_ids } } }))
      .toMatchObject({ material_kind: "canonical_projection", source_binding: "checked_record",
        source_representation: { kind: "canonical_projection", source_record_ids } });
  });

  it.each([
    ["2026-09-25T10:00:00Z", "before_start"],
    ["2026-09-25T10:00:00.0000001Z", "within_interval"],
    ["2026-09-25T10:00:00.0000002Z", "within_interval"],
    ["2026-09-25T10:00:00.0000003Z", "at_or_after_end"],
    ["2026-09-25T10:00:00.0000004Z", "at_or_after_end"]
  ] as const)("preserves the half-open interval at %s", (evaluated_as_of, expected) => {
    const disclosure = projectSourceDisclosure({ material_kind: "original_body", evaluated_as_of, source });
    expect(disclosure.temporal_state).toBe(expected);
    expect(disclosure.validity).toEqual({ kind: "bounded", from: source.valid_from, to_exclusive: source.valid_to });
    expect(disclosure.proof_use).toEqual({ kind: "source_only", qualification: "not_current_proof" });
  });

  it("keeps a future open start distinct from an expired end and unknown bounds", () => {
    const at = "2026-09-25T10:00:00Z";
    expect(projectSourceDisclosure({ material_kind: "original_body", evaluated_as_of: at,
      source: { valid_from: source.valid_from, valid_to: null } })).toMatchObject({
      validity: { kind: "open", from: source.valid_from }, temporal_state: "before_start"
    });
    expect(projectSourceDisclosure({ material_kind: "original_body", evaluated_as_of: at,
      source: { valid_from: null, valid_to: null } })).toMatchObject({
      validity: { kind: "unknown", reason: "not_recorded" }, temporal_state: "unknown"
    });
    expect(projectSourceDisclosure({ material_kind: "original_body", evaluated_as_of: at,
      source: {} })).toMatchObject({ validity: { kind: "unknown", reason: "metadata_unavailable" } });
  });

  it("preserves checked source observation time independently of validity and read time", () => {
    const evaluated_as_of = "2026-09-25T10:00:00Z";
    const known = projectSourceDisclosure({ material_kind: "original_body", evaluated_as_of,
      source: { ...source, event_time: "2024-01-02T03:04:05.0000007Z" } });
    expect(known.source_time).toEqual({ kind: "known", at: "2024-01-02T03:04:05.0000007Z" });
    expect(known.validity).toEqual({ kind: "bounded", from: source.valid_from, to_exclusive: source.valid_to });
    expect(projectSourceDisclosure({ material_kind: "original_body", evaluated_as_of,
      source: { ...source, event_time: null } }).source_time).toEqual({ kind: "unknown", reason: "not_recorded" });
    expect(projectSourceDisclosure({ material_kind: "original_body", evaluated_as_of,
      source }).source_time).toEqual({ kind: "unknown", reason: "metadata_unavailable" });
    expect(projectSourceDisclosure({ material_kind: "original_body", evaluated_as_of }).source_time)
      .toEqual({ kind: "unknown", reason: "unbound" });
  });

  it("labels independently retained evidence text without claiming original validity", () => {
    const projected = projectEvidenceRead({ gist: "interpretation", excerpt: "joined mention" }, "2026-09-25T10:00:00Z");
    expect(projected.gist).toBe("interpretation");
    expect(projected.excerpt).toBe("joined mention");
    expect(sourceDisclosure(projected.text_disclosures.gist)).toMatchObject({ material_kind: "retained_gist",
      validity: { kind: "unknown", reason: "unbound" }, source_time: { kind: "unknown", reason: "unbound" },
      proof_use: { kind: "source_only", qualification: "not_current_proof" } });
    expect(sourceDisclosure(projected.text_disclosures.excerpt!)).toMatchObject({ material_kind: "retained_excerpt" });
    expect(projected.text_disclosures.content).toEqual(projected.text_disclosures.excerpt);
  });
});
