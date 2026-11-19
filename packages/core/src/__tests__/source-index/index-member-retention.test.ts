import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../scripts/test-support/provider-free/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); });
afterAll(() => isolation.restore());
import type { SourceIndexAcquisitionInput, SourceIndexLexicalRead, SourceIndexQueryRepository } from "@do-soul/alaya-protocol";
import { SourceIndexAcquisition } from "../../source-index/source-index-acquisition.js";
import type { SourceIndexAcquisitionFact } from "../../source-index/acquisition-observation.js";
import { fieldSha256 } from "../../../../storage/src/__tests__/repos/source-index/source-index-fixture.js";
import { template, templateBudget, templateStatement } from "./source-template-fixture.js";

const empty = { work: 0, memory_bytes: 0, native_bytes: 0, sql_internal_work: "unknown" as const };

type Row = ReturnType<typeof templateStatement>;
function lexical(rows: readonly Row[]): SourceIndexLexicalRead {
  return { completion: "complete", reason: null,
    candidates: rows.map((row, i) => ({ source: row.source, lexical: { lane: "unicode61", rank: i + 1, lane_rank: i + 1, bm25: -1 } })),
    resources: empty, resource_refusal: null, index_coverage: "partial", limitations: [], tokenization: null };
}

function fixture(rows: readonly Row[]) {
  const repository: SourceIndexQueryRepository = {
    readLexicalCandidates: () => lexical(rows),
    readVectorCandidates: () => ({ completion: "complete", reason: null, candidates: [], resources: empty,
      state: { status: "unavailable", reason: "fixture" }, resource_refusal: null, cursor: null, inspected: 0, invalid: 0 }),
    admitQueryCandidate: () => ({ status: "ready", scope_class: "project", resources: empty })
  };
  const input: SourceIndexAcquisitionInput = { workspace_id: "workspace-template", navigation_text: "game",
    vector: { status: "unavailable", reason: "fixture" }, allowance: { max_attempts: 128, max_roots: 16, max_vector_windows: 0 },
    budget: templateBudget };
  return { repository, input, run: (members: number, view: "original" | "hint" = "original") =>
    new SourceIndexAcquisition(repository, fieldSha256)
      .nominateWithWitness(input, () => "admitted", view, undefined, undefined, undefined, undefined, members) };
}

it("lists roots refused only by the root limit, in attempt order, without changing the nominated prefix or its resources", () => {
  const rows = Array.from({ length: 24 }, (_, i) => templateStatement(`root-${i}`));
  const { run } = fixture(rows);
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
  const { run } = fixture([...rows, rows[20]!, rows[3]!]);
  expect(run(3).index_members).toEqual(rows.slice(16, 19).map(row => row.source));
  expect(run(16).index_members).toEqual(rows.slice(16).map(row => row.source));
  expect(run(16, "hint")).not.toHaveProperty("index_members");
});

it.each([
  { maxAttempts: 128, tailLength: 1, tailOverBudget: false },
  { maxAttempts: 32, tailLength: 0, tailOverBudget: false },
  { maxAttempts: 128, tailLength: 0, tailOverBudget: true }
])("lists displaced originals before the unrestricted tail (attempts=$maxAttempts, listing exhausted=$tailOverBudget)",
  ({ maxAttempts, tailLength, tailOverBudget }) => {
    const original = Array.from({ length: 24 }, (_, i) => templateStatement(`original-${i}`));
    const preferred = Array.from({ length: 16 }, (_, i) => templateStatement(`preferred-${i}`));
    const base = fixture(original);
    const admit = vi.fn<SourceIndexQueryRepository["admitQueryCandidate"]>(source => ({
      status: "ready", scope_class: "project",
      resources: tailOverBudget && source === original[16]!.source ? { ...empty, work: 524_288 } : empty
    }));
    const repository: SourceIndexQueryRepository = {
      ...base.repository,
      readLexicalCandidates: (_workspace, _query, limit, _budget, time) => lexical((time ? preferred : original).slice(0, limit)),
      readQuestionTimeDomain: () => ({ status: "ready", exists: true, matched_root_keys: [], resources: empty }),
      readTemplateStatements: source => source === original[0]!.source ? original[0]!.read
        : { status: "complete", statements: [], resources: empty },
      admitQueryCandidate: admit
    };
    const run = (count: number) => {
      const observed: SourceIndexAcquisitionFact[] = [];
      const capture = new SourceIndexAcquisition(repository, fieldSha256).nominateWithWitness({
        ...base.input, allowance: { ...base.input.allowance, max_attempts: maxAttempts }, source_template: template,
        question_time: { interpretation_clock: template.interpretation_clock,
          intervals: [{ start: "2026-09-01", end: "2026-09-06" }] }
      }, () => "admitted", "original", fact => { observed.push(fact()); },
      { status: "ready", vectors: [Float32Array.of(1)], conditions: [{ statement: "s", speaker: "user", anchors: [] }] },
      { retain: (result, meter) => {
        const before = meter.spentBytes;
        meter.retain(result);
        return meter.spentBytes - before;
      } }, undefined, count);
      return { capture, observed };
    };
    const unlisted = run(0);
    expect(admit).toHaveBeenCalledTimes(32);
    admit.mockClear();
    const listed = run(16);
    const { index_members, ...ranked } = listed.capture;
    expect(ranked).toEqual(unlisted.capture);
    expect(listed.observed).toEqual(unlisted.observed);
    expect(ranked.result.nominations.map(row => row.source)).toEqual([
      original[0]!.source, ...preferred.slice(0, 15).map(row => row.source)
    ]);
    expect(index_members).toEqual(original.slice(1, 16 + tailLength).map(row => row.source));
    expect(admit.mock.calls.slice(32).map(([source]) => source)).toEqual(
      maxAttempts === 32 ? [] : [original[16]!.source]);
  });
