import { describe, expect, it } from "vitest";
import { type MemoryEntry } from "@do-soul/alaya-protocol";
import { filterMemoriesByTimeWindow } from "../recall-service-helpers.js";

function entry(overrides: Partial<MemoryEntry> & Pick<MemoryEntry, "object_id">): MemoryEntry {
  return {
    object_kind: "memory_entry",
    schema_version: 1,
    workspace_id: "ws-1",
    scope_id: "scope-1",
    scope_class: "global",
    domain_tags: [],
    dimension: "fact",
    content: null,
    storage_tier: "hot",
    lifecycle_state: "active",
    activation_score: 0.5,
    last_used_at: null,
    last_hit_at: null,
    evidence_refs: [],
    created_by: "system",
    created_at: "2026-05-15T00:00:00.000Z",
    updated_at: "2026-05-15T00:00:00.000Z",
    ...overrides
  } as MemoryEntry;
}

describe("filterMemoriesByTimeWindow", () => {
  const may10 = entry({ object_id: "may-10", created_at: "2026-05-10T12:00:00.000Z" });
  const may20 = entry({ object_id: "may-20", created_at: "2026-05-20T12:00:00.000Z" });
  const may25 = entry({
    object_id: "may-25",
    created_at: "2026-05-25T12:00:00.000Z",
    last_used_at: "2026-05-26T12:00:00.000Z"
  });
  const all = [may10, may20, may25];

  it("returns input unchanged when filter is undefined", () => {
    expect(filterMemoriesByTimeWindow(all, undefined)).toBe(all);
  });

  it("returns input unchanged when both bounds are null", () => {
    const result = filterMemoriesByTimeWindow(all, { since: null, until: null });
    expect(result).toBe(all);
  });

  it("applies an only-since lower bound on created_at", () => {
    const result = filterMemoriesByTimeWindow(all, { since: "2026-05-20T00:00:00.000Z" });
    expect(result.map((entry) => entry.object_id)).toEqual(["may-20", "may-25"]);
  });

  it("applies an only-until upper bound on created_at", () => {
    const result = filterMemoriesByTimeWindow(all, { until: "2026-05-20T23:59:59.000Z" });
    expect(result.map((entry) => entry.object_id)).toEqual(["may-10", "may-20"]);
  });

  it("applies both bounds (single-day window)", () => {
    const result = filterMemoriesByTimeWindow(all, {
      since: "2026-05-20T00:00:00.000Z",
      until: "2026-05-20T23:59:59.000Z"
    });
    expect(result.map((entry) => entry.object_id)).toEqual(["may-20"]);
  });

  it("can target last_used_at instead of created_at", () => {
    const result = filterMemoriesByTimeWindow(all, {
      since: "2026-05-26T00:00:00.000Z",
      field: "last_used_at"
    });
    expect(result.map((entry) => entry.object_id)).toEqual(["may-25"]);
  });

  it("drops entries whose selected timestamp is null when bounds are present", () => {
    const result = filterMemoriesByTimeWindow(all, {
      since: "2026-05-01T00:00:00.000Z",
      field: "last_used_at"
    });
    expect(result.map((entry) => entry.object_id)).toEqual(["may-25"]);
  });

  it("returns an empty array when no entry falls within the window", () => {
    const result = filterMemoriesByTimeWindow(all, {
      since: "2027-01-01T00:00:00.000Z"
    });
    expect(result).toEqual([]);
  });
});
