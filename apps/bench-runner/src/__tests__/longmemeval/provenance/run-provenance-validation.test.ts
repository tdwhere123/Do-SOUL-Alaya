import { createHash } from "node:crypto";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveLocalArtifactTreeSha256 } from "../../../runs/provenance/embedding/local-onnx.js";
import {
  buildLongMemEvalRunProvenance,
  LongMemEvalRunProvenanceSchema
} from "../../../runs/provenance/run.js";
import {
  bindSnapshotRunProvenanceAuthority,
  compactSnapshotRunProvenance
} from "../../../runs/snapshot/run-provenance.js";
import { buildSnapshotExtractionAuthority } from
  "../../../runs/snapshot/extraction-authority.js";
import {
  fakeExecutedDistIdentity,
  registerRunProvenanceRootCleanup
} from "./run-provenance-fixture.js";
import { resolveBenchCommitSha7 } from "../../../shared/version.js";
import { runSemanticFill } from
  "../../../runs/extraction/fill/semantic-fill-executor.js";
import {
  computeLazySemanticRunIdentity,
  loadVerifiedLazySemanticRunReceipt,
  sealLazySemanticRunReceipt,
  serializeLazySemanticRunReceipt,
  type LazySemanticRunReceipt
} from "../../../runs/extraction/fill/semantic-fill-receipt.js";
import {
  createOfflineSemanticEnvelope,
  createOfflineSemanticReplayForTasks
} from "../../../runs/extraction/fill/semantic-fill-envelope.js";
import {
  SEMANTIC_FIXTURE_DATASET_REVISION,
  SEMANTIC_RAW,
  TOKEN_AWARE_POLICY,
  semanticArtifactUnsigned,
  semanticTask
} from "../extraction/semantic-artifact-fixture.js";
import { writeCompletedExtractionCacheFixture } from
  "../extraction/completed-extraction-cache-fixture.js";
import { readExtractionCacheManifestIdentity } from
  "../../../runs/extraction/cache/extraction-cache-manifest.js";
import { sealSemanticArtifact } from
  "../../../runs/extraction/cache/semantic-artifact/contract.js";
import {
  persistRawArtifact,
  recordSourceBinding,
  semanticArtifactPath
} from "../../../runs/extraction/cache/semantic-artifact/store.js";
import { buildSemanticSubstrateManifestAuthority } from
  "../../../runs/extraction/fill/semantic-fill-authority.js";

const roots = registerRunProvenanceRootCleanup();
const currentCommitSha7 = resolveBenchCommitSha7();

async function assertRejects(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  let failure: unknown;
  try {
    await promise;
  } catch (cause) {
    failure = cause;
  }
  expect(failure).toBeInstanceOf(Error);
  expect(failure instanceof Error ? failure.message : String(failure)).toMatch(pattern);
}

