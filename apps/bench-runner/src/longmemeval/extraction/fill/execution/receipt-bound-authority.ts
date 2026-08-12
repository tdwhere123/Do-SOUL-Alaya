import type { ExtractionFillOptions } from "../../extraction-fill.js";
import { ExtractionCacheInvariantError } from "../../cache/cache-invariant-error.js";
import { readExtractionCacheManifestIdentity } from
  "../../cache/extraction-cache-manifest.js";
import {
  inspectExtractionAuthority, readCurrentExtractionAuthorityRevision
} from "../../authority/inspection.js";
import {
  assertExtractionAuthorityReceipt, assertExtractionAuthorityRuntimeReadiness,
  readExtractionAuthorityReceipt, type ExtractionAuthorityReceipt
} from "../../authority/receipt.js";
import type { ExtractionAttemptLedgerSnapshot } from "../../authority/attempt-ledger.js";
import {
  assertLoadedSameRootContinuation, inspectContinuationLedgerState,
  loadSameRootExtractionContinuation, type LoadedSameRootContinuation
} from "../../authority/continuation/runtime.js";
import { assertDirectExtractionSpendRootBinding } from
  "../../authority/direct-deepseek-500.js";
import {
  assertExtractionTargetSelectionReceipt, assertExtractionTargetSelectionWindow,
  type ExtractionTargetSelectionReceipt
} from "../../authority/target-selection/receipt.js";
import { assertRemainingRepairShards } from "../../authority/repair/repair-scope.js";
import { assertPreservedValidClosureUnchanged } from
  "../../authority/repair/preserved-valid-closure.js";
import { assertCatalogRefillScopeMatchesInspection } from
  "../../authority/catalog-refill/scope.js";
import { readCatalogRefillResumeManifest } from
  "../../authority/catalog-refill/resume-manifest.js";
import { assertDirectExtractionMetadataScope } from "../../authority/runtime/scope.js";
import { loadReceiptTargetSelection } from "../target-selection.js";
import type { ExtractionCacheWriteLease } from "../manifest/fill-root-guard.js";
import type { ExecutionExtractionAuthority } from "../fill-execution.js";
import { recordCatalogRefillResumeManifest } from "../catalog-refill/runtime.js";

export interface ReceiptBoundExtractionAuthority {
  readonly receipt: ExtractionAuthorityReceipt;
  readonly targetSelection?: ExtractionTargetSelectionReceipt;
  readonly continuation?: LoadedSameRootContinuation;
  readonly recoverResumeManifestSha256?: string;
}

export async function loadExtractionAuthority(
  options: ExtractionFillOptions,
  cacheRoot: string
): Promise<ReceiptBoundExtractionAuthority> {
  const receipt = readExtractionAuthorityReceipt(options.authorityReceiptPath!);
  assertDirectExtractionMetadataScope(options, receipt);
  const targetSelection = loadReceiptTargetSelection(options, receipt);
  const continuation = loadSameRootExtractionContinuation({
    predecessorAuthorityReceiptPath: options.predecessorAuthorityReceiptPath,
    cacheRoot,
    receipt
  });
  const inspected = await inspectReceiptAuthority(options, cacheRoot, receipt, continuation);
  assertAuthorityInspection(
    receipt, inspected.inspection, cacheRoot, undefined, targetSelection,
    continuation, inspected.successorLedger, undefined, inspected.resumeManifestSha256,
    inspected.settledManifestSha256
  );
  return Object.freeze({
    receipt,
    ...(targetSelection === undefined ? {} : { targetSelection }),
    ...(continuation === undefined ? {} : { continuation }),
    ...(inspected.resumeManifestRequiresRecovery !== true ? {} : {
      recoverResumeManifestSha256: inspected.resumeManifestSha256
    })
  });
}

export async function revalidateExtractionAuthority(
  options: ExtractionFillOptions,
  cacheRoot: string,
  authority: ReceiptBoundExtractionAuthority,
  writeLease: ExtractionCacheWriteLease,
  postPinManifestSha256: string | undefined = undefined
): Promise<void> {
  writeLease.assertOwned();
  const inspected = await inspectReceiptAuthority(
    options, cacheRoot, authority.receipt, authority.continuation
  );
  assertAuthorityInspection(
    authority.receipt, inspected.inspection, cacheRoot, writeLease, authority.targetSelection,
    authority.continuation, inspected.successorLedger, postPinManifestSha256,
    inspected.resumeManifestSha256, inspected.settledManifestSha256
  );
}

