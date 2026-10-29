import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture, publishSource, WORKSPACE, type Fixture } from
  "../../../../../../packages/storage/src/__tests__/repos/source-index/source-index-fixture.js";
import { createSourceIndexProducer, type SourceIndexProducer } from
  "../../../../../core-daemon/src/runtime/source-index/source-index-producer.js";
import { runSourceIndexLexicalPreparation } from "../../../runs/recall-measurement/source-index-lexical-preparation.js";
import { prepareSemanticChainSourceIndex } from "../../../runs/recall-measurement/source-index-binding.js";
import { readChainArtifact } from "../../../runs/recall-measurement/contract.js";

const directories: string[] = [], environments: Fixture[] = [], producers: SourceIndexProducer[] = [];
afterEach(async () => {
  for (const producer of producers.splice(0)) await producer.stop();
  for (const environment of environments.splice(0)) environment.database.close({ optimize: false });
  for (const root of directories.splice(0)) rmSync(root, { force: true, recursive: true });
});
function setup(body = "lexical source fixture") {
  const root = mkdtempSync(join(tmpdir(), "lexical-preparation-")); directories.push(root);
  const environment = fixture(); environments.push(environment); publishSource(environment, body);
  const bind = vi.fn(async () => ({ status: "unsupported" as const, reason: "model_forbidden" }));
  const producer = createSourceIndexProducer({ database: environment.database, bindSourceEmbedding: bind, warn: vi.fn() });
  producers.push(producer);
  const live = { runtime: { runSourceIndexLexicalPass: producer.runLexicalPass.bind(producer) } };
  return { root, live, bind };
}

it("retains explicit lexical allocation and effective work from the real model-free producer before publication", async () => {
  const own = setup(), allocation = { work: 131072 };
  const pending = runSourceIndexLexicalPreparation({ ...own, workspace: WORKSPACE, representation: "segmented-unicode61.v1",
    maxPasses: 2, expired: () => false, allocation });
  allocation.work = 1;
  const report = await pending;
  expect(report).toMatchObject({ requested_allocation: { work: 131072 }, stop_reason: "ready",
    passes: [{ pass: 1, effective_work: 131072,
      receipt: { status: "ready", model_inputs: 0, preparation_allocation: { requested_work: 131072, effective_work: 131072 } } }] });
  expect(readChainArtifact(join(own.root, "lexical-passes/pass-1.json"))).toEqual(report.passes[0]);
  expect(own.bind).not.toHaveBeenCalled();
});

it("retains both real refused lexical passes when the default atomic work budget cannot advance", async () => {
  const own = setup("stone ".repeat(12984) + "x");
  const report = await runSourceIndexLexicalPreparation({ ...own, workspace: WORKSPACE, representation: "segmented-unicode61.v1",
    maxPasses: 3, expired: () => false });
  expect(report).toMatchObject({ requested_allocation: null, stop_reason: "lexical_no_progress" });
  expect(report.passes).toHaveLength(2);
  for (const entry of report.passes) {
    expect(entry.receipt).toMatchObject({ status: "partial", reason: "read_budget", model_inputs: 0,
      generation: { target_count: 1, completed_count: 0 } });
    expect(readChainArtifact(join(own.root, `lexical-passes/pass-${entry.pass}.json`))).toEqual(entry);
  }
  expect(own.bind).not.toHaveBeenCalled();
});

it("rejects malformed lexical setup allocations before starting a daemon or reading an input snapshot", async () => {
  for (const lexicalPreparation of [{ work: Number.NaN }, { work: 0 }, { work: 131072, nativeBytes: 8388608 }]) {
    await expect(prepareSemanticChainSourceIndex({}, {}, "/unused-fixture", undefined,
      { maxPasses: 1, lexicalPreparation } as never)).rejects.toThrow(/invalid Source lexical preparation allocation/u);
  }
});
