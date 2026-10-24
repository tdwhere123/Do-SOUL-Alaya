import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import(
    "../../../../../apps/bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
import {
  sourceIndexProfileId, SourceSemanticResourceExhausted, SourceSemanticResourceLedger,
  type SourceIndexAcquisitionInput, type SourceIndexQueryRepository, type SourceIndexQueryResources
} from "@do-soul/alaya-protocol";
import { SourceIndexAcquisition } from "../../source-index/source-index-acquisition.js";
import { configuration, fieldSha256, fixture, type Fixture }
  from "../../../../storage/src/__tests__/repos/source-index/source-index-fixture.js";
import {
  admitScope, digest, expectBounded, NAVIGATION, publishIndex, query, queryInput
} from "./source-index-acquisition-fixture.js";

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

function emptyRepository(): SourceIndexQueryRepository {
  return {
    readLexicalCandidates: () => ({ candidates: [], completion: "complete", reason: null, resources: ZERO_RESOURCES,
      tokenization: null, resource_refusal: null, index_coverage: "partial", limitations: [] }),
    readVectorCandidates: () => { throw new Error("unexpected vector read"); },
    admitQueryCandidate: () => { throw new Error("unexpected admission"); }
  };
}
function inputCapture(changes: Partial<SourceIndexAcquisitionInput> = {}): SourceIndexAcquisitionInput {
  return queryInput(configuration(), { allowance: { max_attempts: 2, max_roots: 2, max_vector_windows: 0 }, ...changes });
}
function availableAt(dimensions: number): SourceIndexAcquisitionInput {
  const config = configuration({ dimensions });
  const embedding = new Float32Array(dimensions);
  embedding[0] = 1;
  return inputCapture({ vector: { status: "available", profile: config.profile,
    profile_id: sourceIndexProfileId(config.profile, fieldSha256),
    input_digest: digest(NAVIGATION), embedding } });
}
function quoteOf(input: SourceIndexAcquisitionInput, planner?: SourceSemanticResourceLedger) {
  return SourceIndexAcquisition.quoteEnvelopeAndInputCapture({
    navigation: input.navigation_text, vector: input.vector, max_roots: input.allowance.max_roots
  }, input.budget, planner);
}
function execute(input: SourceIndexAcquisitionInput, scope = admitScope) {
  return new SourceIndexAcquisition(emptyRepository(), fieldSha256).nominate(input, scope);
}

it("quotes unavailable and available input capture against admitted execution without treating discovery as the same debit", () => {
  const unavailable = inputCapture({ vector: { status: "unavailable", reason: "not_requested" } });
  const available = inputCapture();
  const unavailableQuote = quoteOf(unavailable);
  const availableQuote = quoteOf(available);
  const unavailableRun = execute(unavailable);
  const availableRun = execute(available);
  expectBounded(unavailableRun, unavailable);
  expectBounded(availableRun, available);
  expect(unavailableRun.resources).toEqual({ work: unavailableQuote.work_units,
    memory_bytes: unavailableQuote.memory_bytes, native_bytes: 0, sql_internal_work: "unknown" });
  expect(availableRun.resources).toEqual({ work: availableQuote.work_units,
    memory_bytes: availableQuote.memory_bytes, native_bytes: 0, sql_internal_work: "unknown" });
  expect(availableQuote.work_units).toBeGreaterThan(unavailableQuote.work_units);
  expect(availableQuote.memory_bytes).toBeGreaterThan(unavailableQuote.memory_bytes);
  expect(unavailableRun.vector.input.status).toBe("unavailable");
  expect(availableRun.vector.validation).toBe("validated");
  expect(unavailableRun.completion).not.toBe("complete");
  expect(availableRun.completion).not.toBe("complete");

  const environment = fixture();
  environments.push(environment);
  publishIndex(environment);
  const discovered = query(environment, queryInput(), admitScope);
  const discoveredQuote = quoteOf(queryInput());
  expectBounded(discovered, queryInput());
  expect(discovered.resources.work).toBeGreaterThan(discoveredQuote.work_units);
  expect(discovered.resources.memory_bytes).toBeGreaterThan(discoveredQuote.memory_bytes);
  expect(discovered.resources.sql_internal_work).toBe("unknown");
  expect(discovered.resources.work).toBeLessThanOrEqual(queryInput().budget.work_units);
});

it("accounts navigation by text length, not UTF-8 bytes, and scales envelope bytes with max_roots", () => {
  const utf8 = "港湾";
  const ascii = "ab";
  expect(Buffer.byteLength(utf8, "utf8")).toBeGreaterThan(utf8.length);
  expect(utf8.length).toBe(ascii.length);
  const unavailable = { status: "unavailable" as const, reason: "not_requested" };
  const utf8Input = inputCapture({ navigation_text: utf8, vector: unavailable });
  const asciiInput = inputCapture({ navigation_text: ascii, vector: unavailable });
  expect(quoteOf(utf8Input)).toEqual(quoteOf(asciiInput));
  expect(execute(utf8Input).resources.work).toBe(quoteOf(utf8Input).work_units);
  const longer = inputCapture({ navigation_text: "abcd", vector: unavailable });
  expect(quoteOf(longer).work_units - quoteOf(asciiInput).work_units).toBe("abcd".length - ascii.length);
  const tight = inputCapture({ vector: unavailable, allowance: { max_attempts: 2, max_roots: 1, max_vector_windows: 0 } });
  const wide = inputCapture({ vector: unavailable, allowance: { max_attempts: 16, max_roots: 16, max_vector_windows: 0 } });
  expect(quoteOf(wide).work_units).toBe(quoteOf(tight).work_units);
  expect(quoteOf(wide).memory_bytes - quoteOf(tight).memory_bytes).toBe(8 * 15);
  expect(quoteOf(availableAt(128)).work_units - quoteOf(availableAt(1)).work_units).toBe(3 * 127);
  expect(quoteOf(availableAt(128)).memory_bytes - quoteOf(availableAt(1)).memory_bytes).toBe(4 * 127);
  const eight = availableAt(8), eightQuote = quoteOf(eight);
  expect(execute(eight).resources).toEqual({ work: eightQuote.work_units,
    memory_bytes: eightQuote.memory_bytes, native_bytes: 0, sql_internal_work: "unknown" });
  expect(execute(eight).vector.validation).toBe("validated");
});

it("quotes zero-dimension available capture separately from executed invalid-profile spend", () => {
  const profile = { ...configuration().profile, dimensions: 0 };
  const input = inputCapture({ vector: { status: "available", profile, profile_id: `sha256:${"c".repeat(64)}`,
    input_digest: digest(NAVIGATION), embedding: new Float32Array() } });
  const quoted = quoteOf(input);
  const executed = execute(input);
  expect(executed.vector).toMatchObject({ completion: "unavailable", reason: "invalid_profile", validation: "invalid" });
  expect(executed.completion).not.toBe("complete");
  expect(quoted.work_units).toBe(executed.resources.work + 1);
  expect(quoted.memory_bytes).toBe(executed.resources.memory_bytes + 256);
  expect(executed.resources.sql_internal_work).toBe("unknown");
});

it("keeps planning retain expenditure distinct from the returned quotation and refuses one-byte-short admission", () => {
  const input = inputCapture();
  const quoted = quoteOf(input);
  const planner = new SourceSemanticResourceLedger(input.budget);
  expect(quoteOf(input, planner)).toEqual(quoted);
  expect(planner.spentWork).toBeGreaterThan(0);
  expect(planner.spentBytes).toBeGreaterThan(0);
  expect(planner.spentWork).toBeLessThan(quoted.work_units);
  expect(planner.spentBytes).toBeLessThan(quoted.memory_bytes);
  const short = execute({ ...input, budget: { work_units: quoted.work_units, memory_bytes: quoted.memory_bytes - 1 } });
  expect(short.completion).not.toBe("complete");
  expect(short.resource_refusals).toEqual(expect.arrayContaining([{ stage: "input", phase: expect.any(String) }]));
  expect(short.resources.work).toBeLessThan(quoted.work_units);
  expect(short.resources.sql_internal_work).toBe("unknown");
  expect(short.nominations).toEqual([]);
  expect(() => quoteOf(input, new SourceSemanticResourceLedger({ work_units: 0, memory_bytes: 0 })))
    .toThrow(SourceSemanticResourceExhausted);
});
