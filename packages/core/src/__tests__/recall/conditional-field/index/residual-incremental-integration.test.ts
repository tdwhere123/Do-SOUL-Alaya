import { describe, expect, it } from "vitest";
import { productSubjectId, type CoverageRegion, type QueryInterpretation } from "@do-soul/alaya-protocol";
import { SqliteEvidenceCapsuleRepo, SqliteFieldSourceRecordRepo, SqliteSourceRootRecallReader } from "@do-soul/alaya-storage";
import { createConditionalField } from "../../../../recall/conditional-field/engine/field-engine.js";
import { orderedProjectionValues } from "../../../../recall/conditional-field/engine/field-solve.js";
import { projectAcceptingIndex } from "../../../../recall/conditional-field/index/project-accepting-index.js";
import { toSourceRootObserverRow } from "../../../../recall/conditional-field/observers/observe.js";
import { observeField } from "../../../../recall/runtime/conditional-field-observe.js";
import { fieldSha256, hashedRecord, openFieldDatabase } from "../../../../../../storage/src/__tests__/repos/field/field-contract-fixture.js";
import { defaultBudget, defaultView, productKey, QUERY_ID, SNAPSHOT_ID } from "../reference/deployment.fixture.js";

function interpretation(): QueryInterpretation {
  return { schema_version: 1, query_id: QUERY_ID, snapshot_id: SNAPSHOT_ID, status: "resolved",
    program: { schema_version: 1, kind: "epsilon" }, view: defaultView(), holes: [], hypotheses: [] };
}

