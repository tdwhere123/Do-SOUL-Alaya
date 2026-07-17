import process from "node:process";
import { parseFlags } from "../cli-options.js";
import { resolveEffectiveExtractionCacheRoot } from "../../longmemeval/compile-seed-config.js";
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
}

export async function runAuthorizeExtractionCommand(
  args: ReadonlyArray<string>,
  deps: {
    readonly inspect?: typeof inspectExtractionAuthority;
    readonly write?: typeof writeExtractionAuthorityReceipt;
    readonly readRevision?: () => string;
    readonly readLedger?: typeof readExtractionAttemptLedger;
  } = {}
): Promise<number> {
  try {
    const flags = parseFlags(args);
    const authority = parseAuthorizeExtractionArgs(args);
    const cacheRoot = resolveEffectiveExtractionCacheRoot(flags.extractionCacheRoot);
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
    const ledger = (deps.readLedger ?? readExtractionAttemptLedger)({
      cacheRoot,
      lineageDigest: computeExtractionAuthorityLineageDigest(initial.observation),
      cacheIdentity: {
        model: initial.observation.extraction.model,
        requestProfile: initial.observation.extraction.requestProfile
      }
    });
    const inspection = ledger === undefined
      ? initial
      : await inspect({ ...inspectInput, excludeContentClosureKeys: ledger.successfulKeys });
    assertInspectableAuthority(inspection, authority);
    const receipt = createExtractionAuthorityReceipt({
      action: authority.action,
      observation: inspection.observation,
      outputTokenCap: {
        field: authority.outputTokenField,
        value: authority.outputTokenCap
      },
      priceEstimate: {
        inputUsdPerMillion: authority.inputPriceUsdPerMillion,
        outputUsdPerMillion: authority.outputPriceUsdPerMillion,
        maximumInputTokensPerAttempt: authority.maximumInputTokens
      },
      diskFloorBytes: authority.diskFloorBytes,
      ...(flags.concurrency === undefined ? {} : { maxConcurrency: flags.concurrency }),
      ...(authority.probeKey === undefined ? {} : { probeKey: authority.probeKey }),
      ...(ledger === undefined ? {} : {
        cumulativeLimits: {
          startingMissing: ledger.startingMissing,
          maximumAttempts: ledger.maximumAttempts,
          successfulShardCeiling: ledger.successfulShardCeiling
        }
      }),
      inspection: {
        writerLock: inspection.writerLock,
        disk: inspection.disk,
        credentialStatus: inspection.credentialStatus,
        modelReadiness: inspection.modelReadiness
      }
    });
    (deps.write ?? writeExtractionAuthorityReceipt)(authority.outputPath, receipt);
    process.stdout.write(
      `Extraction authority receipt written: ${authority.outputPath}\n` +
      `  action=${receipt.action} identity=${receipt.identity_digest} ` +
      `receipt=${receipt.receipt_digest} missing=${receipt.limits.starting_missing} ` +
      `attempt_cap=${receipt.limits.maximum_attempts}\n`
    );
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
    probeKey: optionalString(args, "--extraction-probe-key")
  };
  if (parsed.action === "probe" && parsed.probeKey === undefined) {
    throw new Error("--extraction-probe-key is required when --extraction-action=probe");
  }
  if (parsed.action === "fill" && parsed.probeKey !== undefined) {
    throw new Error("--extraction-probe-key is only valid when --extraction-action=probe");
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
