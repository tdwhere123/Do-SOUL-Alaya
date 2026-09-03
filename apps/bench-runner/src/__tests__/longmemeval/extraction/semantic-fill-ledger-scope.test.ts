import { closeSync, constants, openSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  officialApiSemanticWorksetFromUnits,
  planOfficialApiTransport
} from "@do-soul/alaya-soul";
import {
  inspectSemanticArtifact,
  recordedSourceBindings
} from "../../../runs/extraction/cache/semantic-artifact/store.js";
import { runSemanticFill } from
  "../../../runs/extraction/fill/semantic-fill-executor.js";
import {
  createOfflineSemanticEnvelope,
  createOfflineSemanticReplay,
  createOfflineSemanticReplayForTasks
} from "../../../runs/extraction/fill/semantic-fill-envelope.js";
import { readSemanticFillAttemptEvidence } from
  "../../../runs/extraction/fill/semantic-fill-attempt-ledger.js";
import { toWorkUnit } from
  "../../../runs/extraction/fill/semantic-fill-plan.js";
import {
  SEMANTIC_CAPABILITY as CAP,
  TOKEN_AWARE_POLICY,
  semanticTask,
  semanticTasks
} from "./semantic-artifact-fixture.js";

function envelope(
  overrides: Partial<Parameters<typeof createOfflineSemanticEnvelope>[0]> = {}
) {
  return createOfflineSemanticEnvelope({
    maxCalls: 20,
    maxFailures: 20,
    transportPolicy: TOKEN_AWARE_POLICY,
    ...overrides
  });
}

async function expectRejection(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  let failure: unknown;
  try {
    await promise;
  } catch (cause) {
    failure = cause;
  }
  expect(failure).toBeInstanceOf(Error);
  expect(failure instanceof Error ? failure.message : String(failure)).toMatch(pattern);
}

function rawForText(text: string, assertionId = 1): string {
  return JSON.stringify({ signals: [{
    object_kind: "fact",
    confidence: 0.9,
    matched_text: text,
    source_locator: { contract_version: 2, kind: "assertion_catalog", assertion_id: assertionId }
  }] });
}

function signalFor(task: ReturnType<typeof semanticTask>) {
  return {
    object_kind: "fact",
    confidence: 0.9,
    matched_text: task.text.replace(/^(?:User|Assistant): /u, ""),
    source_locator: {
      contract_version: 2,
      kind: "assertion_catalog",
      assertion_id: task.assertionId
    }
  };
}

function rawForPack(tasks: readonly ReturnType<typeof semanticTask>[]): string {
  return JSON.stringify({ signals: tasks.map(signalFor) });
}

function reorderKeys<T extends object>(value: T, keys: readonly (keyof T)[]): T {
  const next = {} as T;
  for (const key of keys) next[key] = value[key];
  return next;
}

