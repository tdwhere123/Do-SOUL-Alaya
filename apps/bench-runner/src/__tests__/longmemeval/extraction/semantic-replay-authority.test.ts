import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireExtractionCacheWriteLease } from
  "../../../runs/extraction/fill/manifest/fill-root-guard.js";
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
  semanticTask
} from "./semantic-artifact-fixture.js";

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
});
