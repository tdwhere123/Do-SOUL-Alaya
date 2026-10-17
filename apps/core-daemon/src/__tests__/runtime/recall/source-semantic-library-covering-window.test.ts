import { afterAll, afterEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); });
afterAll(() => { isolation.restore(); });

const enabled = process.env["ALAYA_SOURCE_COVER_PROBE"] === "1";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../..");
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const cases = [
  { fixture: "partial_overlap", body_bytes: 2_471, limits: [83_499, 83_899] },
  { fixture: "repeated_lines", body_bytes: 2_511, limits: [83_579, 83_979] },
  { fixture: "irrelevant_novel", body_bytes: 2_541, limits: [83_609, 84_009] }
] as const;
const orders = ["cover_first", "cover_last"] as const;
const requests = cases.flatMap(row => row.limits.flatMap(limit => orders.map(order => ({
  fixture: row.fixture, body_bytes: row.body_bytes, limit, order, id: `${row.fixture}-${limit}-${order}`
}))));
const testDirectory = "apps/core-daemon/src/__tests__/runtime/recall/";
const sourceFiles = [
  `${testDirectory}source-semantic-library-covering-window.test.ts`,
  `${testDirectory}source-semantic-library-covering-window.test-support.ts`,
  `${testDirectory}source-semantic-library-subset-packing.test-support.ts`,
  `${testDirectory}source-semantic-library-exposure.test-support.ts`,
  "apps/bench-runner/src/__tests__/support/provider-free-boundary.ts",
  "apps/core-daemon/src/runtime/recall-read-worker/source-semantic-library-delivery.ts",
  "apps/core-daemon/src/runtime/recall-read-worker/source-semantic-library-packages.ts",
  "apps/core-daemon/src/runtime/recall-read-worker/source-semantic-candidate-access.ts",
  "apps/core-daemon/src/runtime/recall-read-worker/source-semantic-leases.ts",
  "apps/core-daemon/src/runtime/field/source-semantic-read-stores.ts",
  "packages/core/src/__tests__/recall/runtime/source-semantic-selection-fixture.ts",
  "packages/core/src/__tests__/recall/runtime/source-semantic-proof-fixture.ts",
  "packages/core/src/recall/runtime/source-semantic-library-recall.ts",
  "packages/core/src/recall/runtime/source-semantic-library-selection.ts",
  "packages/core/src/recall/runtime/source-disclosure.ts",
  "packages/core/src/memory/evidence-create/source-utf8-hydrate.ts",
  "packages/core/src/memory/evidence-create/source-span-views.ts",
  "packages/storage/src/repos/field/source-repo.ts",
  "packages/storage/src/repos/field/bounded-source-root-reader.ts",
  "packages/protocol/src/recall/conditional-field/product-identity.ts",
  "packages/protocol/src/garden/source-semantic-resources.ts",
  "packages/protocol/src/garden/source-semantic-worker.ts",
  "packages/protocol/src/recall/field-contract/source-span.ts"
];

function sourceSnapshot() {
  return { head: git("rev-parse", "HEAD"), dirty_state: git("status", "--porcelain=v1", "--untracked-files=all"),
    hash_scope: "listed_harness_fixture_and_live_owners_not_transitive_dependency_closure",
    source_sha256: Object.fromEntries(sourceFiles.map(path => [path,
      createHash("sha256").update(readFileSync(join(root, path))).digest("hex")])) };
}

function freshOutputDirectory() {
  const output = process.env["ALAYA_SOURCE_COVER_PROBE_DIR"];
  if (output === undefined || !isAbsolute(output) || resolve(output) !== output) throw new Error("ALAYA_SOURCE_COVER_PROBE_DIR must be a fresh absolute path");
  const main = dirname(git("rev-parse", "--path-format=absolute", "--git-common-dir"));
  const collection = join(main, ".do-it/bench-runs/source-delivery/representation/text-recall/whole-source-cover-admission");
  if (dirname(output) !== collection) throw new Error(`output must be a fresh direct child of ${collection}`);
  mkdirSync(collection, { recursive: true });
  if (realpathSync(collection) !== collection) throw new Error("output collection must not traverse symlinks");
  // No recursive creation here: EEXIST refuses any previous output, even an empty directory.
  mkdirSync(output);
  return output;
}

