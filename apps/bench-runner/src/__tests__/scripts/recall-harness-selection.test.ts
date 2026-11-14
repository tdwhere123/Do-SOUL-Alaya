import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { chainIdentity } from "../../runs/recall-measurement/contract.js";
import { readCurrentExtractionAuthorityRevision } from "../../runs/extraction/authority/inspection.js";

it("keeps lexical preparation work in cache identity without changing semantic execution identity", async () => {
  const selection = await loadHarnessSelection();
  const execution = { cache_root: "/fixture/models", model_id: "fixture-model" }, revision = "fixture-revision";
  const arm = { name: "time", host: true, lexical: "segmented-unicode61.v1", windowing: "recorded-message-windows.v1" };
  const values = { model: execution.model_id }, identity = selection.recallExecutionIdentity(values, execution, revision, chainIdentity);
  const oldKey = createHash("sha256").update(JSON.stringify([revision, identity, true, arm.windowing, arm.lexical])).digest("hex").slice(0, 16);
  expect(selection.recallPreparationKey(revision, identity, execution, arm)).toBe(oldKey);
  expect(selection.recallPreparationKey(revision, identity, execution, arm, undefined)).toBe(oldKey);
  const allocated = selection.recallPreparationKey(revision, identity, execution, arm, { work: 131072 });
  expect(allocated).not.toBe(oldKey);
  expect(selection.recallPreparationKey(revision, identity, execution, arm, { work: 131073 })).not.toBe(allocated);
  expect(selection.recallExecutionIdentity({ ...values, "source-lexical-work": "131072" }, execution, revision, chainIdentity)).toBe(identity);
});

it("binds the statement map that published a preparation's statements into its cache key", async () => {
  const selection = await loadHarnessSelection();
  const execution = { cache_root: "/fixture/models", model_id: "fixture-model" }, revision = "fixture-revision";
  const arm = { name: "time", host: true };
  const unmapped = selection.recallPreparationKey(revision, undefined, execution, arm);
  const mapped = selection.recallPreparationKey(revision, undefined, execution, arm, undefined, "a".repeat(64));
  expect(selection.recallPreparationKey(revision, undefined, execution, arm, undefined, undefined)).toBe(unmapped);
  expect(mapped).not.toBe(unmapped);
  expect(selection.recallPreparationKey(revision, undefined, execution, arm, undefined, "b".repeat(64))).not.toBe(mapped);
});

const roots: string[] = [];
const runChild = promisify(execFile);
const childTimeout = 30_000;
const harness = new URL("../../../scripts/recall-harness.mjs", import.meta.url);
const d1 = new URL("../../../scripts/recall-harness-d1.mjs", import.meta.url);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function loadHarnessSelection() {
  return import(new URL("../../../scripts/recall-harness-selection.mjs", import.meta.url).href);
}

function harnessFixture() {
  const root = mkdtempSync(join(tmpdir(), "recall-harness-selection-"));
  roots.push(root);
  const dataset = join(root, "longmemeval_s.json");
  const trace = join(root, "selection-trace.json");
  const pinned = join(root, "pinned");
  const sample = { question_id: "fixture", question: "synthetic", question_type: "synthetic",
    question_date: "2026/10/28 (Wed) 12:00", answer: "fixture", haystack_session_ids: [],
    haystack_dates: [], haystack_sessions: [], answer_session_ids: [] };
  const raw = JSON.stringify([sample, { ...sample, question_id: "second" }, { ...sample, question_id: "third" }]);
  const digest = createHash("sha256").update(raw).digest("hex");
  writeFileSync(dataset, raw);
  mkdirSync(pinned);
  writeFileSync(join(pinned, "longmemeval_s.meta.json"), JSON.stringify({ sha256: digest,
    size_bytes: Buffer.byteLength(raw), question_count: 3 }));
  const hook = writeDatasetTraceHook(root, pinned, trace);
  const run = (entry: URL, args: readonly string[], env?: NodeJS.ProcessEnv) => runChild(process.execPath,
    [`--import=${hook}`, fileURLToPath(entry), ...args], { timeout: childTimeout, env });
  return { root, dataset, trace, digest, run };
}

