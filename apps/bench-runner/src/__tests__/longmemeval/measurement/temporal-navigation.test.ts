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
import { describeLongMemEvalSessionTime } from "../../../datasets/longmemeval/ingestion/source-time.js";
import { SOURCE_OBSERVATION_PROJECTION } from "../../../runs/snapshot/source-records/observation-projection.js";
import { observeSessionWindow, ObservationWindowSchema, TEMPORAL_NAVIGATION_METHOD, type SourceTimeProjection } from "../../../runs/source-access-diagnostic/temporal-navigation.js";
import { solveConditionalNavigation, type NavigationCondition } from "../../../runs/source-access-diagnostic/conditional-navigation.js";
import { formationQueryShares } from "../../../runs/source-access-diagnostic/input-condition-formation.js";

const window = { contract: TEMPORAL_NAVIGATION_METHOD, coordinate: "normalized_session_coordinate" as const,
  from: "2021-02-03T12:00:00.000Z", until: "2021-02-03T12:01:00.000Z" };
const source = (raw: string, record_id = "a") => ({ contract: SOURCE_OBSERVATION_PROJECTION,
  recorded_at: "2026-01-01T00:00:00.000Z", event_time: null, valid_from: null, valid_to: null,
  binding: { manifest_sha256: "a".repeat(64), record_id, question_id: "authored", session_id: "session", session_index: 0, message_index: 0 },
  observation: { status: "known", ...describeLongMemEvalSessionTime(raw) } } satisfies SourceTimeProjection);
const condition = (id: string): NavigationCondition => ({ id, object: "object", hypothesis: "hypothesis", query: id,
  status: "ready", residual: null, provenance: "authored-explicit-window" });
const input = () => ({ original: "original", conditions: [condition("original"), { ...condition("time"), observation_window: window }],
  branches: [["time"]], pool: ["a", "b", "c", "tail"].map((record_id, catalog_position) => ({ record_id, catalog_position })),
  occurrences: ["b", "a"].map((record_id, index) => ({ condition: "original", channel: "lexical" as const,
    native_rank: index + 1, reference: record_id, root_key: record_id, record_id })) });

