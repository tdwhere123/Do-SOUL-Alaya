import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it, vi } from "vitest";
import { indexEntryCacheKey, sourceSemanticQueryIdentity, type SourceSemanticResourceLedger } from "@do-soul/alaya-protocol";
import { fieldContractSha256, sourceGoldRootIdentity } from "@do-soul/alaya-core";
import { selectSourceSemanticLibraryPageWithEvidenceSetCoverage }
  from "../../../../../../packages/core/src/recall/runtime/source-semantic-library-selection.js";
import { physicalRoot, selectionExecutionBudget, type SelectionTaskFixture }
  from "../../../../../../packages/core/src/__tests__/recall/runtime/source-semantic-selection-fixture.js";
import type { LibraryPageSelector } from "../../../runtime/recall-read-worker/source-semantic-library-delivery.js";
import { SourceSemanticReadBudget } from "../../../runtime/field/source-semantic-read-stores.js";
import { assertNativeSupport, measureNativeSubset, measurementSummary, nativeSubsetContext, persistArtifact,
  type NativeMeasurement, type NativeSubsetContext } from "./source-semantic-library-subset-packing.test-support.js";

const isolation = await vi.hoisted(async () => {
  if (process.env["ALAYA_NATIVE_SINGLETON_EXCHANGE"] !== "1") return undefined;
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterAll(() => { isolation?.restore(); if (isolation !== undefined) expect(isolation.violations).toEqual([]); });

const enabled = process.env["ALAYA_NATIVE_SINGLETON_EXCHANGE"] === "1", caseName = "native-singleton-exchange";
const limit = 126_000, clock = "2026-09-18T00:00:00.000Z";
const queryId = "sha256:fcf749a7197481ca5d865d2146ed2f2dbf9b208e473ef3bf332a5b10d5fd8f1e";
type Configuration = ReturnType<typeof configuration>;

function configuration() {
  const required = (name: string) => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required for the opt-in diagnostic`);
    return value;
  };
  const root = required("ALAYA_SELECTION_DELIVERY_REPORT_DIR"), fixture = required("ALAYA_NATIVE_SINGLETON_EXCHANGE_FIXTURE");
  const sha = required("ALAYA_NATIVE_SINGLETON_EXCHANGE_SHA"), tree = required("ALAYA_NATIVE_SINGLETON_EXCHANGE_TREE");
  if (![sha, tree].every(value => /^[a-f0-9]{40}$/u.test(value))) throw new Error("exact candidate SHA and tree required");
  if (!isAbsolute(root) || resolve(root) !== root || realpathSync(dirname(root)) !== dirname(root)) {
    throw new Error("report root must be a fresh canonical absolute path with an existing parent");
  }
  if (!isAbsolute(fixture) || realpathSync(fixture) !== fixture || !fixture.endsWith(
    "/.do-it/bench-runs/native-chain/evidence-selection/native-candidate-bound/alternatives-comparison/fixture.json")) {
    throw new Error("the retained four-source alternatives fixture is required");
  }
  const location = relative(dirname(fixture), root);
  if (location === "" || !isAbsolute(location) && location !== ".." && !location.startsWith(`..${sep}`)) {
    throw new Error("reports must stay outside the retained fixture directory");
  }
  mkdirSync(root);
  return { root, fixture, sha, tree, worktree: realpathSync(fileURLToPath(new URL("../../../../../../", import.meta.url))) };
}

function assertFrozen(config: Configuration, fixtureBytes?: string) {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: config.worktree, encoding: "utf8" }).trim();
  expect({ root: realpathSync(git("rev-parse", "--show-toplevel")), sha: git("rev-parse", "HEAD"),
    tree: git("rev-parse", "HEAD^{tree}"), status: git("status", "--porcelain=v1", "--untracked-files=all") })
    .toEqual({ root: config.worktree, sha: config.sha, tree: config.tree, status: "" });
  expect(process.env["ALAYA_SELECTION_DELIVERY_REPORT_DIR"]).toBe(config.root);
  expect(isolation?.violations).toEqual([]);
  if (fixtureBytes !== undefined) expect(readFileSync(config.fixture, "utf8")).toBe(fixtureBytes);
}

function assertFixture(fixture: SelectionTaskFixture) {
  expect(fixture.original).toBe("For Deployment Cedar, establish either (permission granted AND backup completed) OR "
    + "(schema validated AND migration rehearsed AND rollback verified AND capacity reserved AND health checks passed).");
  expect(selectionExecutionBudget).toEqual({ schema_version: 1, work_units: 1_000_000, memory_bytes: 64_000_000,
    page_budget: 100_000, finalization_reserve: 10_000, min_envelope: 10 });
  expect(fixture.execution_budget).toEqual(selectionExecutionBudget);
  expect(sourceSemanticQueryIdentity(fixture.semantics, fieldContractSha256)).toBe(queryId);
  expect(fixture.alternatives).toEqual([[1, 2], [3, 4, 5, 6, 7]]);
  expect(fixture.sources.map(row => [row.id, row.inputs, row.body])).toEqual([
    ["permission", [1], "Deployment Cedar permission granted."], ["backup", [2], "Deployment Cedar backup completed."],
    ["checks-left", [3, 4], "Deployment Cedar schema validated.\nDeployment Cedar migration rehearsed."],
    ["checks-right", [5, 6], "Deployment Cedar rollback verified.\nDeployment Cedar capacity reserved."]
  ]);
  expect(fixture.pool).toEqual(fixture.sources.map(row => row.package));
  expect(new Set(fixture.pool.map(physicalRoot)).size).toBe(4);
  for (const source of fixture.sources) {
    expect(source.budget_rejections).toEqual([]);
    expect(source.package.preview).toBe(source.body);
    expect(source.package.proofs).toHaveLength(1);
    expect(source.package.proofs[0]!.query).toEqual(fixture.semantics);
    expect(source.package.proofs[0]!.query_semantics_id).toBe(queryId);
  }
}

function assertMeasurement(context: NativeSubsetContext, measurement: NativeMeasurement) {
  const fixture = context.fixture, selected = measurement.plan.pages[0]!;
  assertNativeSupport(fixture, measurement);
  expect(measurement.desired_sources).toBeNull(); expect(measurement.probe).toBeUndefined();
  expect(measurement.request).toMatchObject({ original_query: fixture.original, query_semantics: fixture.semantics,
    budget: selectionExecutionBudget, output_byte_limit: limit });
  expect(measurement.plan.pages.flat().map(physicalRoot).sort()).toEqual(fixture.pool.map(physicalRoot).sort());
  expect(new Set(measurement.plan.pages.flat().map(physicalRoot)).size).toBe(4);
  expect(measurement.plan).toMatchObject({ as_of: clock, expires_at: "2026-09-18T00:05:00.000Z", authorized: ["project"],
    snapshot_id: context.pool.access.pool_id, coverage: { payload: "complete" },
    discovery: { eligible_source_count: 4, open_residuals: false, truncated: false } });
  expect(measurement.plan.page_access).toHaveLength(measurement.plan.pages.length);
  for (const row of measurement.plan.pages.flat()) {
    const retained = fixture.pool.find(candidate => physicalRoot(candidate) === physicalRoot(row))!;
    expect(row.proofs).toEqual(retained.proofs); expect(row.preview).toBe(retained.preview);
  }
  expect(measurement.reserved_bytes).not.toBeNull(); expect(measurement.reserved_bytes!).toBeLessThanOrEqual(limit);
  for (const page of [measurement.encoded, measurement.reserved]) {
    if (!page?.results || !page.index || !page.proofs || !page.slot_qualifiers) throw new Error("complete reserved and delivered pages required");
    expect(page.results).toHaveLength(2); expect(page.index.entries).toHaveLength(2);
    expect(page.proofs).toHaveLength(2); expect(page.proofs).toEqual(expect.arrayContaining(selected.flatMap(row => row.proofs)));
    expect(page.slot_qualifiers).toHaveLength(2);
    expect(page.request_identity).toBe(measurement.plan.public_request_identity);
    expect(page.request_budget).toEqual(selectionExecutionBudget); expect(page.provider_attempts).toBe(0);
    expect(page.query_semantics_status).toEqual({ status: "admitted", query_semantics_id: queryId });
    expect(page.index).toMatchObject({ as_of: clock, snapshot_id: context.pool.access.pool_id,
      query_id: measurement.plan.query_id, representation: { page_budget: 5 }, continuation: {
        cursor: "offset-2", expires_at: "2026-09-18T00:05:00.000Z", query_id: measurement.plan.query_id,
        snapshot_id: context.pool.access.pool_id, interpretation_clock: clock, authorized_scopes: ["project"] } });
    const records = selected.flatMap(row => row.proofs.map(proof => proof.source_record.identity));
    expect(page.discovery?.access?.source_candidates.map(row => row.record_id).sort()).toEqual([...records].sort());
    for (const [index, result] of page.results.entries()) {
      if (result.target.kind !== "source_evidence") throw new Error("source evidence result required");
      const target = result.target, row = selected.find(candidate => physicalRoot(candidate) === sourceGoldRootIdentity(target))!;
      expect(page.index.entries[index]!.target).toEqual(target); expect(result.content_preview).toBe(row.preview);
      expect(result.source_disclosure).toEqual(row.source_disclosure);
      expect(page.source_disclosures?.[indexEntryCacheKey(row.entry)]).toEqual(row.source_disclosure);
      expect(result.budget_state).toMatchObject({ within_budget: true, max_entries: 5, max_total_tokens: 2000 });
      expect(page.slot_qualifiers[index]).toMatchObject({ index, evidence_kind: "semantic_proof", payload_support: "available",
        support: { answer: "unrepresented", operation: "not_executed", compatibility: "unknown", distinctness: "unknown" } });
    }
  }
  for (const cost of [measurement.preparation_work, measurement.delivery_work]) {
    expect(Object.values(cost).every(value => Number.isSafeInteger(value) && value >= 0)).toBe(true);
  }
  expect(measurement.preparation_work.logical_work + measurement.delivery_work.logical_work).toBeLessThanOrEqual(selectionExecutionBudget.work_units);
  expect(measurement.preparation_work.logical_bytes + measurement.delivery_work.logical_bytes).toBeLessThanOrEqual(selectionExecutionBudget.memory_bytes);
  expect(measurement.selected_sources).toEqual(["backup", "permission"]);
  expect(measurement.support.alternatives).toEqual(["complete", "incomplete"]);
}

// No fixture read, SQLite setup or native measurement occurs during ordinary collection.
it.skipIf(!enabled)("observes one unforced singleton exchange through the complete native page envelope", { timeout: 120_000, retry: 0 }, async () => {
  const config = configuration(), save = (name: string, value: unknown) => persistArtifact(caseName, name, value);
  await save("start.json", { configuration: config, limit, offset: 0, registered_calls: 1, retries: "forbidden",
    historical_window: "immutable_not_replayed", historical_proofs: "retained_without_reexecution" });
  let context: NativeSubsetContext | undefined, measurement: NativeMeasurement | undefined, fixtureBytes: string | undefined;
  let preparationMeter: SourceSemanticResourceLedger | undefined, phase = "candidate_guard", calls = 0, fetches = 0;
  let status: "passed" | "failed" | "unknown" = "unknown";
  const errors: { phase: string; error: string; details: Record<string, unknown> | null }[] = [];
  const recordError = (phase: string, error: unknown) => errors.push({ phase, error: String(error),
    details: error !== null && typeof error === "object" ? Object.fromEntries(Object.entries(error)) : null });
  const selections: { candidates: number; static_singleton_pair_bound: number; complete_fit_calls: number; standalone_fit_calls: number }[] = [];
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { fetches++; throw new Error("network forbidden"); });
  try {
    assertFrozen(config); fixtureBytes = readFileSync(config.fixture, "utf8");
    const retained = JSON.parse(fixtureBytes) as { fixture: SelectionTaskFixture };
    await save("input.json", retained); assertFixture(retained.fixture);
    phase = "setup"; await save("setup.start.json", { status: "started" });
    context = await nativeSubsetContext(retained.fixture);
    await save("setup.json", { work: context.setup_work, pool: context.pool,
      historical_proof_receipts: retained.fixture.pool.flatMap(row => row.proofs.map(proof => ({
        computation: proof.conditional_computation_id, usage: proof.resource_usage }))) });
    const selector: LibraryPageSelector = input => {
      preparationMeter = input.meter;
      const count = input.candidates.length, row = { candidates: count, static_singleton_pair_bound: Math.max(0, count - 1) * Math.max(0, count - 2) / 2,
        complete_fit_calls: 0, standalone_fit_calls: 0 };
      selections.push(row);
      return selectSourceSemanticLibraryPageWithEvidenceSetCoverage({ ...input,
        fits: page => { row.complete_fit_calls++; return input.fits(page); },
        ...(input.fitsStandalone === undefined ? {} : { fitsStandalone: (candidate, precedingSlots) => {
          row.standalone_fit_calls++; return input.fitsStandalone!(candidate, precedingSlots);
        } }) });
    };
    assertFrozen(config, fixtureBytes);
    await save("call.start.json", { status: "started", offset: 0, desired_subset: null });
    phase = "native"; calls++;
    measurement = measureNativeSubset(context, limit, undefined, retained.fixture.pool, selector);
    phase = "capture"; await save("candidate.full.json", measurement);
    phase = "assessment"; assertMeasurement(context, measurement);
    phase = "final_guard"; assertFrozen(config, fixtureBytes); expect(fetches).toBe(0);
    status = "passed";
  } catch (error) {
    status = phase === "assessment" && measurement !== undefined ? "failed" : "unknown";
    recordError(phase, error);
  } finally {
    try { await context?.close(); } catch (error) { status = "unknown"; recordError("cleanup", error); }
    try { assertFrozen(config, fixtureBytes); expect(fetches).toBe(0); }
    catch (error) { status = "unknown"; recordError("final_guard", error); }
    network.mockRestore();
    await save("result.json", { configuration: config, status, calls, limit, offset: 0,
      measurement: measurement === undefined ? null : measurementSummary(measurement), selections,
      stopping_point_total: measurement === undefined ? null : {
        logical_work: measurement.preparation_work.logical_work + measurement.delivery_work.logical_work,
        logical_bytes: measurement.preparation_work.logical_bytes + measurement.delivery_work.logical_bytes,
        native_work: measurement.preparation_work.native_work + measurement.delivery_work.native_work,
        native_bytes: measurement.preparation_work.native_bytes + measurement.delivery_work.native_bytes },
      pair_visits: "not_exposed; static eligible pair bounds are not observed counts",
      preparation_known_prefix: preparationMeter === undefined ? null : { logical_work: preparationMeter.spentWork, logical_bytes: preparationMeter.spentBytes,
        native_work: preparationMeter instanceof SourceSemanticReadBudget ? preparationMeter.nativeWork : null,
        native_bytes: preparationMeter instanceof SourceSemanticReadBudget ? preparationMeter.nativeBytes : null },
      measured_setup: context?.setup_work ?? null, network_attempts: fetches, provider_boundary_violations: isolation?.violations ?? null, errors,
      stopping_point: "all-page preparation plus first-page delivery", authored_evaluator_environment: "h",
      incomplete_call_cost: measurement === undefined ? "unknown_beyond_known_prefix" : null,
      unknown_costs: ["later page deliveries", "consumer evaluation", "physical work", "storage and admission", "capture"],
      lease_history: "fresh runtime; historical baseline had four prior feasibility calls", net_benefit: "not_established", default_adoption: "not_authorized" });
  }
  expect(calls).toBe(1); expect(errors).toEqual([]); expect(status).toBe("passed");
});