function receiptWriter(directory: string) {
  return (name: string, value: unknown) => writeFileSync(join(directory, `${name}.json`),
    `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

it("observes logical debits and refusals without changing ledger behavior", { timeout: 60_000 }, async () => {
  const { SourceSemanticResourceLedger, SourceSemanticResourceExhausted } = await import("@do-soul/alaya-protocol");
  const { observeNativeBudgets } = await import("./source-semantic-library-covering-window.test-support.js");
  const observer = observeNativeBudgets();
  try {
    const ledger = new SourceSemanticResourceLedger({ work_units: 4, memory_bytes: 100 });
    ledger.charge(1, 8, "synthetic debit");
    ledger.retain("x", "synthetic retained value");
    expect(ledger.remaining()).toEqual({ work_units: 2, memory_bytes: 64 });
    expect([ledger.spentWork, ledger.spentBytes]).toEqual([2, 36]);
    expect(() => ledger.charge(3, 0, "synthetic refusal")).toThrow(SourceSemanticResourceExhausted);
    expect(ledger.remaining()).toEqual({ work_units: 2, memory_bytes: 64 });
    const snapshot = observer.snapshot();
    expect(snapshot.observed_prepare_invocations).toBe(0);
    expect(snapshot.refusals).toHaveLength(1);
    expect(snapshot.refusals[0]).toMatchObject({ phase: "synthetic refusal", work: 3, bytes: 0 });
    expect(snapshot.ledgers[0]?.phases).toEqual({
      "synthetic debit": { calls: 1, work: 1, bytes: 8 },
      "synthetic retained value": { calls: 1, work: 1, bytes: 28 }
    });
  } finally { observer.restore(); }
  expect(vi.isMockFunction(SourceSemanticResourceLedger.prototype.charge)).toBe(false);
  expect(vi.isMockFunction(SourceSemanticResourceLedger.prototype.reserve)).toBe(false);
  expect(vi.isMockFunction(SourceSemanticResourceLedger.prototype.retain)).toBe(false);
});

it.skipIf(!enabled)("observes whole-source source-only cover admission under bounded private directed orders", { timeout: 600_000, retry: 0, repeats: 0 }, async () => {
  const output = freshOutputDirectory(), receipt = receiptWriter(output), before = sourceSnapshot();
  const quiet = () => {
    if (isolation.violations.length > 0) throw new Error(`provider-free guard activity: ${isolation.violations.join(", ")}`);
  };
  receipt("run-started", { before, requested_attempts: requests, maximum_prepare_invocations: 12,
    helper_contract: "measureNativeSubset: exactly one prepare; deliverAllPages: zero prepare calls",
    retry_policy: "none", test_only: true, selection: "private_directed_orders_not_native_policy",
    scope: "whole_source_prefix_packages_only", claims: { production_reachability: "NOT_CHECKED",
      non_prefix_acceptance: "NOT_CHECKED", natural_gains: "NOT_CHECKED", archive_consumer_admission: "NOT_CHECKED" },
    budget_distinctions: "unchanged per-attempt logical/native ledgers; per-page delivery ledgers; atomic public 2000 tokens separate from output bytes; no RSS bound" });
  const attempted = new Set<string>(), finals: unknown[] = [];
  let prepareInvocations = 0, fitCalls = 0, stop: unknown = null, failure: Error | undefined;
  let context: import("./source-semantic-library-covering-window.test-support.js").NativeSubsetContext | undefined;
  try {
    quiet();
    if (before.head !== "308163627d9a7569448dbbd19dd7d4c85e2b25be") throw new Error("probe HEAD differs from the authorized retained scope");
    // Fixture computation and SQLite setup are behind the opt-in.
    const harness = await import("./source-semantic-library-covering-window.test-support.js");
    for (const fixtureCase of cases) {
      if (stop !== null) break;
      quiet();
      const fixture = harness.previewNoveltySelectionFixture(fixtureCase.fixture);
      quiet();
      context = await harness.nativeSubsetContext(fixture);
      try {
        const original = harness.prepareOriginalCandidates(context);
        const identity = context.pool.sources.find(record => record.source_id === "window-overlap");
        if (identity === undefined) throw new Error("named cover source missing from current admitted pool");
        const constructed = harness.sourceCoverConstructor(context, original.candidates)(identity);
        if (constructed.binding.body_bytes !== fixtureCase.body_bytes) throw new Error("fixture body bytes differ from retained scope");
        receipt(`${fixtureCase.fixture}-inputs`, { original_query: fixture.original, query_semantics: fixture.semantics,
          snapshot_id: context.pool.access.pool_id, sources: context.exposure_sources,
          // Gold is preserved for inspection, never passed to construction or directed selection.
          evaluator_only_gold: fixture.alternatives, candidates: original.candidates, candidate_preparation_work: original.work,
          cover: constructed.cover, binding: constructed.binding, setup_work: context.setup_work });
        for (const request of requests.filter(row => row.fixture === fixtureCase.fixture)) {
          if (stop !== null) break;
          quiet();
          if (attempted.size >= 12) throw new Error("declared twelve-attempt ceiling reached");
          const attemptDirectory = join(output, request.id);
          mkdirSync(attemptDirectory);
          const attemptReceipt = receiptWriter(attemptDirectory);
          attemptReceipt("started", { request, ordinal: attempted.size + 1, before,
            execution_budget: fixture.execution_budget, cover_target: constructed.cover.entry.target });
          attempted.add(request.id);
          const result = harness.attemptWholeSourceCover(context, original.candidates, constructed.cover,
            request.limit, request.order, attemptReceipt, quiet);
          prepareInvocations += result.budgets.observed_prepare_invocations;
          fitCalls += result.directed.fit_calls;
          const final = { request, ...result, provider_guard_activity: [...isolation.violations] };
          attemptReceipt("final", final); finals.push(final);
          if (result.stop || isolation.violations.length > 0) stop = { request, status: result.status };
          if (result.status === "unexpected_observation_error") failure = new Error(`Unexpected probe error: ${JSON.stringify(result)}`);
          if (prepareInvocations > 12) throw new Error("native preparation bound violated");
        }
      } finally { await context.close(); context = undefined; }
    }
  } catch (error) {
    stop = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { thrown: String(error) };
    failure = error instanceof Error ? error : new Error(String(error));
    receipt("run-error", stop);
  } finally {
    if (context !== undefined) await context.close();
    const unexecuted = requests.filter(row => !attempted.has(row.id));
    const after = sourceSnapshot();
    receipt("run-final", { status: stop === null ? "completed" : "stopped", stop, before, after,
      source_state_unchanged: JSON.stringify(before) === JSON.stringify(after),
      actual_started_attempts: attempted.size, actual_prepare_invocations: prepareInvocations,
      actual_fit_calls: fitCalls, final_attempt_records: finals.length, unexecuted_count: unexecuted.length,
      unexecuted: unexecuted.map(request => ({ ...request, status: "not_executed" })),
      provider_guard_activity: [...isolation.violations], outcomes: finals,
      claims: { production_reachability: "NOT_CHECKED", non_prefix_acceptance: "NOT_CHECKED",
        natural_gains: "NOT_CHECKED", archive_consumer_admission: "NOT_CHECKED" } });
  }
  expect(isolation.violations).toEqual([]);
  if (failure !== undefined) throw failure;
});
