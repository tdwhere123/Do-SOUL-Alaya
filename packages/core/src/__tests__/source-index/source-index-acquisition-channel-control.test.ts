import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import(
    "../../../../../apps/bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); vi.restoreAllMocks(); });
afterAll(() => { isolation.restore(); });
import { unavailableSourceQueryPreparation, type SourceIndexQueryRepository } from "@do-soul/alaya-protocol";
import { SourceIndexAcquisition } from "../../source-index/source-index-acquisition.js";
import { fieldSha256 } from "../../../../storage/src/__tests__/repos/source-index/source-index-fixture.js";
import { admitScope, queryInput } from "./source-index-acquisition-fixture.js";

function repository(impl: Partial<SourceIndexQueryRepository>): SourceIndexQueryRepository {
  return {
    readLexicalCandidates: impl.readLexicalCandidates ?? (() => { throw new Error("unexpected lexical read"); }),
    readVectorCandidates: impl.readVectorCandidates ?? (() => { throw new Error("unexpected vector read"); }),
    admitQueryCandidate: impl.admitQueryCandidate ?? (() => { throw new Error("unexpected admission"); })
  };
}
function acquire(impl: Partial<SourceIndexQueryRepository>, control?: "lexical" | "vector" | "dual",
  input = queryInput()) {
  return new SourceIndexAcquisition(repository(impl), fieldSha256).nominate(input, admitScope, control);
}

it("omitted control still reads both channels", () => {
  const lexical = vi.fn(() => ({ candidates: [], completion: "complete" as const, reason: null,
    resources: { work: 0, memory_bytes: 0, native_bytes: 0, sql_internal_work: "unknown" as const },
    tokenization: null, resource_refusal: null, index_coverage: "partial" as const, limitations: [] }));
  const vector = vi.fn(() => ({ candidates: [], completion: "complete" as const, reason: null,
    resources: { work: 0, memory_bytes: 0, native_bytes: 0, sql_internal_work: "unknown" as const },
    state: { status: "unavailable" as const, reason: "no_windows" }, resource_refusal: null,
    cursor: null, inspected: 0, invalid: 0 }));
  const result = acquire({ readLexicalCandidates: lexical, readVectorCandidates: vector });
  expect(lexical).toHaveBeenCalledTimes(1);
  expect(vector).toHaveBeenCalledTimes(1);
  expect(result.lexical.completion).toBe("complete");
});

it("lexical control skips vector SQL and keeps not_run rather than unavailable", () => {
  const lexical = vi.fn(() => ({ candidates: [], completion: "complete" as const, reason: null,
    resources: { work: 0, memory_bytes: 0, native_bytes: 0, sql_internal_work: "unknown" as const },
    tokenization: null, resource_refusal: null, index_coverage: "partial" as const, limitations: [] }));
  const vector = vi.fn(() => { throw new Error("vector SQL must not run"); });
  const result = acquire({ readLexicalCandidates: lexical, readVectorCandidates: vector }, "lexical",
    { ...queryInput(), vector: { status: "unavailable", reason: SourceIndexAcquisition.channelNotRequested } });
  expect(lexical).toHaveBeenCalledTimes(1);
  expect(vector).not.toHaveBeenCalled();
  expect(result.vector.completion).toBe("not_run");
  expect(result.vector.completion).not.toBe("unavailable");
  expect(result.vector.reason).toBe(SourceIndexAcquisition.channelNotRequested);
  expect(result.lexical.completion).toBe("complete");
});

it("vector control skips lexical SQL and keeps not_run rather than read_budget", () => {
  const lexical = vi.fn(() => { throw new Error("lexical SQL must not run"); });
  const vector = vi.fn(() => ({ candidates: [], completion: "complete" as const, reason: null,
    resources: { work: 0, memory_bytes: 0, native_bytes: 0, sql_internal_work: "unknown" as const },
    state: { status: "unavailable" as const, reason: "no_windows" }, resource_refusal: null,
    cursor: null, inspected: 0, invalid: 0 }));
  const result = acquire({ readLexicalCandidates: lexical, readVectorCandidates: vector }, "vector");
  expect(vector).toHaveBeenCalledTimes(1);
  expect(lexical).not.toHaveBeenCalled();
  expect(result.lexical.completion).toBe("not_run");
  expect(result.lexical.reason).toBe(SourceIndexAcquisition.channelNotRequested);
  expect(result.lexical.reason).not.toBe("read_budget");
});

it("rejects a lexical control that carries an embedding", () => {
  expect(() => acquire({
    readLexicalCandidates: () => { throw new Error("must not read"); }
  }, "lexical", queryInput())).toThrow(/cannot carry a query embedding/);
});

it("rejects vector control without a prepared embedding", () => {
  expect(() => acquire({
    readLexicalCandidates: () => { throw new Error("must not read"); }
  }, "vector", { ...queryInput(), vector: { status: "unavailable", reason: "not_requested" } }))
    .toThrow(/requires a prepared query vector/);
});

it("does not rewrite an omitted unavailable vector into a disabled channel", () => {
  const lexical = vi.fn(() => ({ candidates: [], completion: "complete" as const, reason: null,
    resources: { work: 0, memory_bytes: 0, native_bytes: 0, sql_internal_work: "unknown" as const },
    tokenization: null, resource_refusal: null, index_coverage: "partial" as const, limitations: [] }));
  const result = acquire({ readLexicalCandidates: lexical, readVectorCandidates: () => {
    throw new Error("vector SQL must not run for unavailable input");
  } }, undefined, { ...queryInput(), vector: { status: "unavailable", reason: "not_requested" } });
  expect(result.vector.completion).toBe("unavailable");
  expect(result.vector.completion).not.toBe("not_run");
  expect(result.vector.reason).toBe("not_requested");
});

it("rejects worker lexical control that is missing not_requested preparation", () => {
  expect(() => SourceIndexAcquisition.assertControl({
    control: "lexical",
    vector: { status: "unavailable", reason: SourceIndexAcquisition.channelNotRequested },
    receipt: unavailableSourceQueryPreparation("preparation_scope_unavailable"),
    navigation: "needle",
    request: { kind: "recall", original_query: "needle" }
  })).toThrow(/not_requested preparation/);
});