describe("LongMemEval run provenance", () => {

  it("rejects symbolic links in the local ONNX artifact tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "lme-onnx-symlink-"));
    roots.push(root);
    const modelRoot = join(root, "models", "Xenova", "test");
    await mkdir(modelRoot, { recursive: true });
    await writeFile(join(root, "outside"), "secret", "utf8");
    await symlink(join(root, "outside"), join(modelRoot, "model.onnx"));

    await assertRejects(resolveLocalArtifactTreeSha256(
      join(root, "models"), "Xenova/test"
    ), /artifact tree/u);
  });

  it("rejects an environment identity that does not match the fresh closure", async () => {
    await assertRejects(buildLongMemEvalRunProvenance({
      opts: {
        variant: "longmemeval_s",
        historyRoot: "/tmp",
        embeddingMode: "disabled"
      },
      evaluatedCount: 0,
      commitSha7: currentCommitSha7,
      embeddingProviderLabel: "disabled",
      env: {
        ALAYA_BENCH_EXECUTED_DIST_CLOSURE_SHA256: "f".repeat(64),
        ALAYA_BENCH_EXECUTED_DIST_FILE_COUNT: "1"
      },
      computeExecutedDistIdentity: fakeExecutedDistIdentity
    }), /does not match fresh closure/u);
  });

  it("rejects an ONNX thread count above the runtime maximum", async () => {
    await assertRejects(buildLongMemEvalRunProvenance({
      opts: {
        variant: "longmemeval_s",
        historyRoot: "/tmp",
        embeddingMode: "disabled"
      },
      evaluatedCount: 0,
      commitSha7: currentCommitSha7,
      embeddingProviderLabel: "disabled",
      env: { ALAYA_LOCAL_ONNX_THREADS: "128" },
      computeExecutedDistIdentity: fakeExecutedDistIdentity
    }), /ALAYA_LOCAL_ONNX_THREADS/u);
  });

  it("rejects model traversal and a symlinked model root", async () => {
    const root = await mkdtemp(join(tmpdir(), "lme-onnx-root-symlink-"));
    roots.push(root);
    const cacheRoot = join(root, "models");
    const outside = join(root, "outside");
    await mkdir(cacheRoot, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "model.onnx"), "model", "utf8");
    await symlink(outside, join(cacheRoot, "linked"), "dir");

    await assertRejects(
      resolveLocalArtifactTreeSha256(cacheRoot, "../outside"), /cache root/u
    );
    await assertRejects(
      resolveLocalArtifactTreeSha256(cacheRoot, "linked"), /artifact tree/u
    );
  });

  it("writes schema v2 only from a verified persisted lazy receipt", async () => {
    const receiptRoot = await mkdtemp(join(tmpdir(), "lazy-provenance-receipt-"));
    const cacheRoot = await mkdtemp(join(tmpdir(), "lazy-provenance-cache-"));
    roots.push(receiptRoot, cacheRoot);
    const lazy = await persistLazyProvenanceReceipt(receiptRoot, cacheRoot);
    const extraction = readExtractionCacheManifestIdentity(cacheRoot);
    if (extraction === undefined || extraction.manifest.schema_version !== 3) {
      throw new Error("fixture extraction authority is missing");
    }
    const loadedReceiptHandle = loadVerifiedLazySemanticRunReceipt({
      semanticRoot: receiptRoot,
      extractionCacheRoot: cacheRoot,
      runIdentity: lazy.lazyRunReceipt.runIdentity
    });
    const provenance = await buildLongMemEvalRunProvenance({
      opts: {
        variant: "longmemeval_s",
        historyRoot: "/tmp",
        embeddingMode: "disabled",
        extractionCacheRoot: cacheRoot
      },
      evaluatedCount: 0,
      commitSha7: currentCommitSha7,
      embeddingProviderLabel: "disabled",
      env: {},
      computeExecutedDistIdentity: fakeExecutedDistIdentity,
      ingestionMode: "lazy_field",
      semanticOverlayIdentity: lazy.lazyRunReceipt.endingOverlayIdentity,
      lazySemanticRun: loadedReceiptHandle
    });
    expect(provenance.schema_version).toBe(2);
    expect(provenance.ingestion_mode).toBe("lazy_field");
    expect(provenance.semantic_overlay_identity).toBe(lazy.lazyRunReceipt.endingOverlayIdentity);
    const compact = compactSnapshotRunProvenance(provenance);
    const snapshotAuthority = buildSnapshotExtractionAuthority(
      extraction.manifest, extraction.manifestSha256
    );
    expect(() => bindSnapshotRunProvenanceAuthority(compact, snapshotAuthority))
      .toThrow(/verified receipt loader handle/u);
    expect(() => bindSnapshotRunProvenanceAuthority(
      compact, snapshotAuthority, lazy.lazyRunReceiptHandle
    )).not.toThrow();
    const untrustedPersisted = LongMemEvalRunProvenanceSchema.parse(
      JSON.parse(JSON.stringify(provenance))
    );
    expect(() => compactSnapshotRunProvenance(untrustedPersisted))
      .toThrow(/verified receipt handle/u);

    const foreignCacheRoot = await mkdtemp(join(tmpdir(), "lazy-provenance-foreign-cache-"));
    roots.push(foreignCacheRoot);
    writeCompletedExtractionCacheFixture({
      cacheRoot: foreignCacheRoot,
      turnContents: ["I moved to Paris."],
      datasetRevision: SEMANTIC_FIXTURE_DATASET_REVISION,
      windowOffset: 0,
      windowLimit: 1
    });
    await assertRejects(buildLongMemEvalRunProvenance({
      opts: {
        variant: "longmemeval_s", historyRoot: "/tmp", embeddingMode: "disabled",
        extractionCacheRoot: foreignCacheRoot
      },
      evaluatedCount: 0,
      commitSha7: currentCommitSha7,
      embeddingProviderLabel: "disabled",
      env: {},
      computeExecutedDistIdentity: fakeExecutedDistIdentity,
      ingestionMode: "lazy_field",
      semanticOverlayIdentity: lazy.lazyRunReceipt.endingOverlayIdentity,
      lazySemanticRun: lazy.lazyRunReceiptHandle
    }), /foreign snapshot or substrate authority/u);

    await assertRejects(buildLongMemEvalRunProvenance({
      opts: { variant: "longmemeval_s", historyRoot: "/tmp", embeddingMode: "disabled" },
      evaluatedCount: 0,
      commitSha7: currentCommitSha7,
      embeddingProviderLabel: "disabled",
      env: {},
      computeExecutedDistIdentity: fakeExecutedDistIdentity,
      ingestionMode: "precomputed_full",
      semanticOverlayIdentity: lazy.lazyRunReceipt.endingOverlayIdentity
    }), /precomputed_full cannot carry semantic overlay/u);
    await assertRejects(buildLongMemEvalRunProvenance({
      opts: {
        variant: "longmemeval_s", historyRoot: "/tmp", embeddingMode: "disabled",
        extractionCacheRoot: cacheRoot
      },
      evaluatedCount: 0,
      commitSha7: currentCommitSha7,
      embeddingProviderLabel: "disabled",
      env: {},
      computeExecutedDistIdentity: fakeExecutedDistIdentity,
      ingestionMode: "lazy_field",
      semanticOverlayIdentity: "ab".repeat(32),
      lazySemanticRun: lazy.lazyRunReceiptHandle
    }), /overlay must equal/u);
    const { runIdentity: _run, receiptDigest: _seal, ...unsigned } = lazy.lazyRunReceipt;
    const forgedUnsigned = {
      ...unsigned,
      budget: { ...unsigned.budget, maxCalls: unsigned.budget.maxCalls + 1 }
    };
    const forgedRunIdentity = computeLazySemanticRunIdentity(forgedUnsigned);
    const forged = {
      ...forgedUnsigned,
      runIdentity: forgedRunIdentity,
      receiptDigest: createHash("sha256").update(JSON.stringify({
        ...forgedUnsigned, runIdentity: forgedRunIdentity
      }), "utf8").digest("hex")
    };
    await assertRejects(buildLongMemEvalRunProvenance({
      opts: {
        variant: "longmemeval_s", historyRoot: "/tmp", embeddingMode: "disabled",
        extractionCacheRoot: cacheRoot
      },
      evaluatedCount: 0,
      commitSha7: currentCommitSha7,
      embeddingProviderLabel: "disabled",
      env: {},
      computeExecutedDistIdentity: fakeExecutedDistIdentity,
      ingestionMode: "lazy_field",
      semanticOverlayIdentity: lazy.lazyRunReceipt.endingOverlayIdentity,
      lazySemanticRun: { kind: "verified-lazy-semantic-run-receipt", receipt: forged } as never
    }), /verified persisted receipt handle/u);
  });

  it("does not emit verified provenance from mode overlay or admitted-count mutation after start", async () => {
    const receiptRoot = await mkdtemp(join(tmpdir(), "lazy-provenance-freeze-"));
    const cacheRoot = await mkdtemp(join(tmpdir(), "lazy-provenance-freeze-cache-"));
    roots.push(receiptRoot, cacheRoot);
    const lazy = await persistLazyProvenanceReceipt(receiptRoot, cacheRoot);
    const loadedReceiptHandle = loadVerifiedLazySemanticRunReceipt({
      semanticRoot: receiptRoot,
      extractionCacheRoot: cacheRoot,
      runIdentity: lazy.lazyRunReceipt.runIdentity
    });
    const originalOverlay = lazy.lazyRunReceipt.endingOverlayIdentity;
    const originalCold = lazy.lazyRunReceipt.cold;
    const originalAttempts = lazy.lazyRunReceipt.attempts.map((attempt) => attempt.outcome);
    const input = {
      opts: {
        variant: "longmemeval_s" as const,
        historyRoot: "/tmp",
        embeddingMode: "disabled" as const,
        extractionCacheRoot: cacheRoot
      },
      evaluatedCount: 0,
      commitSha7: currentCommitSha7,
      embeddingProviderLabel: "disabled",
      env: {},
      computeExecutedDistIdentity: async () => {
        input.ingestionMode = "precomputed_full";
        input.semanticOverlayIdentity = "ff".repeat(32);
        const forged = rewriteMemberOutcomes(lazy.lazyRunReceipt);
        writeFileSync(
          join(receiptRoot, "receipts", `${forged.runIdentity}.json`),
          serializeLazySemanticRunReceipt(forged)
        );
        return fakeExecutedDistIdentity();
      },
      ingestionMode: "lazy_field" as "precomputed_full" | "lazy_field",
      semanticOverlayIdentity: originalOverlay,
      lazySemanticRun: loadedReceiptHandle
    };
    const provenance = await buildLongMemEvalRunProvenance(input);
    expect(provenance.ingestion_mode).toBe("lazy_field");
    expect(provenance.semantic_overlay_identity).toBe(originalOverlay);
    expect(provenance.lazy_semantic_run?.cold).toBe(originalCold);
    expect(provenance.lazy_semantic_run?.attempts.map((attempt) => attempt.outcome))
      .toEqual(originalAttempts);
  });

});

