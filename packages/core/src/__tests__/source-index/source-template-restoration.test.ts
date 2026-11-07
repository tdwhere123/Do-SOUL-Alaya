import { describe, expect, it, vi } from "vitest";
import { SourceSemanticResourceExhausted, sourceIndexNativeRootKey,
  type SourceIndexAcquisitionInput, type SourceIndexLexicalRead, type SourceIndexQueryRepository,
  type SourceIndexTarget, type SourceIndexTemplateRead } from "@do-soul/alaya-protocol";
import { SourceIndexAcquisition } from "../../source-index/source-index-acquisition.js";
import type { SourceIndexAcquisitionFact } from "../../source-index/acquisition-observation.js";
import type { SourcePreferenceRetention } from "../../source-index/question-time-preference.js";
import { fieldSha256 } from "../../../../storage/src/__tests__/repos/source-index/source-index-fixture.js";
import { readResources, template, templateBudget, templateStatement } from "./source-template-fixture.js";

const emptyResources = { work: 0, memory_bytes: 0, native_bytes: 0, sql_internal_work: "unknown" as const };
function fixture() {
  const original = Array.from({ length: 16 }, (_, i) => templateStatement(`original-${i}`));
  const preferred = Array.from({ length: 16 }, (_, i) => templateStatement(`preferred-${i}`));
  const readTemplateStatements = vi.fn<(source: SourceIndexTarget) => SourceIndexTemplateRead>(source => ({
    status: "complete", statements: source.root_key === original[0]!.source.root_key ? [original[0]!.statement] : [], resources: readResources
  }));
  const lexical = (rows: typeof original): SourceIndexLexicalRead => ({ completion: "complete", reason: null,
    candidates: rows.map((row, i) => ({ source: row.source, lexical: { lane: "unicode61", rank: i + 1,
      lane_rank: i + 1, bm25: -1 } })), resources: emptyResources, resource_refusal: null,
    index_coverage: "partial", limitations: [], tokenization: null });
  const repository: SourceIndexQueryRepository = {
    readLexicalCandidates: (_workspace, _query, _limit, _budget, preference) => lexical(preference === undefined ? original : preferred),
    readQuestionTimeDomain: () => ({ status: "ready", exists: true, matched_root_keys: [], resources: emptyResources }),
    readTemplateStatements,
    readVectorCandidates: () => ({ completion: "complete", reason: null, candidates: [], resources: emptyResources,
      state: { status: "unavailable", reason: "fixture" }, resource_refusal: null, cursor: null, inspected: 0, invalid: 0 }),
    admitQueryCandidate: () => ({ status: "ready", scope_class: "project", resources: emptyResources })
  };
  const input: SourceIndexAcquisitionInput = { workspace_id: "workspace-template", navigation_text: "game",
    vector: { status: "unavailable", reason: "fixture" }, allowance: { max_attempts: 128, max_roots: 16, max_vector_windows: 0 },
    budget: templateBudget, question_time: { interpretation_clock: template.interpretation_clock,
      intervals: [{ start: "2026-09-01", end: "2026-09-06" }] } };
  const observed: SourceIndexAcquisitionFact[] = [];
  const retain = vi.fn<SourcePreferenceRetention["retain"]>((capture, meter) => {
    const before = meter.spentBytes; meter.retain(capture, "fixture actual nomination retention"); return meter.spentBytes - before;
  });
  const run = (options: { proposed?: boolean; retention?: SourcePreferenceRetention; budget?: typeof templateBudget } = {}) =>
    new SourceIndexAcquisition(repository, fieldSha256).nominateWithWitness({ ...input, ...(options.budget ? { budget: options.budget } : {}),
      ...(options.proposed === false ? {} : { source_template: template }) }, () => "admitted", "original",
    capture => { observed.push(capture()); }, true, options.retention ?? { retain });
  return { original, preferred, readTemplateStatements, observed, retain, run };
}

