import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  if (process.env["ALAYA_NATIVE_PAGE_CARDINALITY"] !== "1") return undefined;
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterAll(() => { isolation?.restore(); });
import { indexEntryCacheKey, sourceSemanticQueryIdentity } from "@do-soul/alaya-protocol";
import { fieldContractSha256, sourceGoldRootIdentity, type SourceSemanticLibraryPackage } from "@do-soul/alaya-core";
import { selectSourceSemanticLibraryPageWithEvidenceSetCoverage }
  from "../../../../../../packages/core/src/recall/runtime/source-semantic-library-selection.js";
import { executedInputNumbers, physicalRoot, selectionExecutionBudget, type SelectionTaskFixture }
  from "../../../../../../packages/core/src/__tests__/recall/runtime/source-semantic-selection-fixture.js";
import { assertNativeSupport, measureNativeSubset, measurementSummary, nativeSubsetContext,
  persistArtifact, persistMeasurement, type NativeMeasurement, type NativeSubsetContext }
  from "./source-semantic-library-subset-packing.test-support.js";

const enabled = process.env["ALAYA_NATIVE_PAGE_CARDINALITY"] === "1";
const caseName = "native-page-cardinality", limit = 126_000;
const clock = "2026-09-18T00:00:00.000Z", expiry = "2026-09-18T00:05:00.000Z";
const queryId = "sha256:fcf749a7197481ca5d865d2146ed2f2dbf9b208e473ef3bf332a5b10d5fd8f1e";
const specifications = [
  { name: "a", sources: ["checks-left"], fits: true },
  { name: "bc", sources: ["permission", "backup"], fits: true },
  { name: "ab", sources: ["checks-left", "permission"], fits: false },
  { name: "ac", sources: ["checks-left", "backup"], fits: false }
] as const;
type Slot = { name: string; status: "not_run" | "passed" | "hypothesis_not_observed" | "observed" | "unknown";
  reason: string | null; measurement: ReturnType<typeof measurementSummary> | null };
type Configuration = { root: string; fixture: string; sha: string; tree: string; worktree: string };
type PublicPage = NativeMeasurement["encoded"];

function configuration(): Configuration {
  const required = (key: string) => {
    const value = process.env[key];
    if (!value) throw new Error(`${key} is required for the opt-in study`);
    return value;
  };
  const root = required("ALAYA_SELECTION_DELIVERY_REPORT_DIR");
  const fixture = required("ALAYA_NATIVE_PAGE_CARDINALITY_FIXTURE");
  const sha = required("ALAYA_NATIVE_PAGE_CARDINALITY_SHA"), tree = required("ALAYA_NATIVE_PAGE_CARDINALITY_TREE");
  if (![sha, tree].every(value => /^[a-f0-9]{40}$/.test(value))) throw new Error("exact candidate SHA and tree required");
  if (!isAbsolute(root) || resolve(root) !== root || realpathSync(dirname(root)) !== dirname(root)) {
    throw new Error("report root must be a fresh canonical absolute path with an existing parent");
  }
  if (!isAbsolute(fixture) || realpathSync(fixture) !== fixture || !fixture.endsWith(
    "/.do-it/bench-runs/native-chain/evidence-selection/native-candidate-bound/alternatives-comparison/fixture.json")) {
    throw new Error("the exact retained alternatives fixture path is required");
  }
  const outputRelative = relative(dirname(fixture), root);
  if (outputRelative === "" || (!isAbsolute(outputRelative) && outputRelative !== ".." && !outputRelative.startsWith(`..${sep}`))) {
    throw new Error("reports must stay outside the retained fixture directory");
  }
  mkdirSync(root); // Existing directories fail before any evidence can be overwritten.
  return { root, fixture, sha, tree, worktree: realpathSync(fileURLToPath(new URL("../../../../../../", import.meta.url))) };
}

