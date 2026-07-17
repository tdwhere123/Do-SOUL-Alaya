import process from "node:process";
import { isAbsolute, relative, resolve } from "node:path";
import { parseFlags } from "../cli-options.js";
import { resolveEffectiveExtractionCacheRoot } from
  "../../longmemeval/compile-seed/compile-seed-config.js";
import {
  inspectExtractionAuthority,
  readCurrentExtractionAuthorityRevision
} from "../../longmemeval/extraction/authority/inspection.js";
import {
  createExtractionTargetSelectionReceipt,
  createFreshExtractionTargetSelectionRoot,
  discardFreshExtractionTargetSelectionRoot,
  writeExtractionTargetSelectionReceipt,
  type ExtractionTargetRootBinding
} from "../../longmemeval/extraction/authority/target-selection/receipt.js";
import { readExtractionCacheAuditReceipt } from
  "../../longmemeval/extraction/cache-audit/receipt.js";

interface TargetSelectionArgs {
  readonly auditReceiptPath: string;
  readonly outputPath: string;
}

interface TargetSelectionDependencies {
  readonly inspect?: typeof inspectExtractionAuthority;
  readonly readAudit?: typeof readExtractionCacheAuditReceipt;
  readonly write?: typeof writeExtractionTargetSelectionReceipt;
  readonly readRevision?: () => string;
}

export async function runSelectExtractionTargetCommand(
  args: ReadonlyArray<string>,
  deps: TargetSelectionDependencies = {}
): Promise<number> {
  let freshTargetRoot: ExtractionTargetRootBinding | undefined;
  let cacheRoot: string | undefined;
  try {
    const flags = parseFlags(args);
    const selection = parseTargetSelectionArgs(args);
    const auditReceipt = (deps.readAudit ?? readExtractionCacheAuditReceipt)(
      selection.auditReceiptPath
    );
    cacheRoot = resolveEffectiveExtractionCacheRoot(flags.extractionCacheRoot);
    assertSelectionOutputOutsideCacheRoot(selection.outputPath, cacheRoot);
    freshTargetRoot = createFreshExtractionTargetSelectionRoot({ cacheRoot, auditReceipt });
    const inspection = await (deps.inspect ?? inspectExtractionAuthority)({
      variant: flags.variant,
      ...(flags.limit === undefined ? {} : { limit: flags.limit }),
      ...(flags.offset === undefined ? {} : { offset: flags.offset }),
      cacheRoot,
      ...(flags.dataDir === undefined ? {} : { dataDir: flags.dataDir }),
      ...(flags.pinnedMetaRoot === undefined ? {} : { pinnedMetaRoot: flags.pinnedMetaRoot }),
      revision: (deps.readRevision ?? readCurrentExtractionAuthorityRevision)(),
      action: "probe"
    });
    assertSelectionInspection(inspection);
    const selected = createExtractionTargetSelectionReceipt({
      auditReceipt,
      targetRoot: freshTargetRoot,
      observation: inspection.observation
    });
    (deps.write ?? writeExtractionTargetSelectionReceipt)(selection.outputPath, selected);
    freshTargetRoot = undefined;
    process.stdout.write(
      `Extraction target selection written: ${selection.outputPath}\n` +
      `  receipt=${selected.receipt_digest} audit=${selected.audit_decision_digest}\n`
    );
    return 0;
  } catch (error) {
    if (freshTargetRoot !== undefined && cacheRoot !== undefined) {
      discardFreshExtractionTargetSelectionRoot({ cacheRoot, targetRoot: freshTargetRoot });
    }
    process.stderr.write(
      `alaya-bench-runner select-extraction-target: ${error instanceof Error
        ? error.message
        : String(error)}\n`
    );
    return 2;
  }
}

function assertSelectionInspection(
  inspection: Awaited<ReturnType<typeof inspectExtractionAuthority>>
): void {
  const inventory = inspection.observation.inventory;
  if (inventory.invalidTurns !== 0 || inventory.orphanTurns !== 0) {
    throw new Error("cannot select an extraction target with invalid or orphan cache shards");
  }
}

function parseTargetSelectionArgs(args: ReadonlyArray<string>): TargetSelectionArgs {
  return {
    auditReceiptPath: requiredString(args, "--cache-audit-receipt"),
    outputPath: requiredString(args, "--target-selection-out")
  };
}

function assertSelectionOutputOutsideCacheRoot(outputPath: string, cacheRoot: string): void {
  const relativePath = relative(resolve(cacheRoot), resolve(outputPath));
  if (relativePath.length === 0 || (!relativePath.startsWith("..") && !isAbsolute(relativePath))) {
    throw new Error("--target-selection-out must be outside the extraction cache root");
  }
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
    if (token === flag) return args[index + 1];
    if (token?.startsWith(`${flag}=`)) return token.slice(flag.length + 1);
  }
  return undefined;
}