describe("funded source-template restoration", () => {
  it("restores only a unique original displaced root, keeps the cap and finalizes association once over the chosen roots", () => {
    const env = fixture(), result = env.run(), ids = result.result.nominations.map(row => row.source.source_id);
    expect(ids).toEqual(["original-0", ...Array.from({ length: 15 }, (_, i) => `preferred-${i}`)]);
    expect(result.result.accounting).toMatchObject({ attempted: 32, admitted: 16 });
    expect(result.witness.map(row => row.source.source_id)).toEqual(ids);
    expect(result.question_time_order).toEqual(result.result.nominations.map(row => sourceIndexNativeRootKey(row.source)));
    expect(result.association?.roots).toEqual(result.question_time_order);
    expect(env.readTemplateStatements).toHaveBeenCalledTimes(16);
    expect(env.retain).toHaveBeenCalledTimes(2);
    expect(result.prepaid_base_bytes).toBeGreaterThan(0);
    expect(env.observed).toContainEqual(expect.objectContaining({ kind: "source_template_restoration",
      observation: expect.objectContaining({ status: "unique", inspected_roots: 16, restored: true }) }));
  });

  it("preserves the paid incumbent after a later unknown root and records all native charges", () => {
    const env = fixture();
    env.readTemplateStatements.mockImplementation(source => source.root_key === env.original[15]!.source.root_key
      ? { status: "unknown", reason: "stale", resources: readResources }
      : { status: "complete", statements: source.root_key === env.original[0]!.source.root_key
        ? [env.original[0]!.statement] : [], resources: readResources });
    const result = env.run();
    expect(result.result.nominations.map(row => row.source.source_id)).toEqual(env.preferred.map(row => row.source.source_id));
    expect(env.retain).toHaveBeenCalledTimes(1);
    expect(env.readTemplateStatements).toHaveBeenCalledTimes(16);
    expect(result.result.resources.native_bytes).toBe(16 * readResources.native_bytes);
    expect(result.association?.roots).toHaveLength(16);
    expect(env.observed).toContainEqual(expect.objectContaining({ kind: "source_template_restoration",
      observation: expect.objectContaining({ status: "unknown", restored: false, reason: "stale" }) }));
  });

  it("cannot mutate membership when replacement retention fails after spending part of its child allowance", () => {
    const env = fixture();
    env.retain.mockImplementationOnce((capture, meter) => {
      const before = meter.spentBytes; meter.retain(capture); return meter.spentBytes - before;
    }).mockImplementationOnce((_capture, meter) => {
      meter.charge(11, 123, "fixture partial replacement");
      throw new SourceSemanticResourceExhausted("fixture replacement refusal");
    });
    const result = env.run();
    expect(env.retain).toHaveBeenCalledTimes(2);
    expect(result.result.nominations.map(row => row.source.source_id)).toEqual(env.preferred.map(row => row.source.source_id));
    expect(result.association?.roots).toHaveLength(16);
    expect(result.result.resources.work).toBeGreaterThan(11);
    expect(env.observed).toContainEqual(expect.objectContaining({ kind: "source_template_restoration",
      observation: expect.objectContaining({ status: "unknown", restored: false, reason: "fixture replacement refusal" }) }));
  });

  it("does not inspect excluded source roots and does not activate without an explicit proposal", () => {
    const env = fixture(), baseline = env.run({ proposed: false });
    expect(env.readTemplateStatements).not.toHaveBeenCalled();
    expect(env.retain).not.toHaveBeenCalled();
    expect(baseline.prepaid_base_bytes).toBeUndefined();
    const restricted = env.run({ retention: { retain: env.retain, source_id: "original-1" } });
    expect(env.readTemplateStatements.mock.calls.map(([source]) => source.source_id)).toEqual(["original-1"]);
    expect(restricted.result.nominations).toEqual(baseline.result.nominations);
  });

  it("protects final association when only the mandatory incumbent can fit", () => {
    const env = fixture(), baseline = env.run({ proposed: false });
    env.readTemplateStatements.mockReturnValue({ status: "complete", statements: [], resources: readResources });
    const measured = env.run();
    env.readTemplateStatements.mockClear();
    const bounded = env.run({ budget: { work_units: templateBudget.work_units,
      memory_bytes: baseline.result.resources.memory_bytes + measured.prepaid_base_bytes! + 1024 } });
    expect(env.readTemplateStatements).not.toHaveBeenCalled();
    expect(bounded.result.nominations).toEqual(baseline.result.nominations);
    expect(bounded.association).toEqual(baseline.association);
    expect(bounded.result.resources.memory_bytes).toBeLessThanOrEqual(
      baseline.result.resources.memory_bytes + measured.prepaid_base_bytes! + 1024);
    expect(env.observed.at(-2)).toMatchObject({ kind: "source_template_restoration",
      observation: { status: "unknown", restored: false } });
  });
});