function candidate(config: Configuration) {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: config.worktree, encoding: "utf8" }).trim();
  return { worktree: realpathSync(git("rev-parse", "--show-toplevel")), sha: git("rev-parse", "HEAD"),
    tree: git("rev-parse", "HEAD^{tree}"), status: git("status", "--porcelain=v1", "--untracked-files=all") };
}
function assertFrozen(config: Configuration, fixtureBytes?: string) {
  const actual = candidate(config);
  expect(actual).toEqual({ worktree: config.worktree, sha: config.sha, tree: config.tree, status: "" });
  expect(process.env["ALAYA_SELECTION_DELIVERY_REPORT_DIR"]).toBe(config.root);
  expect(isolation?.violations).toEqual([]);
  if (fixtureBytes !== undefined) expect(readFileSync(config.fixture, "utf8")).toBe(fixtureBytes);
  return actual;
}
function failure(error: unknown): unknown {
  if (!(error instanceof Error)) return { value: String(error) };
  return { name: error.name, message: error.message, stack: error.stack ?? null,
    cause: error.cause === undefined ? null : failure(error.cause),
    errors: error instanceof AggregateError ? error.errors.map(failure) : [],
    metadata: Object.fromEntries(Object.entries(error).filter(([key]) => key !== "cause" && key !== "errors")) };
}
async function save(config: Configuration, name: string, value: unknown) {
  expect(process.env["ALAYA_SELECTION_DELIVERY_REPORT_DIR"]).toBe(config.root);
  await persistArtifact(caseName, name, value);
  expect(JSON.parse(readFileSync(join(config.root, caseName, name), "utf8"))).toEqual(JSON.parse(JSON.stringify(value)));
}

function assertFixture(fixture: SelectionTaskFixture) {
  expect(fixture.original).toBe("For Deployment Cedar, establish either (permission granted AND backup completed) OR "
    + "(schema validated AND migration rehearsed AND rollback verified AND capacity reserved AND health checks passed).");
  expect(fixture.alternatives).toEqual([[1, 2], [3, 4, 5, 6, 7]]);
  expect(fixture.execution_budget).toEqual(selectionExecutionBudget);
  expect(selectionExecutionBudget).toEqual({ schema_version: 1, work_units: 1_000_000, memory_bytes: 64_000_000,
    page_budget: 100_000, finalization_reserve: 10_000, min_envelope: 10 });
  expect(sourceSemanticQueryIdentity(fixture.semantics, fieldContractSha256)).toBe(queryId);
  expect(fixture.sources.map(row => row.id)).toEqual(["permission", "backup", "checks-left", "checks-right"]);
  expect(fixture.sources.map(row => row.inputs)).toEqual([[1], [2], [3, 4], [5, 6]]);
  expect(fixture.sources.map(row => row.body)).toEqual(["Deployment Cedar permission granted.",
    "Deployment Cedar backup completed.", "Deployment Cedar schema validated.\nDeployment Cedar migration rehearsed.",
    "Deployment Cedar rollback verified.\nDeployment Cedar capacity reserved."]);
  expect(fixture.pool).toEqual(fixture.sources.map(row => row.package));
  expect(new Set(fixture.pool.map(physicalRoot)).size).toBe(4);
  for (const source of fixture.sources) {
    expect(source.budget_rejections).toEqual([]);
    expect(executedInputNumbers(source.package)).toEqual(source.inputs);
    expect(source.package.preview).toBe(source.body);
    expect(source.package.proofs).toHaveLength(1);
    for (const proof of source.package.proofs) {
      expect(proof.query).toEqual(fixture.semantics);
      expect(proof.query_semantics_id).toBe(queryId);
      expect(proof.outcome).toEqual({ status: "interpreted", gaps: [] });
      expect(proof.completeness).toMatchObject({ logical_index: "complete", interpretation_coverage: "open",
        transport: "complete", payload: "complete", representation: "complete", order_coverage: "complete" });
      expect(proof.world_claim).toBe("unknown"); expect(proof.semantic_status).toBe("unreviewed");
    }
  }
}

