import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  officialApiSemanticWorksetFromUnits,
  planOfficialApiTransport
} from "@do-soul/alaya-soul";
import { inspectSemanticArtifact } from
  "../../../runs/extraction/cache/semantic-artifact/store.js";
import { runSemanticFill, type SemanticFillReport } from
  "../../../runs/extraction/fill/semantic-fill-executor.js";
import { createOfflineSemanticReplay } from
  "../../../runs/extraction/fill/semantic-fill-envelope.js";
import { toWorkUnit } from
  "../../../runs/extraction/fill/semantic-fill-plan.js";
import {
  SEMANTIC_CAPABILITY,
  semanticTasks
} from "./semantic-artifact-fixture.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) =>
  rm(root, { recursive: true, force: true }))));

function rawForPack(tasks: ReturnType<typeof semanticTasks>): string {
  return JSON.stringify({ signals: tasks.map((task) => ({
    object_kind: "fact",
    confidence: 0.9,
    matched_text: task.text.replace(/^(?:User|Assistant): /u, ""),
    source_locator: {
      contract_version: 2,
      kind: "assertion_catalog",
      assertion_id: task.assertionId
    }
  })) });
}

async function receiptFiles(root: string): Promise<readonly string[]> {
  try {
    return await readdir(join(root, "receipts"));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw cause;
  }
}

describe("semantic fill cancellation between transport packs", () => {
  it("settles abort after pack one, releases later work, publishes no receipt, and resumes remaining only", async () => {
    const root = await mkdtemp(join(tmpdir(), "semantic-pack-abort-"));
    roots.push(root);
    const tasks = semanticTasks(Array.from({ length: 18 }, (_, index) =>
      `I recorded durable detail number ${index + 1}.`)).slice(1);
    const transportPolicy = { kind: "reference_batch_8" as const };
    const plan = planOfficialApiTransport(
      officialApiSemanticWorksetFromUnits(tasks.map(toWorkUnit)),
      transportPolicy
    );
    expect(plan.packs.length).toBeGreaterThan(1);
    const membersByKey = new Map(tasks.map((task) => [task.semanticKey, task]));
    const results = plan.packs.map((pack) => {
      const members = pack.semantic_keys.map((key) => membersByKey.get(key)!);
      return {
        packId: pack.pack_id,
        tasks: members,
        result: { kind: "raw" as const, rawJson: rawForPack(members) }
      };
    });
    const controller = new AbortController();
    const executedPacks: string[] = [];
    const replayDescriptor = {
      results,
      faultHooks: {
        afterPack: (packId: string) => {
          executedPacks.push(packId);
          if (executedPacks.length === 1) {
            controller.abort(new Error("abort-after-first-response-before-receipt"));
          }
        }
      }
    };

    let completed: SemanticFillReport | undefined;
    let failure: unknown;
    try {
      completed = await runSemanticFill({
        root,
        tasks,
        envelope: {
          mode: "offline-only",
          maxCalls: plan.packs.length,
          maxFailures: plan.packs.length,
          transportPolicy
        },
        transport: createOfflineSemanticReplay(replayDescriptor),
        signal: controller.signal
      });
    } catch (cause) {
      failure = cause;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect.soft(failure).toBeInstanceOf(Error);
    expect.soft(failure instanceof Error ? failure.message : String(failure))
      .toMatch(/abort-after-first-response-before-receipt/u);
    expect.soft(completed === undefined).toBe(true);
    expect.soft(executedPacks).toEqual([plan.packs[0]!.pack_id]);
    expect.soft(await receiptFiles(root)).toEqual([]);

    const states = tasks.map((task) =>
      inspectSemanticArtifact(root, task.semanticKey, SEMANTIC_CAPABILITY).status);
    expect.soft(states.every((state) => state === "missing")).toBe(true);

    const resumedPhysicalPacks: string[] = [];
    const resumed = await runSemanticFill({
      root,
      tasks,
      envelope: {
        mode: "offline-only",
        maxCalls: plan.packs.length,
        maxFailures: plan.packs.length,
        transportPolicy
      },
      transport: createOfflineSemanticReplay({
        results: results.slice(1),
        faultHooks: { afterPack: (packId) => resumedPhysicalPacks.push(packId) }
      })
    });
    expect.soft(resumed.calls).toBe(plan.packs.length);
    expect.soft(resumed.lazyRunReceipt.calls).toBe(plan.packs.length);
    expect.soft(resumedPhysicalPacks).toEqual(plan.packs.slice(1).map((pack) => pack.pack_id));
    expect.soft(resumed.attempts.filter((attempt) => attempt.outcome === "skipped"))
      .toHaveLength(0);
    expect.soft(resumed.admitted).toBe(tasks.length);
  });
});