function writeDatasetTraceHook(root: string, pinned: string, trace: string): string {
  const hook = join(root, "dataset-hook.mjs");
  const fetchUrl = new URL("../../../dist/datasets/longmemeval/ingestion/fetch.js", import.meta.url).href;
  const wrapper = `import { writeFileSync } from 'node:fs';
    import { loadSelectedQuestionMetadata as actual } from ${JSON.stringify(fetchUrl)};
    export * from ${JSON.stringify(fetchUrl)};
    export async function loadSelectedQuestionMetadata(variant, options) {
      const selected = await actual(variant, { ...options, pinnedMetaRoot: ${JSON.stringify(pinned)} });
      writeFileSync(${JSON.stringify(trace)}, JSON.stringify({ requested: options.questionIds, entries: selected.entries, sha256: selected.sha256 }));
      return selected;
    }`;
  writeFileSync(hook, `import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, next) {
      if (${JSON.stringify([harness.href, d1.href])}.includes(context.parentURL) && specifier === ${JSON.stringify(fetchUrl)})
        return { url: ${JSON.stringify(`data:text/javascript,${encodeURIComponent(wrapper)}`)}, shortCircuit: true };
      return next(specifier, context);
    } });`);
  return pathToFileURL(hook).href;
}

async function cacheFixture() {
  const fixture = harnessFixture();
  const { root } = fixture;
  const selection = await loadHarnessSelection();
  const revision = readCurrentExtractionAuthorityRevision(), model_id = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
  const cacheA = join(root, "models-a"), cacheB = join(root, "models-b"), cache = join(root, "preparations");
  const arm = { name: "plain", host: true }, executionA = { cache_root: cacheA, model_id }, executionB = { cache_root: cacheB, model_id };
  const identityA = selection.recallExecutionIdentity({ "model-cache": cacheA }, executionA, revision, chainIdentity);
  const identityB = selection.recallExecutionIdentity({ "model-cache": cacheB }, executionB, revision, chainIdentity);
  const keyA = selection.recallPreparationKey(revision, identityA, executionA, arm);
  const keyB = selection.recallPreparationKey(revision, identityB, executionB, arm);
  const configA = { implementation_revision: revision, source_index: executionA };
  const prepareA = join(cache, "fixture", keyA, "prepare"), prepareB = join(cache, "fixture", keyB, "prepare");
  for (const directory of [prepareA, prepareB]) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "chain-config.json"), JSON.stringify(configA));
  }
  return { ...fixture, selection, revision, cacheA, cacheB, cache, arm, executionA, executionB, identityA, identityB, keyA, keyB, configA };
}

async function d1Fixture() {
  const fixture = await cacheFixture();
  const { root, revision, arm, dataset, cacheA, run } = fixture;
  const arms = join(root, "d1-arms.json"), coordinates = join(root, "coordinates.jsonl");
  writeFileSync(arms, JSON.stringify([{ ...arm, question_time: true }]));
  writeFileSync(coordinates, JSON.stringify({ question_id: "fixture", status: "failed" }) + "\n");
  const env = { ...process.env }; delete env.STATEMENT_MAP;
  const runD1 = (output: string, preparedCache: string, producerRevision = revision,
    extra: readonly string[] = [], environment = env) => run(d1,
    ["--out", output, "--arms", arms, "--dataset", dataset, "--model-cache", cacheA, "--ids", "fixture",
      "--prepared-cache", preparedCache, "--prepared-revision", producerRevision, "--coordinates", coordinates, ...extra], environment);
  return { ...fixture, coordinates, env, runD1 };
}

function firstRow(output: string) {
  return JSON.parse(readFileSync(join(output, "rows.jsonl"), "utf8"));
}

