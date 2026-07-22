import process from "node:process";
import { parseFlags } from "../cli-options.js";
import { resolveEffectiveExtractionCacheRoot } from "../../longmemeval/compile-seed/compile-seed-config.js";
import {
  inspectExtractionAuthority,
  readCurrentExtractionAuthorityRevision,
  type ExtractionAuthorityInspection
} from "../../longmemeval/extraction/authority/inspection.js";
import {
  createExtractionAuthorityReceipt,
  computeExtractionAuthorityLineageDigest,
  writeExtractionAuthorityReceipt
} from "../../longmemeval/extraction/authority/receipt.js";
import {
  createFreshDirectDeepSeek500Authorization,
  createFreshNewApiDeepSeek500Authorization,
  discardFreshDirectExtractionSpendAuthorization,
  type DirectExtractionSpendAuthorization
} from "../../longmemeval/extraction/authority/direct-deepseek-500.js";
import {
  assertExtractionTargetSelectionReceipt,
  assertExtractionTargetSelectionWindow,
  readExtractionTargetSelectionReceipt,
  requiresExtractionTargetSelection,
  type ExtractionTargetSelectionReceipt
} from "../../longmemeval/extraction/authority/target-selection/receipt.js";
import { readExtractionAttemptLedger } from
  "../../longmemeval/extraction/authority/attempt-ledger.js";
import { createExtractionRepairScope } from
  "../../longmemeval/extraction/authority/repair/repair-scope.js";
import { computeExtractionFillAttemptCeiling } from
  "../../longmemeval/extraction/authority/receipt-limits.js";
import {
  parseAuthorizeExtractionArgs,
  type AuthorizeExtractionArgs
} from "./args.js";
import {
  acquireExtractionCacheWriteLease,
  withExtractionCacheWriteLease
} from "../../longmemeval/extraction/fill/manifest/fill-root-guard.js";
import {
  assertExactContinuationIssuanceInspection,
  persistContinuationAuthority,
  prepareAuthorityContinuation,
  type AuthorityContinuationDependencies,
  type PreparedAuthorityContinuation
} from "./continuation.js";

interface AuthorizeExtractionDependencies extends AuthorityContinuationDependencies {
  readonly inspect?: typeof inspectExtractionAuthority;
  readonly write?: typeof writeExtractionAuthorityReceipt;
  readonly readRevision?: () => string;
  readonly readLedger?: typeof readExtractionAttemptLedger;
  readonly createDirectSpend?: typeof createFreshDirectDeepSeek500Authorization;
  readonly createNewApiDirectSpend?: typeof createFreshNewApiDeepSeek500Authorization;
  readonly discardDirectSpend?: typeof discardFreshDirectExtractionSpendAuthorization;
  readonly readTargetSelection?: typeof readExtractionTargetSelectionReceipt;
  readonly assertTargetSelection?: typeof assertExtractionTargetSelectionReceipt;
  readonly assertTargetSelectionWindow?: typeof assertExtractionTargetSelectionWindow;
}

