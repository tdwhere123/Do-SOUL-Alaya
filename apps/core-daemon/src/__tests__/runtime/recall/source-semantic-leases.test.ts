import { expect, it } from "vitest";
import { CoreError } from "@do-soul/alaya-core";
import { SourceSemanticReadBudget } from "../../../runtime/field/source-semantic-read-stores.js";
import { issueSemanticLease, issueSemanticLeaseGroup, readSemanticLease, type SourceSemanticLease }
  from "../../../runtime/recall-read-worker/source-semantic-leases.js";
import type { RecallReadWorkerRuntime } from "../../../runtime/recall-read-worker/runtime.js";

const CLOCK = "2026-09-23T00:00:00.000Z";
const LATER = "2026-09-23T00:11:00.000Z";
const SCOPES = ["project"];

function runtime(): RecallReadWorkerRuntime {
  return { database: { connection: {
    pragma: () => 0,
    prepare: () => ({ get: () => ({ n: 0 }) })
  } } } as unknown as RecallReadWorkerRuntime;
}

function meter(): SourceSemanticReadBudget {
  return new SourceSemanticReadBudget({ work_units: 1_000_000, memory_bytes: 40_000_000 });
}

function lease(kind: SourceSemanticLease["kind"], now = CLOCK, originalQuery?: string): SourceSemanticLease {
  return { kind, workspace_id: "workspace", principal: "agent", as_of: CLOCK, lifetime_now: now,
    authorized: SCOPES, expires_at: "2026-09-23T00:10:00.000Z", revision: "0:0",
    ...(originalQuery === undefined ? {} : { original_query: originalQuery }) };
}

function read(worker: RecallReadWorkerRuntime, id: string, kind: SourceSemanticLease["kind"], now = CLOCK) {
  return readSemanticLease(worker, { workspace_id: "workspace", principal: "agent", as_of: CLOCK, lifetime_now: now },
    id, SCOPES, kind);
}

it("rejects an over-cap lease pair without replacing or installing any handle", () => {
  const worker = runtime(), budget = meter();
  const existing = issueSemanticLease(worker, lease("source"), budget, "existing");
  const large = "x".repeat(1_050_000);
  const single = runtime();
  const singleId = issueSemanticLease(single, lease("query", CLOCK, large), meter());
  expect(read(single, singleId, "query")).toMatchObject({ kind: "query" });
  const issues = [
    { lease: lease("query", CLOCK, large), issuedId: "new-query" },
    { lease: lease("page", CLOCK, large), issuedId: "new-page" }
  ];
  expect(() => issueSemanticLeaseGroup(worker, issues, budget)).toThrowError(CoreError);
  expect(read(worker, existing, "source")).toMatchObject({ kind: "source" });
  expect(() => read(worker, "new-query", "query")).toThrow(/expired/u);
  expect(() => read(worker, "new-page", "page")).toThrow(/expired/u);
});

it("evicts older handles under count pressure while retaining the whole new pair", () => {
  const worker = runtime(), budget = meter();
  for (let index = 0; index < 32; index += 1) issueSemanticLease(worker, lease("source"), budget, `older-${index}`);
  const [query, page] = issueSemanticLeaseGroup(worker,
    [{ lease: lease("query") }, { lease: lease("page") }], budget);
  expect(read(worker, query!, "query")).toMatchObject({ kind: "query" });
  expect(read(worker, page!, "page")).toMatchObject({ kind: "page" });
  expect(() => read(worker, "older-0", "source")).toThrow(/expired/u);
  expect(() => read(worker, "older-1", "source")).toThrow(/expired/u);
  expect(read(worker, "older-2", "source")).toMatchObject({ kind: "source" });
});

it("prunes expired capacity and keeps supplied library continuation identities", () => {
  const worker = runtime(), budget = meter();
  issueSemanticLease(worker, lease("source"), budget, "expired-source");
  const library = { ...lease("library", LATER), expires_at: "2026-09-23T00:20:00.000Z" };
  const issued = issueSemanticLease(worker, library, budget, "library-continuation");
  expect(issued).toBe("library-continuation");
  expect(read(worker, issued, "library", LATER)).toMatchObject({ kind: "library" });
  expect(() => read(worker, "expired-source", "source", LATER)).toThrow(/expired/u);
  expect(issueSemanticLease(worker, library, budget, issued)).toBe(issued);
  expect(read(worker, issued, "library", LATER)).toMatchObject({ kind: "library" });
});
