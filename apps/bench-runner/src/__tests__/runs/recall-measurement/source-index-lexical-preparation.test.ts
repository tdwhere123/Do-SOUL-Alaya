import { afterEach, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { SqliteEvidenceCapsuleRepo } from "@do-soul/alaya-storage";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture, publishSource, WORKSPACE, type Fixture } from
  "../../../../../../packages/storage/src/__tests__/repos/source-index/source-index-fixture.js";
import { createSourceIndexProducer, type SourceIndexProducer, type SourceIndexProducerLimits } from
  "../../../../../core-daemon/src/runtime/source-index/source-index-producer.js";
import { runSourceIndexLexicalPreparation } from "../../../runs/recall-measurement/source-index-lexical-preparation.js";
import { prepareSemanticChainSourceIndex } from "../../../runs/recall-measurement/source-index-binding.js";
import { readChainArtifact } from "../../../runs/recall-measurement/contract.js";
import { bindBenchDaemonTestSignal, clearBenchDaemonTestSignal } from "../../../harness/daemon-task.js";

const directories: string[] = [], environments: Fixture[] = [], producers: SourceIndexProducer[] = [];
afterEach(async () => {
  for (const producer of producers.splice(0)) await producer.stop();
  for (const environment of environments.splice(0)) environment.database.close({ optimize: false });
  for (const root of directories.splice(0)) rmSync(root, { force: true, recursive: true });
});
function setup(body = "lexical source fixture", limits: Partial<SourceIndexProducerLimits> = {}) {
  const root = mkdtempSync(join(tmpdir(), "lexical-preparation-")); directories.push(root);
  const environment = fixture(); environments.push(environment); publishSource(environment, body);
  const bind = vi.fn(async () => ({ status: "unsupported" as const, reason: "model_forbidden" }));
  const producer = createSourceIndexProducer({ database: environment.database, bindSourceEmbedding: bind, warn: vi.fn(), limits });
  producers.push(producer);
  const live = { runtime: { runSourceIndexLexicalPass: producer.runLexicalPass.bind(producer) } };
  return { root, live, bind, environment };
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

it("continues real census pages when only family state and capsule cursors advance at unchanged coverage", async () => {
  const own = setup("first root", { capturePage: 1, maxCapturePages: 1 });
  for (const digit of [1, 2]) await new SqliteEvidenceCapsuleRepo(own.environment.database).create({
    object_id: `00000000-0000-4000-8000-00000000000${digit}`, object_kind: "evidence_capsule", schema_version: 1,
    lifecycle_state: "archived", created_at: "2026-08-16T00:00:00.000Z", updated_at: "2026-08-16T00:00:00.000Z",
    created_by: "storage-test", evidence_kind: "conversation_excerpt", semantic_anchor: { topic: "archive", keywords: [], summary: "archive" },
    event_anchor: null, physical_anchor: null, evidence_health_state: "questionable", gist: "archived", excerpt: "archived",
    source_hash: null, run_id: "run-1", workspace_id: WORKSPACE, surface_id: null
  });
  const report = await runSourceIndexLexicalPreparation({ ...own, workspace: WORKSPACE, representation: "raw-unicode61.v1",
    maxPasses: 6, expired: () => false });
  expect(report.stop_reason).toBe("ready"); expect(report.passes).toHaveLength(5);
  expect(report.passes.slice(0, 4).map(entry => entry.receipt.reason)).toEqual(Array(4).fill("enumeration_page"));
  const generations = report.passes.map(entry => entry.receipt.generation!);
  expect(generations.slice(0, 4).map(g => [g.completed_count, g.target_count, g.enumeration_complete]))
    .toEqual(Array.from({ length: 4 }, () => [1, 1, false]));
  expect(generations[0]!.records_complete).toBe(false); expect(generations[1]!.records_complete).toBe(true);
  expect(generations[1]!.after_capsule_cursor).toBeNull();
  expect(generations[2]!.after_capsule_cursor).not.toBeNull();
  expect(generations[3]!.after_capsule_cursor).not.toBe(generations[2]!.after_capsule_cursor);
  for (const entry of report.passes) expect(readChainArtifact(join(own.root, `lexical-passes/pass-${entry.pass}.json`))).toEqual(entry);
  expect(own.bind).not.toHaveBeenCalled();
});

it.each([1, 4])("continues real remaining-budget progress within a %i-pass bound", async maxPasses => {
  const own = setup("first", { capturePage: 1 }); publishSource(own.environment, "second", "second");
  const report = await runSourceIndexLexicalPreparation({ ...own, workspace: WORKSPACE, representation: "raw-unicode61.v1",
    maxPasses, expired: () => false, allocation: { work: 330 } });
  expect(report.stop_reason).toBe(maxPasses === 1 ? "setup_pass_exhausted" : "ready");
  expect(report.passes).toHaveLength(maxPasses === 1 ? 1 : 3);
  expect(report.passes[0]!.receipt).toMatchObject({ status: "partial", reason: "enumeration_budget" });
  for (const entry of report.passes) {
    expect(entry.receipt.resources.work).toBeLessThanOrEqual(330);
    expect(readChainArtifact(join(own.root, `lexical-passes/pass-${entry.pass}.json`))).toEqual(entry);
  }
  expect(own.bind).not.toHaveBeenCalled();
});

it("persists an allocation refusal and stops that invocation without retrying", async () => {
  const own = setup();
  const report = await runSourceIndexLexicalPreparation({ ...own, workspace: WORKSPACE, representation: "raw-unicode61.v1",
    maxPasses: 4, expired: () => false, allocation: { work: 200 } });
  expect(report).toMatchObject({ stop_reason: "lexical_unavailable:enumeration_allocation_exhausted", passes: [
    { pass: 1, receipt: { status: "unavailable", reason: "enumeration_allocation_exhausted", generation: { after_source_id: null } } }
  ] });
  expect(readChainArtifact(join(own.root, "lexical-passes/pass-1.json"))).toEqual(report.passes[0]);
  expect(existsSync(join(own.root, "lexical-passes/pass-2.json"))).toBe(false);
});

it("persists the actual partial receipt before honoring cancellation and never starts another pass", async () => {
  const own = setup("first", { capturePage: 1, maxCapturePages: 1 }), controller = new AbortController();
  const run = own.live.runtime.runSourceIndexLexicalPass;
  own.live.runtime.runSourceIndexLexicalPass = vi.fn(async (...args: Parameters<typeof run>) => {
    const receipt = await run(...args); controller.abort(); return receipt;
  });
  bindBenchDaemonTestSignal(controller.signal);
  try {
    await expect(runSourceIndexLexicalPreparation({ ...own, workspace: WORKSPACE, representation: "raw-unicode61.v1",
      maxPasses: 4, expired: () => false })).rejects.toMatchObject({ code: "CANCELLED" });
    expect(own.live.runtime.runSourceIndexLexicalPass).toHaveBeenCalledTimes(1);
    const receipt = readChainArtifact(join(own.root, "lexical-passes/pass-1.json"));
    expect(receipt).toMatchObject({ receipt: { status: "partial", reason: "enumeration_page" } });
    expect(readChainArtifact(join(own.root, "lexical-failure-prefix.json"))).toMatchObject({ stop_reason: "threw", passes: [receipt] });
    expect(existsSync(join(own.root, "lexical-passes/pass-2.json"))).toBe(false);
  } finally { clearBenchDaemonTestSignal(controller.signal); }
});

it("rejects malformed lexical setup allocations before starting a daemon or reading an input snapshot", async () => {
  for (const lexicalPreparation of [{ work: Number.NaN }, { work: 0 }, { work: 131072, nativeBytes: 8388608 }]) {
    await expect(prepareSemanticChainSourceIndex({}, {}, "/unused-fixture", undefined,
      { maxPasses: 1, lexicalPreparation } as never)).rejects.toThrow(/invalid Source lexical preparation allocation/u);
  }
});
