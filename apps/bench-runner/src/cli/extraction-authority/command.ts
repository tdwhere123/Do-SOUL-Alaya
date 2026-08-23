import process from "node:process";
import { parseFlags } from "../cli-options.js";
import { resolveEffectiveExtractionCacheRoot } from "../../bench/compile-seed/compile-seed-config.js";
import {
  inspectExtractionAuthority,
  readCurrentExtractionAuthorityRevision,
  type ExtractionAuthorityInspection
} from "../../bench/extraction/authority/inspection.js";
import {
  assertExtractionAuthorityReceipt,
  createExtractionAuthorityReceipt,
  computeExtractionAuthorityLineageDigest,
  readExtractionAuthorityReceipt
} from "../../bench/extraction/authority/receipt.js";
import {
  assertExtractionTargetSelectionReceipt,
  assertExtractionTargetSelectionWindow,
  readExtractionTargetSelectionReceipt,
  requiresExtractionTargetSelection,
  type ExtractionTargetSelectionReceipt
} from "../../bench/extraction/authority/target-selection/receipt.js";
import {
  readExtractionAttemptLedger,
  readSettledExtractionAttemptLedger
} from
  "../../bench/extraction/authority/attempt-ledger.js";
import { createExtractionRepairScope } from
  "../../bench/extraction/authority/repair/repair-scope.js";
import { computeExtractionFillAttemptCeiling } from
  "../../bench/extraction/authority/receipt-limits.js";
import {
  parseAuthorizeExtractionArgs,
  type AuthorizeExtractionArgs
} from "./args.js";
import {
  prepareAuthorityContinuation,
  type PreparedAuthorityContinuation
} from "./continuation.js";
import { continuationPredecessorNewSuccessfulKeys } from
  "../../bench/extraction/authority/continuation/predecessor-state.js";
import {
  publishAuthorizedExtractionReceipt,
  type AuthorityPublicationDependencies
} from "./publication.js";

interface AuthorizeExtractionDependencies extends AuthorityPublicationDependencies {
  readonly readRevision?: () => string;
  readonly readLedger?: typeof readExtractionAttemptLedger;
  readonly readTargetSelection?: typeof readExtractionTargetSelectionReceipt;
  readonly assertTargetSelection?: typeof assertExtractionTargetSelectionReceipt;
  readonly assertTargetSelectionWindow?: typeof assertExtractionTargetSelectionWindow;
}

export async function runAuthorizeExtractionCommand(
  args: ReadonlyArray<string>,
  deps: AuthorizeExtractionDependencies = {}
): Promise<number> {
  try {
    const authorized = await buildAuthorizedReceipt(args, deps);
    await publishAuthorizedExtractionReceipt(authorized, deps);
    process.stdout.write(renderAuthorizedReceipt(authorized.outputPath, authorized.receipt));
    return 0;
  } catch (error) {
    process.stderr.write(
      `alaya-bench-runner authorize-extraction: ${error instanceof Error
        ? error.message
        : String(error)}\n`
    );
    return 2;
  }
}

async function buildAuthorizedReceipt(
  args: ReadonlyArray<string>,
  deps: AuthorizeExtractionDependencies
) {
  const flags = parseFlags(args);
  const authority = parseAuthorizeExtractionArgs(args);
  const cacheRoot = resolveEffectiveExtractionCacheRoot(flags.extractionCacheRoot);
  const { inspection, ledger, inspectInput, predecessorBaseInspection } =
    await inspectAuthorityForReceipt(flags, authority, cacheRoot, deps);
  assertInspectableAuthority(inspection, authority);
  return finishAuthorizedReceipt({
    authority, flags, cacheRoot, inspection, ledger, inspectInput,
    predecessorBaseInspection, deps
  });
}

