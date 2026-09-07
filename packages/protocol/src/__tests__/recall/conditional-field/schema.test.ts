import { describe, expect, it } from "vitest";
import {
  ASSOCIATION_DOMAIN_ID,
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  CompletenessReportSchema,
  FacetModeSchema,
  CompletenessStatusSchema,
  ConditionalFieldSha256DigestSchema,
  GuardKindSchema,
  GuardSchema,
  InformationIndexSchema,
  MILLIGRADE_BOTTOM,
  MILLIGRADE_TOP,
  MilligradeSchema,
  ObserverStatusSchema,
  ProductStateKeySchema,
  QueryInterpretationSchema,
  QueryProgramSchema,
  QueryViewSchema,
  RepresentationDecisionSchema,
  RequestBudgetSchema,
  Sha256HexSchema,
  SnapshotReadLeaseSchema,
  formatConditionalFieldDigest
} from "../../../recall/conditional-field/index.js";
import {
  COMPATIBILITY_DISPOSITIONS,
  COMPATIBILITY_LEDGER
} from "./compatibility-ledger.fixture.js";
import {
  ORDINARY_LANGUAGE_ADMISSION_STATUSES,
  OWNERSHIP_LEDGER
} from "./ownership-ledger.fixture.js";

describe("conditional-field schemas", () => {
  it("keeps epsilon and empty as distinct parseable kinds", () => {
    const epsilon = QueryProgramSchema.parse({ schema_version: 1, kind: "epsilon" });
    const empty = QueryProgramSchema.parse({ schema_version: 1, kind: "empty" });
    expect(epsilon.kind).toBe("epsilon");
    expect(empty.kind).toBe("empty");
    expect(epsilon.kind).not.toBe(empty.kind);
    expect(() => QueryProgramSchema.parse({ schema_version: 1, kind: "epsilon", extra: true }))
      .toThrow();
  });

  it("rejects milligrades outside 0..1000 and accepts the bounds", () => {
    expect(MilligradeSchema.parse(MILLIGRADE_BOTTOM)).toBe(0);
    expect(MilligradeSchema.parse(MILLIGRADE_TOP)).toBe(1000);
    expect(() => MilligradeSchema.parse(-1)).toThrow();
    expect(() => MilligradeSchema.parse(1001)).toThrow();
    expect(() => MilligradeSchema.parse(12.5)).toThrow();
    expect(ASSOCIATION_DOMAIN_ID).toBe("assoc.bottleneck.milligrade.v1");
    expect(CONDITIONAL_FIELD_SCHEMA_VERSION).toBe(1);
  });

  it("defaults facet_mode to same_path and threshold_milligrades to 0", () => {
    const view = QueryViewSchema.parse({
      schema_version: 1,
      requested_roles: ["requested", "associated"]
    });
    expect(view.facet_mode).toBe("same_path");
    expect(view.threshold_milligrades).toBe(0);
    expect(FacetModeSchema.parse("independent")).toBe("independent");
    const relation = QueryProgramSchema.parse({
      schema_version: 1,
      kind: "relation",
      relation_kind: "associated_config",
      source_variable: "r",
      target_variable: "c",
      guard: {
        schema_version: 1,
        kind: "interval_relation",
        verdict: "true",
        variable: "r",
        time_scope: "anchor"
      }
    });
    expect(relation).toMatchObject({
      kind: "relation",
      facet_mode: "same_path",
      threshold_milligrades: 0
    });
  });

  it("requires closure product_state_sufficient and repeat count 1..8", () => {
    expect(() => QueryProgramSchema.parse({
      schema_version: 1,
      kind: "closure",
      product_state_sufficient: false,
      body: { schema_version: 1, kind: "epsilon" }
    })).toThrow();
    const closure = QueryProgramSchema.parse({
      schema_version: 1,
      kind: "closure",
      product_state_sufficient: true,
      body: { schema_version: 1, kind: "epsilon" }
    });
    expect(closure.kind).toBe("closure");
    expect(() => QueryProgramSchema.parse({
      schema_version: 1,
      kind: "repeat",
      count: 0,
      body: { schema_version: 1, kind: "epsilon" }
    })).toThrow();
    expect(() => QueryProgramSchema.parse({
      schema_version: 1,
      kind: "repeat",
      count: 9,
      body: { schema_version: 1, kind: "epsilon" }
    })).toThrow();
    expect(QueryProgramSchema.parse({
      schema_version: 1,
      kind: "repeat",
      count: 8,
      body: { schema_version: 1, kind: "empty" }
    }).kind).toBe("repeat");
  });

  it("parses recursive programs, guards, budgets, and digest forms", () => {
    const program = QueryProgramSchema.parse({
      schema_version: 1,
      kind: "sequence",
      steps: [
        { schema_version: 1, kind: "epsilon" },
        {
          schema_version: 1,
          kind: "hyperedge",
          join: "and",
          premises: [
            { schema_version: 1, kind: "empty" },
            { schema_version: 1, kind: "alternative", options: [{ schema_version: 1, kind: "epsilon" }] }
          ]
        }
      ]
    });
    expect(program.kind).toBe("sequence");
    expect(GuardSchema.parse({ schema_version: 1, kind: "equality" }).verdict).toBe("unresolved");
    expect(GuardKindSchema.options).toEqual([
      "equality",
      "source_bound_entity",
      "interval_relation",
      "authorization",
      "query_predicate"
    ]);
    expect(RequestBudgetSchema.parse({
      schema_version: 1,
      work_units: 100,
      memory_bytes: 4096,
      page_budget: 800,
      finalization_reserve: 20,
      min_envelope: 10
    }).min_envelope).toBe(10);
    const hex = "a".repeat(64);
    expect(Sha256HexSchema.parse(hex)).toBe(hex);
    expect(ConditionalFieldSha256DigestSchema.parse(formatConditionalFieldDigest(hex)))
      .toBe(`sha256:${hex}`);
    expect(() => formatConditionalFieldDigest("zz")).toThrow();
  });

  it("keeps completeness dimensions independent and representation policy frozen", () => {
    const completeness = CompletenessReportSchema.parse({
      schema_version: 1,
      logical_index: "complete",
      observed_coverage: "open",
      transport: "partial",
      payload: "unavailable",
      representation: "resource_rejected"
    });
    expect(completeness.logical_index).toBe("complete");
    expect(completeness.observed_coverage).toBe("open");
    expect(RepresentationDecisionSchema.parse({
      schema_version: 1,
      policy: "construct_index_then_page_then_payload",
      page_budget: 800,
      identity_tie_break: "serialization"
    }).policy).toBe("construct_index_then_page_then_payload");
    expect(ProductStateKeySchema.parse({
      schema_version: 1,
      object_id: "r",
      program_state: "accepting",
      hypothesis_id: "h0",
      binding_context: "default",
      time_state: "as_of"
    }).object_id).toBe("r");
    expect(InformationIndexSchema.parse({
      schema_version: 1,
      query_id: "q1",
      snapshot_id: `sha256:${"b".repeat(64)}`,
      result_version: "v1",
      entries: [],
      completeness,
      continuation: null,
      representation: {
        schema_version: 1,
        policy: "construct_index_then_page_then_payload",
        page_budget: 800,
        identity_tie_break: "serialization"
      }
    }).continuation).toBeNull();
  });

  it("records the live-field compatibility ledger with frozen dispositions", () => {
    const fields = COMPATIBILITY_LEDGER.map((row) => row.field);
    expect(fields).toEqual([
      "query",
      "recent_turn",
      "source_observed_at",
      "since/until/time_field",
      "max_results",
      "delivery_path",
      "ranking_authority",
      "host_context",
      "scope_class/dimension/domain_tags",
      "persisted_old_receipts",
      "rebuildable_projections",
      "operational_feedback",
      "continuation",
      "second_production_selector"
    ]);
    for (const row of COMPATIBILITY_LEDGER) {
      expect(COMPATIBILITY_DISPOSITIONS).toContain(row.disposition);
    }
    expect(COMPATIBILITY_LEDGER.find((row) => row.field === "query")?.disposition)
      .toBe("already-migrated");
    expect(COMPATIBILITY_LEDGER.find((row) => row.field === "recent_turn")?.disposition)
      .toBe("ignore-on-target");
    expect(COMPATIBILITY_LEDGER.find((row) => row.field === "second_production_selector")?.disposition)
      .toBe("forbidden-second-selector");
    expect(COMPATIBILITY_LEDGER.find((row) => row.field === "persisted_old_receipts")?.disposition)
      .toBe("freeze-live");
    expect(COMPATIBILITY_LEDGER.find((row) => row.field === "operational_feedback")?.disposition)
      .toBe("unreachable-on-target");
    expect(COMPATIBILITY_LEDGER.find((row) => row.field === "ranking_authority")?.disposition)
      .toBe("deferred-D01");
  });

  it("requires interpretation status and a snapshot pin", () => {
    const interpretation = QueryInterpretationSchema.parse({
      schema_version: 1,
      query_id: "q1",
      status: "resolved",
      snapshot_id: `sha256:${"b".repeat(64)}`,
      program: { schema_version: 1, kind: "epsilon" },
      view: { schema_version: 1, requested_roles: ["requested"] },
      holes: [],
      hypotheses: [],
      interpretation_clock: "2026-09-06T00:00:00.000Z",
      time_window: {
        start: "2026-09-05T00:00:00.000Z",
        end: "2026-09-06T00:00:00.000Z"
      }
    });
    expect(interpretation.status).toBe("resolved");
    expect(interpretation.snapshot_id.startsWith("sha256:")).toBe(true);
    expect(() => QueryInterpretationSchema.parse({
      schema_version: 1,
      query_id: "q1",
      program: { schema_version: 1, kind: "epsilon" },
      view: { schema_version: 1, requested_roles: ["requested"] },
      holes: [],
      hypotheses: []
    })).toThrow();
  });

  it("freezes snapshot leases, invalidated completeness, and extra observer statuses", () => {
    expect(SnapshotReadLeaseSchema.parse({
      schema_version: 1,
      lease_id: "lease-1",
      snapshot_id: `sha256:${"b".repeat(64)}`,
      query_id: "q1",
      status: "active"
    }).status).toBe("active");
    expect(CompletenessStatusSchema.parse("invalidated")).toBe("invalidated");
    expect(ObserverStatusSchema.parse("cancelled")).toBe("cancelled");
    expect(ObserverStatusSchema.parse("unknown")).toBe("unknown");
  });

  it("keeps an exclusive ownership ledger and ordinary-language admission statuses", () => {
    expect(OWNERSHIP_LEDGER.length).toBeGreaterThan(0);
    const seen = new Set<string>();
    for (const row of OWNERSHIP_LEDGER) {
      for (const path of row.paths) {
        expect(seen.has(path), path).toBe(false);
        seen.add(path);
      }
    }
    expect(ORDINARY_LANGUAGE_ADMISSION_STATUSES).toEqual([
      "resolved",
      "hypotheses",
      "partial",
      "unsupported",
      "malformed",
      "resource_rejected"
    ]);
    const c00 = OWNERSHIP_LEDGER.find((row) => row.card === "C00");
    const u01 = OWNERSHIP_LEDGER.find((row) => row.card === "U01");
    expect(c00?.classification).toBe("already-written");
    expect(u01?.paths).toContain("packages/core/src/recall/conditional-field/query/");
    expect(OWNERSHIP_LEDGER.find((row) => row.card === "live-unowned")?.paths)
      .toContain("packages/core/src/recall/decision/budget-aware-q/");
  });
});