describe("residual semantics on incremental delivery", () => {
  it("preserves native exhaustion when resuming a field that has no source-domain region yet", () => {
    const query = { ...interpretation(), view: { ...defaultView(), result_kind_view: "memory_only" as const } };
    const budget = defaultBudget();
    const initial = createConditionalField({ interpretation: query, budget,
      seeds: [{ schema_version: 1, state: productKey("known"), milligrades: 400 }] });
    expect(initial.residuals.some((region) => region.kind === "source_domain")).toBe(false);
    const field = observeField(query, { workspace_id: "ws", query_text: "known", budget,
      as_of: "2026-09-10T00:00:00.000Z", authorized_scopes: null, resume_field: initial, readers: {
        lexical: () => ({ ids: ["known"], nativeVisits: 1, nativeBytes: 1, rowsRead: 1, bytesRead: 1, truncated: false }),
        source: () => ({ row: { object_id: "known", sourceRevision: "rev", lifecycle_state: "active" },
          rowsRead: 1, bytesRead: 1, unavailable: false })
      } });
    expect(field.residuals.find((region) => region.kind === "source_domain")?.status).toBe("not_applicable");
    expect(field.last_observer_status).toBe("exhausted");
    expect(field.closure.observation).toBe("exhausted");
    expect(field.closure.requested_index).toBe("complete");
    const values = orderedProjectionValues(field);
    expect(values?.at(0)?.activation?.kind).toBe("reachable");
    expect(values?.at(0)?.state.target).toMatchObject({ kind: "memory_entry", object_id: "known" });
  });

  it("keeps interrupted memory observation visible when the source domain is outside the view", () => {
    const residuals: CoverageRegion[] = [
      { schema_version: 1, region_id: "seed", kind: "seed", status: "interrupted" },
      { schema_version: 1, region_id: "source_domain", kind: "source_domain", status: "not_applicable" }
    ];
    const query = { ...interpretation(), view: { ...defaultView(), result_kind_view: "memory_only" as const } };
    const budget = defaultBudget();
    const field = createConditionalField({ interpretation: query, budget, residuals,
      seeds: [{ schema_version: 1, state: productKey("known"), milligrades: 400 }] });
    expect(field.closure.observation).toBe("interrupted");
    expect(field.residuals.find((region) => region.kind === "source_domain")?.status).toBe("not_applicable");
    if (field.binding.kind !== "bound") throw new Error("field was not bound");
    const index = projectAcceptingIndex({ snapshot: field.binding.snapshot, ordered_values: orderedProjectionValues(field),
      view: query.view, query_id: QUERY_ID, snapshot_id: SNAPSHOT_ID, result_version: "v1", budget,
      observer: { outcome: { schema_version: 1, status: field.closure.observation }, open_regions: field.residuals } });
    expect(index.entries).toHaveLength(1);
    expect(index.completeness.observed_coverage).toBe("interrupted");
    expect(index.completeness.logical_index).not.toBe("complete");
  });

  it.each([
    { status: "unknown" as const, low: 400, high: 1000 },
    { status: "invalidated" as const, low: undefined, high: 1000 },
    { status: "exhausted" as const, low: 400, high: 400 }
  ])("preserves $status bounds through the ordered projection port", ({ status, low, high }) => {
    const residuals: CoverageRegion[] = [{ schema_version: 1, region_id: "source_domain", kind: "source_domain",
      coverage_role: "required", status, semantic_effects: ["membership", "grade_bound"] }];
    const query = interpretation();
    const budget = defaultBudget();
    const field = createConditionalField({ interpretation: query, budget, residuals,
      seeds: [{ schema_version: 1, state: productKey("known"), milligrades: 400 }] });
    expect(field.binding.kind).toBe("bound");
    if (field.binding.kind !== "bound") throw new Error("field was not bound");
    const ordered = orderedProjectionValues(field);
    expect(ordered?.size).toBe(1);
    expect(ordered?.at(0)).toMatchObject({ milligrades: 400, high_milligrades: high });
    expect(ordered?.at(0)?.low_milligrades).toBe(low);
    expect(field.binding.snapshot.values[0]?.low_milligrades).toBe(low);
    expect(field.binding.snapshot.values[0]?.high_milligrades).toBe(high);
    const index = projectAcceptingIndex({ snapshot: field.binding.snapshot, ordered_values: ordered,
      view: query.view, query_id: QUERY_ID, snapshot_id: SNAPSHOT_ID, result_version: "v1", budget,
      expand_payload: false, observer: { outcome: { schema_version: 1, status }, open_regions: residuals } });
    expect(index.entries).toHaveLength(1);
    expect(index.entries[0]).toMatchObject({ object_id: "known", association_milligrades: 400 });
    expect(index.entries[0]?.guaranteed_milligrades).toBe(low);
    if (status === "exhausted") expect(index.completeness.logical_index).toBe("complete");
    else {
      expect(index.completeness.logical_index).not.toBe("complete");
      expect(index.order_status).toBe("open");
      expect(index.completeness.certificate_id).toBeUndefined();
    }
  });

  it.each([0, 400])("does not deliver guaranteed zero after the snapshot observer invalidates a %i proof", (grade) => {
    const query = { ...interpretation(), view: { ...defaultView(), result_kind_view: "memory_only" as const } };
    const budget = defaultBudget({ work_units: 10_000, finalization_reserve: 1000 });
    const initial = createConditionalField({ interpretation: query, budget,
      residuals: [{ schema_version: 1, region_id: "seed", kind: "seed", status: "open" }],
      seeds: [{ schema_version: 1, state: productKey("known"), milligrades: grade }] });
    const project = (field: typeof initial) => {
      if (field.binding.kind !== "bound") throw new Error("field was not bound");
      return projectAcceptingIndex({ snapshot: field.binding.snapshot, ordered_values: orderedProjectionValues(field),
        view: query.view, query_id: QUERY_ID, snapshot_id: SNAPSHOT_ID, result_version: "v1", budget,
        expand_payload: false, observer: { outcome: { schema_version: 1, status: field.closure.observation }, open_regions: field.residuals } });
    };
    expect(project(initial).entries[0]?.guaranteed_milligrades).toBe(grade);
    const invalidated = observeField(query, { workspace_id: "ws", query_text: "known", budget,
      as_of: "2026-09-10T00:00:00.000Z", expected_source_revision: "old",
      resume_field: { ...initial, observation_workspace_id: "ws", observation_query_text: "known",
        observation_as_of: "2026-09-10T00:00:00.000Z", observation_source_revision: "old" },
      readers: { snapshotPin: () => ({ source_revision: "changed" }),
        lexical: () => { throw new Error("Invalidation must precede lexical reads"); } } });
    expect(invalidated.residuals.find(region => region.region_id === "seed")?.status).toBe("invalidated");
    expect(invalidated.closure.observation).toBe("invalidated");
    expect(orderedProjectionValues(invalidated)?.at(0)?.low_milligrades).toBeUndefined();
    const index = project(invalidated);
    expect(index.entries).toHaveLength(1);
    expect(index.entries[0]).toMatchObject({ object_id: "known", association_milligrades: grade });
    expect(index.entries[0]).not.toHaveProperty("guaranteed_milligrades");
    expect(index.completeness.observed_coverage).toBe("invalidated");
    expect(index.completeness.logical_index).not.toBe("complete");
  });

  it("settles source coverage after advancing through truncated SQLite pages in one observation", () => {
    const database = openFieldDatabase();
    try {
      const records = new SqliteFieldSourceRecordRepo(database, fieldSha256);
      const roots = ["first source", "second source"].map((body, i) =>
        records.insert(hashedRecord("workspace-1", body, `source-${i}`)));
      const reader = new SqliteSourceRootRecallReader(records, new SqliteEvidenceCapsuleRepo(database));
      const pages: { truncated: boolean; cursor: string | null | undefined }[] = [];
      const field = observeField({ ...interpretation(), view: { ...defaultView(), result_kind_view: "source_only" } }, {
        workspace_id: "workspace-1", query_text: "source", as_of: "2026-09-10T00:00:00.000Z",
        authorized_scopes: null,
        budget: defaultBudget({ work_units: 100_000, memory_bytes: 10_000_000, finalization_reserve: 2000 }),
        readers: { sourceRoots: (input) => {
          const page = reader.page({ ...input, limit: Math.min(input.limit, 1) });
          pages.push({ truncated: page.truncated, cursor: page.committedThrough });
          return { ...page, rows: page.rows.map(toSourceRootObserverRow) };
        } }
      });
      expect(pages.length).toBeGreaterThan(1);
      expect(pages[0]?.truncated).toBe(true);
      expect(pages.at(-1)?.truncated).toBe(false);
      expect(new Set(pages.map((page) => page.cursor)).size).toBeGreaterThan(1);
      expect(field.residuals.find((row) => row.kind === "source_domain")?.status).toBe("exhausted");
      expect(field.binding.kind).toBe("bound");
      if (field.binding.kind !== "bound") throw new Error("field was not bound");
      const admitted = field.binding.snapshot.values.filter((row) => row.accepting && row.activation?.kind === "reachable");
      expect(new Set(admitted.map((row) => productSubjectId(row.state))))
        .toEqual(new Set(roots.map((root) => root.record_id)));
      expect(field.source_facts?.size).toBe(roots.length);
      expect(new Set([...field.source_facts!.values()].map((facts) => facts.content)))
        .toEqual(new Set(["first source", "second source"]));
    } finally {
      database.close();
    }
  });
});
