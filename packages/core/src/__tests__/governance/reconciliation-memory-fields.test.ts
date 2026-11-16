import { describe, expect, it } from "vitest";
import {
  buildProjectionMergeFields,
  buildUpdateFields,
  updateFieldsMatch
} from "../../governance/reconciliation/reconciliation-memory-fields.js";
import { createMemoryEntry } from "./reconciliation-service.test-support.js";

describe("reconciliation memory field derivation", () => {
  it("omits evidence_refs when the incoming ref is missing or blank", () => {
    const existing = createMemoryEntry({ evidence_refs: ["evidence-old"] });
    for (const incomingRef of [undefined, "", "   "]) {
      const fields = buildUpdateFields(existing, "next", ["tag"], incomingRef, undefined);
      expect(fields).toEqual({ content: "next", domain_tags: ["tag"] });
      expect("evidence_refs" in fields).toBe(false);
    }
  });

  it("keeps the existing evidence_refs array identity when the incoming ref is already present", () => {
    const existing = createMemoryEntry({ evidence_refs: ["evidence-old", "evidence-shared"] });
    const fields = buildUpdateFields(existing, "next", ["tag"], "evidence-shared", undefined);
    expect(fields.evidence_refs).toBe(existing.evidence_refs);
  });

  it("appends a new evidence ref after existing refs without trimming the stored value", () => {
    const existing = createMemoryEntry({ evidence_refs: ["evidence-old"] });
    const fields = buildUpdateFields(existing, "next", ["tag"], " evidence-new", undefined);
    expect(fields.evidence_refs).toEqual(["evidence-old", " evidence-new"]);
    expect(fields.evidence_refs).not.toBe(existing.evidence_refs);
  });

  it("replaces independent projection keys individually and omits undefined", () => {
    const existing = createMemoryEntry({
      event_time_start: "2019-01-01T00:00:00.000Z",
      time_precision: "year"
    });
    const fields = buildUpdateFields(existing, "next", ["tag"], undefined, {
      event_time_start: null,
      time_source: "explicit"
    });
    expect(fields).toEqual({
      content: "next",
      domain_tags: ["tag"],
      event_time_start: null,
      time_source: "explicit"
    });
    expect("time_precision" in fields).toBe(false);
  });

  it("replaces every preference key when any incoming preference is present", () => {
    const existing = createMemoryEntry({
      preference_subject: "operator",
      preference_predicate: "avoid",
      preference_object: "dark mode",
      preference_category: "theme",
      preference_polarity: "negative"
    });
    const fields = buildUpdateFields(existing, "next", ["preference"], undefined, {
      preference_subject: "operator",
      preference_object: "dark mode"
    });
    expect(fields).toMatchObject({
      preference_subject: "operator",
      preference_predicate: null,
      preference_object: "dark mode",
      preference_category: null,
      preference_polarity: null
    });
  });

  it("does not write preference keys when incoming preference values are all null or omitted", () => {
    const fields = buildUpdateFields(createMemoryEntry(), "next", ["tag"], undefined, {
      preference_subject: null,
      event_time_start: "2024-01-01T00:00:00.000Z"
    });
    expect(fields).toEqual({
      content: "next",
      domain_tags: ["tag"],
      event_time_start: "2024-01-01T00:00:00.000Z"
    });
  });

  it("never copies facet_tags into merge or replacement payloads", () => {
    const existing = createMemoryEntry({ facet_tags: [{ facet: "person", value: "alice" }] });
    const merge = buildProjectionMergeFields(existing, {
      projection_schema_version: 1,
      canonical_entities: ["alice"]
    });
    const update = buildUpdateFields(existing, "next", ["tag"], "evidence-1", {
      projection_schema_version: 1
    });
    expect(merge).not.toHaveProperty("facet_tags");
    expect(update).not.toHaveProperty("facet_tags");
  });

  it("fills missing independent projection keys on merge without overwriting present values", () => {
    const existing = createMemoryEntry({
      event_time_start: "2019-01-01T00:00:00.000Z",
      time_precision: null
    });
    expect(
      buildProjectionMergeFields(existing, {
        event_time_start: "2024-01-01T00:00:00.000Z",
        time_precision: "year",
        time_source: "explicit"
      })
    ).toEqual({
      time_precision: "year",
      time_source: "explicit"
    });
  });

  it("merges only present non-null preference keys when the survivor has none", () => {
    expect(
      buildProjectionMergeFields(createMemoryEntry(), {
        preference_subject: "operator",
        preference_object: "dark mode",
        preference_predicate: null
      })
    ).toEqual({
      preference_subject: "operator",
      preference_object: "dark mode"
    });
  });

  it("does not assemble a preference profile from survivor and incoming fragments", () => {
    const existing = createMemoryEntry({
      preference_subject: "operator",
      preference_predicate: "prefer"
    });
    expect(
      buildProjectionMergeFields(existing, {
        preference_object: "dark mode",
        preference_category: "theme",
        preference_polarity: "positive"
      })
    ).toEqual({});
  });
});

describe("reconciliation memory field recovery equality", () => {
  it("treats expected null projection values as matching omitted row fields", () => {
    const row = createMemoryEntry({ content: "next", domain_tags: ["tag"] });
    expect(
      updateFieldsMatch(row, {
        content: "next",
        domain_tags: ["tag"],
        projection_schema_version: null,
        event_time_start: null,
        canonical_entities: null
      })
    ).toBe(true);
  });

  it("is duplicate-sensitive and order-insensitive for tags, evidence, and canonical entities", () => {
    const row = createMemoryEntry({
      content: "next",
      domain_tags: ["b", "a", "a"],
      evidence_refs: ["e2", "e1"],
      canonical_entities: ["alice", "alice"]
    });
    expect(
      updateFieldsMatch(row, {
        content: "next",
        domain_tags: ["a", "a", "b"],
        evidence_refs: ["e1", "e2"],
        canonical_entities: ["alice", "alice"]
      })
    ).toBe(true);
    expect(
      updateFieldsMatch(row, {
        content: "next",
        domain_tags: ["a", "b"],
        evidence_refs: ["e1", "e2"],
        canonical_entities: ["alice", "alice"]
      })
    ).toBe(false);
    expect(
      updateFieldsMatch(row, {
        content: "next",
        domain_tags: ["a", "a", "b"],
        evidence_refs: ["e1", "e2"],
        canonical_entities: ["alice"]
      })
    ).toBe(false);
  });

  it("ignores evidence_refs on the row when the update payload omitted them", () => {
    const row = createMemoryEntry({
      content: "next",
      domain_tags: ["tag"],
      evidence_refs: ["evidence-old"]
    });
    expect(updateFieldsMatch(row, { content: "next", domain_tags: ["tag"] })).toBe(true);
  });
});