function finishAuthorizedReceipt(input: {
  readonly authority: AuthorizeExtractionArgs;
  readonly flags: ReturnType<typeof parseFlags>;
  readonly cacheRoot: string;
  readonly inspection: ExtractionAuthorityInspection;
  readonly ledger: ReturnType<typeof readExtractionAttemptLedger>;
  readonly inspectInput: Parameters<typeof inspectExtractionAuthority>[0];
  readonly predecessorBaseInspection: ExtractionAuthorityInspection | undefined;
  readonly deps: AuthorizeExtractionDependencies;
}) {
  const targetSelection = readTargetSelection(
    input.authority, input.inspection.observation, input.deps
  );
  assertTargetSelection(
    targetSelection, input.cacheRoot, input.inspection.observation, input.deps
  );
  const continuation = prepareAuthorityContinuation({
    predecessorAuthorityPath: input.authority.predecessorAuthorityPath,
    cacheRoot: input.cacheRoot,
    inspection: input.inspection,
    ...(input.predecessorBaseInspection === undefined ? {} : {
      predecessorBaseInspection: input.predecessorBaseInspection
    }),
    targetSelection,
    dependencies: input.deps
  });
  assertSuccessorLineageAvailable(
    input.cacheRoot, input.inspection.observation, continuation, input.deps
  );
  return Object.freeze({
    cacheRoot: input.cacheRoot,
    outputPath: input.authority.outputPath,
    inspection: input.inspection,
    inspectionInput: input.inspectInput,
    targetSelection,
    receipt: createReceipt(
      input.authority, input.flags.concurrency, input.inspection, input.ledger,
      targetSelection, continuation
    ),
    ...(continuation === undefined ? {} : { continuation })
  });
}

function assertSuccessorLineageAvailable(
  cacheRoot: string,
  observation: ExtractionAuthorityInspection["observation"],
  continuation: PreparedAuthorityContinuation | undefined,
  deps: AuthorizeExtractionDependencies
): void {
  if (continuation === undefined) return;
  // Successor lineage includes the continuation; the observation-only ledger is the ancestor.
  const successorLedger = (deps.readLedger ?? readExtractionAttemptLedger)({
    cacheRoot,
    lineageDigest: computeExtractionAuthorityLineageDigest(
      observation, continuation.evidence
    ),
    cacheIdentity: {
      model: observation.extraction.model,
      requestProfile: observation.extraction.requestProfile
    }
  });
  if (successorLedger !== undefined) {
    throw new Error("same-root continuation successor lineage already exists");
  }
}

function readTargetSelection(
  authority: AuthorizeExtractionArgs,
  observation: Awaited<ReturnType<typeof inspectExtractionAuthority>>["observation"],
  deps: AuthorizeExtractionDependencies
): ExtractionTargetSelectionReceipt | undefined {
  if (authority.repairInvalidShards ||
      !requiresExtractionTargetSelection(observation)) {
    if (authority.targetSelectionPath !== undefined) {
      throw new Error(
        "extraction target selection only applies to canonical longmemeval_s 0..100 or 0..500"
      );
    }
    return undefined;
  }
  if (authority.targetSelectionPath === undefined) {
    throw new Error(
      "--extraction-target-selection is required for canonical normal longmemeval_s extraction authority"
    );
  }
  return (deps.readTargetSelection ?? readExtractionTargetSelectionReceipt)(
    authority.targetSelectionPath
  );
}

function assertTargetSelection(
  selection: ExtractionTargetSelectionReceipt | undefined,
  cacheRoot: string,
  observation: Awaited<ReturnType<typeof inspectExtractionAuthority>>["observation"],
  deps: AuthorizeExtractionDependencies
): void {
  if (selection === undefined) return;
  (deps.assertTargetSelection ?? assertExtractionTargetSelectionReceipt)({
    receipt: selection,
    cacheRoot,
    observation
  });
  (deps.assertTargetSelectionWindow ?? assertExtractionTargetSelectionWindow)(selection, observation);
}

