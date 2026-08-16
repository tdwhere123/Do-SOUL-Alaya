import process from "node:process";
import {
  recoverInterruptedExtractionAttemptLedger
} from "../../longmemeval/extraction/authority/attempt-ledger/interruption-recovery.js";
import {
  interruptedFillRecoveryEvidence,
  recoverInterruptedExtractionFillManifest
} from
  "../../longmemeval/extraction/authority/attempt-ledger/interruption-manifest-recovery.js";
import {
  assertExtractionAuthorityReceipt,
  readExtractionAuthorityReceipt
} from "../../longmemeval/extraction/authority/receipt.js";
import {
  acquireExtractionCacheWriteLease,
  withExtractionCacheWriteLease
} from "../../longmemeval/extraction/fill/manifest/fill-root-guard.js";

interface RecoverAttemptLedgerDependencies {
  readonly readReceipt?: typeof readExtractionAuthorityReceipt;
  readonly acquireLease?: typeof acquireExtractionCacheWriteLease;
  readonly recover?: typeof recoverInterruptedExtractionAttemptLedger;
  readonly recoverManifest?: typeof recoverInterruptedExtractionFillManifest;
}

export async function runRecoverExtractionAttemptLedgerCommand(
  args: readonly string[],
  dependencies: RecoverAttemptLedgerDependencies = {}
): Promise<number> {
  try {
    const options = parseRecoveryOptions(args);
    const receipt = (dependencies.readReceipt ?? readExtractionAuthorityReceipt)(
      options.authorityPath
    );
    assertExtractionAuthorityReceipt(receipt, receipt.observation);
    if (receipt.action !== "fill") {
      throw new Error("interrupted attempt recovery requires a fill authority");
    }
    const lease = (dependencies.acquireLease ?? acquireExtractionCacheWriteLease)(
      options.cacheRoot
    );
    const recovered = await withExtractionCacheWriteLease(lease, async () => {
      lease.assertOwned();
      const snapshot = (dependencies.recover ?? recoverInterruptedExtractionAttemptLedger)({
        cacheRoot: lease.stableRootPath,
        lineageDigest: receipt.lineage_digest,
        cacheIdentity: {
          model: receipt.observation.extraction.model,
          requestProfile: receipt.observation.extraction.requestProfile
        },
        startingMissing: receipt.limits.starting_missing,
        maximumAttempts: receipt.limits.maximum_attempts,
        successfulShardCeiling: receipt.limits.successful_shard_ceiling
      });
      const manifest = options.recoverManifest
        ? (dependencies.recoverManifest ?? recoverInterruptedExtractionFillManifest)({
          cacheRoot: lease.stableRootPath,
          ledger: snapshot,
          expected: {
            model: receipt.observation.extraction.model,
            modelFamily: receipt.observation.extraction.modelFamily,
            requestProfile: receipt.observation.extraction.requestProfile,
            providerUrl: receipt.observation.extraction.providerUrl,
            systemPromptSha256: receipt.observation.extraction.systemPromptSha256,
            cacheKeyAlgorithm: receipt.observation.extraction.cacheKeyAlgorithm,
            datasetVariant: receipt.observation.dataset.variant,
            datasetRevisionSha256: receipt.observation.dataset.revisionSha256,
            windowOffset: receipt.observation.dataset.windowOffset,
            windowLimit: receipt.observation.dataset.windowLimit,
            expectedTurns: receipt.observation.inventory.expectedTurns,
            expectedKeySetSha256: receipt.observation.dataset.expectedKeySetSha256,
            ...interruptedFillRecoveryEvidence(receipt)
          }
        })
        : undefined;
      lease.assertOwned();
      return { snapshot, manifest };
    });
    process.stdout.write(
      `Recovered extraction attempt ledger: attempts=${recovered.snapshot.attempts} ` +
      `successful_shards=${recovered.snapshot.successfulShards} ` +
      `aborted=${recovered.snapshot.telemetry.terminalRetryClassifications.failure_aborted} ` +
      `usage_unknown=${recovered.snapshot.telemetry.usageUnknownAttempts}` +
      (recovered.manifest === undefined
        ? "\n"
        : ` manifest_cached=${recovered.manifest.cached_turns}\n`)
    );
    return 0;
  } catch (error) {
    process.stderr.write(
      `alaya-bench-runner recover-extraction-attempt-ledger: ${errorMessage(error)}\n`
    );
    return 2;
  }
}

function parseRecoveryOptions(args: readonly string[]): {
  readonly cacheRoot: string;
  readonly authorityPath: string;
  readonly recoverManifest: boolean;
} {
  let cacheRoot: string | undefined;
  let authorityPath: string | undefined;
  let recoverManifest = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--extraction-cache-root") {
      if (cacheRoot !== undefined) throw new Error("duplicate --extraction-cache-root");
      cacheRoot = readValue(args, ++index, token);
    } else if (token === "--extraction-authority") {
      if (authorityPath !== undefined) throw new Error("duplicate --extraction-authority");
      authorityPath = readValue(args, ++index, token);
    } else if (token === "--recover-in-progress-manifest") {
      if (recoverManifest) throw new Error("duplicate --recover-in-progress-manifest");
      recoverManifest = true;
    } else {
      throw new Error(`unknown argument '${token ?? ""}'`);
    }
  }
  if (cacheRoot === undefined) throw new Error("--extraction-cache-root <path> required");
  if (authorityPath === undefined) throw new Error("--extraction-authority <receipt> required");
  return { cacheRoot, authorityPath, recoverManifest };
}

function readValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index];
  if (value === undefined || value.length === 0 || value.startsWith("--")) {
    throw new Error(`${flag} requires a path value`);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