export async function runAuthorizeExtractionCommand(
  args: ReadonlyArray<string>,
  deps: AuthorizeExtractionDependencies = {}
): Promise<number> {
  let freshDirectSpend: DirectExtractionSpendAuthorization | undefined;
  let freshDirectCacheRoot: string | undefined;
  try {
    const authorized = await buildAuthorizedReceipt(args, deps, (spend, cacheRoot) => {
      freshDirectSpend = spend;
      freshDirectCacheRoot = cacheRoot;
    });
    if (authorized.continuation === undefined) {
      (deps.write ?? writeExtractionAuthorityReceipt)(authorized.outputPath, authorized.receipt);
    } else {
      const continuation = authorized.continuation;
      const lease = acquireExtractionCacheWriteLease(authorized.cacheRoot);
      await withExtractionCacheWriteLease(lease, async () => {
        const live = await (deps.inspect ?? inspectExtractionAuthority)(
          authorized.inspectionInput
        );
        assertExactContinuationIssuanceInspection(authorized.inspection, live);
        persistContinuationAuthority({
          cacheRoot: authorized.cacheRoot,
          outputPath: authorized.outputPath,
          receipt: authorized.receipt,
          prepared: continuation,
          dependencies: deps
        });
      });
    }
    freshDirectSpend = undefined;
    process.stdout.write(renderAuthorizedReceipt(authorized.outputPath, authorized.receipt));
    return 0;
  } catch (error) {
    if (freshDirectSpend !== undefined && freshDirectCacheRoot !== undefined) {
      (deps.discardDirectSpend ?? discardFreshDirectExtractionSpendAuthorization)({
        authorization: freshDirectSpend,
        cacheRoot: freshDirectCacheRoot
      });
    }
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
  deps: AuthorizeExtractionDependencies,
  onFreshDirectSpend: (
    spend: DirectExtractionSpendAuthorization | undefined,
    cacheRoot: string
  ) => void
) {
  const flags = parseFlags(args);
  const authority = parseAuthorizeExtractionArgs(args);
  const cacheRoot = resolveEffectiveExtractionCacheRoot(flags.extractionCacheRoot);
  const directSpend = createDirectSpend(authority, flags, cacheRoot, deps);
  onFreshDirectSpend(directSpend, cacheRoot);
  const { inspection, ledger, inspectInput } = await inspectAuthorityForReceipt(
    flags, authority, cacheRoot, deps
  );
  assertInspectableAuthority(inspection, authority);
  const targetSelection = readTargetSelection(
    authority, directSpend, inspection.observation, deps
  );
  assertTargetSelection(
    targetSelection, cacheRoot, inspection.observation, deps
  );
  const continuation = prepareAuthorityContinuation({
    predecessorAuthorityPath: authority.predecessorAuthorityPath,
    cacheRoot,
    inspection,
    targetSelection,
    dependencies: deps
  });
  if (continuation !== undefined && ledger !== undefined) {
    throw new Error("same-root continuation successor lineage already exists");
  }
  return Object.freeze({
    cacheRoot,
    outputPath: authority.outputPath,
    inspection,
    inspectionInput: inspectInput,
    receipt: createReceipt(
      authority, flags.concurrency, inspection, ledger, directSpend, targetSelection, continuation
    ),
    ...(continuation === undefined ? {} : { continuation })
  });
}

function createDirectSpend(
  authority: AuthorizeExtractionArgs,
  flags: ReturnType<typeof parseFlags>,
  cacheRoot: string,
  deps: AuthorizeExtractionDependencies
) {
  const operator = authority.directDeepSeek500Operator ?? authority.directNewApiDeepSeek500Operator;
  if (operator === undefined) return undefined;
  assertDirectExtraction500Scope(flags);
  if (authority.directNewApiDeepSeek500Operator !== undefined) {
    return (deps.createNewApiDirectSpend ?? createFreshNewApiDeepSeek500Authorization)({
      cacheRoot,
      operator
    });
  }
  return (deps.createDirectSpend ?? createFreshDirectDeepSeek500Authorization)({
    cacheRoot,
    operator
  });
}

function readTargetSelection(
  authority: AuthorizeExtractionArgs,
  directSpend: DirectExtractionSpendAuthorization | undefined,
  observation: Awaited<ReturnType<typeof inspectExtractionAuthority>>["observation"],
  deps: AuthorizeExtractionDependencies
): ExtractionTargetSelectionReceipt | undefined {
  if (directSpend !== undefined) {
    if (authority.targetSelectionPath !== undefined) {
      throw new Error("direct extraction cannot mix an extraction target selection receipt");
    }
    return undefined;
  }
  if (authority.repairInvalidShards || !requiresExtractionTargetSelection(observation)) {
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

function assertDirectExtraction500Scope(flags: ReturnType<typeof parseFlags>): void {
  if (flags.variant !== "longmemeval_s" || flags.offset !== 0 || flags.limit !== 500 ||
      flags.pinnedMetaRoot !== undefined || flags.promotionContract !== undefined ||
      flags.r3SpendApproval !== undefined) {
    throw new Error(
      "direct extraction 500 requires canonical longmemeval_s 0..500 without custom metadata or R3 evidence"
    );
  }
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
  const ledger = (deps.readLedger ?? readExtractionAttemptLedger)(ledgerReadInput(
    cacheRoot, initial.observation
  ));
  const inspection = ledger === undefined
    ? initial
    : await inspect({ ...inspectInput, excludeContentClosureKeys: ledger.successfulKeys });
  return Object.freeze({ inspection, ledger, inspectInput });
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
  directSpend: DirectExtractionSpendAuthorization | undefined,
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
      maximumAttempts: inheritedLedger.maximumAttempts,
      successfulShardCeiling: inheritedLedger.successfulShardCeiling
    };
  return createExtractionAuthorityReceipt({
    action: authority.action,
    observation: inspection.observation,
    outputTokenCap: { field: authority.outputTokenField, value: authority.outputTokenCap },
    priceEstimate: {
      inputUsdPerMillion: authority.inputPriceUsdPerMillion,
      outputUsdPerMillion: authority.outputPriceUsdPerMillion,
      maximumInputTokensPerAttempt: authority.maximumInputTokens
    },
    diskFloorBytes: authority.diskFloorBytes,
    ...(maxConcurrency === undefined ? {} : { maxConcurrency }),
    ...(authority.probeKey === undefined ? {} : { probeKey: authority.probeKey }),
    ...(carriedLimits === undefined ? {} : { cumulativeLimits: carriedLimits }),
    inspection: inspectionSummary(inspection),
    ...(targetSelection === undefined ? {} : {
      targetSelectionDigest: targetSelection.receipt_digest
    }),
    ...(directSpend === undefined ? {} : { directSpend }),
    ...(repairScope === undefined ? {} : { repairScope }),
    ...(continuation === undefined ? {} : { continuation: continuation.evidence }),
    ...(continuation === undefined || targetSelection === undefined ? {} : {
      now: new Date(targetSelection.created_at)
    })
  });
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
    `attempt_cap=${receipt.limits.maximum_attempts}` +
    (receipt.direct_spend === undefined ? "" : ` spend=${receipt.direct_spend.kind}`) +
    "\n";
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
