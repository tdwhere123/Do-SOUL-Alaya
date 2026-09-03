import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireExtractionCacheWriteLease,
  type ExtractionCacheWriteLease
} from "../../../runs/extraction/fill/manifest/fill-root-guard.js";
import { semanticPackRequestSha256 } from
  "../../../runs/extraction/cache/semantic-artifact/admit.js";
import { runSemanticFill } from
  "../../../runs/extraction/fill/semantic-fill-executor.js";
import {
  createOfflineSemanticEnvelope,
  createOfflineSemanticReplay,
  createOfflineSemanticReplayForTasks
} from "../../../runs/extraction/fill/semantic-fill-envelope.js";
import * as receiptApi from
  "../../../runs/extraction/fill/semantic-fill-receipt.js";
import {
  computeLazySemanticRunIdentity,
  LazySemanticRunReceiptSchema,
  unwrapVerifiedLazySemanticRunReceipt,
  type LazySemanticRunReceipt
} from "../../../runs/extraction/fill/semantic-fill-receipt.js";
import { sealSemanticArtifact } from
  "../../../runs/extraction/cache/semantic-artifact/contract.js";
import {
  inspectSemanticArtifact,
  listSemanticArtifactInventory,
  materializeDerivedReplayFromRaw,
  semanticArtifactPath
} from "../../../runs/extraction/cache/semantic-artifact/store.js";
import {
  assertSemanticArtifactCompatibility,
  semanticTaskIdentity
} from "../../../runs/extraction/cache/semantic-artifact/admission-identity.js";
import {
  currentSemanticReplayAuthority,
  semanticReplayIdentityDigest,
  unwrapSemanticReplayAuthority
} from "../../../runs/extraction/cache/semantic-artifact/replay-authority.js";
import {
  SEMANTIC_CAPABILITY,
  TOKEN_AWARE_POLICY,
  semanticTask,
  semanticTasks
} from "./semantic-artifact-fixture.js";
import { transportPackIdentity } from "@do-soul/alaya-soul";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) =>
  rm(root, { recursive: true, force: true }))));

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function resign(
  receipt: LazySemanticRunReceipt,
  change: (unsigned: Record<string, unknown>) => Record<string, unknown>
): LazySemanticRunReceipt {
  const { runIdentity: _run, receiptDigest: _receipt, ...base } = receipt;
  const unsigned = change(base);
  const runIdentity = computeLazySemanticRunIdentity(unsigned as never);
  return {
    ...unsigned,
    runIdentity,
    receiptDigest: digest(JSON.stringify({ ...unsigned, runIdentity }))
  } as LazySemanticRunReceipt;
}

async function failedReceipt() {
  const root = await mkdtemp(join(tmpdir(), "semantic-receipt-authority-"));
  roots.push(root);
  const report = await runSemanticFill({
    root,
    tasks: [semanticTask()],
    envelope: createOfflineSemanticEnvelope({
      maxCalls: 1,
      maxFailures: 1,
      transportPolicy: TOKEN_AWARE_POLICY
    }),
    transport: createOfflineSemanticReplay({
      defaultResult: { kind: "failure", reason: "offline fixture" }
    })
  });
  return { root, receipt: report.lazyRunReceipt };
}

