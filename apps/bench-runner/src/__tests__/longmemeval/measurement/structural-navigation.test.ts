import { afterAll, expect, it, vi } from "vitest";
const boundary = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  const { installStrictProviderFreeBoundary } = await import("../../support/strict-provider-free-boundary.js");
  return { safe: installProviderFreeBoundary(), strict: installStrictProviderFreeBoundary() };
});
afterAll(() => {
  expect(boundary.safe.violations).toEqual([]); expect(boundary.strict.forbidden).toEqual([]);
  boundary.strict.restore(); boundary.safe.restore();
});
import { observeSessionAdjacency, StructuralNavigationSchema, STRUCTURAL_NAVIGATION_METHOD } from "../../../runs/source-access-diagnostic/structural-navigation.js";
import { solveConditionalNavigation } from "../../../runs/source-access-diagnostic/conditional-navigation.js";
import type { NavigationSourceObservation } from "../../../runs/source-access-diagnostic/temporal-navigation.js";

const source = (record_id: string, message_index: number, session_id = "session", session_index = 0): NavigationSourceObservation => ({ record_id,
  source_time: { contract: "benchmark-session-observation.v1", recorded_at: "2026-01-01T00:00:00.000Z", event_time: null, valid_from: null, valid_to: null,
    observation: { status: "unknown", reason: "historical_granularity_not_retained" },
    binding: { manifest_sha256: "a".repeat(64), question_id: "authored", record_id, session_id, session_index, message_index } } });
const seed = { record_id: "seed", prefix_bytes: 6, body_bytes: 6 };
const config = (mode: "off" | "adjacent" | "original_and_adjacent") => StructuralNavigationSchema.parse({ contract: STRUCTURAL_NAVIGATION_METHOD, mode });

