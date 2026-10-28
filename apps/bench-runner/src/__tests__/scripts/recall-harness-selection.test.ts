import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { chainIdentity } from "../../runs/recall-measurement/contract.js";
import { readCurrentExtractionAuthorityRevision } from "../../runs/extraction/authority/inspection.js";

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
  const dataset = join(root, "synthetic.json"), arms = join(root, "arms.json"), out = join(root, "out");
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
    writeFileSync(dataset, JSON.stringify([{ question_id: "fixture", question: "synthetic", question_type: "synthetic",
      question_date: "2026/10/28 (Wed) 12:00" }]));
    const args = (output: string, modelCache: string) => [harness, "--out", output, "--arms", arms, "--dataset", dataset,
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
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);