describe("lazy semantic receipt authority", () => {
  it("does not trust a caller-written self-digested receipt or expose it to provenance", async () => {
    const { root, receipt } = await failedReceipt();
    const forged = resign(receipt, (unsigned) => ({
      ...unsigned,
      budget: { ...receipt.budget, maxCalls: receipt.budget.maxCalls + 1 }
    }));
    await mkdir(join(root, "receipts"), { recursive: true });
    await writeFile(
      join(root, "receipts", `${forged.runIdentity}.json`),
      `${JSON.stringify(forged)}\n`,
      "utf8"
    );

    expect(receiptApi).not.toHaveProperty("readVerifiedLazySemanticRunReceipt");
    expect(() => receiptApi.loadVerifiedLazySemanticRunReceipt({
      semanticRoot: root,
      extractionCacheRoot: join(root, "caller-claimed-extraction"),
      runIdentity: forged.runIdentity
    })).toThrow(/physical extraction authority/iu);
    expect(() => unwrapVerifiedLazySemanticRunReceipt({ receipt: forged } as never))
      .toThrow(/verified persisted receipt handle|receipt.*authority/iu);
  });

  it("rejects replayable receipts with empty demand or calls beyond budget", async () => {
    const { receipt } = await failedReceipt();
    const emptyDemand = resign(receipt, (unsigned) => ({
      ...unsigned,
      demandTraceIdentity: digest(""),
      demandUnits: [],
      attempts: [],
      uniqueUnits: 0,
      occurrenceCount: 0,
      bindingCount: 0,
      cold: 0,
      warm: 0,
      calls: 0,
      failures: 0,
      failedUnits: 0,
      unavailable: 0,
      attemptCount: 0
    }));
    const overBudget = resign(receipt, (unsigned) => ({
      ...unsigned,
      budget: { ...receipt.budget, maxCalls: 0 }
    }));

    expect(LazySemanticRunReceiptSchema.safeParse(emptyDemand).success).toBe(false);
    expect(LazySemanticRunReceiptSchema.safeParse(overBudget).success).toBe(false);
  });
});

function errorMessages(cause: unknown): readonly string[] {
  if (!(cause instanceof Error)) return [String(cause)];
  return cause instanceof AggregateError
    ? [cause.message, ...cause.errors.flatMap(errorMessages)]
    : [cause.message];
}

function permutedSourceAuthority(
  authority: ReturnType<typeof semanticTask>["sourceAuthority"]
): ReturnType<typeof semanticTask>["sourceAuthority"] {
  const manifest = authority.substrateManifest;
  return {
    substrateCacheKeys: [...authority.substrateCacheKeys],
    substrateManifest: {
      windowLimit: manifest.windowLimit,
      windowOffset: manifest.windowOffset,
      contentClosureIndexSha256: manifest.contentClosureIndexSha256,
      contentClosureSha256: manifest.contentClosureSha256,
      expectedKeySetSha256: manifest.expectedKeySetSha256,
      expectedTurns: manifest.expectedTurns,
      cacheKeyAlgorithm: manifest.cacheKeyAlgorithm,
      systemPromptSha256: manifest.systemPromptSha256,
      requestProfile: manifest.requestProfile,
      modelFamily: manifest.modelFamily,
      extractionModel: manifest.extractionModel,
      datasetRevision: manifest.datasetRevision,
      dataset: manifest.dataset,
      manifestSha256: manifest.manifestSha256,
      schemaVersion: manifest.schemaVersion
    },
    datasetRevision: authority.datasetRevision
  };
}

function rawResult(text: string, assertionId: number) {
  return {
    kind: "raw" as const,
    rawJson: JSON.stringify({ signals: [{
      object_kind: "fact",
      confidence: 0.9,
      matched_text: text.replace(/^(?:User|Assistant): /u, ""),
      source_locator: {
        contract_version: 2,
        kind: "assertion_catalog",
        assertion_id: assertionId
      }
    }] })
  };
}