function assertPage(page: PublicPage, wanted: readonly SourceSemanticLibraryPackage[], context: NativeSubsetContext,
  measurement: NativeMeasurement) {
  const { results, index, proofs, slot_qualifiers: qualifiers } = page, access = page.discovery?.access;
  if (!results || !index || !proofs || !qualifiers || !access) throw new Error("complete proof-bearing page unavailable");
  const expectedProofs = wanted.flatMap(row => row.proofs);
  expect(results).toHaveLength(wanted.length); expect(index.entries).toHaveLength(wanted.length);
  expect(proofs).toHaveLength(expectedProofs.length); expect(proofs).toEqual(expect.arrayContaining(expectedProofs));
  expect(page.request_identity).toBe(measurement.plan.public_request_identity);
  expect(page.request_budget).toEqual(selectionExecutionBudget); expect(page.provider_attempts).toBe(0);
  expect(page.query_semantics_status).toEqual({ status: "admitted", query_semantics_id: queryId });
  expect(index.as_of).toBe(clock); expect(index.snapshot_id).toBe(context.pool.access.pool_id);
  expect(index.query_id).toBe(measurement.plan.query_id); expect(index.representation.page_budget).toBe(5);
  expect(index.continuation).toMatchObject({ cursor: `offset-${wanted.length}`, expires_at: expiry,
    query_id: index.query_id, snapshot_id: index.snapshot_id, interpretation_clock: clock, authorized_scopes: ["project"] });
  expect(page.coverage).toEqual({ discovery: "complete", source_interpretation: "open", query_semantics: "complete",
    semantic_correspondence: "open", conditional_computation: "complete", payload: "truncated" });
  expect(access).toMatchObject({ input_id: context.pool.access.input_id, pool_id: context.pool.access.pool_id,
    observed_source_count: 4, observed_interpretation_count: 0, unvisited_sources: false,
    unvisited_interpretations: false, stopping_reasons: [], trace: { kind: "library_selection",
      omitted_source_count: 4 - wanted.length, omitted_interpretation_count: 0 } });
  const recordIds = new Set(wanted.flatMap(row => row.proofs.map(proof => proof.source_record.identity)));
  const observations = context.pool.access.source_candidates.filter(row => recordIds.has(row.record_id));
  expect(access.source_candidates).toHaveLength(wanted.length);
  expect(observations).toHaveLength(wanted.length);
  expect(access.source_candidates).toEqual(expect.arrayContaining(observations));
  expect(qualifiers).toHaveLength(wanted.length);
  const found = results.map((result, position) => {
    const target = result.target;
    if (target?.kind !== "source_evidence") throw new Error("source target unavailable");
    const row = wanted.find(row => physicalRoot(row) === sourceGoldRootIdentity(target));
    if (!row) throw new Error("page contains a root outside the requested subset");
    expect(index.entries[position]?.target).toEqual(result.target);
    expect(result.content_preview).toBe(row.preview);
    expect(result.budget_state).toMatchObject({ within_budget: true, max_entries: 5, max_total_tokens: 2000 });
    const disclosure = { material_kind: "original_body", source_binding: "unbound", evaluated_as_of: clock,
      validity: { kind: "unknown", reason: "unbound" }, temporal_state: "unknown",
      proof_use: { kind: "conditional_support", qualification: "not_world_claim" } };
    expect(result.source_disclosure).toEqual(disclosure);
    expect(page.source_disclosures?.[indexEntryCacheKey(row.entry)]).toEqual(disclosure);
    expect(qualifiers[position]).toMatchObject({ evidence_kind: "semantic_proof", payload_support: "available",
      support: { answer: "unrepresented", operation: "not_executed", compatibility: "unknown", distinctness: "unknown" } });
    return physicalRoot(row);
  });
  expect(found.sort()).toEqual(wanted.map(physicalRoot).sort());
}