it.each([
  ["2021-02-03T11:59:59.999Z", "known", "outside"],
  ["2021-02-03T12:00:00.000Z", "known", "inside"],
  ["2021-02-03T12:00:59.999Z", "known", "inside"],
  ["2021-02-03T12:01:00.000Z", "known", "outside"],
  ["2021/02/03 12:00", "known", "inside"],
  ["2021/02/03 12:01", "known", "outside"],
  ["2021/02/03", "partial", "overlap"],
  ["2021/02/02", "known", "outside"]
])("compares %s against independently specified half-open edges", (raw, status, relation) => {
  expect(observeSessionWindow(window, source(raw!))).toMatchObject({ status, relation });
});
it("does not convert timezone uncertainty or historical absence into a low observation", () => {
  expect(observeSessionWindow({ ...window, coordinate: "utc_instant" }, source("2021/02/03 12:00")))
    .toMatchObject({ status: "unsupported", reason: "source_timezone_unspecified", relation: null });
  expect(observeSessionWindow({ ...window, coordinate: "utc_instant" }, source(window.from))).toMatchObject({ status: "known", relation: "inside" });
  expect(observeSessionWindow(window)).toMatchObject({ status: "unobserved", relation: null });
  const { binding: _binding, ...unbound } = source(window.from);
  expect(observeSessionWindow(window, { ...unbound, observation: { status: "unknown", reason: "artifact_not_bound" } }))
    .toMatchObject({ status: "unknown", reason: "artifact_not_bound", relation: null });
  expect(observeSessionWindow(window, { ...source(window.from), observation: { status: "unknown", reason: "historical_granularity_not_retained" } }))
    .toMatchObject({ status: "unknown", reason: "historical_granularity_not_retained", relation: null });
});
it("preserves coarse overlap without inventing a usable min premise", () => {
  const result = solveConditionalNavigation({ ...input(), branches: [["original", "time"]],
    source_observations: [{ record_id: "a", source_time: source("2021/02/03") }] });
  expect(result.assessments.find(row => row.record_id === "a" && row.conditions.length === 2)).toMatchObject({ status: "partial", tier: null });
  expect(result.rows.find(row => row.record_id === "a")?.navigation.tier).toBe(1022);
  expect(result.temporal_observations?.find(row => row.record_id === "tail")).toMatchObject({ observation: { status: "unobserved" }, tier: null });
});
it("participates before selection with its own method; known-low is above bottom, not native rank", () => {
  const result = solveConditionalNavigation({ ...input(), source_observations: [
    { record_id: "a", source_time: source(window.from) }, { record_id: "c", source_time: source("2021/02/02", "c") }] });
  expect(result.rows.map(row => [row.record_id, row.navigation.tier])).toEqual([["a", 1024], ["b", 1024], ["c", 1], ["tail", null]]);
  expect(result.temporal_observations?.find(row => row.record_id === "c")).toMatchObject({ observation: { method: TEMPORAL_NAVIGATION_METHOD, relation: "outside" }, tier: 1 });
  expect(result.rows.every(row => row.read.status === "unobserved" && row.conditional_support.status === "unknown")).toBe(true);
  const conjunctive = solveConditionalNavigation({ ...input(), branches: [["original", "time"]],
    source_observations: [{ record_id: "a", source_time: source(window.from) }] });
  expect(conjunctive.rows.map(row => [row.record_id, row.navigation.tier])).toEqual([["b", 1024], ["a", 1022], ["c", null], ["tail", null]]);
  expect(conjunctive.assessments.find(row => row.record_id === "a" && row.conditions.length === 2)?.tier).toBe(1022);
});
it("preserves native equivalence and query shares when the time operator is absent", () => {
  const fixture = input(), native = { ...fixture, conditions: [fixture.conditions[0]!], branches: [] };
  const result = solveConditionalNavigation(native);
  expect(result.single_condition_equivalent).toBe(true);
  expect(result.rows.map(row => row.record_id)).toEqual(["b", "a", "c", "tail"]);
  expect(result.temporal_observations).toBeUndefined();
  expect(formationQueryShares(fixture.conditions, true, fixture.original)).toEqual(formationQueryShares(native.conditions, true, native.original));
});
it("rejects invalid windows, metadata, native-time fabrication, and cross-object conjunctions", () => {
  for (const change of [{ until: window.from }, { from: window.until }, { from: "2021-02-30T00:00:00.000Z" },
    { coordinate: "event_time" }, { contract: "unknown" }, { from: "2021-02-03" }]) {
    expect(ObservationWindowSchema.safeParse({ ...window, ...change }).success).toBe(false);
  }
  const bad = source(window.from);
  expect(() => observeSessionWindow(window, { ...bad, observation: { ...bad.observation, precision: "day" } })).toThrow(/provenance/);
  const fixture = input();
  expect(() => solveConditionalNavigation({ ...fixture, occurrences: [{ ...fixture.occurrences[0]!, condition: "time" }] })).toThrow(/membership/);
  expect(() => solveConditionalNavigation({ ...fixture, source_observations: [{ record_id: "c", source_time: source(window.from) }] })).toThrow(/membership/);
  for (const change of [{ object: "different" }, { hypothesis: "different" }]) {
    expect(() => solveConditionalNavigation({ ...fixture, conditions: [fixture.conditions[0]!, { ...fixture.conditions[1]!, ...change }],
      branches: [["original", "time"]] })).toThrow(/different compared objects or hypotheses/);
  }
});
it("runs authored preparation, matched SQLite CLI captures, admission and frozen evaluation", { timeout: 180_000 }, async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { fileURLToPath } = await import("node:url");
  const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../../support/temporal-navigation-proof.mjs", import.meta.url))],
    { timeout: 170_000, env: process.env });
  expect(JSON.parse(stdout)).toMatchObject({ status: "passed", scratch_removed: true, provider_calls: 0 });
});