it("keeps explicit Memory cache changes out of cached preparations and resumed harness rows", async () => {
  const { root, dataset, run, selection, executionA, executionB, revision, configA, arm,
    identityA, identityB, keyA, keyB, cacheA, cacheB, cache } = await cacheFixture();
  expect(selection.recallExecutionIdentity({}, executionA, revision, chainIdentity)).toBeUndefined();
  expect(identityA).not.toBe(identityB);
  expect(keyA).not.toBe(keyB);
  expect(() => selection.assertRecallCachedPreparation(configA, revision, executionB, arm))
    .toThrow(expect.objectContaining({ code: "CONFLICT", message: "cached Source preparation uses a different execution selection" }));
  const arms = join(root, "arms.json"), out = join(root, "out");
  writeFileSync(arms, JSON.stringify([arm]));
  const args = (output: string, modelCache: string) => ["--out", output, "--arms", arms, "--dataset", dataset,
    "--cache", cache, "--model-cache", modelCache, "--ids", "fixture"];
  await run(harness, args(out, cacheA));
  const rowA = firstRow(out);
  expect(rowA.source_execution_identity).toBe(identityA);
  expect(rowA.status).toBe("error"); // Synthetic cached config intentionally stops before daemon/model execution.
  expect(rowA.error).not.toContain("cached Source preparation uses a different execution selection");
  await expect(run(harness, args(out, cacheB))).rejects.toMatchObject({
    stderr: expect.stringContaining("existing rows use a different Source or Memory execution")
  });
  const otherOut = join(root, "other-out");
  await run(harness, args(otherOut, cacheB));
  const rowB = firstRow(otherOut);
  expect(rowB.source_execution_identity).toBe(identityB);
  expect(rowB.error).toContain("cached Source preparation uses a different execution selection");
}, 60_000);

it.each([
  ["ordered", [], [["third", 2], ["fixture", 0]]],
  ["sharded", ["--shard", "1/2"], [["fixture", 0]]]
] as const)("uses the pinned dataset order for %s selection", async (name, shard, expected) => {
  const { root, dataset, trace, digest, run } = harnessFixture();
  const arms = join(root, "empty-arms.json");
  writeFileSync(arms, "[]");
  await run(harness, ["--out", join(root, `${name}-out`), "--arms", arms, "--dataset", dataset,
    "--cache", join(root, `${name}-cache`), "--ids", "third,fixture,second", "--limit", "2", ...shard]);
  const selected = JSON.parse(readFileSync(trace, "utf8"));
  expect(selected.entries.map((entry: { question: { question_id: string }; index: number }) =>
    [entry.question.question_id, entry.index])).toEqual(expected);
  expect(selected.requested).toEqual(expected.map(([id]) => id));
  expect(selected.sha256).toBe(digest);
}, 60_000);

