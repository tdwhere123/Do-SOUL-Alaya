import { describe, expect, it } from "vitest";
import {
  GlobalMemoryEntrySchema,
  MemoryDimension,
  ScopeClass,
  type GlobalMemoryEntry
} from "../../index.js";

function without<T extends Record<string, unknown>, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const clone = { ...value };
  delete clone[key];
  return clone;
}

const validTimestamp = "2026-04-23T00:00:00.000Z";

function createGlobalMemoryEntry(overrides: Partial<GlobalMemoryEntry> = {}): GlobalMemoryEntry {
  return {
    global_object_id: "global-memory-1",
    object_kind: "global_memory_entry",
    canonical_identity: "docs::workflow::pnpm-build-before-commit",
    dimension: MemoryDimension.PROCEDURE,
    scope_class: ScopeClass.GLOBAL_CORE,
    content: "Run pnpm build before commit.",
    domain_tags: ["workflow", "build"],
    provenance: "seed://lane-c22/test-fixture",
    activation_score: 0.83,
    version: 2,
    created_at: validTimestamp,
    updated_at: validTimestamp,
    ...overrides
  };
}

describe("GlobalMemoryEntrySchema", () => {
  it("parses a recall-ready global memory entry round-trip", () => {
    const entry = createGlobalMemoryEntry();

    expect(GlobalMemoryEntrySchema.parse(entry)).toEqual(entry);
  });

  it("accepts null activation_score for unrated source entries", () => {
    const entry = createGlobalMemoryEntry({ activation_score: null });

    expect(GlobalMemoryEntrySchema.parse(entry).activation_score).toBeNull();
  });

  it("rejects workspace-local fields because the source plane is workspace-agnostic", () => {
    expect(
      GlobalMemoryEntrySchema.safeParse({
        ...createGlobalMemoryEntry(),
        workspace_id: "workspace-1"
      }).success
    ).toBe(false);
  });

  it("requires the recall-mapping fields added for C-22", () => {
    const requiredFields = ["dimension", "scope_class", "domain_tags", "activation_score"] as const;

    for (const field of requiredFields) {
      expect(GlobalMemoryEntrySchema.safeParse(without(createGlobalMemoryEntry(), field)).success).toBe(false);
    }
  });

  it("enforces the activation_score range", () => {
    expect(
      GlobalMemoryEntrySchema.safeParse({
        ...createGlobalMemoryEntry(),
        activation_score: 1.1
      }).success
    ).toBe(false);
  });
});