function assertMeasurement(context: NativeSubsetContext, measurement: NativeMeasurement,
  desired: readonly SourceSemanticLibraryPackage[] | undefined) {
  const { fixture } = context, { pages, page_access, ...common } = measurement.plan;
  expect(measurement.limit).toBe(limit); expect(measurement.request.output_byte_limit).toBe(limit);
  expect(measurement.request.original_query).toBe(fixture.original);
  expect(measurement.request.query_semantics).toEqual(fixture.semantics);
  expect(measurement.request.semantic_correspondences).toEqual(fixture.pool.flatMap(row => row.proofs.map(proof => proof.semantic_correspondence)));
  expect(common).toMatchObject({ as_of: clock, expires_at: expiry, authorized: ["project"],
    snapshot_id: context.pool.access.pool_id, coverage: { payload: "complete" },
    discovery: { eligible_source_count: 4, open_residuals: false, truncated: false } });
  expect(pages.flat().map(physicalRoot).sort()).toEqual(fixture.pool.map(physicalRoot).sort());
  expect(page_access).toHaveLength(pages.length);
  for (const row of pages.flat()) {
    const retained = fixture.pool.find(candidate => physicalRoot(candidate) === physicalRoot(row));
    expect(row.proofs).toEqual(retained?.proofs); expect(row.preview).toBe(retained?.preview);
  }
  for (const cost of [measurement.preparation_work, measurement.delivery_work]) {
    for (const value of Object.values(cost)) expect(Number.isSafeInteger(value) && value >= 0).toBe(true);
    expect(cost.logical_work).toBeLessThanOrEqual(selectionExecutionBudget.work_units);
    expect(cost.logical_bytes).toBeLessThanOrEqual(selectionExecutionBudget.memory_bytes);
  }
  assertNativeSupport(fixture, measurement);
  const actual = pages[0];
  if (!actual?.length || !measurement.reserved) throw new Error("actual first-page reservation unavailable");
  assertPage(measurement.encoded, actual, context, measurement);
  assertPage(measurement.reserved, actual, context, measurement);
  expect(measurement.reserved_bytes).toBeLessThanOrEqual(limit);
  if (desired !== undefined) {
    if (!measurement.probe || measurement.probe_bytes === null) throw new Error("requested native probe unavailable");
    assertPage(measurement.probe.encoded, desired, context, measurement);
    expect(measurement.probe.fits).toBe(measurement.probe_bytes <= limit);
  }
  return { request: measurement.request, plan: common };
}

async function runSlot(config: Configuration, fixtureBytes: string, context: NativeSubsetContext,
  slot: Slot, ordinal: number, common: unknown) {
  const spec = specifications[ordinal], desired = spec?.sources.map(id => context.fixture.sources.find(row => row.id === id)!.package);
  await save(config, `${slot.name}.start.json`, { ordinal, candidate: assertFrozen(config, fixtureBytes),
    sources: spec?.sources ?? null, output_byte_limit: limit, offset: 0, status: "started" });
  slot.status = "unknown"; slot.reason = "native call started without a terminal result";
  const measurement = spec === undefined
    ? measureNativeSubset(context, limit, undefined, context.fixture.pool, selectSourceSemanticLibraryPageWithEvidenceSetCoverage)
    : measureNativeSubset(context, limit, desired);
  slot.measurement = measurementSummary(measurement);
  await save(config, `${slot.name}.full.json`, measurement);
  await persistMeasurement(caseName, slot.name, measurement);
  assertFrozen(config, fixtureBytes);
  expect(context.fixture).toEqual((JSON.parse(fixtureBytes) as { fixture: SelectionTaskFixture }).fixture);
  const binding = assertMeasurement(context, measurement, desired);
  if (common !== undefined) expect(binding).toEqual(common);
  if (spec === undefined) {
    slot.status = "observed";
    slot.reason = measurement.selected_sources.join(",") === "checks-left" && measurement.support.complete_alternatives === 0
      ? "singleton_trap_observed" : measurement.support.complete_alternatives > 0
        ? "counterevidence_complete_alternative_selected" : "other_selection_observed";
  } else {
    const met = spec.fits ? measurement.probe!.fits && measurement.actual_subset
      && measurement.reserved_bytes !== null && measurement.reserved_bytes <= limit && measurement.encoded_bytes <= limit
      : !measurement.probe!.fits && measurement.probe_bytes! > limit;
    slot.status = met ? "passed" : "hypothesis_not_observed";
    slot.reason = met ? null : `requested subset did not satisfy expected fit=${spec.fits}`;
    if (met && spec.name === "bc") expect(measurement.support.complete_alternatives).toBe(1);
  }
  await save(config, `${slot.name}.terminal.json`, slot);
  return binding;
}

