import { describe, expect, it } from "vitest";
import type { ObserveConditionalFieldInput, SourceObserverRow, SourceRootObserverRow } from "../../../../recall/conditional-field/observers/observe.js";
import {
  parseAuthorizedScopesAdmission,
  sourceRootEligible,
  sourceRowEligible
} from "../../../../recall/conditional-field/observers/observation-admission.js";
import { continuationViewMismatch } from "../../../../recall/conditional-field/query/compile-query.js";
import { runConditionalFieldRecall } from "../../../../recall/runtime/recall-service-runner.js";
import { defaultBudget, defaultView, SNAPSHOT_ID } from "../reference/deployment.fixture.js";

const AS_OF = "2026-09-09T00:00:00.000Z";

describe("authorized_scopes tri-state admission", () => {
  it("typed null (not JSON null) remains unrestricted", () => {
    expect(sourceRowEligible(observe("null"), sourceRow("project"))).toBe(true);
    expect(sourceRowEligible(observe("null"), sourceRow("global_domain"))).toBe(true);
    expect(sourceRowEligible(observe("null"), sourceRow(undefined))).toBe(true);
    expect(sourceRootEligible(observe("null"), sourceRoot("project"))).toBe(true);
    expect(sourceRootEligible(observe("null"), sourceRoot("global_domain"))).toBe(true);
    expect(sourceRootEligible(observe("null"), sourceRoot(undefined))).toBe(true);
  });

  it("denies omitted and empty authorized sets", () => {
    expect(sourceRowEligible(observe("omit"), sourceRow("project"))).toBe(false);
    expect(sourceRowEligible(observe("empty"), sourceRow("project"))).toBe(false);
    expect(sourceRowEligible(observe("omit"), undefined)).toBe(false);
    expect(sourceRootEligible(observe("omit"), sourceRoot("project"))).toBe(false);
    expect(sourceRootEligible(observe("empty"), sourceRoot("project"))).toBe(false);
    expect(sourceRootEligible(observe("empty"), sourceRoot(undefined))).toBe(false);
  });

  it("keeps named includes fail-closed on omitted scope_class", () => {
    expect(sourceRowEligible(observe("named"), sourceRow("project"))).toBe(true);
    expect(sourceRowEligible(observe("named"), sourceRow("global_domain"))).toBe(false);
    expect(sourceRowEligible(observe("named"), sourceRow(undefined))).toBe(false);
    expect(sourceRootEligible(observe("named"), sourceRoot("project"))).toBe(true);
    expect(sourceRootEligible(observe("named"), sourceRoot("global_domain"))).toBe(false);
    expect(sourceRootEligible(observe("named"), sourceRoot(undefined))).toBe(false);
  });

  it("invalidates a recall request that omits authorized_scopes", () => {
    const index = runConditionalFieldRecall({
      workspace_id: "workspace-1",
      query_text: "needle",
      budget: defaultBudget(),
      snapshot_id: SNAPSHOT_ID,
      interpretation_clock: AS_OF,
      as_of: AS_OF,
      expires_at: "2099-01-01T00:00:00.000Z",
      readers: {}
    });
    expect(index.entries).toEqual([]);
    expect(index.completeness.logical_index).toBe("invalidated");
  });

  it("does not flip denied to unrestricted when JSON turns a missing key into null", () => {
    const omitted = JSON.parse("{}") as { readonly authorized_scopes?: unknown };
    const jsonNull = JSON.parse("{\"authorized_scopes\":null}") as { readonly authorized_scopes?: unknown };
    const deniedRoundtrip = JSON.parse(JSON.stringify({ authorized_scopes: { mode: "denied" } })) as {
      readonly authorized_scopes?: unknown;
    };
    expect(parseAuthorizedScopesAdmission(omitted.authorized_scopes).mode).toBe("denied");
    expect(parseAuthorizedScopesAdmission(jsonNull.authorized_scopes).mode).toBe("denied");
    expect(parseAuthorizedScopesAdmission(deniedRoundtrip.authorized_scopes).mode).toBe("denied");
    expect(parseAuthorizedScopesAdmission(JSON.parse(JSON.stringify({ mode: "unrestricted" }))).mode)
      .toBe("unrestricted");
    expect(parseAuthorizedScopesAdmission(JSON.parse("null")).mode).toBe("denied");
  });

  it("mismatches one-sided continuation omit, null, and empty without regressing named change", () => {
    const view = defaultView();
    const continuation = {
      schema_version: 1 as const,
      continuation_id: "page-1",
      query_id: "q",
      snapshot_id: SNAPSHOT_ID,
      result_version: "v1",
      expires_at: "2099-01-01T00:00:00.000Z",
      cursor: "offset-1"
    };
    expect(continuationViewMismatch(continuation, view)).toBe(false);
    expect(continuationViewMismatch(continuation, view, null)).toBe(true);
    expect(continuationViewMismatch(continuation, view, [])).toBe(true);
    expect(continuationViewMismatch({ ...continuation, authorized_scopes: null }, view, null)).toBe(false);
    expect(continuationViewMismatch({ ...continuation, authorized_scopes: [] }, view, [])).toBe(false);
    expect(continuationViewMismatch({ ...continuation, authorized_scopes: null }, view, [])).toBe(true);
    expect(continuationViewMismatch({ ...continuation, authorized_scopes: ["public"] }, view, ["private"])).toBe(true);
    expect(continuationViewMismatch({ ...continuation, authorized_scopes: ["public"] }, view, ["public"])).toBe(false);
  });
});

function observe(kind: "omit" | "null" | "empty" | "named"): ObserveConditionalFieldInput {
  const base = { as_of: AS_OF, query: { interpretation_clock: AS_OF } };
  if (kind === "omit") return base as unknown as ObserveConditionalFieldInput;
  if (kind === "null") return { ...base, authorized_scopes: null } as unknown as ObserveConditionalFieldInput;
  if (kind === "empty") return { ...base, authorized_scopes: [] } as unknown as ObserveConditionalFieldInput;
  return { ...base, authorized_scopes: ["project"] } as unknown as ObserveConditionalFieldInput;
}

function sourceRow(scope_class: string | undefined): SourceObserverRow {
  return { object_id: "mem-1", sourceRevision: "rev-1", lifecycle_state: "active", ...(scope_class === undefined ? {} : { scope_class }) };
}

function sourceRoot(scope_class: string | undefined): SourceRootObserverRow {
  return {
    kind: "source_record",
    workspace_id: "workspace-1",
    root_id: "root-1",
    revision: "rev-1",
    digest: SNAPSHOT_ID,
    evidence_object_id: null,
    ...(scope_class === undefined ? {} : { scope_class })
  };
}
