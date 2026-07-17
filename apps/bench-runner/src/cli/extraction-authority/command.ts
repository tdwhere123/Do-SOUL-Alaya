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
  discardFreshDirectDeepSeek500Authorization
} from "../../longmemeval/extraction/authority/direct-deepseek-500.js";
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
}

interface AuthorizeExtractionDependencies {
  readonly inspect?: typeof inspectExtractionAuthority;
  readonly write?: typeof writeExtractionAuthorityReceipt;
  readonly readRevision?: () => string;
  readonly readLedger?: typeof readExtractionAttemptLedger;
  readonly createDirectSpend?: typeof createFreshDirectDeepSeek500Authorization;
  readonly discardDirectSpend?: typeof discardFreshDirectDeepSeek500Authorization;
}

export async function runAuthorizeExtractionCommand(
  args: ReadonlyArray<string>,
  deps: AuthorizeExtractionDependencies = {}
): Promise<number> {
  let freshDirectSpend: ReturnType<typeof createFreshDirectDeepSeek500Authorization> | undefined;
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
      (deps.discardDirectSpend ?? discardFreshDirectDeepSeek500Authorization)({
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
    spend: ReturnType<typeof createFreshDirectDeepSeek500Authorization> | undefined,
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
  return Object.freeze({
    outputPath: authority.outputPath,
    receipt: createReceipt(authority, flags.concurrency, inspection, ledger, directSpend)
  });
}

function createDirectSpend(
  authority: AuthorizeExtractionArgs,
  flags: ReturnType<typeof parseFlags>,
  cacheRoot: string,
  deps: AuthorizeExtractionDependencies
) {
  if (authority.directDeepSeek500Operator === undefined) return undefined;
  assertDirectDeepSeek500Scope(flags);
  return (deps.createDirectSpend ?? createFreshDirectDeepSeek500Authorization)({
    cacheRoot,
    operator: authority.directDeepSeek500Operator
  });
}

function assertDirectDeepSeek500Scope(flags: ReturnType<typeof parseFlags>): void {
  if (flags.variant !== "longmemeval_s" || flags.offset !== 0 || flags.limit !== 500 ||
      flags.pinnedMetaRoot !== undefined || flags.promotionContract !== undefined ||
      flags.r3SpendApproval !== undefined) {
    throw new Error(
      "direct DeepSeek 500 requires canonical longmemeval_s 0..500 without custom metadata or R3 evidence"
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
  directSpend: ReturnType<typeof createFreshDirectDeepSeek500Authorization> | undefined
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
    (receipt.direct_spend === undefined ? "" : " spend=deepseek_direct_500") +
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
    )
  };
  if (parsed.action === "probe" && parsed.probeKey === undefined) {
    throw new Error("--extraction-probe-key is required when --extraction-action=probe");
  }
  if (parsed.action === "fill" && parsed.probeKey !== undefined) {
    throw new Error("--extraction-probe-key is only valid when --extraction-action=probe");
  }
  if (parsed.directDeepSeek500Operator !== undefined && parsed.action !== "fill") {
    throw new Error("--direct-deepseek-500-operator is only valid when --extraction-action=fill");
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
