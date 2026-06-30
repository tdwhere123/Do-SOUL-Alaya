import { describe, expect, it } from "vitest";
import {
  DecayProfile,
  FactualPolicyConditionSchema,
  ForgetDisposition,
  FORMATION_CONFIDENCE_MAP,
  FormationKind,
  ManifestationState,
  MemoryDimension,
  MemoryEntrySchema,
  ObjectKind,
  RetentionState,
  SourceKind,
  StorageTier
} from "../../index.js";
import { CANONICAL_ENTITIES_MAX } from "../../shared/schema-primitives.js";

function without<T extends Record<string, unknown>, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const clone = { ...value };
  delete clone[key];
  return clone;
}

const validTimestamp = "2026-03-20T00:00:00.000Z";
const canonicalEntitiesAtLimit = Array.from(
  { length: CANONICAL_ENTITIES_MAX },
  (_, index) => `entity-${index + 1}`
);
const canonicalEntitiesOverLimit = [...canonicalEntitiesAtLimit, "entity-over-limit"];

const memoryEntryBase = {
  object_id: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
  object_kind: ObjectKind.MEMORY_ENTRY,
  schema_version: 1,
  created_at: validTimestamp,
  updated_at: validTimestamp,
  created_by: "user",
  lifecycle_state: "active",
  dimension: MemoryDimension.PREFERENCE,
  source_kind: SourceKind.USER,
  formation_kind: FormationKind.EXPLICIT,
  scope_class: "project",
  content: "Use pnpm for all workspace commands.",
  domain_tags: ["tooling", "workflow"],
  evidence_refs: ["evidence-1", "evidence-2"],
  workspace_id: "workspace-1",
  run_id: "run-1",
  surface_id: "surface://task/main",
  storage_tier: StorageTier.HOT,
  activation_score: 0.7,
  retention_score: 0.9,
  manifestation_state: ManifestationState.FULL_ELIGIBLE,
  retention_state: RetentionState.CANON,
  decay_profile: "stable",
  confidence: 0.95,
  last_used_at: validTimestamp,
  last_hit_at: validTimestamp,
  reinforcement_count: 4,
  contradiction_count: 0,
  superseded_by: null
} as const;

