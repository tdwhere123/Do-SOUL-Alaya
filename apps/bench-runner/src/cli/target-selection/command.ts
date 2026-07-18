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
  createFreshRetiredSourceRebuildTargetSelectionRoot,
  createRetiredSourceRebuildTargetSelectionReceipt,
  discardFreshExtractionTargetSelectionRoot,
  writeExtractionTargetSelectionReceipt,
  type ExtractionTargetRootBinding
} from "../../longmemeval/extraction/authority/target-selection/receipt.js";
import { readExtractionCacheAuditReceipt } from
  "../../longmemeval/extraction/cache-audit/receipt.js";

interface TargetSelectionArgs {
  readonly authority: TargetSelectionAuthority;
  readonly outputPath: string;
}

type TargetSelectionAuthority =
  | { readonly kind: "cache_audit"; readonly receiptPath: string }
  | { readonly kind: "retired_source_rebuild"; readonly operator: string };

type ResolvedTargetSelectionAuthority =
  | { readonly kind: "cache_audit"; readonly auditReceipt: ReturnType<typeof readExtractionCacheAuditReceipt> }
  | { readonly kind: "retired_source_rebuild"; readonly operator: string };

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
    cacheRoot = resolveEffectiveExtractionCacheRoot(flags.extractionCacheRoot);
    assertSelectionOutputOutsideCacheRoot(selection.outputPath, cacheRoot);
    const selectionAuthority = resolveTargetSelectionAuthority(selection.authority, deps);
    freshTargetRoot = selectionAuthority.kind === "retired_source_rebuild"
      ? createFreshRetiredSourceRebuildTargetSelectionRoot({
          cacheRoot,
          operator: selectionAuthority.operator
        })
      : createFreshExtractionTargetSelectionRoot({
          cacheRoot,
          auditReceipt: selectionAuthority.auditReceipt
        });
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
    const selected = selectionAuthority.kind === "retired_source_rebuild"
      ? createRetiredSourceRebuildTargetSelectionReceipt({
          operator: selectionAuthority.operator,
          targetRoot: freshTargetRoot,
          observation: inspection.observation
        })
      : createExtractionTargetSelectionReceipt({
          auditReceipt: selectionAuthority.auditReceipt,
          targetRoot: freshTargetRoot,
          observation: inspection.observation
        });
    (deps.write ?? writeExtractionTargetSelectionReceipt)(selection.outputPath, selected);
    freshTargetRoot = undefined;
    process.stdout.write(
      `Extraction target selection written: ${selection.outputPath}\n` +
      `  receipt=${selected.receipt_digest} basis=${selected.selection_basis.kind}\n`
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
  const auditReceiptPath = optionalRequiredString(args, "--cache-audit-receipt");
  const retiredSourceRebuildOperator = optionalRequiredString(
    args, "--retired-source-rebuild-operator"
  );
  if ((auditReceiptPath === undefined) === (retiredSourceRebuildOperator === undefined)) {
    throw new Error(
      "select-extraction-target requires exactly one of --cache-audit-receipt or --retired-source-rebuild-operator"
    );
  }
  return {
    authority: auditReceiptPath === undefined
      ? { kind: "retired_source_rebuild", operator: retiredSourceRebuildOperator! }
      : { kind: "cache_audit", receiptPath: auditReceiptPath },
    outputPath: requiredString(args, "--target-selection-out")
  };
}

function resolveTargetSelectionAuthority(
  authority: TargetSelectionAuthority,
  deps: TargetSelectionDependencies
): ResolvedTargetSelectionAuthority {
  if (authority.kind === "retired_source_rebuild") return authority;
  return {
    kind: "cache_audit",
    auditReceipt: (deps.readAudit ?? readExtractionCacheAuditReceipt)(authority.receiptPath)
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

function optionalRequiredString(args: ReadonlyArray<string>, flag: string): string | undefined {
  return args.some((token) => token === flag || token.startsWith(`${flag}=`))
    ? requiredString(args, flag)
    : undefined;
}
