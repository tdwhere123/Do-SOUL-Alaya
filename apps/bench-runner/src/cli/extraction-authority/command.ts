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

interface AuthorizeExtractionArgs {
  readonly action: "probe" | "fill";
  readonly outputPath: string;
  readonly outputTokenCap: number;
  readonly outputTokenField: "max_tokens" | "max_completion_tokens";
  readonly inputPriceUsdPerMillion: number;
  readonly outputPriceUsdPerMillion: number;
  readonly maximumInputTokens: number;
  readonly diskFloorBytes: number;
  readonly probeKey?: string;
  readonly directDeepSeek500Operator?: string;
  readonly directNewApiDeepSeek500Operator?: string;
  readonly targetSelectionPath?: string;
}

interface AuthorizeExtractionDependencies {
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
    (deps.write ?? writeExtractionAuthorityReceipt)(authorized.outputPath, authorized.receipt);
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
  const { inspection, ledger } = await inspectAuthorityForReceipt(
    flags, authority, cacheRoot, deps
  );
  assertInspectableAuthority(inspection, authority);
  const targetSelection = readTargetSelection(
    authority, directSpend, inspection.observation, deps
  );
  assertTargetSelection(
    targetSelection, cacheRoot, inspection.observation, deps
  );
  return Object.freeze({
    outputPath: authority.outputPath,
    receipt: createReceipt(
      authority, flags.concurrency, inspection, ledger, directSpend, targetSelection
    )
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
  if (!requiresExtractionTargetSelection(observation)) {
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
    cacheRoot,
    ...(flags.dataDir === undefined ? {} : { dataDir: flags.dataDir }),
    ...(flags.pinnedMetaRoot === undefined ? {} : { pinnedMetaRoot: flags.pinnedMetaRoot }),
    revision: (deps.readRevision ?? readCurrentExtractionAuthorityRevision)(),
    action: authority.action
  } as const;
  const inspect = deps.inspect ?? inspectExtractionAuthority;
  const initial = await inspect(inspectInput);
  const ledger = (deps.readLedger ?? readExtractionAttemptLedger)(ledgerReadInput(
    cacheRoot, initial.observation
  ));
  const inspection = ledger === undefined
    ? initial
    : await inspect({ ...inspectInput, excludeContentClosureKeys: ledger.successfulKeys });
  return Object.freeze({ inspection, ledger });
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
  targetSelection: ExtractionTargetSelectionReceipt | undefined
) {
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
    ...(ledger === undefined ? {} : {
      cumulativeLimits: {
        startingMissing: ledger.startingMissing,
        maximumAttempts: ledger.maximumAttempts,
        successfulShardCeiling: ledger.successfulShardCeiling
      }
    }),
    inspection: inspectionSummary(inspection),
    ...(targetSelection === undefined ? {} : {
      targetSelectionDigest: targetSelection.receipt_digest
    }),
    ...(directSpend === undefined ? {} : { directSpend })
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
  if (inventory.invalidTurns !== 0 || inventory.orphanTurns !== 0) {
    throw new Error("cannot authorize extraction with invalid or orphan cache shards");
  }
  if (authority.action === "probe") {
    if (authority.probeKey === undefined || !inspection.missingKeys.includes(authority.probeKey)) {
      throw new Error("probe key must identify exactly one currently missing target key");
    }
  }
}

function parseAuthorizeExtractionArgs(args: ReadonlyArray<string>): AuthorizeExtractionArgs {
  const action = requiredEnum(args, "--extraction-action", ["probe", "fill"] as const);
  const outputTokenField = requiredEnum(
    args,
    "--extraction-output-token-field",
    ["max_tokens", "max_completion_tokens"] as const
  );
  const parsed = {
    action,
    outputPath: requiredString(args, "--extraction-receipt-out"),
    outputTokenCap: requiredPositiveInt(args, "--extraction-output-token-cap"),
    outputTokenField,
    inputPriceUsdPerMillion: requiredNonNegativeNumber(
      args, "--extraction-input-price-usd-per-million"
    ),
    outputPriceUsdPerMillion: requiredNonNegativeNumber(
      args, "--extraction-output-price-usd-per-million"
    ),
    maximumInputTokens: requiredNonNegativeInt(args, "--extraction-max-input-tokens"),
    diskFloorBytes: requiredNonNegativeInt(args, "--extraction-disk-floor-bytes"),
    probeKey: optionalString(args, "--extraction-probe-key"),
    directDeepSeek500Operator: optionalRequiredString(
      args, "--direct-deepseek-500-operator"
    ),
    directNewApiDeepSeek500Operator: optionalRequiredString(
      args, "--direct-newapi-deepseek-500-operator"
    ),
    targetSelectionPath: optionalRequiredString(args, "--extraction-target-selection")
  };
  if (parsed.action === "probe" && parsed.probeKey === undefined) {
    throw new Error("--extraction-probe-key is required when --extraction-action=probe");
  }
  if (parsed.action === "fill" && parsed.probeKey !== undefined) {
    throw new Error("--extraction-probe-key is only valid when --extraction-action=probe");
  }
  const directOperator = parsed.directDeepSeek500Operator ?? parsed.directNewApiDeepSeek500Operator;
  if (parsed.directDeepSeek500Operator !== undefined &&
      parsed.directNewApiDeepSeek500Operator !== undefined) {
    throw new Error("only one direct DeepSeek 500 operator flag may be provided");
  }
  if (directOperator !== undefined && parsed.action !== "fill") {
    throw new Error("direct DeepSeek 500 operator flags are only valid when --extraction-action=fill");
  }
  if (directOperator !== undefined && parsed.targetSelectionPath !== undefined) {
    throw new Error("--extraction-target-selection cannot mix with a direct DeepSeek 500 operator flag");
  }
  return parsed;
}

function requiredString(args: ReadonlyArray<string>, flag: string): string {
  const value = optionalString(args, flag);
  if (value === undefined || value.length === 0 || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function optionalString(args: ReadonlyArray<string>, flag: string): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === `${flag}`) return args[index + 1];
    if (token?.startsWith(`${flag}=`)) return token.slice(flag.length + 1);
  }
  return undefined;
}

function optionalRequiredString(args: ReadonlyArray<string>, flag: string): string | undefined {
  return args.some((token) => token === flag || token.startsWith(`${flag}=`))
    ? requiredString(args, flag)
    : undefined;
}

function requiredPositiveInt(args: ReadonlyArray<string>, flag: string): number {
  return requiredInteger(args, flag, (value) => value > 0, "a positive integer");
}

function requiredNonNegativeInt(args: ReadonlyArray<string>, flag: string): number {
  return requiredInteger(args, flag, (value) => value >= 0, "a non-negative integer");
}

function requiredInteger(
  args: ReadonlyArray<string>,
  flag: string,
  predicate: (value: number) => boolean,
  description: string
): number {
  const raw = requiredString(args, flag);
  if (!/^\d+$/u.test(raw)) throw new Error(`${flag} must be ${description}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || !predicate(value)) {
    throw new Error(`${flag} must be ${description}`);
  }
  return value;
}

function requiredNonNegativeNumber(args: ReadonlyArray<string>, flag: string): number {
  const value = Number(requiredString(args, flag));
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${flag} must be a non-negative finite number`);
  }
  return value;
}

function requiredEnum<T extends string>(
  args: ReadonlyArray<string>,
  flag: string,
  allowed: readonly T[]
): T {
  const value = requiredString(args, flag);
  if (!allowed.includes(value as T)) {
    throw new Error(`${flag} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}