async function inspectAuthorityForReceipt(
  flags: ReturnType<typeof parseFlags>,
  authority: AuthorizeExtractionArgs,
  cacheRoot: string,
  deps: AuthorizeExtractionDependencies
) {
  const inspectInput = {
    variant: flags.variant,
    ...(flags.limit === undefined ? {} : { limit: flags.limit }),
    ...(flags.offset === undefined ? {} : { offset: flags.offset }),
    ...(flags.questionBatchLimit === undefined ? {} : {
      questionBatchLimit: flags.questionBatchLimit
    }),
    cacheRoot,
    ...(flags.dataDir === undefined ? {} : { dataDir: flags.dataDir }),
    ...(flags.pinnedMetaRoot === undefined ? {} : { pinnedMetaRoot: flags.pinnedMetaRoot }),
    revision: (deps.readRevision ?? readCurrentExtractionAuthorityRevision)(),
    action: authority.action,
    ...(authority.repairInvalidShards ? { repairInvalidShards: true } : {})
  } as const;
  const inspect = deps.inspect ?? inspectExtractionAuthority;
  const initial = await inspect(inspectInput);
  const predecessorProgress = readContinuationPredecessorProgress(
    authority.predecessorAuthorityPath, cacheRoot, deps
  );
  const ledger = (deps.readLedger ?? readExtractionAttemptLedger)(ledgerReadInput(
    cacheRoot, initial.observation
  ));
  const inspection = ledger === undefined || authority.predecessorAuthorityPath !== undefined
    ? initial
    : await inspect({ ...inspectInput, excludeContentClosureKeys: ledger.successfulKeys });
  const predecessorBaseInspection = predecessorProgress === undefined
    ? undefined
    : predecessorProgress.successfulKeys.length === 0
      ? initial
      : await inspect({
        ...inspectInput,
        excludeContentClosureKeys: predecessorProgress.successfulKeys,
        preservedValidExclusionKeys: predecessorProgress.successfulKeys
      });
  return Object.freeze({ inspection, ledger, inspectInput, predecessorBaseInspection });
}

function readContinuationPredecessorProgress(
  predecessorAuthorityPath: string | undefined,
  cacheRoot: string,
  deps: AuthorizeExtractionDependencies
): { readonly successfulKeys: readonly string[] } | undefined {
  if (predecessorAuthorityPath === undefined) return undefined;
  const predecessor = (deps.readPredecessorAuthority ?? readExtractionAuthorityReceipt)(
    predecessorAuthorityPath
  );
  assertExtractionAuthorityReceipt(predecessor, predecessor.observation);
  const ledger = (deps.readSettledLedger ?? readSettledExtractionAttemptLedger)({
    cacheRoot,
    lineageDigest: predecessor.lineage_digest,
    cacheIdentity: {
      model: predecessor.observation.extraction.model,
      requestProfile: predecessor.observation.extraction.requestProfile
    }
  });
  if (predecessor.catalog_refill !== undefined) {
    return Object.freeze({ successfulKeys: ledger.successfulKeys });
  }
  if (predecessor.continuation === undefined) return undefined;
  return Object.freeze({
    successfulKeys: continuationPredecessorNewSuccessfulKeys(predecessor, ledger)
  });
}

function ledgerReadInput(
  cacheRoot: string,
  observation: Awaited<ReturnType<typeof inspectExtractionAuthority>>["observation"]
) {
  return {
    cacheRoot,
    lineageDigest: computeExtractionAuthorityLineageDigest(observation),
    cacheIdentity: {
      model: observation.extraction.model,
      requestProfile: observation.extraction.requestProfile
    }
  };
}

function createReceipt(
  authority: AuthorizeExtractionArgs,
  maxConcurrency: number | undefined,
  inspection: ExtractionAuthorityInspection,
  ledger: ReturnType<typeof readExtractionAttemptLedger>,
  targetSelection: ExtractionTargetSelectionReceipt | undefined,
  continuation: PreparedAuthorityContinuation | undefined
) {
  const repairScope = authority.repairInvalidShards
    ? createExtractionRepairScope(
      inspection.invalidShards,
      inspection.preservedValidClosure
    )
    : undefined;
  const inheritedLedger = continuation?.predecessorLedger ?? ledger;
  const carriedLimits = inheritedLedger === undefined
    ? repairScope === undefined ? undefined : {
      startingMissing: repairScope.shard_count,
      maximumAttempts: computeExtractionFillAttemptCeiling(repairScope.shard_count),
      successfulShardCeiling: repairScope.shard_count
    }
    : {
      startingMissing: inheritedLedger.startingMissing,
      maximumAttempts: continuation?.evidence.successor_maximum_attempts ??
        inheritedLedger.maximumAttempts,
      successfulShardCeiling: inheritedLedger.successfulShardCeiling
    };
  return createExtractionAuthorityReceipt(buildReceiptInput({
    authority, maxConcurrency, inspection, targetSelection,
    continuation, repairScope, carriedLimits
  }));
}

