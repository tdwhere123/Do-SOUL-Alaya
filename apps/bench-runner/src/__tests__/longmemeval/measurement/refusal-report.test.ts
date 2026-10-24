import { afterAll, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
import { rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import * as contract from "../../../runs/longmemeval-semantic/contract.js";
import * as census from "../../../runs/snapshot/source-records/census.js";
import * as visibility from "../../../runs/longmemeval-semantic/message-visibility.js";
import { measureLongMemEvalSemanticRun } from "../../../runs/longmemeval-semantic/measure.js";
import { readChainArtifact } from "../../../runs/recall-measurement/contract.js";
import { ACQUISITION_METRICS } from "../../../runs/longmemeval-semantic/acquisition-measurement.js";
import { prepareRefusalReportFixture } from "./refusal-report.test-support.js";

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true });
  expect(isolation.violations).toEqual([]); isolation.restore(); });

it("keeps refused and absent rows in the real mixed report without consulting their labels or losing costs", async () => {
  const f = await prepareRefusalReportFixture(); roots.push(f.root);
  const labelReads = vi.fn(() => { throw new Error("refused row label read"); });
  const original = contract.loadFrozenLongMemEvalDataset;
  const loader = vi.spyOn(contract, "loadFrozenLongMemEvalDataset").mockImplementation(async config => {
    const loaded = await original(config);
    for (const question of loaded.questions.filter(row => row.question_id !== "supported")) {
      Object.defineProperty(question, "answer_session_ids", { get: labelReads });
      Object.defineProperty(question, "haystack_sessions", { get: labelReads });
    }
    return loaded;
  });
  const answerCensus = vi.spyOn(census, "censusCompleteSourceRecords");
  const scorer = vi.spyOn(visibility, "scoreConsumerMessageVisibility");
  try {
    const measured = await measureLongMemEvalSemanticRun(f.experiment, f.replayPath, join(f.root, "evaluator"));
    expect(readChainArtifact(measured.path)).toEqual(measured.result);
    expect(measured.result.primary).toMatchObject({ eligible: 5, hits: 1, misses: 0, unknown: 4 });
    expect(measured.result.rows.find(row => row.question_id === "supported")?.outcome).toBe("hit");
    for (const id of ["field-present", "field-null"]) {
      const row = measured.result.rows.find(row => row.question_id === id)!;
      expect(row).toMatchObject({ outcome: "unknown", reason: "invalid_response", attribution: { layer: "invalid_measurement" } });
      for (const metric of ACQUISITION_METRICS) expect(row.acquisition?.metrics[metric]).toEqual({ status: "unknown", reason: "invalid_response" });
      expect(row.acquisition?.answer_gold).toBeNull();
      const native = readChainArtifact(row.measurement_path!) as { rows: { mechanism: { reason: string } }[]; gold: unknown };
      expect(native.rows[0]!.mechanism.reason).toBe("invalid_response");
      expect(native.gold).toEqual([{ query_key: f.frozen.selected.find(row => row.question_id === id)!.query_key, source_units: null }]);
    }
    expect(measured.result.rows.find(row => row.question_id === "missing")?.reason).toContain("native initial delivery");
    expect(measured.result.rows.find(row => row.question_id === "tampered")?.reason).toContain("sealed source span");
    for (const metric of ACQUISITION_METRICS) expect(measured.result.acquisition.metrics[metric])
      .toMatchObject({ denominator: 5, hits: 1, misses: 0, unknown: 4 });
    expect(measured.result.acquisition.unknown_reasons).toContainEqual({ reason: "invalid_response", rows: 2 });
    expect(measured.result.acquisition.observed_costs.native_work).toMatchObject({ known: 4, unknown: 1, known_sum: 16 });
    expect(labelReads).not.toHaveBeenCalled();
    expect(answerCensus).toHaveBeenCalledTimes(1);
    expect(answerCensus.mock.calls[0]![0].questionWindow).toEqual({ offset: 0, limit: 1 });
    expect(scorer).toHaveBeenCalledTimes(1);
  } finally { loader.mockRestore(); answerCensus.mockRestore(); scorer.mockRestore(); }
}, 120_000);

/** Runs the real emitted launcher/caller/archive/SQLite path. A module wrapper instruments only
 * the output of the real dataset loader; no private caller body is copied or substituted. */