async function persistLazyProvenanceReceipt(receiptRoot: string, cacheRoot: string) {
  writeCompletedExtractionCacheFixture({
    cacheRoot,
    turnContents: ["I moved to Berlin."],
    datasetRevision: SEMANTIC_FIXTURE_DATASET_REVISION,
    windowOffset: 0,
    windowLimit: 1
  });
  const extraction = readExtractionCacheManifestIdentity(cacheRoot);
  if (extraction === undefined || extraction.manifest.schema_version !== 3) {
    throw new Error("fixture extraction authority is missing");
  }
  const task = semanticTask();
  const boundTask = {
    ...task,
    sourceAuthority: {
      datasetRevision: SEMANTIC_FIXTURE_DATASET_REVISION,
      substrateManifest: buildSemanticSubstrateManifestAuthority({
        manifest: extraction.manifest,
        manifestSha256: extraction.manifestSha256
      }),
      substrateCacheKeys: Object.keys(extraction.manifest.content_closure_index!)
    }
  };
  persistRawArtifact(receiptRoot, SEMANTIC_RAW);
  const planted = sealSemanticArtifact(semanticArtifactUnsigned(boundTask));
  const plantedPath = semanticArtifactPath(
    receiptRoot, boundTask.semanticKey, boundTask.capability
  );
  mkdirSync(dirname(plantedPath), { recursive: true });
  writeFileSync(plantedPath, `${JSON.stringify(planted, null, 2)}\n`);
  recordSourceBinding(receiptRoot, boundTask.semanticKey, boundTask.capability, boundTask.binding);
  return runSemanticFill({
    root: receiptRoot,
    tasks: [boundTask],
    envelope: createOfflineSemanticEnvelope({
      maxCalls: 1, maxFailures: 1, transportPolicy: TOKEN_AWARE_POLICY
    }),
    transport: createOfflineSemanticReplayForTasks({
      tasks: [boundTask],
      transportPolicy: TOKEN_AWARE_POLICY,
      result: {
        kind: "raw",
        rawJson: JSON.stringify({ signals: [{
          object_kind: "fact",
          confidence: 0.9,
          matched_text: boundTask.text.replace(/^(?:User|Assistant): /u, ""),
          source_locator: {
            contract_version: 2,
            kind: "assertion_catalog",
            assertion_id: boundTask.assertionId
          }
        }] })
      }
    })
  });
}

function rewriteMemberOutcomes(receipt: LazySemanticRunReceipt): LazySemanticRunReceipt {
  const attempts = receipt.attempts.map((attempt) => {
    if (attempt.outcome === "admitted") {
      return { semanticKey: attempt.semanticKey, capability: attempt.capability, outcome: "skipped" as const };
    }
    if (attempt.outcome === "skipped") {
      return { semanticKey: attempt.semanticKey, capability: attempt.capability, outcome: "admitted" as const };
    }
    return attempt;
  });
  const { runIdentity: _run, receiptDigest: _digest, ...unsigned } = receipt;
  return sealLazySemanticRunReceipt({
    ...unsigned,
    attempts,
    cold: attempts.filter((attempt) => attempt.outcome === "admitted").length,
    warm: attempts.filter((attempt) => attempt.outcome === "skipped").length,
    failedUnits: attempts.filter((attempt) => attempt.outcome === "failed").length,
    unavailable: attempts.filter((attempt) =>
      attempt.outcome === "unresolved" || attempt.outcome === "failed").length,
    attemptCount: attempts.length
  });
}