it.each(["same", "different"] as const)("a %s-revision consumer never prepares a missing seal", async name => {
  const { root, revision, runD1 } = await d1Fixture();
  const producerRevision = name === "same" ? revision : `git-worktree-v1:${"a".repeat(40)}:${"b".repeat(64)}`;
  const output = join(root, `${name}-missing-seal-out`), cache = join(root, `${name}-missing-seal-cache`);
  await runD1(output, cache, producerRevision);
  const missing = firstRow(output);
  expect(missing.status).toBe("unavailable");
  expect(missing.consumer_revision).toBe(revision);
  expect(missing.error).toContain("no sealed preparation");
  expect(missing.formation.question_time).toEqual({ status: "failed", proposal: "not_issued" });
  expect(existsSync(cache)).toBe(false);
  await runD1(output, cache, producerRevision);
  expect(readFileSync(join(output, "rows.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
}, 60_000);

it("keeps a missing historical seal unavailable and refuses a missing statement input", async () => {
  const { root, cache, revision, env, runD1 } = await d1Fixture();
  const historicalOut = join(root, "historical-missing-out");
  const archivedRevision = "git-worktree-v1:9dce76ae7dabc8103baf277c6ad93863c5c16bbd:401cb0d9177b84228e94123a0d81ba8b4f74706625e4562003ccf3f1dce2edac";
  await runD1(historicalOut, join(root, "absent-historical"), archivedRevision,
    ["--historical-preparation", "pre-statement-map.v1"], { ...env, STATEMENT_MAP: join(root, "missing-original-map") });
  expect(firstRow(historicalOut)).toMatchObject({ status: "unavailable" });
  expect(existsSync(join(root, "absent-historical"))).toBe(false);
  const missingMap = join(root, "statement-map.jsonl"), mapOut = join(root, "missing-map-out");
  writeFileSync(missingMap, JSON.stringify({ cache_file: join(root, "missing-statement.json") }) + "\n");
  const missingMapError = await runD1(mapOut, cache, revision, [], { ...env, STATEMENT_MAP: missingMap })
    .then(() => { throw new Error("a missing original statement input must fail"); }, (error: Error & { stderr: string }) => error);
  expect(missingMapError.stderr).toContain("original statement map or referenced cache is missing");
  expect(missingMapError.stderr).toMatch(/code:\s*['"]UNAVAILABLE['"]/u);
  expect(existsSync(join(mapOut, "rows.jsonl"))).toBe(false);
}, 60_000);

it("distinguishes partial, empty and missing statements without rejecting raw recall", async () => {
  const { root, cache, keyA, coordinates, runD1 } = await d1Fixture();
  const statements = join(cache, "fixture", keyA, "d1-statements.json");
  const receipt = { status: "published", sessions: 2, raw_gaps: [], rejections: [], messages: 2 };
  writeFileSync(coordinates, JSON.stringify({ question_id: "fixture", status: "formed", coordinates: { time: { kind: "absent" } } }) + "\n");
  const observe = async (name: string, counts: object) => {
    writeFileSync(statements, JSON.stringify({ ...receipt, ...counts }));
    const output = join(root, `${name}-formation-out`);
    await runD1(output, cache);
    return firstRow(output);
  };
  const partial = await observe("partial", { unmapped_sessions: 1, matched_messages: 1, keyed_messages: 1, statements: 2 });
  expect(partial.formation.question_time).toEqual({ status: "formed", proposal: "not_issued" });
  expect(partial.formation.statements).toMatchObject({ status: "partial", sessions: 2, unmapped_sessions: 1 });
  expect(partial.error).not.toContain("no sealed preparation");
  const empty = await observe("empty", { unmapped_sessions: 0, matched_messages: 2, keyed_messages: 0, statements: 0 });
  expect(empty.formation.statements).toMatchObject({ status: "empty", sessions: 2, statements: 0 });
  expect(empty.error).not.toContain("no sealed preparation");
  // A missing model-output message is not an explicit empty statement array.
  const missing = await observe("missing-message", { unmapped_sessions: 0, matched_messages: 1, keyed_messages: 0, statements: 0 });
  expect(missing.formation.statements).toMatchObject({ status: "partial", messages: 2, matched_messages: 1, statements: 0 });
  expect(missing.error).toBe(empty.error);
}, 60_000);

it.each([
  ["noncanonical", "fixture", "--dataset must name the canonical longmemeval_s.json file"],
  ["unknown", "missing", "unknown question missing"]
] as const)("refuses %s dataset selection before creating output or cache", async (name, id, expected) => {
  const { root, dataset, run } = harnessFixture();
  const refusedOut = join(root, `${name}-out`), refusedCache = join(root, `${name}-cache`);
  const arms = join(root, "arms.json");
  writeFileSync(arms, JSON.stringify([{ name: "plain", host: true }]));
  await expect(run(harness, ["--out", refusedOut, "--arms", arms,
    "--dataset", name === "noncanonical" ? join(root, "synthetic.json") : dataset, "--cache", refusedCache, "--ids", id]))
    .rejects.toMatchObject({ stderr: expect.stringContaining(expected) });
  expect(existsSync(refusedOut)).toBe(false);
  expect(existsSync(refusedCache)).toBe(false);
}, 60_000);