it("emits the compiled CLI refusal report with actual null exposure and a no-label-read sentinel", async () => {
  const f = await prepareRefusalReportFixture(["field-present", "field-null", "supported", "missing", "tampered"]); roots.push(f.root);
  const boundary = new URL("../../support/provider-free-boundary.ts", import.meta.url).href;
  const base = new URL("../../../../dist/", import.meta.url);
  const compiled = (path: string) => new URL(path, base).href;
  const fetchUrl = compiled("datasets/longmemeval/ingestion/fetch.js");
  const wrapper = `import { loadDatasetWindowWithIdentity as actual } from ${JSON.stringify(fetchUrl)};
    export * from ${JSON.stringify(fetchUrl)};
    export async function loadDatasetWindowWithIdentity(...args) {
      const loaded = await actual(...args);
      for (const question of loaded.questions.filter(row => row.question_id !== "supported")) for (const key of ["answer_session_ids", "haystack_sessions"])
        Object.defineProperty(question, key, { get() { globalThis.labelReads++; throw new Error("refused label read"); } });
      return loaded;
    }`;
  const env = { ...process.env }; delete env.NODE_OPTIONS;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", `
    const { installProviderFreeBoundary } = await import(${JSON.stringify(boundary)});
    const boundary = installProviderFreeBoundary();
    const { registerHooks } = await import("node:module");
    const { readFileSync } = await import("node:fs");
    const assert = (await import("node:assert/strict")).default;
    const archives = ${JSON.stringify(f.replay.rows.map(row => row.replay_path))}.map(path => JSON.parse(readFileSync(path, "utf8")).payload);
    assert.notEqual(archives[0].rows[0].first_exposure, null);
    assert.equal(archives[1].rows[0].first_exposure, null);
    assert.equal(Object.hasOwn(archives[3].rows[0], "response"), false);
    globalThis.labelReads = 0;
    const hooks = registerHooks({ resolve(specifier, context, next) {
      if (context.parentURL === ${JSON.stringify(compiled("runs/longmemeval-semantic/contract.js"))}
          && specifier.endsWith("/ingestion/fetch.js"))
        return { url: ${JSON.stringify(`data:text/javascript,${encodeURIComponent(wrapper)}`)}, shortCircuit: true };
      return next(specifier, context);
    } });
    const { runLongMemEvalSemanticLauncher } = await import(${JSON.stringify(compiled("runs/longmemeval-semantic/launch.js"))});
    const code = await runLongMemEvalSemanticLauncher(["measure", "--root", ${JSON.stringify(f.experiment)},
      "--replay", ${JSON.stringify(f.replayPath)}, "--evaluator-root", ${JSON.stringify(join(f.root, "compiled-evaluator"))}]);
    assert.equal(code, 0); assert.equal(globalThis.labelReads, 0); assert.deepEqual(boundary.violations, []);
    console.log("GUARD:" + JSON.stringify({ labelReads: globalThis.labelReads, violations: boundary.violations,
      serializedExposure: archives.slice(0, 2).map(row => row.rows[0].first_exposure === null ? "null" : "present"),
      missingDelivery: !Object.hasOwn(archives[3].rows[0], "response") }));
    hooks.deregister();
  `], { env, encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  expect(result.error, result.stderr).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
  const [json, guard] = result.stdout.split("GUARD:");
  const output = JSON.parse(json!) as Awaited<ReturnType<typeof measureLongMemEvalSemanticRun>>;
  expect(JSON.parse(guard!)).toEqual({ labelReads: 0, violations: [], serializedExposure: ["present", "null"], missingDelivery: true });
  expect(output.result.primary).toMatchObject({ eligible: 5, hits: 1, misses: 0, unknown: 4 });
  expect(output.result.rows.filter(row => row.question_id.startsWith("field-")).every(row =>
    row.reason === "invalid_response" && row.attribution.layer === "invalid_measurement")).toBe(true);
  expect(output.result.rows.find(row => row.question_id === "supported")?.outcome).toBe("hit");
  expect(output.result.rows.find(row => row.question_id === "missing")?.reason).toContain("native initial delivery");
  expect(output.result.rows.find(row => row.question_id === "tampered")?.reason).toContain("sealed source span");
  expect(output.result.acquisition.unknown_reasons).toContainEqual({ reason: "invalid_response", rows: 2 });
  expect(output.result.acquisition.observed_costs.native_work).toMatchObject({ known: 4, unknown: 1, known_sum: 16 });
  expect(readChainArtifact(output.path)).toEqual(output.result);
}, 120_000);