describe("offline semantic replay execution identity", () => {
  it("rejects caller-supplied replay labels before they can admit an artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "semantic-replay-forged-labels-"));
    roots.push(root);
    const task = semanticTask();
    const ownerIdentity = unwrapSemanticReplayAuthority(currentSemanticReplayAuthority());
    const forgedIdentity = {
      ...ownerIdentity,
      parserSemanticsVersion: "caller-forged-parser-v999"
    };
    expect(() => createOfflineSemanticReplayForTasks({
      tasks: [task],
      transportPolicy: TOKEN_AWARE_POLICY,
      result: rawResult(task.text, task.assertionId),
      replaySemantics: forgedIdentity
    } as never)).toThrow(/caller-supplied execution authority/iu);

    const transport = createOfflineSemanticReplayForTasks({
      tasks: [task],
      transportPolicy: TOKEN_AWARE_POLICY,
      result: rawResult(task.text, task.assertionId)
    });
    await expect(runSemanticFill({
      root,
      tasks: [task],
      envelope: {
        ...createOfflineSemanticEnvelope({
          maxCalls: 1, maxFailures: 1, transportPolicy: TOKEN_AWARE_POLICY
        }),
        replaySemantics: forgedIdentity
      } as never,
      transport
    })).rejects.toThrow(/caller-supplied execution authority/iu);
    expect(inspectSemanticArtifact(root, task.semanticKey, SEMANTIC_CAPABILITY).status)
      .toBe("missing");
  });

  it("replays parser and materializer drift from raw into a coexisting derived identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "semantic-replay-version-drift-"));
    roots.push(root);
    const task = semanticTask();
    const result = rawResult(task.text, task.assertionId);
    const envelope = createOfflineSemanticEnvelope({
      maxCalls: 1, maxFailures: 1, transportPolicy: TOKEN_AWARE_POLICY
    });
    const transport = createOfflineSemanticReplayForTasks({
      tasks: [task], transportPolicy: TOKEN_AWARE_POLICY, result
    });
    const cold = await runSemanticFill({ root, tasks: [task], envelope, transport });
    expect(cold.admitted).toBe(1);
    expect(cold.calls).toBe(1);

    const ownerIdentity = unwrapSemanticReplayAuthority(currentSemanticReplayAuthority());
    const admitted = inspectSemanticArtifact(root, task.semanticKey, SEMANTIC_CAPABILITY).artifact!;
    const currentPath = semanticArtifactPath(root, task.semanticKey, SEMANTIC_CAPABILITY);
    const rawPath = join(root, "raw", admitted.raw_response_digest!.slice(0, 2),
      `${admitted.raw_response_digest}.json`);
    const rawBefore = await readFile(rawPath, "utf8");

    const driftedIdentity = {
      ...ownerIdentity,
      parserSemanticsVersion: `${ownerIdentity.parserSemanticsVersion}-previous`,
      materializerSemanticsVersion: `${ownerIdentity.materializerSemanticsVersion}-previous`
    };
    const driftedDigest = semanticReplayIdentityDigest(driftedIdentity);
    const { artifact_digest: _artifactDigest, ...unsigned } = admitted;
    const drifted = sealSemanticArtifact({
      ...unsigned,
      replay_identity: driftedIdentity,
      replay_identity_digest: driftedDigest,
      raw_evidence_binding: {
        ...admitted.raw_evidence_binding!,
        replay_identity_digest: driftedDigest
      }
    });
    const driftedPath = semanticArtifactPath(
      root, task.semanticKey, SEMANTIC_CAPABILITY, driftedDigest
    );
    mkdirSync(dirname(driftedPath), { recursive: true });
    writeFileSync(driftedPath, `${JSON.stringify(drifted, null, 2)}\n`, "utf8");
    expect(existsSync(currentPath)).toBe(true);
    expect(existsSync(driftedPath)).toBe(true);
    expect(listSemanticArtifactInventory(root)).toHaveLength(2);

    expect(() => materializeDerivedReplayFromRaw({ root, task } as never))
      .toThrow(/owned write lease|assertOwned|lease/u);
    const lease = acquireExtractionCacheWriteLease(root);
    try {
      const replayed = materializeDerivedReplayFromRaw({ root, task, lease });
      expect(replayed.replay_identity_digest).toBe(semanticReplayIdentityDigest(ownerIdentity));
      expect(replayed.raw_response_digest).toBe(admitted.raw_response_digest);
      expect(await readFile(rawPath, "utf8")).toBe(rawBefore);
      expect(existsSync(driftedPath)).toBe(true);
      expect(inspectSemanticArtifact(root, task.semanticKey, SEMANTIC_CAPABILITY)
        .artifact?.replay_identity_digest).toBe(admitted.replay_identity_digest);

      rmSync(currentPath);
      const providerCalls = { count: 0 };
      const replayedAgain = materializeDerivedReplayFromRaw({ root, task, lease });
      expect(providerCalls.count).toBe(0);
      expect(replayedAgain.replay_identity_digest).toBe(admitted.replay_identity_digest);
      expect(replayedAgain.replay_identity_digest).not.toBe(driftedDigest);
      expect(existsSync(driftedPath)).toBe(true);
      expect(existsSync(currentPath)).toBe(true);
      expect(await readFile(rawPath, "utf8")).toBe(rawBefore);
      expect(listSemanticArtifactInventory(root).map((item) => item.replay_identity_digest)
        .sort()).toEqual([driftedDigest, admitted.replay_identity_digest].sort());
    } finally {
      lease.release();
    }
  });

  it("rematerializes packed reference_batch_8 members after parser drift without provider calls", async () => {
    const root = await mkdtemp(join(tmpdir(), "semantic-replay-packed-drift-"));
    roots.push(root);
    const tasks = semanticTasks(["I moved to Berlin.", "I moved to Paris."]);
    const firstTask = tasks[0];
    const secondTask = tasks[1];
    if (firstTask === undefined || secondTask === undefined) {
      throw new Error("packed drift fixture expected two semantic tasks");
    }
    const policy = { kind: "reference_batch_8" as const };
    const rawJson = JSON.stringify({
      signals: tasks.map((task) => ({
        object_kind: "fact",
        confidence: 0.9,
        matched_text: task.text.replace(/^(?:User|Assistant): /u, ""),
        source_locator: {
          contract_version: 2,
          kind: "assertion_catalog",
          assertion_id: task.assertionId
        }
      }))
    });
    const cold = await runSemanticFill({
      root,
      tasks,
      envelope: createOfflineSemanticEnvelope({
        maxCalls: 1, maxFailures: 1, transportPolicy: policy
      }),
      transport: createOfflineSemanticReplayForTasks({
        tasks, transportPolicy: policy, result: { kind: "raw", rawJson }
      })
    });
    expect(cold.admitted).toBe(2);
    expect(cold.calls).toBe(1);
    const first = inspectSemanticArtifact(root, firstTask.semanticKey, SEMANTIC_CAPABILITY).artifact!;
    const second = inspectSemanticArtifact(root, secondTask.semanticKey, SEMANTIC_CAPABILITY).artifact!;
    expect(first.raw_evidence_binding?.policy_kind).toBe("reference_batch_8");
    expect(first.raw_evidence_binding?.member_semantic_keys).toEqual(
      second.raw_evidence_binding?.member_semantic_keys
    );
    expect(first.raw_evidence_binding?.member_semantic_keys).toHaveLength(2);
    expect(first.raw_evidence_binding?.pack_identity).toBe(second.raw_evidence_binding?.pack_identity);
    expect(first.raw_evidence_binding?.pack_identity).not.toBe(
      transportPackIdentity("token_aware", [firstTask.semanticKey])
    );
    expect(first.raw_evidence_binding?.pack_identity).not.toBe(
      transportPackIdentity("reference_batch_8", [firstTask.semanticKey])
    );

    const ownerIdentity = unwrapSemanticReplayAuthority(currentSemanticReplayAuthority());
    const driftedIdentity = {
      ...ownerIdentity,
      parserSemanticsVersion: `${ownerIdentity.parserSemanticsVersion}-previous`,
      materializerSemanticsVersion: `${ownerIdentity.materializerSemanticsVersion}-previous`
    };
    const driftedDigest = semanticReplayIdentityDigest(driftedIdentity);
    for (const admitted of [first, second]) {
      const { artifact_digest: _digest, ...unsigned } = admitted;
      const drifted = sealSemanticArtifact({
        ...unsigned,
        replay_identity: driftedIdentity,
        replay_identity_digest: driftedDigest,
        raw_evidence_binding: {
          ...admitted.raw_evidence_binding!,
          replay_identity_digest: driftedDigest
        }
      });
      const driftedPath = semanticArtifactPath(
        root, admitted.semantic_key, SEMANTIC_CAPABILITY, driftedDigest
      );
      mkdirSync(dirname(driftedPath), { recursive: true });
      writeFileSync(driftedPath, `${JSON.stringify(drifted, null, 2)}\n`, "utf8");
      rmSync(semanticArtifactPath(root, admitted.semantic_key, SEMANTIC_CAPABILITY));
    }

    const lease = acquireExtractionCacheWriteLease(root);
    try {
      const replayedFirst = materializeDerivedReplayFromRaw({ root, task: firstTask, lease });
      const replayedSecond = materializeDerivedReplayFromRaw({ root, task: secondTask, lease });
      expect(replayedFirst.replay_identity_digest).toBe(semanticReplayIdentityDigest(ownerIdentity));
      expect(replayedSecond.replay_identity_digest).toBe(replayedFirst.replay_identity_digest);
      expect(replayedFirst.raw_evidence_binding?.policy_kind).toBe("reference_batch_8");
      expect(replayedFirst.raw_evidence_binding?.pack_identity)
        .toBe(first.raw_evidence_binding?.pack_identity);
      expect(replayedFirst.raw_evidence_binding?.member_semantic_keys)
        .toEqual(first.raw_evidence_binding?.member_semantic_keys);
      expect(replayedFirst.raw_response_digest).toBe(first.raw_response_digest);
      expect(replayedSecond.raw_response_digest).toBe(second.raw_response_digest);
    } finally {
      lease.release();
    }
  });

  it("keeps semantic task identity stable across provider URL changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "semantic-replay-endpoint-"));
    roots.push(root);
    const task = semanticTask();
    await runSemanticFill({
      root, tasks: [task],
      envelope: createOfflineSemanticEnvelope({
        maxCalls: 1, maxFailures: 1, transportPolicy: TOKEN_AWARE_POLICY
      }),
      transport: createOfflineSemanticReplayForTasks({
        tasks: [task], transportPolicy: TOKEN_AWARE_POLICY,
        result: rawResult(task.text, task.assertionId)
      })
    });
    const artifact = inspectSemanticArtifact(root, task.semanticKey, SEMANTIC_CAPABILITY).artifact!;
    const shifted = { ...task, providerUrlSha256: "ff".repeat(32) };
    expect(semanticTaskIdentity(shifted)).toBe(semanticTaskIdentity(task));
    expect(() => assertSemanticArtifactCompatibility(shifted, artifact, false)).not.toThrow();
  });

  it("binds pack request identity to canonical source-authority field order", async () => {
    const root = await mkdtemp(join(tmpdir(), "semantic-replay-request-order-"));
    roots.push(root);
    const base = semanticTask();
    const permuted = permutedSourceAuthority(base.sourceAuthority);
    expect(JSON.stringify(permuted)).not.toBe(JSON.stringify(base.sourceAuthority));
    const task = { ...base, sourceAuthority: permuted };
    const packIdentity = transportPackIdentity("token_aware", [task.semanticKey]);
    const expected = semanticPackRequestSha256({
      packIdentity,
      sourceCorpusIdentity: task.binding.sourceCorpusIdentity,
      sourceAuthority: base.sourceAuthority,
      members: [task]
    });
    expect(semanticPackRequestSha256({
      packIdentity,
      sourceCorpusIdentity: task.binding.sourceCorpusIdentity,
      sourceAuthority: permuted,
      members: [task]
    })).toBe(expected);

    await runSemanticFill({
      root, tasks: [task],
      envelope: createOfflineSemanticEnvelope({
        maxCalls: 1, maxFailures: 1, transportPolicy: TOKEN_AWARE_POLICY
      }),
      transport: createOfflineSemanticReplayForTasks({
        tasks: [task], transportPolicy: TOKEN_AWARE_POLICY,
        result: rawResult(task.text, task.assertionId)
      })
    });
    expect(inspectSemanticArtifact(root, task.semanticKey, SEMANTIC_CAPABILITY)
      .artifact?.raw_evidence_binding?.request_sha256).toBe(expected);
  });

  it("surfaces derived rematerialization and reservation-release failures together", async () => {
    const root = await mkdtemp(join(tmpdir(), "semantic-replay-release-aggregate-"));
    roots.push(root);
    const task = semanticTask();
    await runSemanticFill({
      root, tasks: [task],
      envelope: createOfflineSemanticEnvelope({
        maxCalls: 1, maxFailures: 1, transportPolicy: TOKEN_AWARE_POLICY
      }),
      transport: createOfflineSemanticReplayForTasks({
        tasks: [task], transportPolicy: TOKEN_AWARE_POLICY,
        result: rawResult(task.text, task.assertionId)
      })
    });
    const admitted = inspectSemanticArtifact(root, task.semanticKey, SEMANTIC_CAPABILITY).artifact!;
    const ownerIdentity = unwrapSemanticReplayAuthority(currentSemanticReplayAuthority());
    const driftedIdentity = {
      ...ownerIdentity,
      parserSemanticsVersion: `${ownerIdentity.parserSemanticsVersion}-previous`,
      materializerSemanticsVersion: `${ownerIdentity.materializerSemanticsVersion}-previous`
    };
    const driftedDigest = semanticReplayIdentityDigest(driftedIdentity);
    const { artifact_digest: _digest, ...unsigned } = admitted;
    const drifted = sealSemanticArtifact({
      ...unsigned,
      replay_identity: driftedIdentity,
      replay_identity_digest: driftedDigest,
      raw_evidence_binding: {
        ...admitted.raw_evidence_binding!,
        replay_identity_digest: driftedDigest
      }
    });
    const driftedPath = semanticArtifactPath(
      root, task.semanticKey, SEMANTIC_CAPABILITY, driftedDigest
    );
    mkdirSync(dirname(driftedPath), { recursive: true });
    writeFileSync(driftedPath, `${JSON.stringify(drifted, null, 2)}\n`, "utf8");
    rmSync(semanticArtifactPath(root, task.semanticKey, SEMANTIC_CAPABILITY));

    const inner = acquireExtractionCacheWriteLease(root);
    let asserts = 0;
    const lease: ExtractionCacheWriteLease = {
      cacheRoot: inner.cacheRoot,
      generation: inner.generation,
      stableRootPath: inner.stableRootPath,
      rootIdentity: inner.rootIdentity,
      assertOwned() {
        inner.assertOwned();
        asserts += 1;
        if (asserts === 3) {
          writeFileSync(
            `${semanticArtifactPath(root, task.semanticKey, SEMANTIC_CAPABILITY)}.reserve`,
            "corrupt reservation\n",
            "utf8"
          );
        }
      },
      assertRoot: (candidate) => inner.assertRoot(candidate),
      release: () => inner.release()
    };
    try {
      let failure: unknown;
      try {
        materializeDerivedReplayFromRaw({ root, task, lease });
      } catch (cause) {
        failure = cause;
      }
      expect(failure).toBeInstanceOf(AggregateError);
      const messages = errorMessages(failure).join("\n");
      expect(messages).toMatch(/derived rematerialization and reservation release both failed/u);
      expect(messages).toMatch(/reservation token mismatch/u);
      expect(existsSync(
        `${semanticArtifactPath(root, task.semanticKey, SEMANTIC_CAPABILITY)}.reserve`
      )).toBe(true);
    } finally {
      lease.release();
    }
  });
});