export async function recoverMissingCatalogRefillResumeManifest(input: {
  readonly options: ExtractionFillOptions;
  readonly cacheRoot: string;
  readonly writeLease: ExtractionCacheWriteLease;
  readonly authority: ReceiptBoundExtractionAuthority | undefined;
  readonly executionAuthority: ExecutionExtractionAuthority | undefined;
}): Promise<void> {
  const expected = input.authority?.recoverResumeManifestSha256;
  if (expected === undefined) return;
  input.writeLease.assertOwned();
  const inspected = await inspectReceiptAuthority(
    input.options, input.cacheRoot, input.authority!.receipt, input.authority!.continuation
  );
  if (inspected.resumeManifestRequiresRecovery !== true ||
      inspected.resumeManifestSha256 !== expected) {
    throw new ExtractionCacheInvariantError("catalog refill resume recovery state changed");
  }
  assertAuthorityInspection(
    input.authority!.receipt, inspected.inspection, input.cacheRoot, input.writeLease,
    input.authority!.targetSelection, input.authority!.continuation,
    inspected.successorLedger, undefined, inspected.resumeManifestSha256,
    inspected.settledManifestSha256
  );
  recordCatalogRefillResumeManifest(input.executionAuthority, input.cacheRoot, expected);
  const persisted = readCatalogRefillResumeManifest({
    cacheRoot: input.cacheRoot,
    receipt: input.authority!.receipt,
    ledger: input.executionAuthority?.snapshot()
  });
  if (persisted !== expected) {
    throw new ExtractionCacheInvariantError("catalog refill resume recovery was not durable");
  }
}

async function inspectReceiptAuthority(
  options: ExtractionFillOptions,
  cacheRoot: string,
  receipt: ExtractionAuthorityReceipt,
  continuation: LoadedSameRootContinuation | undefined
) {
  const ledgerState = inspectContinuationLedgerState({ cacheRoot, receipt, continuation });
  const currentManifest = readExtractionCacheManifestIdentity(cacheRoot);
  const settledManifestSha256 = currentManifest?.manifest.schema_version === 3 &&
    currentManifest.manifest.fill_status !== undefined
    ? currentManifest.manifestSha256
    : undefined;
  const persistedResume = receipt.catalog_refill === undefined ? undefined
    : readCatalogRefillResumeManifest({
      cacheRoot, receipt, ledger: ledgerState.successorLedger
    });
  const recoverableResume = catalogRefillResumeRecoveryCandidate({
    receipt, ledger: ledgerState.successorLedger, currentManifest,
    persistedResumeManifestSha256: persistedResume
  });
  const successfulKeys = ledgerState.newSuccessfulKeys;
  const inspection = await inspectExtractionAuthority(extractionInspectionInput({
    options, cacheRoot, receipt, successfulKeys
  }));
  const resumeManifestSha256 = persistedResume ?? recoverableResume;
  return {
    inspection,
    successorLedger: ledgerState.successorLedger,
    ...(resumeManifestSha256 === undefined ? {} : { resumeManifestSha256 }),
    ...(recoverableResume === undefined ? {} : { resumeManifestRequiresRecovery: true as const }),
    ...(settledManifestSha256 === undefined ? {} : { settledManifestSha256 })
  };
}

function extractionInspectionInput(input: {
  readonly options: ExtractionFillOptions;
  readonly cacheRoot: string;
  readonly receipt: ExtractionAuthorityReceipt;
  readonly successfulKeys: readonly string[];
}): Parameters<typeof inspectExtractionAuthority>[0] {
  const { options, cacheRoot, receipt, successfulKeys } = input;
  const preserveSuccessful = successfulKeys.length > 0 &&
    (receipt.continuation !== undefined || receipt.catalog_refill !== undefined);
  return {
    variant: options.variant,
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    ...(options.offset === undefined ? {} : { offset: options.offset }),
    ...(receipt.repair_scope === undefined || options.questionBatchLimit === undefined ? {} : {
      questionBatchLimit: options.questionBatchLimit
    }),
    cacheRoot,
    ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
    ...(options.pinnedMetaRoot === undefined ? {} : { pinnedMetaRoot: options.pinnedMetaRoot }),
    revision: receipt.direct_spend?.kind === "deepseek_newapi_direct_500"
      ? receipt.observation.revision
      : readCurrentExtractionAuthorityRevision(),
    action: receipt.action,
    ...(receipt.repair_scope === undefined ? {} : { repairInvalidShards: true }),
    ...(receipt.repair_scope === undefined ? {} : {
      preservedValidExclusionKeys: receipt.repair_scope.shards.map((shard) => shard.cache_key)
    }),
    ...(successfulKeys.length === 0 ? {} : { excludeContentClosureKeys: successfulKeys }),
    ...(preserveSuccessful ? { preservedValidExclusionKeys: successfulKeys } : {})
  };
}

function catalogRefillResumeRecoveryCandidate(input: {
  readonly receipt: ExtractionAuthorityReceipt;
  readonly ledger: ExtractionAttemptLedgerSnapshot | undefined;
  readonly currentManifest: ReturnType<typeof readExtractionCacheManifestIdentity>;
  readonly persistedResumeManifestSha256: string | undefined;
}): string | undefined {
  const scope = input.receipt.catalog_refill;
  const current = input.currentManifest;
  if (scope === undefined || input.ledger === undefined ||
      input.persistedResumeManifestSha256 !== undefined ||
      current?.manifest.schema_version !== 3 || current.manifest.fill_status !== "in_progress" ||
      current.manifestSha256 === scope.initial_manifest_sha256) return undefined;
  return current.manifestSha256;
}

