import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { chainIdentity } from "../../runs/recall-measurement/contract.js";
import { readCurrentExtractionAuthorityRevision } from "../../runs/extraction/authority/inspection.js";

it("keeps lexical preparation work in cache identity without changing semantic execution identity", async () => {
  const selection = await import(pathToFileURL(fileURLToPath(new URL("../../../scripts/recall-harness-selection.mjs", import.meta.url))).href);
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

it("keeps explicit Memory cache changes out of cached preparations and resumed harness rows", async () => {
  const root = mkdtempSync(join(tmpdir(), "recall-harness-selection-"));
  const harness = fileURLToPath(new URL("../../../scripts/recall-harness.mjs", import.meta.url));
  const selection = await import(pathToFileURL(fileURLToPath(new URL("../../../scripts/recall-harness-selection.mjs", import.meta.url))).href);
  const revision = readCurrentExtractionAuthorityRevision(), model_id = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
  const cacheA = join(root, "models-a"), cacheB = join(root, "models-b"), cache = join(root, "preparations");
  const arm = { name: "plain", host: true }, executionA = { cache_root: cacheA, model_id }, executionB = { cache_root: cacheB, model_id };
  const valuesA = { "model-cache": cacheA }, valuesB = { "model-cache": cacheB };
  const identityA = selection.recallExecutionIdentity(valuesA, executionA, revision, chainIdentity);
  const identityB = selection.recallExecutionIdentity(valuesB, executionB, revision, chainIdentity);
  const keyA = selection.recallPreparationKey(revision, identityA, executionA, arm);
  const keyB = selection.recallPreparationKey(revision, identityB, executionB, arm);
  const dataset = join(root, "longmemeval_s.json"), arms = join(root, "arms.json"), out = join(root, "out");
  const pinned = join(root, "pinned"), hook = join(root, "dataset-hook.mjs"), trace = join(root, "selection-trace.json");
  const configA = { implementation_revision: revision, source_index: executionA };
  const configAPath = join(cache, "fixture", keyA, "prepare", "chain-config.json");
  const configBPath = join(cache, "fixture", keyB, "prepare", "chain-config.json");
  try {
    expect(selection.recallExecutionIdentity({}, executionA, revision, chainIdentity)).toBeUndefined();
    expect(identityA).not.toBe(identityB);
    expect(keyA).not.toBe(keyB);
    let selectionError: unknown;
    try { selection.assertRecallCachedPreparation(configA, revision, executionB, arm); }
    catch (error) { selectionError = error; }
    expect(selectionError).toMatchObject({ code: "CONFLICT", message: "cached Source preparation uses a different execution selection" });
    mkdirSync(join(cache, "fixture", keyA, "prepare"), { recursive: true });
    mkdirSync(join(cache, "fixture", keyB, "prepare"), { recursive: true });
    writeFileSync(configAPath, JSON.stringify(configA));
    writeFileSync(configBPath, JSON.stringify(configA));
    writeFileSync(arms, JSON.stringify([arm]));
    const sample = { question_id: "fixture", question: "synthetic", question_type: "synthetic",
      question_date: "2026/10/28 (Wed) 12:00", answer: "fixture", haystack_session_ids: [],
      haystack_dates: [], haystack_sessions: [], answer_session_ids: [] };
    const raw = JSON.stringify([sample, { ...sample, question_id: "second" }, { ...sample, question_id: "third" }]);
    writeFileSync(dataset, raw); mkdirSync(pinned);
    writeFileSync(join(pinned, "longmemeval_s.meta.json"), JSON.stringify({ sha256: createHash("sha256").update(raw).digest("hex"),
      size_bytes: Buffer.byteLength(raw), question_count: 3 }));
    const fetchPath = fileURLToPath(new URL("../../../dist/datasets/longmemeval/ingestion/fetch.js", import.meta.url));
    const fetchUrl = pathToFileURL(fetchPath).href;
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
        if (context.parentURL === ${JSON.stringify(pathToFileURL(harness).href)} && specifier === ${JSON.stringify(fetchPath)})
          return { url: ${JSON.stringify(`data:text/javascript,${encodeURIComponent(wrapper)}`)}, shortCircuit: true };
        return next(specifier, context);
      } });`);
    const args = (output: string, modelCache: string) => [`--import=${hook}`, harness, "--out", output, "--arms", arms, "--dataset", dataset,
      "--cache", cache, "--model-cache", modelCache, "--ids", "fixture"];
    await promisify(execFile)(process.execPath, args(out, cacheA), { timeout: 30_000 });
    const rowA = JSON.parse(readFileSync(join(out, "rows.jsonl"), "utf8"));
    expect(rowA.source_execution_identity).toBe(identityA);
    expect(rowA.status).toBe("error"); // Synthetic cached config intentionally stops before daemon/model execution.
    expect(rowA.error).not.toContain("cached Source preparation uses a different execution selection");
    const resumed = await promisify(execFile)(process.execPath, args(out, cacheB), { timeout: 30_000 })
      .then(() => { throw new Error("changed cache must not resume old rows"); }, (error: Error & { stderr: string }) => error);
    expect(resumed.stderr).toContain("existing rows use a different Source or Memory execution");
    const otherOut = join(root, "other-out");
    await promisify(execFile)(process.execPath, args(otherOut, cacheB), { timeout: 30_000 });
    const rowB = JSON.parse(readFileSync(join(otherOut, "rows.jsonl"), "utf8"));
    expect(rowB.source_execution_identity).toBe(identityB);
    expect(rowB.error).toContain("cached Source preparation uses a different execution selection");

    const emptyArms = join(root, "empty-arms.json"); writeFileSync(emptyArms, "[]");
    for (const [name, shard, expected] of [
      ["ordered", [], [["third", 2], ["fixture", 0]]],
      ["sharded", ["--shard", "1/2"], [["fixture", 0]]]
    ] as const) {
      await promisify(execFile)(process.execPath, [`--import=${hook}`, harness, "--out", join(root, `${name}-out`),
        "--arms", emptyArms, "--dataset", dataset, "--cache", join(root, `${name}-cache`),
        "--ids", "third,fixture,second", "--limit", "2", ...shard], { timeout: 30_000 });
      const selected = JSON.parse(readFileSync(trace, "utf8"));
      expect(selected.entries.map((entry: { question: { question_id: string }; index: number }) =>
        [entry.question.question_id, entry.index])).toEqual(expected);
      expect(selected.requested).toEqual(expected.map(([id]) => id));
      expect(selected.sha256).toBe(createHash("sha256").update(raw).digest("hex"));
    }

    for (const [name, selectedDataset, id, expected] of [
      ["noncanonical", join(root, "synthetic.json"), "fixture", "--dataset must name the canonical longmemeval_s.json file"],
      ["unknown", dataset, "missing", "unknown question missing"]
    ] as const) {
      const refusedOut = join(root, `${name}-out`), refusedCache = join(root, `${name}-cache`);
      const refusal = await promisify(execFile)(process.execPath, [`--import=${hook}`, harness, "--out", refusedOut, "--arms", arms,
        "--dataset", selectedDataset, "--cache", refusedCache, "--ids", id], { timeout: 30_000 })
        .then(() => { throw new Error("invalid dataset selection must be refused"); }, (error: Error & { stderr: string }) => error);
      expect(refusal.stderr).toContain(expected);
      expect(existsSync(refusedOut)).toBe(false); expect(existsSync(refusedCache)).toBe(false);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);
