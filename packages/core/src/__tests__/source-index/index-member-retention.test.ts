import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../apps/bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); });
afterAll(() => isolation.restore());
import type { SourceIndexAcquisitionInput, SourceIndexLexicalRead, SourceIndexQueryRepository } from "@do-soul/alaya-protocol";
import { SourceIndexAcquisition } from "../../source-index/source-index-acquisition.js";
import { fieldSha256 } from "../../../../storage/src/__tests__/repos/source-index/source-index-fixture.js";
import { templateBudget, templateStatement } from "./source-template-fixture.js";

const empty = { work: 0, memory_bytes: 0, native_bytes: 0, sql_internal_work: "unknown" as const };

function fixture(rows: readonly ReturnType<typeof templateStatement>[]) {
  const lexical: SourceIndexLexicalRead = { completion: "complete", reason: null,
    candidates: rows.map((row, i) => ({ source: row.source, lexical: { lane: "unicode61", rank: i + 1, lane_rank: i + 1, bm25: -1 } })),
    resources: empty, resource_refusal: null, index_coverage: "partial", limitations: [], tokenization: null };
  const repository: SourceIndexQueryRepository = {
    readLexicalCandidates: () => lexical,
    readVectorCandidates: () => ({ completion: "complete", reason: null, candidates: [], resources: empty,
      state: { status: "unavailable", reason: "fixture" }, resource_refusal: null, cursor: null, inspected: 0, invalid: 0 }),
    admitQueryCandidate: () => ({ status: "ready", scope_class: "project", resources: empty })
  };
  const input: SourceIndexAcquisitionInput = { workspace_id: "workspace-template", navigation_text: "game",
    vector: { status: "unavailable", reason: "fixture" }, allowance: { max_attempts: 128, max_roots: 16, max_vector_windows: 0 },
    budget: templateBudget };
  return (members: number, view: "original" | "hint" = "original") => new SourceIndexAcquisition(repository, fieldSha256)
    .nominateWithWitness(input, () => "admitted", view, undefined, undefined, undefined, undefined, members);
}

it("lists roots refused only by the root limit, in attempt order, without changing the nominated prefix or its resources", () => {
  const rows = Array.from({ length: 24 }, (_, i) => templateStatement(`root-${i}`));
  const run = fixture(rows);
  const base = run(0), listed = run(16);
  expect(base).not.toHaveProperty("index_members");
  expect(listed.result.nominations).toEqual(base.result.nominations);
  expect(listed.result.accounting).toEqual(base.result.accounting);
  expect(listed.result.resources).toEqual(base.result.resources);
  expect(listed.result.completion).toBe(base.result.completion);
  expect(listed.index_members).toEqual(rows.slice(16).map(row => row.source));
});

it("caps the list, skips repeated roots and lists nothing for the hint view", () => {
  const rows = Array.from({ length: 24 }, (_, i) => templateStatement(`root-${i}`));
  const run = fixture([...rows, rows[20]!, rows[3]!]);
  expect(run(3).index_members).toEqual(rows.slice(16, 19).map(row => row.source));
  expect(run(16).index_members).toEqual(rows.slice(16).map(row => row.source));
  expect(run(16, "hint")).not.toHaveProperty("index_members");
});