function assertAuthorityInspection(
  receipt: ExtractionAuthorityReceipt,
  inspection: Awaited<ReturnType<typeof inspectExtractionAuthority>>,
  cacheRoot: string,
  writeLease: ExtractionCacheWriteLease | undefined = undefined,
  targetSelection: ExtractionTargetSelectionReceipt | undefined = undefined,
  continuation: LoadedSameRootContinuation | undefined = undefined,
  successorLedger: ExtractionAttemptLedgerSnapshot | undefined = undefined,
  postPinManifestSha256: string | undefined = undefined,
  resumeManifestSha256: string | undefined = undefined,
  settledManifestSha256: string | undefined = undefined
): void {
  assertExtractionAuthorityReceipt(receipt, inspection.observation);
  assertCatalogInspection({ receipt, inspection, cacheRoot, successorLedger,
    postPinManifestSha256, resumeManifestSha256, settledManifestSha256 });
  assertRepairInspection(receipt, inspection);
  writeLease?.assertOwned();
  if (receipt.direct_spend !== undefined) {
    assertDirectExtractionSpendRootBinding({
      authorization: receipt.direct_spend, cacheRoot,
      ...(writeLease === undefined ? {} : { writeLease })
    });
  }
  assertTargetSelectionInspection(targetSelection, cacheRoot, inspection, writeLease);
  assertLoadedSameRootContinuation({
    cacheRoot, receipt, continuation, successorLedger, targetSelection, inspection,
    ...(postPinManifestSha256 === undefined ? {} : { postPinManifestSha256 })
  });
  assertExtractionAuthorityRuntimeReadiness(receipt, {
    writerLock: inspection.writerLock,
    disk: inspection.disk,
    credentialStatus: inspection.credentialStatus,
    modelReadiness: inspection.modelReadiness
  }, { allowOwnedWriterLock: writeLease !== undefined });
  if (receipt.action === "probe" &&
      (receipt.probe_key === undefined || !inspection.missingKeys.includes(receipt.probe_key))) {
    throw new Error("extraction probe authority target is no longer a missing cache key");
  }
}

function assertCatalogInspection(input: {
  readonly receipt: ExtractionAuthorityReceipt;
  readonly inspection: Awaited<ReturnType<typeof inspectExtractionAuthority>>;
  readonly cacheRoot: string;
  readonly successorLedger: ExtractionAttemptLedgerSnapshot | undefined;
  readonly postPinManifestSha256: string | undefined;
  readonly resumeManifestSha256: string | undefined;
  readonly settledManifestSha256: string | undefined;
}): void {
  const scope = input.receipt.catalog_refill;
  if (scope === undefined) return;
  assertCatalogRefillScopeMatchesInspection({
    scope, cacheRoot: input.cacheRoot, inspection: input.inspection,
    ...(input.postPinManifestSha256 === undefined ? {} : {
      pinnedManifestSha256: input.postPinManifestSha256
    }),
    ...(input.resumeManifestSha256 === undefined ? {} : {
      resumeManifestSha256: input.resumeManifestSha256
    }),
    ...(input.settledManifestSha256 === undefined ? {} : {
      settledManifestSha256: input.settledManifestSha256
    }),
    ...(input.successorLedger === undefined ? {} : { ledgerProgress: {
      attempts: input.successorLedger.attempts,
      successfulKeys: input.successorLedger.successfulKeys,
      pendingKeys: input.successorLedger.pendingKeys,
      unresolvedAttempts: input.successorLedger.unresolvedAttempts.length
    } })
  });
}

function assertRepairInspection(
  receipt: ExtractionAuthorityReceipt,
  inspection: Awaited<ReturnType<typeof inspectExtractionAuthority>>
): void {
  if (receipt.repair_scope === undefined) return;
  assertRemainingRepairShards(receipt.repair_scope, inspection.invalidShards);
  assertPreservedValidClosureUnchanged(
    receipt.repair_scope.preserved_valid_closure, inspection.preservedValidClosure
  );
}

function assertTargetSelectionInspection(
  targetSelection: ExtractionTargetSelectionReceipt | undefined,
  cacheRoot: string,
  inspection: Awaited<ReturnType<typeof inspectExtractionAuthority>>,
  writeLease: ExtractionCacheWriteLease | undefined
): void {
  if (targetSelection === undefined) return;
  assertExtractionTargetSelectionReceipt({
    receipt: targetSelection, cacheRoot, observation: inspection.observation,
    ...(writeLease === undefined ? {} : { writeLease })
  });
  assertExtractionTargetSelectionWindow(targetSelection, inspection.observation);
}