it("uses exact bound adjacent indices independent of candidate ordering, session dates and roles", () => {
  const sources = [source("far", 4), source("next", 3), source("other-id", 1, "other"),
    source("seed", 2), source("previous", 1), source("other-index", 3, "session", 1)];
  const observed = observeSessionAdjacency(sources, seed);
  expect(observed.edges.map(edge => [edge.from, edge.to])).toEqual([["seed", "previous"], ["seed", "next"]]);
  expect(observeSessionAdjacency([...sources].reverse(), seed)).toEqual(observed);
  expect(observeSessionAdjacency([source("seed", 2), source("omitted-gap", 4)], seed).edges).toEqual([]);
  expect(observeSessionAdjacency(sources, null)).toMatchObject({ status: "unobserved", seed: null, edges: [] });
  const unbound: NavigationSourceObservation = { record_id: "seed", source_time: {
    contract: "benchmark-session-observation.v1", recorded_at: "2026-01-01T00:00:00.000Z", event_time: null, valid_from: null, valid_to: null,
    observation: { status: "unknown", reason: "artifact_not_bound" } } };
  expect(observeSessionAdjacency([unbound, source("next", 3)], seed)).toMatchObject({ status: "unknown", edges: [] });
});
it("rejects empty claimed seeds, mismatched bindings and ambiguous neighbors", () => {
  expect(() => observeSessionAdjacency([source("seed", 2)], { ...seed, prefix_bytes: 0 })).toThrow(/nonempty read/);
  expect(() => observeSessionAdjacency([], seed)).toThrow(/nonempty read/);
  const mismatch = source("next", 3);
  if ("binding" in mismatch.source_time && mismatch.source_time.binding) mismatch.source_time.binding.manifest_sha256 = "b".repeat(64);
  expect(() => observeSessionAdjacency([source("seed", 2), mismatch], seed)).toThrow(/binding mismatch/);
  expect(() => observeSessionAdjacency([source("seed", 2), source("a", 1), source("b", 1), source("c", 3)], seed)).toThrow(/ambiguous/);
});
it("composes one hop inside max/min, preserves original navigation and never fabricates native ranks or support", () => {
  const pool = ["seed", "previous", "next", "two-hops", "other"].map((record_id, catalog_position) => ({ record_id, catalog_position }));
  const input = { original: "original", conditions: [{ id: "original", query: "fixture", object: "object", hypothesis: "hypothesis",
    status: "ready" as const, residual: null, provenance: "authored" }], branches: [], pool,
    occurrences: ["seed", "other", "two-hops", "next", "previous"].map((record_id, i) => ({ record_id, condition: "original",
      channel: "lexical" as const, native_rank: i + 1, reference: record_id, root_key: record_id })) };
  const observation = observeSessionAdjacency([source("seed", 2), source("previous", 1), source("next", 3), source("two-hops", 4), source("other", 8)], seed);
  const plain = solveConditionalNavigation(input);
  const propagated = solveConditionalNavigation({ ...input, structural: { config: config("adjacent"), observation } });
  expect(propagated.rows.map(row => [row.record_id, row.navigation.tier])).toEqual([
    ["seed", 1024], ["previous", 1023], ["next", 1023], ["other", 1022], ["two-hops", 1020]]);
  expect(solveConditionalNavigation({ ...input, structural: { config: config("off"), observation } })).toEqual(plain);
  expect(solveConditionalNavigation({ ...input, structural: { config: config("original_and_adjacent"), observation } }).rows).toEqual(plain.rows);
  expect(propagated.native_single_condition).toEqual(plain.native_single_condition);
  expect(propagated.rows.every(row => row.read.status === "unobserved" && row.conditional_support.status === "unknown")).toBe(true);
  expect(propagated.single_condition_equivalent).toBeNull();
});
it("keeps catalog-tail delivery separate from original-native seed authority", () => {
  const conditions = ["original", "extra"].map(id => ({ id, query: id, object: "object", hypothesis: "hypothesis",
    status: "ready" as const, residual: null, provenance: "authored" }));
  const pool = ["catalog-first", "seed", "catalog-last"].map((record_id, catalog_position) => ({ record_id, catalog_position }));
  const occurrence = (record_id: string, condition: string, native_rank: number) => ({ record_id, condition, native_rank,
    channel: "lexical" as const, reference: `${condition}:${record_id}`, root_key: record_id });
  const input = { original: "original", conditions, pool, branches: [["extra"]],
    occurrences: pool.map((row, i) => occurrence(row.record_id, "extra", i + 1)) };
  const absent = solveConditionalNavigation(input);
  expect(absent.native_single_condition).toEqual(pool.map(row => row.record_id));
  expect(absent.original_nominee).toBeNull();
  const injected = observeSessionAdjacency([source("catalog-first", 0), source("seed", 1)], { ...seed, record_id: "catalog-first" });
  expect(() => solveConditionalNavigation({ ...input, structural: { config: config("adjacent"), observation: injected } }))
    .toThrow(/first witnessed original-native nominee/);
  const witnessed = solveConditionalNavigation({ ...input, occurrences: [...input.occurrences, occurrence("seed", "original", 7)] });
  expect(witnessed.original_nominee).toMatchObject({ record_id: "seed", decision: "placed", occurrence: { native_rank: 7 } });
  expect(witnessed.native_single_condition).toEqual(["seed", "catalog-first", "catalog-last"]);
  expect(solveConditionalNavigation({ ...input, pool: [], occurrences: [] }).original_nominee).toBeNull();
});
it("caps seed/read policy and rejects caller-provided seed identities", () => {
  expect(config("adjacent").max_source_reads).toBe(522);
  for (const extra of [{ seed_id: "nomination-is-not-a-read" }, { max_source_reads: 523 }, { max_source_reads: -1 }]) {
    expect(StructuralNavigationSchema.safeParse({ contract: STRUCTURAL_NAVIGATION_METHOD, mode: "adjacent", ...extra }).success).toBe(false);
  }
});
it("runs authored compiled SQLite seed admission, shared-cost failures, literal delivery and frozen scoring", { timeout: 180_000 }, async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { fileURLToPath } = await import("node:url");
  const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../../support/structural-navigation-proof.mjs", import.meta.url))],
    { timeout: 170_000, env: process.env });
  expect(JSON.parse(stdout)).toMatchObject({ status: "passed", scratch_removed: true, provider_calls: 0 });
});
