import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import(
    "../../../../../apps/bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
import { createHash } from "node:crypto";
import {
  sourceIndexTarget, sourceRecallTarget, type SourceIndexLexicalRead, type SourceIndexQueryAdmission,
  type SourceIndexQueryRepository, type SourceIndexQueryResources, type SourceIndexVectorBinding,
  type SourceIndexVectorRead
} from "@do-soul/alaya-protocol";
import { SourceIndexAcquisition } from "../../source-index/source-index-acquisition.js";
import { fieldSha256, fixture, type Fixture } from "../../../../storage/src/__tests__/repos/source-index/source-index-fixture.js";
import {
  AXIS_ROOTS, admitScope, expectBounded, publishIndex, query, queryInput
} from "./source-index-acquisition-fixture.js";

const UNKNOWN_COST = "acquisition_failed_unknown_additional_cost";
const ZERO_RESOURCES: SourceIndexQueryResources = {
  work: 0, memory_bytes: 0, native_bytes: 0, sql_internal_work: "unknown"
};
const environments: Fixture[] = [];
afterEach(() => {
  expect(isolation.violations).toEqual([]);
  vi.restoreAllMocks();
  for (const environment of environments.splice(0)) environment.database.close();
});
afterAll(() => { isolation.restore(); });

function setup() {
  const environment = fixture();
  environments.push(environment);
  return environment;
}
function digest(label: string) {
  return `sha256:${createHash("sha256").update(label, "utf8").digest("hex")}`;
}
function target(id: string) {
  return sourceIndexTarget(sourceRecallTarget({
    workspace_id: "workspace-1", root_kind: "source_record", root_id: `record-${id}`,
    source_version: "1", content_digest: digest(id), evidence_object_id: null
  }), id, 8);
}
function lexicalRead(changes: Partial<SourceIndexLexicalRead> = {}): SourceIndexLexicalRead {
  return { candidates: [], completion: "complete", reason: null, resources: ZERO_RESOURCES, tokenization: null,
    resource_refusal: null, index_coverage: "partial", limitations: [], ...changes };
}
function repository(impl: Partial<SourceIndexQueryRepository>): SourceIndexQueryRepository {
  return {
    readLexicalCandidates: impl.readLexicalCandidates ?? (() => lexicalRead()),
    readVectorCandidates: impl.readVectorCandidates ?? (() => { throw new Error("unexpected vector read"); }),
    admitQueryCandidate: impl.admitQueryCandidate ?? (() => { throw new Error("unexpected admission"); })
  };
}
function acquire(impl: Partial<SourceIndexQueryRepository>, input = queryInput(), scope = admitScope) {
  return new SourceIndexAcquisition(repository(impl), fieldSha256).nominate(input, scope);
}
function unavailableInput() {
  return { ...queryInput(), vector: { status: "unavailable" as const, reason: "not_requested" } };
}
function expectUnknown(result: ReturnType<typeof acquire>, stage: "lexical" | "vector" | "admission") {
  expect(result.resource_refusals).toEqual(expect.arrayContaining([{ stage, phase: UNKNOWN_COST }]));
  expect(result.completion).toBe("partial");
  expect(result.completion).not.toBe("complete");
  expect(result.completion).not.toBe("unavailable");
  expect(result.limitations).toContain("nominations_are_not_source_absence");
  expect(result.resources.sql_internal_work).toBe("unknown");
}

describe("native SQLite reads then injected repository/admission failure", () => {
  it("retains completed lexical debits when a later native vector read throws", () => {
    const environment = setup();
    publishIndex(environment);
    const read = environment.index.readLexicalCandidates.bind(environment.index);
    const scan = environment.index.readVectorCandidates.bind(environment.index);
    let lexicalResources: SourceIndexQueryResources | undefined;
    vi.spyOn(environment.index, "readLexicalCandidates").mockImplementation((...args) => {
      const page = read(...args);
      lexicalResources = page.resources;
      return page;
    });
    vi.spyOn(environment.index, "readVectorCandidates").mockImplementation((...args) => {
      scan(...args);
      throw new Error("vector repository failed");
    });
    const input = queryInput();
    const result = query(environment, input, admitScope);
    expect(lexicalResources).toBeDefined();
    expectUnknown(result, "vector");
    expect(result.lexical.completion).toBe("complete");
    expect(result.lexical.completion).not.toBe("unavailable");
    expect(result.vector.completion).toBe("not_run");
    expect(result.vector.completion).not.toBe("unavailable");
    expect(result.nominations).toEqual([]);
    expect(result.accounting.native_unknown).toBe(0);
    expect(result.resources.native_bytes).toBe(lexicalResources!.native_bytes);
    expect(result.resources.work).toBeGreaterThan(lexicalResources!.work);
    expect(result.resources.memory_bytes).toBeGreaterThanOrEqual(result.resources.native_bytes);
    expectBounded(result, input);
  });

  it("retains an earlier native admission when a later repository admit throws", () => {
    const environment = setup();
    publishIndex(environment, [AXIS_ROOTS[0]!, AXIS_ROOTS[1]!]);
    const admit = environment.index.admitQueryCandidate.bind(environment.index);
    const firstResources: SourceIndexQueryResources[] = [];
    const admitSpy = vi.spyOn(environment.index, "admitQueryCandidate").mockImplementation((...args) => {
      const outcome = admit(...args);
      if (firstResources.length === 0) {
        firstResources.push(outcome.resources);
        return outcome;
      }
      throw new Error("admission repository failed");
    });
    const input = { ...queryInput(), vector: { status: "unavailable" as const, reason: "not_requested" } };
    const result = query(environment, input, admitScope);
    expect(admitSpy).toHaveBeenCalledTimes(2);
    expectUnknown(result, "admission");
    expect(result.nominations).toHaveLength(1);
    expect([AXIS_ROOTS[0]!.id, AXIS_ROOTS[1]!.id]).toContain(result.nominations[0]!.source.source_id);
    expect(result.accounting.admitted).toBe(1);
    expect(result.accounting.native_unknown).toBe(0);
    expect(result.resources.native_bytes).toBeGreaterThan(0);
    expect(result.resources.native_bytes).toBeGreaterThanOrEqual(firstResources[0]!.native_bytes);
    expect(result.resources.work).toBeGreaterThan(firstResources[0]!.work);
    expect(result.accounting.attempted).toBe(
      result.accounting.admitted + result.accounting.duplicate + result.accounting.rejected);
    expectBounded(result, input);
  });

  it("retains a completed native admission when a later scope callback throws", () => {
    const environment = setup();
    publishIndex(environment, [AXIS_ROOTS[0]!, AXIS_ROOTS[1]!]);
    const input = { ...queryInput(), vector: { status: "unavailable" as const, reason: "not_requested" } };
    let remaining = 1;
    const result = query(environment, input, () => {
      if (remaining-- > 0) return "admitted";
      throw new Error("scope admission failed");
    });
    expectUnknown(result, "admission");
    expect(result.nominations).toHaveLength(1);
    expect(result.accounting.admitted).toBe(1);
    expect(result.accounting.native_unknown).toBe(0);
    expect(result.resources.native_bytes).toBeGreaterThan(0);
    expect(result.accounting.attempted).toBe(
      result.accounting.admitted + result.accounting.duplicate + result.accounting.rejected);
    expectBounded(result, input);
  });
});

describe("simulated query repository failures, not native error-boundary evidence", () => {
  it("keeps input-stage costs and does not report lexical absence when the first repository read throws", () => {
    const input = unavailableInput();
    const control = acquire({
      readLexicalCandidates: () => lexicalRead(),
      readVectorCandidates: () => { throw new Error("vector should not run"); },
      admitQueryCandidate: () => { throw new Error("admit should not run"); }
    }, input);
    const failed = acquire({
      readLexicalCandidates: () => { throw new Error("lexical repository failed"); }
    }, input);
    expectUnknown(failed, "lexical");
    expect(failed.lexical.completion).toBe("not_run");
    expect(failed.lexical.completion).not.toBe("unavailable");
    expect(failed.vector.completion).toBe("unavailable");
    expect(failed.nominations).toEqual([]);
    expect(failed.resources.native_bytes).toBe(0);
    expect(failed.resources.work).toBe(control.resources.work);
    expect(failed.resources.memory_bytes).toBe(control.resources.memory_bytes);
    expect(control.resource_refusals).toEqual([]);
    expect(control.lexical.completion).toBe("complete");
    expectBounded(failed, input);
  });

  it("retains a completed vector page debit when a later page throw leaves extra cost unknown", () => {
    const input = queryInput();
    if (input.vector.status !== "available") throw new Error("expected available query vector");
    const binding: SourceIndexVectorBinding = {
      workspace_id: "workspace-1", selection_revision: 1, config_id: digest("config"),
      profile_id: input.vector.profile_id, generation_id: digest("generation"), source_epoch: 1, dimensions: 3
    };
    const page: SourceIndexVectorRead = {
      candidates: [{ source: target("vector-a"), window: { window_id: digest("window"), start_byte: 0, end_byte: 8,
        content_digest: digest("window-body") }, embedding: new Float32Array([1, 0, 0]) }],
      completion: "partial", reason: "window_page_limit", resources: { work: 9, memory_bytes: 40, native_bytes: 15,
        sql_internal_work: "unknown" }, state: { status: "ready", binding }, resource_refusal: null,
      cursor: { binding, after_window_id: digest("window") }, inspected: 1, invalid: 0
    };
    const lexical = lexicalRead({ resources: { work: 5, memory_bytes: 8, native_bytes: 6, sql_internal_work: "unknown" } });
    let pages = 0;
    const result = acquire({
      readLexicalCandidates: () => lexical,
      readVectorCandidates: () => {
        if (++pages === 1) return page;
        throw new Error("vector page failed");
      }
    }, input);
    expectUnknown(result, "vector");
    expect(pages).toBe(2);
    expect(result.lexical.completion).toBe("complete");
    expect(result.vector.inspected_windows).toBe(1);
    expect(result.vector.completion).not.toBe("complete");
    expect(result.vector.completion).not.toBe("unavailable");
    expect(result.nominations).toEqual([]);
    expect(result.resources.native_bytes).toBe(lexical.resources.native_bytes + page.resources.native_bytes);
    expect(result.resources.work).toBeGreaterThan(lexical.resources.work + page.resources.work);
    expectBounded(result, input);
  });

  it("retains an earlier simulated admission and known native bytes when a later admit throws", () => {
    const input = unavailableInput();
    const first = target("first"), second = target("second");
    const lexical = lexicalRead({
      candidates: [
        { source: first, lexical: { rank: 1, lane: "unicode61", lane_rank: 1, bm25: 1.4 } },
        { source: second, lexical: { rank: 2, lane: "unicode61", lane_rank: 2, bm25: 1.1 } }
      ],
      resources: { work: 4, memory_bytes: 16, native_bytes: 12, sql_internal_work: "unknown" }
    });
    const ready: SourceIndexQueryAdmission = {
      status: "ready", scope_class: "project",
      resources: { work: 3, memory_bytes: 6, native_bytes: 8, sql_internal_work: "unknown" }
    };
    const control = acquire({
      readLexicalCandidates: () => lexicalRead({
        candidates: lexical.candidates.slice(0, 1), resources: lexical.resources
      }),
      admitQueryCandidate: () => ready
    }, input);
    let admits = 0;
    const failed = acquire({
      readLexicalCandidates: () => lexical,
      admitQueryCandidate: () => {
        if (++admits === 1) return ready;
        throw new Error("admission repository failed");
      }
    }, input);
    expectUnknown(failed, "admission");
    expect(failed.nominations.map(row => row.source.source_id)).toEqual(["first"]);
    expect(failed.accounting.admitted).toBe(1);
    expect(failed.accounting.native_unknown).toBe(0);
    expect(failed.resources.native_bytes).toBe(control.resources.native_bytes);
    expect(failed.resources.work).toBeGreaterThan(control.resources.work);
    expect(failed.accounting.attempted).toBe(
      failed.accounting.admitted + failed.accounting.duplicate + failed.accounting.rejected);
    expectBounded(failed, input);
  });
});
