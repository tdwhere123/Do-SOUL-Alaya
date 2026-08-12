import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { parseExtractionCacheAuditReceiptContents } from
  "../../longmemeval/extraction/cache-audit/receipt.js";
import { readBoundedCanonicalUtf8Artifact } from
  "../../longmemeval/extraction/cache-audit/bounded-artifact-reader.js";
import { readRawInventoryArtifact } from
  "../../longmemeval/extraction/cache-audit/raw-inventory-artifact.js";
import {
  materializeAuditedExtractionCacheTarget,
  withVerifiedCommittedAuditedExtractionCacheSuccessor,
  type ExtractionCacheMaterializationReceipt
} from
  "../../longmemeval/extraction/cache-audit/target-materializer.js";
import { readAuditedSourceManifestArtifact } from
  "../../longmemeval/extraction/cache-audit/source-manifest-artifact.js";
import {
  MATERIALIZATION_COMMIT_NAME
} from "../../longmemeval/extraction/cache-audit/materialization/contract.js";
import { parseExtractionTargetSelectionReceiptContents } from
  "../../longmemeval/extraction/authority/target-selection/receipt.js";
import { publishDurableExclusiveOutputUnderLease } from
  "../output/durable-exclusive-output.js";

const MAX_AUDIT_RECEIPT_BYTES = 64 * 1024;
const MAX_TARGET_SELECTION_RECEIPT_BYTES = 64 * 1024;

interface MaterializeCommandArgs {
  readonly auditOutput: string;
  readonly targetRoot: string;
  readonly targetSelectionPath: string;
  readonly receiptPath: string;
}

export async function runMaterializeAuditedExtractionTargetCommand(
  args: ReadonlyArray<string>
): Promise<number> {
  try {
    const parsed = parseMaterializeCommandArgs(args);
    const targetRoot = canonicalDirectory(parsed.targetRoot, "extraction cache root");
    const receiptPath = preflightReceiptPath(parsed, targetRoot);
    if (pathExists(join(targetRoot, MATERIALIZATION_COMMIT_NAME))) {
      await reexportCommittedReceipt(targetRoot, receiptPath);
      return 0;
    }
    await materializeFromAuditBundle(parsed, targetRoot, receiptPath);
    return 0;
  } catch (error) {
    process.stderr.write(
      `alaya-bench-runner materialize-audited-extraction-target: ${error instanceof Error
        ? error.message
        : String(error)}\n`
    );
    return 2;
  }
}

function reexportCommittedReceipt(targetRoot: string, receiptPath: string): void {
  withVerifiedCommittedAuditedExtractionCacheSuccessor(
    { targetRoot },
    ({ receipt }) => exportReceiptAndReport(receiptPath, receipt)
  );
}

async function materializeFromAuditBundle(
  parsed: MaterializeCommandArgs,
  targetRoot: string,
  receiptPath: string
): Promise<void> {
  const auditOutput = canonicalDirectory(parsed.auditOutput, "cache audit output");
  const auditReceipt = parseExtractionCacheAuditReceiptContents(readBoundedCanonicalUtf8Artifact({
    path: join(auditOutput, "audit-receipt.json"),
    maxBytes: MAX_AUDIT_RECEIPT_BYTES,
    label: "cache audit receipt"
  }));
  const rawInventory = readRawInventoryArtifact(join(auditOutput, "raw-inventory.json"));
  const sourceManifest = readAuditedSourceManifestArtifact(
    join(auditOutput, "source-manifest.json")
  );
  if (sourceManifest.sha256 !== auditReceipt.source_manifest_sha256) {
    throw new Error("source manifest sha256 does not match the cache audit receipt");
  }
  if (rawInventory.sha256 !== auditReceipt.raw_inventory_sha256) {
    throw new Error("raw inventory sha256 does not match the cache audit receipt");
  }
  const targetSelection = parseExtractionTargetSelectionReceiptContents(
    readBoundedCanonicalUtf8Artifact({ path: parsed.targetSelectionPath,
      maxBytes: MAX_TARGET_SELECTION_RECEIPT_BYTES,
      label: "extraction target selection receipt" })
  );
  assertReceiptOutsideRoots(receiptPath, [auditReceipt.source_root, targetRoot, auditOutput]);
  materializeAuditedExtractionCacheTarget({
    sourceRoot: auditReceipt.source_root, targetRoot, auditReceipt,
    inventory: rawInventory.inventory, targetSelection,
    auditedSourceManifestRaw: sourceManifest.raw, now: () => new Date().toISOString(),
    onCommitted: (receipt) => exportReceiptAndReport(receiptPath, receipt)
  });
}