// Ordinary collection does not open the fixture, create SQLite state or run native measurements.
it.skipIf(!enabled)("observes a singleton and a complementary pair under one full native page budget", async () => {
  const config = configuration(), slots: Slot[] = [...specifications.map(row => row.name), "policy"].map(name =>
    ({ name, status: "not_run", reason: "predecessor has not passed", measurement: null }));
  await save(config, "start.json", { configuration: config, limit, slots, retry: "forbidden", offset: 0,
    historical_proofs: "retained without fresh execution", consumer_cost: "not_measured" });
  let context: NativeSubsetContext | undefined, fixtureBytes: string | undefined, active = -1, common: unknown;
  let setup: unknown = null, fetches = 0;
  const errors: unknown[] = [];
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    fetches += 1; throw new Error("network forbidden in native page measurement");
  });
  try {
    await save(config, "candidate.json", candidate(config));
    assertFrozen(config);
    fixtureBytes = readFileSync(config.fixture, "utf8");
    const retained = JSON.parse(fixtureBytes) as { fixture: SelectionTaskFixture };
    await save(config, "input.json", retained);
    assertFixture(retained.fixture);
    await save(config, "setup.start.json", { candidate: assertFrozen(config, fixtureBytes), status: "started" });
    context = await nativeSubsetContext(retained.fixture); setup = context.setup_work;
    await save(config, "setup.json", { measured_setup: setup, pool: context.pool,
      historical_proof_receipts: retained.fixture.sources.map(row => ({ source: row.id,
        receipts: row.package.proofs.map(proof => ({ id: proof.conditional_computation_id, usage: proof.resource_usage })) })),
      unmetered: ["SQLite creation and source admission", "artifact capture", "physical cost", "consumer execution"] });
    for (let index = 0; index < specifications.length; index++) {
      active = index;
      common = await runSlot(config, fixtureBytes, context, slots[index]!, index, common);
      if (slots[index]!.status !== "passed") break;
    }
    if (slots.slice(0, 4).every(slot => slot.status === "passed")) {
      active = 4; await runSlot(config, fixtureBytes, context, slots[4]!, 4, common);
    }
    expect(fetches).toBe(0);
  } catch (error) {
    errors.push(error);
    if (active >= 0) { slots[active]!.status = "unknown"; slots[active]!.reason = "native, binding, protocol or capture failure"; }
    try { await save(config, "error.json", { active_slot: active, error: failure(error),
      incomplete_call_cost: active >= 0 && slots[active]!.measurement === null ? "unknown; helper did not return" : null }); }
    catch (captureError) { errors.push(captureError); }
  } finally {
    try { await context?.close(); } catch (error) {
      errors.push(error);
      try { await save(config, "cleanup-error.json", failure(error)); } catch (captureError) { errors.push(captureError); }
    }
    network.mockRestore();
    try { assertFrozen(config, fixtureBytes); expect(fetches).toBe(0); } catch (error) { errors.push(error); }
    const stopped = errors.length > 0 ? "measurement_unknown" : slots.find(slot => slot.status === "hypothesis_not_observed")?.name;
    for (const slot of slots.filter(slot => slot.status === "not_run")) slot.reason = `stopped: ${stopped ?? "predecessor_not_passed"}`;
    const report = { status: errors.length > 0 ? "measurement_unknown" : stopped ? "hypothesis_not_observed" : "window_settled",
      configuration: config, limit, slots, measured_setup: setup, network_attempts: fetches, errors: errors.map(failure),
      provider_boundary_violations: isolation?.violations ?? null,
      cost_boundary: "all-page preparation and first-page delivery per returned measurement; unfinished helper costs unknown",
      consumer_savings: "not_measured", source_fidelity: "not_recertified" };
    try { await save(config, "result.json", report); } catch (captureError) { errors.push(captureError); }
  }
  if (errors.length > 0) throw new AggregateError(errors, "native page observation or evidence capture failed", { cause: errors[0] });
  expect(slots.filter(slot => slot.measurement !== null).length).toBeLessThanOrEqual(5);
}, 120_000);
