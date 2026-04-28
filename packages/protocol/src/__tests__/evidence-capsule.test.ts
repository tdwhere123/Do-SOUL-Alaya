import { describe, expect, it } from "vitest";
import { EvidenceCapsuleSchema, EvidenceHealthStateSchema, EvidenceKind, EvidenceKindSchema } from "../index.js";

const validTimestamp = "2026-03-20T00:00:00.000Z";

function makeBaseEvidence() {
  return {
    object_id: "5c6b478a-3839-4a9b-833f-af22192c33c7",
    object_kind: "evidence_capsule",
    schema_version: 1,
    created_at: validTimestamp,
    updated_at: validTimestamp,
    created_by: "user",
    lifecycle_state: "active",
    evidence_kind: "tool_output",
    semantic_anchor: {
      topic: "test execution",
      keywords: ["vitest", "protocol"],
      summary: "Captured test results for protocol schemas."
    },
    event_anchor: null,
    physical_anchor: null,
    evidence_health_state: "verified",
    gist: "Protocol tests passed with expected output.",
    excerpt: "PASS - 2 test files",
    source_hash: "sha256:abc123",
    run_id: "run-1",
    workspace_id: "workspace-1",
    surface_id: null
  } as const;
}

function without<T extends Record<string, unknown>, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const clone = { ...value };
  delete clone[key];
  return clone;
}

describe("EvidenceCapsuleSchema", () => {
  it("parses a full evidence capsule round-trip", () => {
    const value = {
      ...makeBaseEvidence(),
      event_anchor: {
        event_type: "run.message.appended",
        event_id: "event-1",
        occurred_at: validTimestamp
      },
      physical_anchor: {
        file_path: "packages/protocol/src/index.ts",
        line_range: { start: 1, end: 10 },
        symbol_name: "index",
        artifact_ref: "artifact://test-output"
      }
    } as const;

    expect(EvidenceCapsuleSchema.parse(value)).toEqual(value);
  });

  it("accepts semantic anchor only", () => {
    const value = makeBaseEvidence();
    expect(EvidenceCapsuleSchema.parse(value)).toEqual(value);
  });

  it("accepts semantic + event anchors", () => {
    const value = {
      ...makeBaseEvidence(),
      event_anchor: {
        event_type: "engine.response.received",
        event_id: "event-2",
        occurred_at: validTimestamp
      }
    } as const;

    expect(EvidenceCapsuleSchema.parse(value)).toEqual(value);
  });

  it("accepts semantic + physical anchors", () => {
    const value = {
      ...makeBaseEvidence(),
      physical_anchor: {
        file_path: "packages/protocol/src/soul/evidence-capsule.ts",
        line_range: { start: 1, end: 80 },
        symbol_name: "EvidenceCapsuleSchema",
        artifact_ref: null
      }
    } as const;

    expect(EvidenceCapsuleSchema.parse(value)).toEqual(value);
  });

  it("accepts semantic + event + physical anchors", () => {
    const value = {
      ...makeBaseEvidence(),
      event_anchor: {
        event_type: "soul.signal.emitted",
        event_id: null,
        occurred_at: validTimestamp
      },
      physical_anchor: {
        file_path: null,
        line_range: null,
        symbol_name: null,
        artifact_ref: "artifact://signal"
      }
    } as const;

    expect(EvidenceCapsuleSchema.parse(value)).toEqual(value);
  });

  it("rejects missing semantic_anchor", () => {
    const value = without(makeBaseEvidence(), "semantic_anchor");
    expect(EvidenceCapsuleSchema.safeParse(value).success).toBe(false);
  });

  it("accepts only supported evidence_health_state values", () => {
    const states = ["verified", "degraded", "broken"] as const;
    for (const state of states) {
      expect(EvidenceHealthStateSchema.parse(state)).toBe(state);
    }

    expect(EvidenceHealthStateSchema.safeParse("invalid").success).toBe(false);
  });

  it("keeps EvidenceKind enum closed and complete", () => {
    expect(EvidenceKindSchema.options).toEqual([
      "user_statement",
      "code_observation",
      "tool_output",
      "conversation_excerpt",
      "file_content",
      "external_reference",
      "inferred"
    ]);

    expect(Object.values(EvidenceKind)).toEqual([
      "user_statement",
      "code_observation",
      "tool_output",
      "conversation_excerpt",
      "file_content",
      "external_reference",
      "inferred"
    ]);
  });

  it("rejects object_kind values other than evidence_capsule", () => {
    const value = {
      ...makeBaseEvidence(),
      object_kind: "memory_entry"
    };

    expect(EvidenceCapsuleSchema.safeParse(value).success).toBe(false);
  });

  it("requires all envelope fields", () => {
    const base = makeBaseEvidence();
    expect(EvidenceCapsuleSchema.safeParse(without(base, "object_id")).success).toBe(false);
    expect(EvidenceCapsuleSchema.safeParse(without(base, "schema_version")).success).toBe(false);
    expect(EvidenceCapsuleSchema.safeParse(without(base, "lifecycle_state")).success).toBe(false);
  });

  it("rejects empty excerpt and empty source_hash", () => {
    expect(
      EvidenceCapsuleSchema.safeParse({
        ...makeBaseEvidence(),
        excerpt: ""
      }).success
    ).toBe(false);

    expect(
      EvidenceCapsuleSchema.safeParse({
        ...makeBaseEvidence(),
        source_hash: ""
      }).success
    ).toBe(false);
  });

  it("rejects line ranges where start is greater than end", () => {
    expect(
      EvidenceCapsuleSchema.safeParse({
        ...makeBaseEvidence(),
        physical_anchor: {
          file_path: "packages/protocol/src/soul/evidence-capsule.ts",
          line_range: { start: 100, end: 5 },
          symbol_name: "EvidenceCapsuleSchema",
          artifact_ref: null
        }
      }).success
    ).toBe(false);
  });
});
