import { describe, expect, it, vi } from "vitest";
import { type QueryProgram } from "@do-soul/alaya-protocol";
import { compileConditionalFieldQuery } from "../../../../recall/conditional-field/query/compile-query.js";
import {
  decodeSourceFilters,
  encodeSourceFilters,
  sourceFactsSatisfyFilters
} from "../../../../recall/conditional-field/query/ordinary-language.js";
import { defaultBudget, INTERPRETATION_CLOCK, SNAPSHOT_ID } from "../reference/deployment.fixture.js";

describe("conditional-field source-filter admission", () => {
  it.each([undefined, "created_at", "last_used_at"] as const)(
    "compares equal UTC instants and preserves fractional precision for time_field=%s", (time_field) => {
      const equivalents = ["2026-09-06T00:00Z", "2026-09-06T00:00:00Z", "2026-09-06T00:00:00.000Z"];
      for (const stamp of equivalents) for (const boundary of equivalents) {
        expect(sourceFactsSatisfyFilters({ time_field, since: boundary, until: boundary },
          { created_at: stamp, last_used_at: stamp, observed_at: stamp })).toBe("true");
      }
      const lower = "2026-09-06T00:00:00.0000000000000000001Z";
      const higher = "2026-09-06T00:00:00.0000000000000000002Z";
      expect(sourceFactsSatisfyFilters({ time_field, since: higher },
        { created_at: lower, last_used_at: lower, observed_at: lower })).toBe("false");
      expect(sourceFactsSatisfyFilters({ time_field, until: lower },
        { created_at: higher, last_used_at: higher, observed_at: higher })).toBe("false");
      expect(sourceFactsSatisfyFilters({ time_field, since: higher, until: higher },
        { created_at: higher, last_used_at: higher, observed_at: higher })).toBe("true");
    }
  );

  it("keeps an invalid source timestamp unresolved", () => {
    expect(sourceFactsSatisfyFilters({ since: "2026-09-06T00:00Z" },
      { observed_at: "not-a-timestamp" })).toBe("unresolved");
  });

  it("preserves delimiters, quotes, Unicode, and time constraints as literal filter values", () => {
    const literal = "team|tag=other|since=1900-01-01T00:00:00.000Z\"%领域\n";
    const filters = { domain_tag_filter: [literal], dimension_filter: ["fact"], time_field: "created_at" as const,
      since: "2026-09-01T00:00:00.000Z", until: "2026-09-09T00:00:00.000Z" };
    const restored = decodeSourceFilters(encodeSourceFilters(filters));
    expect(restored).toEqual(filters);
    expect(sourceFactsSatisfyFilters(restored!, { domain_tags: ["other"], dimension: "fact",
      created_at: "2026-09-06T00:00:00.000Z" })).toBe("false");
    expect(sourceFactsSatisfyFilters(restored!, { domain_tags: [literal], dimension: "fact",
      created_at: "2020-01-01T00:00:00.000Z" })).toBe("false");
    expect(sourceFactsSatisfyFilters(restored!, { domain_tags: [literal], dimension: "fact",
      created_at: "2026-09-06T00:00:00.000Z" })).toBe("true");
  });

  it.each(["needle", "yesterday failed deployment", "find observed_log from source to target"])(
    "rejects oversized filter predicates before memory access for %s", (text) => {
      const readAuthorizedSnapshot = vi.fn();
      const interpretation = compileConditionalFieldQuery({ source: "ordinary", text,
        snapshot_id: SNAPSHOT_ID, interpretation_clock: INTERPRETATION_CLOCK, budget: defaultBudget(),
        domain_tag_filter: ["x".repeat(1024)], since: "2026-09-01T00:00:00.000Z",
        memory: { readAuthorizedSnapshot } });
      expect(interpretation.status).toBe("resource_rejected");
      expect(readAuthorizedSnapshot).not.toHaveBeenCalled();
    }
  );

  it.each([
    "source.filters",
    "source.filters|tag=other",
    "source.filters.unrecognized",
    "source.filters:{",
    "source.filters:null",
    "source.filters:[]",
    "source.filters:{}",
    'source.filters:{"domain_tag_filter":[]}',
    'source.filters:{"domain_tag_filter":"other"}',
    'source.filters:{"domain_tag_filter":[null]}',
    'source.filters:{"since":"invalid"}',
    'source.filters:{"unknown":"other"}'
  ])("rejects malformed reserved predicates at the typed compiler: %s", (predicate_name) => {
    const program: QueryProgram = { schema_version: 1, kind: "relation", relation_kind: "observed_log",
      source_variable: "source", target_variable: "target", facet_mode: "same_path", threshold_milligrades: 0,
      guard: { schema_version: 1, kind: "source_bound_entity", verdict: "unresolved", entity_id: "memory-a", predicate_name } };
    const readAuthorizedSnapshot = vi.fn();
    const interpretation = compileConditionalFieldQuery({ source: "typed", program,
      snapshot_id: SNAPSHOT_ID, interpretation_clock: INTERPRETATION_CLOCK, budget: defaultBudget(),
      memory: { readAuthorizedSnapshot } });
    expect(interpretation.status).toBe("malformed");
    expect(readAuthorizedSnapshot).not.toHaveBeenCalled();
    expect(() => decodeSourceFilters(predicate_name)).toThrow();
  });
});