describe("MemoryEntrySchema", () => {
  it("parses a full memory entry round-trip", () => {
    expect(MemoryEntrySchema.parse(memoryEntryBase)).toEqual(memoryEntryBase);
  });

  it("accepts all dynamics fields as null", () => {
    const value = {
      ...memoryEntryBase,
      activation_score: null,
      retention_score: null,
      manifestation_state: null,
      retention_state: null,
      decay_profile: null,
      confidence: null,
      last_used_at: null,
      last_hit_at: null,
      reinforcement_count: null,
      contradiction_count: null,
      superseded_by: null
    } as const;

    expect(MemoryEntrySchema.parse(value)).toEqual(value);
  });

  it("round-trips optional event-time and valid-time projection fields", () => {
    const value = {
      ...memoryEntryBase,
      projection_schema_version: 1,
      event_time_start: "2026-03-19T00:00:00.000Z",
      event_time_end: "2026-03-19T23:59:59.999Z",
      valid_from: "2026-03-19T00:00:00.000Z",
      valid_to: null,
      time_precision: "day",
      time_source: "relative_resolved"
    } as const;

    const parsed = MemoryEntrySchema.parse(value);

    expect(parsed.projection_schema_version).toBe(1);
    expect(parsed.event_time_start).toBe("2026-03-19T00:00:00.000Z");
    expect(parsed.event_time_end).toBe("2026-03-19T23:59:59.999Z");
    expect(parsed.valid_from).toBe("2026-03-19T00:00:00.000Z");
    expect(parsed.valid_to).toBeNull();
    expect(parsed.time_precision).toBe("day");
    expect(parsed.time_source).toBe("relative_resolved");
  });

  it("rejects invalid event-time precision and source values", () => {
    expect(
      MemoryEntrySchema.safeParse({
        ...memoryEntryBase,
        time_precision: "hour",
        time_source: "relative_resolved"
      }).success
    ).toBe(false);
    expect(
      MemoryEntrySchema.safeParse({
        ...memoryEntryBase,
        time_precision: "day",
        time_source: "regex_guess"
      }).success
    ).toBe(false);
  });

  it("round-trips optional preference profile projection fields", () => {
    const value = {
      ...memoryEntryBase,
      projection_schema_version: 1,
      preference_subject: "operator",
      preference_predicate: "prefer",
      preference_object: "dark mode in the editor",
      preference_category: "editor-theme",
      preference_polarity: "positive"
    } as const;

    const parsed = MemoryEntrySchema.parse(value);

    expect(parsed.projection_schema_version).toBe(1);
    expect(parsed.preference_subject).toBe("operator");
    expect(parsed.preference_predicate).toBe("prefer");
    expect(parsed.preference_object).toBe("dark mode in the editor");
    expect(parsed.preference_category).toBe("editor-theme");
    expect(parsed.preference_polarity).toBe("positive");
  });

  it("round-trips with and without canonical_entities", () => {
    const withEntities = {
      ...memoryEntryBase,
      canonical_entities: ["alice", "postgres"]
    } as const;
    const parsed = MemoryEntrySchema.parse(withEntities);
    expect(parsed.canonical_entities).toEqual(["alice", "postgres"]);

    const withoutEntities = MemoryEntrySchema.parse(memoryEntryBase);
    expect(withoutEntities.canonical_entities).toBeUndefined();

    const nullEntities = MemoryEntrySchema.parse({ ...memoryEntryBase, canonical_entities: null });
    expect(nullEntities.canonical_entities).toBeNull();
  });

  it("accepts canonical_entities at the configured limit", () => {
    const value = {
      ...memoryEntryBase,
      canonical_entities: canonicalEntitiesAtLimit
    };

    expect(MemoryEntrySchema.parse(value).canonical_entities).toEqual(canonicalEntitiesAtLimit);
  });

  it("rejects canonical_entities above the configured limit", () => {
    expect(
      MemoryEntrySchema.safeParse({
        ...memoryEntryBase,
        canonical_entities: canonicalEntitiesOverLimit
      }).success
    ).toBe(false);
  });

  it("rejects invalid preference polarity values", () => {
    expect(
      MemoryEntrySchema.safeParse({
        ...memoryEntryBase,
        preference_polarity: "love"
      }).success
    ).toBe(false);
  });

  it("rejects unsupported projection schema versions", () => {
    expect(
      MemoryEntrySchema.safeParse({
        ...memoryEntryBase,
        projection_schema_version: 2
      }).success
    ).toBe(false);
  });

  it("treats an omitted forget_disposition as no disposition (undefined, not present)", () => {
    const parsed = MemoryEntrySchema.parse(memoryEntryBase);
    expect(parsed.forget_disposition).toBeUndefined();
    expect(parsed.forget_disposition_ref).toBeUndefined();
  });

  it("round-trips a compressed forget_disposition with a capsule ref", () => {
    const value = {
      ...memoryEntryBase,
      forget_disposition: ForgetDisposition.COMPRESSED,
      forget_disposition_ref: "capsule-1"
    } as const;
    const parsed = MemoryEntrySchema.parse(value);
    expect(parsed.forget_disposition).toBe(ForgetDisposition.COMPRESSED);
    expect(parsed.forget_disposition_ref).toBe("capsule-1");
  });

  it("round-trips a judged_useless forget_disposition with a null ref", () => {
    const value = {
      ...memoryEntryBase,
      forget_disposition: ForgetDisposition.JUDGED_USELESS,
      forget_disposition_ref: null
    } as const;
    const parsed = MemoryEntrySchema.parse(value);
    expect(parsed.forget_disposition).toBe(ForgetDisposition.JUDGED_USELESS);
    expect(parsed.forget_disposition_ref).toBeNull();
  });

  it("rejects an unknown forget_disposition value", () => {
    expect(() =>
      MemoryEntrySchema.parse({ ...memoryEntryBase, forget_disposition: "purged" })
    ).toThrow();
  });

  it("accepts partially populated dynamics fields", () => {
    const value = {
      ...memoryEntryBase,
      activation_score: 0.32,
      retention_score: null,
      manifestation_state: null,
      retention_state: RetentionState.WORKING,
      decay_profile: null,
      confidence: null,
      last_used_at: validTimestamp,
      last_hit_at: null,
      reinforcement_count: null,
      contradiction_count: 2
    };
    const parsed = MemoryEntrySchema.parse(value);

    expect(parsed.activation_score).toBe(0.32);
    expect(parsed.retention_score).toBeNull();
    expect(parsed.manifestation_state).toBeNull();
    expect(parsed.retention_state).toBe(RetentionState.WORKING);
    expect(parsed.decay_profile).toBeNull();
    expect(parsed.confidence).toBeNull();
    expect(parsed.last_used_at).toBe(validTimestamp);
    expect(parsed.last_hit_at).toBeNull();
    expect(parsed.reinforcement_count).toBeNull();
    expect(parsed.contradiction_count).toBe(2);
  });

  it("rejects missing dynamics fields because they must be explicit nullable keys", () => {
    const requiredDynamicsFields = [
      "activation_score",
      "retention_score",
      "manifestation_state",
      "retention_state",
      "decay_profile",
      "confidence",
      "last_used_at",
      "last_hit_at",
      "reinforcement_count",
      "contradiction_count",
      "superseded_by"
    ] as const;

    for (const field of requiredDynamicsFields) {
      expect(MemoryEntrySchema.safeParse(without(memoryEntryBase, field)).success).toBe(false);
    }
  });

  it("rejects non-memory_entry object_kind", () => {
    expect(() =>
      MemoryEntrySchema.parse({
        ...memoryEntryBase,
        object_kind: ObjectKind.CLAIM_FORM
      })
    ).toThrow();
  });

  it("requires all persistent envelope fields", () => {
    const requiredFields = [
      "object_id",
      "object_kind",
      "schema_version",
      "created_at",
      "updated_at",
      "created_by",
      "lifecycle_state"
    ] as const;

    for (const field of requiredFields) {
      expect(() => MemoryEntrySchema.parse(without(memoryEntryBase, field))).toThrow();
    }
  });

  it("rejects empty content", () => {
    expect(
      MemoryEntrySchema.safeParse({
        ...memoryEntryBase,
        content: ""
      }).success
    ).toBe(false);
  });

  it("enforces [0,1] range for activation_score, retention_score, and confidence", () => {
    expect(
      MemoryEntrySchema.safeParse({
        ...memoryEntryBase,
        activation_score: 1.1
      }).success
    ).toBe(false);

    expect(
      MemoryEntrySchema.safeParse({
        ...memoryEntryBase,
        retention_score: -0.1
      }).success
    ).toBe(false);

    expect(
      MemoryEntrySchema.safeParse({
        ...memoryEntryBase,
        confidence: 2
      }).success
    ).toBe(false);
  });

  it("supports fact dimension entries and factual policy boundary conditions", () => {
    const factMemory = MemoryEntrySchema.parse({
      ...memoryEntryBase,
      dimension: MemoryDimension.FACT
    });

    expect(factMemory.dimension).toBe(MemoryDimension.FACT);

    const eligibleCondition = FactualPolicyConditionSchema.parse({
      affects_execution_paths: false,
      affects_tool_choices: true,
      affects_write_permissions: false,
      affects_governance_decisions: false
    });
    expect(Object.values(eligibleCondition).some(Boolean)).toBe(true);

    const ineligibleCondition = FactualPolicyConditionSchema.parse({
      affects_execution_paths: false,
      affects_tool_choices: false,
      affects_write_permissions: false,
      affects_governance_decisions: false
    });
    expect(Object.values(ineligibleCondition).some(Boolean)).toBe(false);
  });
});