describe("semantic fill durable ledger scope", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "semantic-ledger-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("shares stop-loss across sequential sparse demands on the same root", async () => {
    const [first, second] = semanticTasks(["I moved to Berlin.", "I moved to Paris."]);
    const shared = envelope({ maxCalls: 1, maxFailures: 8 });
    const consumed = await runSemanticFill({
      root, tasks: [first!], envelope: shared,
      transport: createOfflineSemanticReplay({
        defaultResult: { kind: "failure", reason: "sealed failure" }
      })
    });
    expect(consumed.calls).toBe(1);
    const scopeIdentity = consumed.lazyRunReceipt.ledgerScopeIdentity;
    let laterPhysicalCalls = 0;
    await expectRejection(runSemanticFill({
      root, tasks: [second!], envelope: shared,
      transport: createOfflineSemanticReplay({
        defaultResult: { kind: "failure", reason: "must not start a new pack" },
        faultHooks: { afterPack: () => { laterPhysicalCalls += 1; } }
      })
    }), /stop-loss budget is exhausted/u);
    expect(laterPhysicalCalls).toBe(0);
    expect(scopeIdentity).toMatch(/^[a-f0-9]{64}$/u);
    expect(inspectSemanticArtifact(root, second!.semanticKey, CAP).status).toBe("missing");
  });

  it("shares stop-loss when extra directory fds occupy later descriptors", async () => {
    const [first, second] = semanticTasks(["I moved to Berlin.", "I moved to Paris."]);
    const shared = envelope({ maxCalls: 1, maxFailures: 8 });
    const consumed = await runSemanticFill({
      root, tasks: [first!], envelope: shared,
      transport: createOfflineSemanticReplay({
        defaultResult: { kind: "failure", reason: "sealed failure" }
      })
    });
    expect(consumed.calls).toBe(1);
    const held = holdExtraDirectoryFds(root, 32);
    try {
      let laterPhysicalCalls = 0;
      await expectRejection(runSemanticFill({
        root, tasks: [second!], envelope: shared,
        transport: createOfflineSemanticReplay({
          defaultResult: { kind: "failure", reason: "must not start a new pack" },
          faultHooks: { afterPack: () => { laterPhysicalCalls += 1; } }
        })
      }), /stop-loss budget is exhausted/u);
      expect(laterPhysicalCalls).toBe(0);
    } finally {
      releaseDirectoryFds(held);
    }
    expect(consumed.lazyRunReceipt.ledgerScopeIdentity).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("keeps the same scope identity when task and policy keys are reordered", async () => {
    const task = semanticTask();
    const policy = TOKEN_AWARE_POLICY;
    const first = await runSemanticFill({
      root, tasks: [task], envelope: envelope({ maxCalls: 1, transportPolicy: policy }),
      transport: createOfflineSemanticReplay({
        defaultResult: { kind: "failure", reason: "sealed failure" }
      })
    });
    const reorderedTask = reorderKeys(task, [
      "text", "binding", "sourceAuthority", "semanticIdentity", "assertionId",
      "capability", "semanticKey", "sourceCorpus", "semanticContract", "modelFamily",
      "modelId", "transportModelId", "requestProfile", "providerUrlSha256"
    ]);
    const reorderedPolicy = reorderKeys(policy, [
      "systemPromptChars", "expectedOutputCap", "maxInputTokens", "maxAssertions", "kind"
    ]);
    const resumed = await runSemanticFill({
      root, tasks: [reorderedTask],
      envelope: envelope({ maxCalls: 1, transportPolicy: reorderedPolicy }),
      transport: createOfflineSemanticReplay({
        defaultResult: { kind: "failure", reason: "must reuse sealed scope" }
      })
    });
    expect(resumed.lazyRunReceipt.ledgerScopeIdentity).toBe(
      first.lazyRunReceipt.ledgerScopeIdentity
    );
    expect(resumed.calls).toBe(1);
  });

  it("resumes a sealed raw without a second paid call or budget increment", async () => {
    const tasks = semanticTasks(["I moved to Berlin.", "I moved to Paris."]);
    const transportPolicy = TOKEN_AWARE_POLICY;
    const plan = planOfficialApiTransport(
      officialApiSemanticWorksetFromUnits(tasks.map(toWorkUnit)), transportPolicy
    );
    expect(plan.packs).toHaveLength(1);
    const controller = new AbortController();
    await expectRejection(runSemanticFill({
      root,
      tasks,
      envelope: envelope({ transportPolicy }),
      transport: createOfflineSemanticReplay({
        results: [{
          packId: plan.packs[0]!.pack_id,
          tasks,
          result: { kind: "raw", rawJson: rawForPack(tasks) }
        }],
        faultHooks: {
          afterPack: () => controller.abort(new Error("crash-after-seal"))
        }
      }),
      signal: controller.signal
    }), /crash-after-seal/u);
    const evidence = readSemanticFillAttemptEvidence(root);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.response?.kind).toBe("raw");
    expect(evidence[0]?.packComplete).toBe(false);
    let resumedPhysicalCalls = 0;
    const resumed = await runSemanticFill({
      root,
      tasks,
      envelope: envelope({ transportPolicy }),
      transport: createOfflineSemanticReplay({
        defaultResult: { kind: "failure", reason: "must use sealed raw" },
        faultHooks: { afterPack: () => { resumedPhysicalCalls += 1; } }
      })
    });
    expect(resumedPhysicalCalls).toBe(0);
    expect(resumed.calls).toBe(1);
    expect(resumed.admitted).toBe(2);
    expect(inspectSemanticArtifact(root, tasks[0]!.semanticKey, CAP).status)
      .toBe("provider_backed");
    expect(inspectSemanticArtifact(root, tasks[1]!.semanticKey, CAP).status)
      .toBe("provider_backed");
  });

  it("resumes sealed raw across extra directory fds without a second paid call", async () => {
    const tasks = semanticTasks(["I moved to Berlin.", "I moved to Paris."]);
    const transportPolicy = TOKEN_AWARE_POLICY;
    const plan = planOfficialApiTransport(
      officialApiSemanticWorksetFromUnits(tasks.map(toWorkUnit)), transportPolicy
    );
    expect(plan.packs).toHaveLength(1);
    const controller = new AbortController();
    await expectRejection(runSemanticFill({
      root,
      tasks,
      envelope: envelope({ transportPolicy }),
      transport: createOfflineSemanticReplay({
        results: [{
          packId: plan.packs[0]!.pack_id,
          tasks,
          result: { kind: "raw", rawJson: rawForPack(tasks) }
        }],
        faultHooks: {
          afterPack: () => controller.abort(new Error("crash-after-seal"))
        }
      }),
      signal: controller.signal
    }), /crash-after-seal/u);
    const held = holdExtraDirectoryFds(root, 32);
    try {
      let resumedPhysicalCalls = 0;
      const resumed = await runSemanticFill({
        root,
        tasks,
        envelope: envelope({ transportPolicy }),
        transport: createOfflineSemanticReplay({
          defaultResult: { kind: "failure", reason: "must use sealed raw" },
          faultHooks: { afterPack: () => { resumedPhysicalCalls += 1; } }
        })
      });
      expect(resumedPhysicalCalls).toBe(0);
      expect(resumed.calls).toBe(1);
      expect(resumed.admitted).toBe(2);
    } finally {
      releaseDirectoryFds(held);
    }
  });

  it("size-split retries only unresolved members while admitted stay admitted", async () => {
    const tasks = semanticTasks([
      "I recorded durable detail number 1.",
      "I recorded durable detail number 2.",
      "I recorded durable detail number 3.",
      "I recorded durable detail number 4."
    ]);
    const transportPolicy = { kind: "reference_batch_8" as const };
    const original = planOfficialApiTransport(
      officialApiSemanticWorksetFromUnits(tasks.map(toWorkUnit)), transportPolicy
    );
    expect(original.packs).toHaveLength(1);
    const members = original.packs[0]!.semantic_keys.map((key) =>
      tasks.find((task) => task.semanticKey === key)!);
    const midpoint = Math.ceil(members.length / 2);
    const firstHalf = members.slice(0, midpoint);
    const secondHalf = members.slice(midpoint);
    const firstHalfPlan = planOfficialApiTransport(
      officialApiSemanticWorksetFromUnits(firstHalf.map(toWorkUnit)), transportPolicy
    );
    const first = await runSemanticFill({
      root,
      tasks,
      envelope: envelope({ transportPolicy, maxCalls: 20 }),
      transport: createOfflineSemanticReplay({
        defaultResult: { kind: "size_failure", reason: "fixture cap" },
        results: [{
          packId: firstHalfPlan.packs[0]!.pack_id,
          tasks: firstHalf,
          result: { kind: "raw", rawJson: rawForPack(firstHalf) }
        }]
      })
    });
    for (const task of firstHalf) {
      expect(inspectSemanticArtifact(root, task.semanticKey, CAP).status)
        .toBe("provider_backed");
    }
    const called: string[] = [];
    const resumed = await runSemanticFill({
      root,
      tasks,
      envelope: envelope({ transportPolicy, maxCalls: 20 }),
      transport: createOfflineSemanticReplay({
        defaultResult: { kind: "failure", reason: "must not retry admitted" },
        faultHooks: { afterPack: (packId) => called.push(packId) }
      })
    });
    expect(called).not.toContain(firstHalfPlan.packs[0]!.pack_id);
    expect(called).not.toContain(original.packs[0]!.pack_id);
    expect(resumed.calls).toBe(first.calls);
    for (const task of firstHalf) {
      expect(inspectSemanticArtifact(root, task.semanticKey, CAP).status)
        .toBe("provider_backed");
    }
    expect(resumed.attempts).toEqual(expect.arrayContaining(firstHalf.map((task) =>
      expect.objectContaining({ semanticKey: task.semanticKey, outcome: "skipped" }))));
    expect(secondHalf.every((task) =>
      inspectSemanticArtifact(root, task.semanticKey, CAP).status !== "provider_backed")).toBe(true);
  });

  it("does not mint admission from a later success replay of a failed pack", async () => {
    const task = semanticTask();
    const first = await runSemanticFill({
      root, tasks: [task], envelope: envelope({ maxCalls: 2, maxFailures: 8 }),
      transport: createOfflineSemanticReplay({
        defaultResult: { kind: "failure", reason: "rate limit" }
      })
    });
    expect(first.failures).toBe(1);
    const resumed = await runSemanticFill({
      root, tasks: [task], envelope: envelope({ maxCalls: 2, maxFailures: 8 }),
      transport: createOfflineSemanticReplayForTasks({
        tasks: [task], transportPolicy: TOKEN_AWARE_POLICY,
        result: { kind: "raw", rawJson: rawForText(task.text, task.assertionId) }
      })
    });
    expect(resumed.admitted).toBe(0);
    expect(resumed.calls).toBe(1);
    expect(inspectSemanticArtifact(root, task.semanticKey, CAP).status).toBe("missing");
  });

  it("keeps the first source binding when a second occurrence shares the semantic key", async () => {
    const first = semanticTask();
    const second = {
      ...first,
      binding: { ...first.binding, occurrenceIdentity: "99".repeat(32) }
    };
    const report = await runSemanticFill({
      root,
      tasks: [first, second],
      envelope: envelope(),
      transport: createOfflineSemanticReplayForTasks({
        tasks: [first], transportPolicy: TOKEN_AWARE_POLICY,
        result: { kind: "raw", rawJson: rawForPack([first]) }
      })
    });
    expect(report.admitted).toBe(1);
    const artifact = inspectSemanticArtifact(root, first.semanticKey, CAP).artifact;
    expect(artifact?.source_bindings[0]?.occurrenceIdentity).toBe(first.binding.occurrenceIdentity);
    expect(artifact?.source_bindings[0]?.locator).toEqual(first.binding.locator);
    const recorded = recordedSourceBindings(root, first.semanticKey, CAP);
    expect(recorded.some((binding) =>
      binding.occurrenceIdentity === second.binding.occurrenceIdentity)).toBe(true);
  });
});

function holdExtraDirectoryFds(path: string, count: number): readonly number[] {
  const held: number[] = [];
  try {
    const directoryFlag = constants.O_RDONLY | constants.O_DIRECTORY;
    for (let index = 0; index < count; index += 1) {
      held.push(openSync(path, directoryFlag));
    }
    return held;
  } catch (cause) {
    releaseDirectoryFds(held);
    throw cause;
  }
}

function releaseDirectoryFds(held: readonly number[]): void {
  for (const descriptor of held) closeSync(descriptor);
}