function buildReceiptInput(input: {
  readonly authority: AuthorizeExtractionArgs;
  readonly maxConcurrency: number | undefined;
  readonly inspection: ExtractionAuthorityInspection;
  readonly targetSelection: ExtractionTargetSelectionReceipt | undefined;
  readonly continuation: PreparedAuthorityContinuation | undefined;
  readonly repairScope: ReturnType<typeof createExtractionRepairScope> | undefined;
  readonly carriedLimits: { readonly startingMissing: number; readonly maximumAttempts: number;
    readonly successfulShardCeiling: number } | undefined;
}) {
  return {
    action: input.authority.action,
    observation: input.inspection.observation,
    outputTokenCap: {
      field: input.authority.outputTokenField, value: input.authority.outputTokenCap
    },
    priceEstimate: {
      inputUsdPerMillion: input.authority.inputPriceUsdPerMillion,
      outputUsdPerMillion: input.authority.outputPriceUsdPerMillion,
      maximumInputTokensPerAttempt: input.authority.maximumInputTokens
    },
    diskFloorBytes: input.authority.diskFloorBytes,
    ...(input.maxConcurrency === undefined ? {} : { maxConcurrency: input.maxConcurrency }),
    ...(input.authority.probeKey === undefined ? {} : { probeKey: input.authority.probeKey }),
    ...(input.carriedLimits === undefined ? {} : { cumulativeLimits: input.carriedLimits }),
    inspection: inspectionSummary(input.inspection),
    ...(input.targetSelection === undefined ? {} : {
      targetSelectionDigest: input.targetSelection.receipt_digest
    }),
    ...(input.repairScope === undefined ? {} : { repairScope: input.repairScope }),
    ...(input.continuation === undefined ? {} : { continuation: input.continuation.evidence }),
    ...(input.targetSelection === undefined || input.continuation === undefined ? {} : {
      now: new Date(input.targetSelection.created_at)
    })
  };
}

function inspectionSummary(inspection: ExtractionAuthorityInspection) {
  return {
    writerLock: inspection.writerLock,
    disk: inspection.disk,
    credentialStatus: inspection.credentialStatus,
    modelReadiness: inspection.modelReadiness
  };
}

function renderAuthorizedReceipt(
  outputPath: string,
  receipt: ReturnType<typeof createExtractionAuthorityReceipt>
): string {
  return `Extraction authority receipt written: ${outputPath}\n` +
    `  action=${receipt.action} identity=${receipt.identity_digest} ` +
    `receipt=${receipt.receipt_digest} missing=${receipt.limits.starting_missing} ` +
    `attempt_cap=${receipt.limits.maximum_attempts}\n`;
}

function assertInspectableAuthority(
  inspection: ExtractionAuthorityInspection,
  authority: AuthorizeExtractionArgs
): void {
  const inventory = inspection.observation.inventory;
  if (inventory.orphanTurns !== 0 ||
      (!authority.repairInvalidShards && inventory.invalidTurns !== 0)) {
    throw new Error("cannot authorize extraction with invalid or orphan cache shards");
  }
  if (authority.repairInvalidShards &&
      (authority.action !== "fill" || inventory.invalidTurns === 0 ||
       inspection.invalidShards.length !== inventory.invalidTurns)) {
    throw new Error("repair authority requires hashable strict-JSON-invalid shards");
  }
  if (authority.action === "probe") {
    if (authority.probeKey === undefined || !inspection.missingKeys.includes(authority.probeKey)) {
      throw new Error("probe key must identify exactly one currently missing target key");
    }
  }
}
