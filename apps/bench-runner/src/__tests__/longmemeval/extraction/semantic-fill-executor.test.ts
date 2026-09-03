import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planOfficialApiSemanticWorkset } from "@do-soul/alaya-soul";
import {
  inspectSemanticArtifact,
  reserveSemanticArtifact,
  semanticArtifactPath
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
import { reserveSemanticPack } from
  "../../../runs/extraction/fill/semantic-fill-pack-execution.js";
import { acquireExtractionCacheWriteLease } from
  "../../../runs/extraction/fill/manifest/fill-root-guard.js";
import {
  assertCensusLazySemanticReceiptFitsBoundedSerialization,
  estimateLazySemanticReceiptCensusBytes,
  MAX_LAZY_SEMANTIC_RUN_RECEIPT_BYTES
} from "../../../runs/extraction/fill/semantic-fill-receipt.js";
import {
  SEMANTIC_CAPABILITY as CAP,
  SEMANTIC_FIXTURE_DATASET_REVISION,
  TOKEN_AWARE_POLICY,
  semanticFixtureSourceAuthority,
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

function errorMessages(cause: unknown): readonly string[] {
  if (!(cause instanceof Error)) return [String(cause)];
  return cause instanceof AggregateError
    ? [cause.message, ...cause.errors.flatMap(errorMessages)]
    : [cause.message];
}

describe("semantic fill executor", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "semantic-fill-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("rejects unknown transports and unsafe envelopes before any invocation", async () => {
    const unknown = Object.freeze({ kind: "sealed-local-replay" as const });
    await expectRejection(runSemanticFill({
      root, tasks: [semanticTask()], envelope: envelope(), transport: unknown
    }), /sealed local replay/u);
    for (const invalid of [Number.NaN, -1, 0.5, Number.POSITIVE_INFINITY]) {
      await expectRejection(runSemanticFill({
        root,
        tasks: [semanticTask()],
        envelope: envelope({ maxCalls: invalid }),
        transport: createOfflineSemanticReplay({
          defaultResult: { kind: "failure", reason: "unused" }
        })
      }), /finite safe nonnegative integer/u);
    }
  });

  it("rejects successful replay without a physical request identity", () => {
    expect(() => createOfflineSemanticReplay({
      defaultResult: { kind: "raw", rawJson: '{"signals":[]}' }
    } as never)).toThrow(/physical request identity/u);
  });

  it("does not relabel replay across model execution identity", async () => {
    const task = semanticTask();
    const replay = createOfflineSemanticReplayForTasks({
      tasks: [task], transportPolicy: TOKEN_AWARE_POLICY,
      result: { kind: "raw", rawJson: rawForText(task.text) }
    });
    const report = await runSemanticFill({
      root,
      tasks: [{ ...task, modelId: "foreign-model" }],
      envelope: envelope(),
      transport: replay
    });
    expect(report.admitted).toBe(0);
    expect(report.failures).toBe(1);
    expect(report.attempts[0]?.reason).toMatch(/physical request identity/u);
  });

  it("does not relabel replay across source corpus identity", async () => {
    const text = "I moved to Berlin.";
    const firstSource = `${text} I prefer TypeScript.`;
    const secondSource = `${text} I prefer Rust.`;
    const firstUnit = planOfficialApiSemanticWorkset(firstSource, [
      { role: "user", content: firstSource }
    ], SEMANTIC_FIXTURE_DATASET_REVISION).units.find((unit) => unit.text.endsWith(text))!;
    const secondUnit = planOfficialApiSemanticWorkset(secondSource, [
      { role: "user", content: secondSource }
    ], SEMANTIC_FIXTURE_DATASET_REVISION).units.find((unit) => unit.text.endsWith(text))!;
    const first = semanticTask(text, {
      ...firstUnit,
      sourceAuthority: semanticFixtureSourceAuthority(firstUnit.sourceCorpus)
    });
    const second = semanticTask(text, {
      ...secondUnit,
      sourceAuthority: semanticFixtureSourceAuthority(secondUnit.sourceCorpus)
    });
    expect(first.semanticKey).toBe(second.semanticKey);
    expect(first.binding.sourceCorpusIdentity).not.toBe(second.binding.sourceCorpusIdentity);
    const replay = createOfflineSemanticReplayForTasks({
      tasks: [first], transportPolicy: TOKEN_AWARE_POLICY,
      result: { kind: "raw", rawJson: rawForText(text) }
    });
    const report = await runSemanticFill({
      root, tasks: [second], envelope: envelope(), transport: replay
    });
    expect(report.admitted).toBe(0);
    expect(report.attempts[0]?.reason).toMatch(/physical request identity/u);
  });

  it("rejects a foreign corpus relabeled onto substrate cache keys", async () => {
    const first = semanticTask("I moved to Berlin.");
    const second = semanticTask("I moved to Paris.");
    await expectRejection(runSemanticFill({
      root,
      tasks: [{ ...second, sourceAuthority: first.sourceAuthority }],
      envelope: envelope(),
      transport: createOfflineSemanticReplay({
        defaultResult: { kind: "failure", reason: "must not replay" }
      })
    }), /foreign source corpus authority/u);
  });

  it("honors cancellation before reservation", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled-before-reserve"));
    const task = semanticTask();
    await expectRejection(runSemanticFill({
      root,
      tasks: [task],
      envelope: envelope(),
      transport: createOfflineSemanticReplayForTasks({
        tasks: [task], transportPolicy: TOKEN_AWARE_POLICY,
        result: { kind: "raw", rawJson: rawForText(task.text) }
      }),
      signal: controller.signal
    }), /cancelled-before-reserve/u);
    expect(inspectSemanticArtifact(root, task.semanticKey, CAP).status).toBe("missing");
  });

  it("rejects a locator whose exact quote does not ground the task", async () => {
    const task = semanticTask();
    const report = await runSemanticFill({
      root,
      tasks: [task],
      envelope: envelope(),
      transport: createOfflineSemanticReplayForTasks({
        tasks: [task], transportPolicy: TOKEN_AWARE_POLICY,
        result: { kind: "raw", rawJson: rawForText("wrong quote") }
      })
    });
    expect(report.admitted).toBe(0);
    expect(report.attempts[0]?.reason).toMatch(/grounding rejected/u);
  });

  it("does not admit empty provider JSON as available", async () => {
    const task = semanticTask();
    const report = await runSemanticFill({
      root,
      tasks: [task],
      envelope: envelope(),
      transport: createOfflineSemanticReplayForTasks({
        tasks: [task], transportPolicy: TOKEN_AWARE_POLICY,
        result: { kind: "raw", rawJson: '{"signals":[]}' }
      })
    });
    expect(report.admitted).toBe(0);
    expect(report.calls).toBe(1);
    expect(report.attempts[0]?.outcome).toBe("unresolved");
    expect(inspectSemanticArtifact(root, task.semanticKey, CAP).status).toBe("quarantined");
  });

  it("uses the envelope token-aware policy and never calls unpackable work", async () => {
    const huge = semanticTask("I moved to Berlin.");
    const report = await runSemanticFill({
      root,
      tasks: [huge],
      envelope: envelope({
        transportPolicy: {
          kind: "token_aware",
          maxAssertions: 32,
          maxInputTokens: 1,
          expectedOutputCap: 1_500,
          systemPromptChars: 100
        }
      }),
      transport: createOfflineSemanticReplay({
        defaultResult: { kind: "failure", reason: "must not run" }
      })
    });
    expect(report.calls).toBe(0);
    expect(report.unresolved).toBe(1);
    expect(report.attempts[0]?.reason).toMatch(/unpackable/u);
  });

  it("splits only the size-failed pack under the same hard-cap policy", async () => {
    const tasks = semanticTasks(Array.from({ length: 9 }, (_, index) =>
      `I recorded durable detail number ${index + 1}.`));
    const report = await runSemanticFill({
      root,
      tasks,
      envelope: envelope({ transportPolicy: { kind: "reference_batch_8" } }),
      transport: createOfflineSemanticReplay({
        defaultResult: { kind: "size_failure", reason: "fixture cap" }
      })
    });
    expect(report.calls).toBe(16);
    expect(report).not.toHaveProperty("unavailable");
    expect(report.attempts).toHaveLength(9);
    expect(report.lazyRunReceipt.transportPolicy).toEqual({ kind: "reference_batch_8" });
  });

  it("does not mark failed transport work complete and honors stop-loss", async () => {
    const tasks = semanticTasks(Array.from({ length: 9 }, (_, index) =>
      `I recorded durable detail number ${index + 1}.`));
    const report = await runSemanticFill({
      root,
      tasks,
      envelope: envelope({ maxCalls: 1, maxFailures: 8, transportPolicy: { kind: "reference_batch_8" } }),
      transport: createOfflineSemanticReplay({
        defaultResult: { kind: "failure", reason: "rate limit" }
      })
    });
    expect(report.failures).toBe(1);
    expect(report.calls).toBe(1);
    expect(report.stopLoss).toBe(true);
    expect(report.attempts.filter((attempt) => attempt.outcome === "failed")).toHaveLength(8);
    expect(report.attempts.filter((attempt) => attempt.outcome === "unresolved")).toHaveLength(1);
  });

  it("rolls back earlier reservations when the second member is held", () => {
    const first = semanticTask("I moved to Berlin.");
    const second = semanticTask("I moved to Paris.");
    reserveSemanticArtifact(root, second.semanticKey, CAP);
    expect(() => reserveSemanticPack(root, [first, second])).toThrow(/reservation is held/u);
    expect(inspectSemanticArtifact(root, first.semanticKey, CAP).status).toBe("missing");
    expect(inspectSemanticArtifact(root, second.semanticKey, CAP).status).toBe("reserved");
  });

  it("separates unique semantic work from occurrence and binding counts", async () => {
    const first = semanticTask();
    const second = {
      ...first,
      binding: { ...first.binding, occurrenceIdentity: "99".repeat(32) }
    };
    const report = await runSemanticFill({
      root,
      tasks: [first, second],
      envelope: envelope(),
      transport: createOfflineSemanticReplay({
        defaultResult: { kind: "failure", reason: "offline fixture" }
      })
    });
    expect(report.lazyRunReceipt).toMatchObject({
      uniqueUnits: 1, occurrenceCount: 2, bindingCount: 2,
      attemptCount: 1, failures: 1, unavailable: 1
    });
  });

  it("rejects incompatible duplicate identities before replay", async () => {
    const valid = semanticTask();
    await expectRejection(runSemanticFill({
      root,
      tasks: [valid, { ...valid, modelId: "foreign-model" }],
      envelope: envelope(),
      transport: createOfflineSemanticReplay({
        defaultResult: { kind: "failure", reason: "must not replay" }
      })
    }), /incompatible task identities/u);
  });

  it("seals malformed raw bytes and digest as failed evidence without availability", async () => {
    const task = semanticTask();
    const malformed = "{not strict json";
    const report = await runSemanticFill({
      root,
      tasks: [task],
      envelope: envelope(),
      transport: createOfflineSemanticReplayForTasks({
        tasks: [task], transportPolicy: TOKEN_AWARE_POLICY,
        result: { kind: "raw", rawJson: malformed }
      })
    });
    expect(report.calls).toBe(1);
    expect(report.failures).toBe(1);
    expect(report.attempts[0]).toMatchObject({ outcome: "failed" });
    expect(inspectSemanticArtifact(root, task.semanticKey, CAP).status).toBe("missing");
    const evidence = readSemanticFillAttemptEvidence(root);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.response).toMatchObject({
      kind: "malformed_raw",
      rawUtf8: malformed,
      rawBytes: Buffer.byteLength(malformed, "utf8")
    });
    expect(evidence[0]?.response).toHaveProperty("rawSha256", expect.stringMatching(/^[a-f0-9]{64}$/u));
  });

  it("admits A while duplicate B remains unresolved", async () => {
    const [a, b] = semanticTasks(["I moved to Berlin.", "I moved to Paris."]);
    const rawJson = JSON.stringify({ signals: [signalFor(a!), signalFor(b!), signalFor(b!)] });
    const report = await runSemanticFill({
      root,
      tasks: [a!, b!],
      envelope: envelope(),
      transport: createOfflineSemanticReplayForTasks({
        tasks: [a!, b!], transportPolicy: TOKEN_AWARE_POLICY,
        result: { kind: "raw", rawJson }
      })
    });
    expect(report.admitted).toBe(1);
    expect(report.unresolved).toBe(1);
    expect(inspectSemanticArtifact(root, a!.semanticKey, CAP).status).toBe("provider_backed");
    expect(inspectSemanticArtifact(root, b!.semanticKey, CAP).status).toBe("missing");
    let resumedPhysicalCalls = 0;
    const resumed = await runSemanticFill({
      root,
      tasks: [a!, b!],
      envelope: envelope(),
      transport: createOfflineSemanticReplay({
        defaultResult: { kind: "failure", reason: "must use sealed response" },
        faultHooks: { afterPack: () => { resumedPhysicalCalls += 1; } }
      })
    });
    expect(resumedPhysicalCalls).toBe(0);
    expect(resumed.calls).toBe(1);
    expect(resumed.attempts).toEqual(expect.arrayContaining([
      expect.objectContaining({ semanticKey: a!.semanticKey, outcome: "skipped" }),
      expect.objectContaining({ semanticKey: b!.semanticKey, outcome: "unresolved" })
    ]));
  });

  it("ignores foreign assertion 999 without losing legal A", async () => {
    const [a, b] = semanticTasks(["I moved to Berlin.", "I moved to Paris."]);
    const foreign = {
      ...signalFor(a!),
      matched_text: "foreign",
      source_locator: {
        contract_version: 2, kind: "assertion_catalog", assertion_id: 999
      }
    };
    const report = await runSemanticFill({
      root,
      tasks: [a!, b!],
      envelope: envelope(),
      transport: createOfflineSemanticReplayForTasks({
        tasks: [a!, b!], transportPolicy: TOKEN_AWARE_POLICY,
        result: { kind: "raw", rawJson: JSON.stringify({ signals: [signalFor(a!), foreign] }) }
      })
    });
    expect(report.admitted).toBe(1);
    expect(inspectSemanticArtifact(root, a!.semanticKey, CAP).status).toBe("provider_backed");
    expect(inspectSemanticArtifact(root, b!.semanticKey, CAP).status).toBe("missing");
  });

  it("does not renew the physical-call budget across restart", async () => {
    const task = semanticTask();
    const first = await runSemanticFill({
      root, tasks: [task], envelope: envelope({ maxCalls: 1 }),
      transport: createOfflineSemanticReplay({
        defaultResult: { kind: "failure", reason: "sealed failure" }
      })
    });
    expect(first.calls).toBe(1);
    expect(first.failures).toBe(1);
    let laterPhysicalCalls = 0;
    for (const budget of [{ maxCalls: 2 }, { maxCalls: 1, maxFailures: 21 }]) {
      await expectRejection(runSemanticFill({
        root, tasks: [task], envelope: envelope(budget),
        transport: createOfflineSemanticReplay({
          defaultResult: { kind: "failure", reason: "must not run" },
          faultHooks: { afterPack: () => { laterPhysicalCalls += 1; } }
        })
      }), /budget or execution scope cannot widen or reset/u);
    }
    const resumed = await runSemanticFill({
      root, tasks: [task], envelope: envelope({ maxCalls: 1 }),
      transport: createOfflineSemanticReplay({
        defaultResult: { kind: "failure", reason: "must replay from disk" },
        faultHooks: { afterPack: () => { laterPhysicalCalls += 1; } }
      })
    });
    expect(laterPhysicalCalls).toBe(0);
    expect(resumed.calls).toBe(1);
    expect(resumed.failures).toBe(1);
    expect(resumed.lazyRunReceipt.calls).toBe(1);
    expect(resumed.lazyRunReceipt.failures).toBe(1);
  });

  it("does not swallow reservation release faults", async () => {
    const task = semanticTask();
    let failure: unknown;
    try {
      await runSemanticFill({
        root,
        tasks: [task],
        envelope: envelope(),
        transport: createOfflineSemanticReplay({
          defaultResult: { kind: "failure", reason: "primary transport failure" },
          faultHooks: {
            afterPack: () => writeFileSync(
              `${semanticArtifactPath(root, task.semanticKey, CAP)}.reserve`,
              "corrupt reservation\n",
              "utf8"
            )
          }
        })
      });
    } catch (cause) {
      failure = cause;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    const messages = errorMessages(failure).join("\n");
    expect(messages).toMatch(/primary transport failure/u);
    expect(messages).toMatch(/reservation token mismatch/u);
    expect(readSemanticFillAttemptEvidence(root)[0]?.response).toMatchObject({
      kind: "failure", reason: "primary transport failure"
    });
  });

  it("allows a new writer generation in the same process to recover an old reservation", async () => {
    const task = semanticTask();
    const firstLease = acquireExtractionCacheWriteLease(root);
    reserveSemanticArtifact(root, task.semanticKey, CAP, firstLease);
    firstLease.release();
    const report = await runSemanticFill({
      root,
      tasks: [task],
      envelope: envelope(),
      transport: createOfflineSemanticReplayForTasks({
        tasks: [task], transportPolicy: TOKEN_AWARE_POLICY,
        result: {
          kind: "raw",
          rawJson: rawForText(task.text.replace(/^(?:User|Assistant): /u, ""), task.assertionId)
        }
      })
    });
    expect(report.admitted).toBe(1);
    expect(inspectSemanticArtifact(root, task.semanticKey, CAP).status).toBe("provider_backed");
  });

  it("rejects an oversize receipt before publication and leaves no receipt file", async () => {
    const task = semanticTask();
    await expectRejection(runSemanticFill({
      root,
      tasks: [task],
      envelope: envelope({ maxCalls: 1, maxFailures: 1 }),
      transport: createOfflineSemanticReplay({
        defaultResult: { kind: "failure", reason: "bounded receipt fixture" }
      }),
      maxReceiptBytes: 1
    }), /bounded publication size/u);
    expect(existsSync(join(root, "receipts"))).toBe(false);
  });

  it("keeps the declared lazy-semantic census inside the shared bounded reader limit", () => {
    expect(() => assertCensusLazySemanticReceiptFitsBoundedSerialization({
      sourceCorpusCount: 35_946,
      substrateCacheKeyCount: 35_946
    })).not.toThrow();
    expect(estimateLazySemanticReceiptCensusBytes({
      occurrenceCount: 37_623,
      uniqueUnits: 35_946,
      sourceCorpusCount: 35_946,
      substrateCacheKeyCount: 35_946
    })).toBeLessThanOrEqual(MAX_LAZY_SEMANTIC_RUN_RECEIPT_BYTES);
  });

  it("rejects forged semantic keys before replay", async () => {
    const valid = semanticTask();
    const forged = { ...valid, semanticKey: "ab".repeat(32), binding: {
      ...valid.binding, semanticKey: "ab".repeat(32)
    } };
    await expectRejection(runSemanticFill({
      root, tasks: [forged], envelope: envelope(),
      transport: createOfflineSemanticReplay({ defaultResult: { kind: "failure", reason: "unused" } })
    }), /invalid v2 identity witness/u);
  });
});