function parseMaterializeCommandArgs(args: ReadonlyArray<string>): MaterializeCommandArgs {
  const flags = [
    "--cache-audit-output", "--extraction-cache-root",
    "--extraction-target-selection", "--materialization-receipt-out"
  ] as const;
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === undefined || !flags.includes(flag as typeof flags[number])) {
      throw new Error(`unknown materialization option: ${flag ?? ""}`);
    }
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    if (values.has(flag)) throw new Error(`${flag} may be provided only once`);
    values.set(flag, value);
  }
  return {
    auditOutput: requiredValue(values, "--cache-audit-output"),
    targetRoot: requiredValue(values, "--extraction-cache-root"),
    targetSelectionPath: requiredValue(values, "--extraction-target-selection"),
    receiptPath: requiredValue(values, "--materialization-receipt-out")
  };
}

function canonicalDirectory(path: string, label: string): string {
  const absolute = resolve(path);
  let canonical: string;
  try {
    canonical = realpathSync(absolute);
  } catch (cause) {
    throw new Error(`${label} must be an existing directory`, { cause });
  }
  if (canonical !== absolute) throw new Error(`${label} must be canonical and not a symlink`);
  if (!lstatSync(canonical).isDirectory()) throw new Error(`${label} must be a directory`);
  return canonical;
}

function preflightReceiptPath(
  parsed: MaterializeCommandArgs,
  targetRoot: string
): string {
  const absolute = resolve(parsed.receiptPath);
  assertReceiptOutsideRoots(absolute, [parsed.auditOutput, targetRoot]);
  assertReceiptDiffersFromSelection(absolute, parsed.targetSelectionPath);
  mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
  const canonical = join(realpathSync(dirname(absolute)), basename(absolute));
  assertReceiptOutsideRoots(canonical, [parsed.auditOutput, targetRoot]);
  assertReceiptDiffersFromSelection(canonical, parsed.targetSelectionPath);
  if (pathExists(canonical) && !pathExists(join(targetRoot, MATERIALIZATION_COMMIT_NAME))) {
    throw new Error("materialization receipt already exists without a committed target");
  }
  return canonical;
}

function assertReceiptOutsideRoots(path: string, roots: readonly string[]): void {
  const protectedRoots = roots.flatMap((root) => {
    const absolute = resolve(root);
    return pathExists(absolute) ? [absolute, realpathSync(absolute)] : [absolute];
  });
  if (protectedRoots.some((root) => isInside(path, root))) {
    throw new Error("materialization receipt must be outside all artifact roots");
  }
}

function assertReceiptDiffersFromSelection(path: string, selectionPath: string): void {
  const absolute = resolve(selectionPath);
  const canonical = pathExists(absolute)
    ? realpathSync(absolute)
    : join(resolve(dirname(absolute)), basename(absolute));
  if (path === absolute || path === canonical) {
    throw new Error("materialization receipt must not replace the target selection receipt");
  }
}

function writeMaterializationSuccess(materializedKeyCount: number): void {
  process.stdout.write(`Extraction cache materialized: ${materializedKeyCount} shard(s).\n`);
}

function exportReceiptAndReport(
  path: string,
  receipt: ExtractionCacheMaterializationReceipt
): void {
  publishDurableExclusiveOutputUnderLease({
    outputPath: path,
    contents: `${JSON.stringify(receipt, null, 2)}\n`,
    ownershipId: receipt.materialization_commit_digest
  });
  writeMaterializationSuccess(receipt.materialized_key_count);
}

function isInside(path: string, root: string): boolean {
  const child = relative(root, path);
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}

function requiredValue(values: ReadonlyMap<string, string>, flag: string): string {
  const value = values.get(flag);
  if (value === undefined) throw new Error(`${flag} is required`);
  return value;
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