describe("MemoryEntry enums", () => {
  it("exports the full MemoryDimension set", () => {
    expect(Object.values(MemoryDimension)).toEqual([
      "preference",
      "constraint",
      "decision",
      "procedure",
      "fact",
      "hazard",
      "glossary",
      "episode"
    ]);
  });

  it("exports the full SourceKind set", () => {
    expect(Object.values(SourceKind)).toEqual(["compiler", "user", "seed", "import", "review"]);
  });

  it("exports the full FormationKind set", () => {
    expect(Object.values(FormationKind)).toEqual(["extracted", "explicit", "inferred", "derived", "imported"]);
  });

  it("exports the full DecayProfile set", () => {
    expect(Object.values(DecayProfile)).toEqual(["pinned", "stable", "normal", "volatile", "hazard"]);
  });

  it("exports the full ManifestationState set", () => {
    expect(Object.values(ManifestationState)).toEqual(["hidden", "hint", "excerpt", "full_eligible"]);
  });

  it("exports the full RetentionState set", () => {
    expect(Object.values(RetentionState)).toEqual(["working", "consolidated", "canon", "archived", "tombstoned"]);
  });

  it("exports the full StorageTier set", () => {
    expect(Object.values(StorageTier)).toEqual(["hot", "warm", "cold"]);
  });
});

describe("FORMATION_CONFIDENCE_MAP", () => {
  it("defines the expected initial confidence per formation kind", () => {
    expect(FORMATION_CONFIDENCE_MAP).toEqual({
      extracted: 0.6,
      explicit: 0.9,
      inferred: 0.4,
      derived: 0.5,
      imported: 0.7
    });
  });
});
