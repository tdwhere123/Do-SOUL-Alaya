import process from "node:process";
import { isAbsolute, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
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
  createSameRootContinuationTargetSelectionReceipt,
  createMaterializedSuccessorTargetSelectionReceipt,
  discardFreshExtractionTargetSelectionRoot,
  assertExtractionTargetSelectionRootBinding,
  readExtractionTargetSelectionReceipt,
  writeExtractionTargetSelectionReceipt,
  type ExtractionTargetRootBinding,
  type ExtractionTargetSelectionReceipt
} from "../../longmemeval/extraction/authority/target-selection/receipt.js";
import {
  materializationReceiptFromCommit,
  readExtractionCacheMaterializationReceipt
} from "../../longmemeval/extraction/cache-audit/materialization/receipt.js";
import { verifyCommittedAuditedExtractionCacheSuccessor } from
  "../../longmemeval/extraction/cache-audit/target-materializer.js";
import { readExtractionCacheAuditReceipt } from
  "../../longmemeval/extraction/cache-audit/receipt.js";
import { readExtractionAuthorityReceipt } from
  "../../longmemeval/extraction/authority/receipt.js";
import {
  assertExtractionAuthorityHasNoContinuationChild,
  assertImmediateContinuationAdoptionParent,
  claimExtractionContinuationChild,
  prepareExistingContinuationChildAdoption,
  type ExtractionContinuationChildClaim
} from "../../longmemeval/extraction/authority/continuation/child-claim.js";

interface TargetSelectionArgs {
  readonly authority: TargetSelectionAuthority;
  readonly adoption?: {
    readonly childSelectionPath: string;
    readonly childAuthorityPath: string;
  };
  readonly outputPath: string;
}

type TargetSelectionAuthority =
  | { readonly kind: "cache_audit"; readonly receiptPath: string }
  | { readonly kind: "retired_source_rebuild"; readonly operator: string }
  | { readonly kind: "materialized_successor"; readonly receiptPath: string }
  | {
      readonly kind: "same_root_continuation";
      readonly predecessorSelectionPath: string;
      readonly predecessorAuthorityPath: string;
    };

type ResolvedTargetSelectionAuthority =
  | { readonly kind: "cache_audit"; readonly auditReceipt: ReturnType<typeof readExtractionCacheAuditReceipt> }
  | { readonly kind: "retired_source_rebuild"; readonly operator: string }
  | {
      readonly kind: "materialized_successor";
      readonly commit: ReturnType<typeof verifyCommittedAuditedExtractionCacheSuccessor>;
    }
  | {
      readonly kind: "same_root_continuation";
      readonly predecessorSelection: ReturnType<typeof readExtractionTargetSelectionReceipt>;
      readonly predecessorAuthority: ReturnType<typeof readExtractionAuthorityReceipt>;
    };

interface TargetSelectionDependencies {
  readonly inspect?: typeof inspectExtractionAuthority;
  readonly readAudit?: typeof readExtractionCacheAuditReceipt;
  readonly readSelection?: typeof readExtractionTargetSelectionReceipt;
  readonly readAuthority?: typeof readExtractionAuthorityReceipt;
  readonly readMaterializationReceipt?: typeof readExtractionCacheMaterializationReceipt;
  readonly verifyMaterializedSuccessor?: typeof verifyCommittedAuditedExtractionCacheSuccessor;
  readonly prepareExistingChild?: typeof prepareExistingContinuationChildAdoption;
  readonly claimExistingChild?: typeof claimExtractionContinuationChild;
  readonly assertUnclaimed?: typeof assertExtractionAuthorityHasNoContinuationChild;
  readonly assertRootBinding?: typeof assertExtractionTargetSelectionRootBinding;
  readonly write?: typeof writeExtractionTargetSelectionReceipt;
  readonly readRevision?: () => string;
}

interface TargetSelectionRunState {
  cacheRoot?: string;
  freshTargetRoot?: ExtractionTargetRootBinding;
}

export async function runSelectExtractionTargetCommand(
  args: ReadonlyArray<string>,
  deps: TargetSelectionDependencies = {}
): Promise<number> {
  const state: TargetSelectionRunState = {};
  try {
    await executeTargetSelection(args, deps, state);
    return 0;
  } catch (error) {
    if (state.freshTargetRoot !== undefined && state.cacheRoot !== undefined) {
      discardFreshExtractionTargetSelectionRoot({
        cacheRoot: state.cacheRoot, targetRoot: state.freshTargetRoot
      });
    }
    process.stderr.write(
      `alaya-bench-runner select-extraction-target: ${error instanceof Error
        ? error.message
        : String(error)}\n`
    );
    return 2;
  }
}

async function executeTargetSelection(
  args: ReadonlyArray<string>,
  deps: TargetSelectionDependencies,
  state: TargetSelectionRunState
): Promise<void> {
  const flags = parseFlags(args);
  const selection = parseTargetSelectionArgs(args);
  const cacheRoot = resolveEffectiveExtractionCacheRoot(flags.extractionCacheRoot);
  state.cacheRoot = cacheRoot;
  assertSelectionOutputOutsideCacheRoot(selection.outputPath, cacheRoot);
  const authority = resolveTargetSelectionAuthority(selection.authority, cacheRoot, deps);
  state.freshTargetRoot = createSelectionTargetRoot(authority, cacheRoot);
  prepareContinuationAdoption(selection, authority, cacheRoot, deps);
  const inspection = await inspectSelection(flags, cacheRoot, deps);
  const selected = createSelectedReceipt(authority, state.freshTargetRoot, inspection.observation);
  (deps.write ?? writeExtractionTargetSelectionReceipt)(selection.outputPath, selected);
  state.freshTargetRoot = undefined;
  process.stdout.write(
    `Extraction target selection written: ${selection.outputPath}\n` +
    `  receipt=${selected.receipt_digest} basis=${selected.selection_basis.kind}\n`
  );
}

function createSelectionTargetRoot(
  authority: ResolvedTargetSelectionAuthority,
  cacheRoot: string
): ExtractionTargetRootBinding | undefined {
  if (authority.kind === "same_root_continuation" ||
      authority.kind === "materialized_successor") return undefined;
  return authority.kind === "retired_source_rebuild"
    ? createFreshRetiredSourceRebuildTargetSelectionRoot({ cacheRoot, operator: authority.operator })
    : createFreshExtractionTargetSelectionRoot({ cacheRoot, auditReceipt: authority.auditReceipt });
}

function prepareContinuationAdoption(
  selection: TargetSelectionArgs,
  authority: ResolvedTargetSelectionAuthority,
  cacheRoot: string,
  deps: TargetSelectionDependencies
): void {
  if (authority.kind !== "same_root_continuation") return;
  const explicitClaim = selection.adoption === undefined ? undefined
    : prepareExplicitExistingChild(selection.adoption, authority, cacheRoot, deps);
  (deps.assertRootBinding ?? assertExtractionTargetSelectionRootBinding)(
    authority.predecessorSelection, cacheRoot
  );
  const predecessorClaim = (deps.prepareExistingChild ??
    prepareExistingContinuationChildAdoption)({
    cacheRoot, child: authority.predecessorAuthority,
    childTargetSelection: authority.predecessorSelection
  });
  (deps.assertUnclaimed ?? assertExtractionAuthorityHasNoContinuationChild)({
    cacheRoot, authority: authority.predecessorAuthority
  });
  claimPreparedExistingChild(explicitClaim, cacheRoot, deps);
  claimPreparedExistingChild(predecessorClaim, cacheRoot, deps);
}

async function inspectSelection(
  flags: ReturnType<typeof parseFlags>,
  cacheRoot: string,
  deps: TargetSelectionDependencies
): Promise<Awaited<ReturnType<typeof inspectExtractionAuthority>>> {
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
  return inspection;
}

function createSelectedReceipt(
  authority: ResolvedTargetSelectionAuthority,
  freshTargetRoot: ExtractionTargetRootBinding | undefined,
  observation: Parameters<typeof createSameRootContinuationTargetSelectionReceipt>[0]["observation"]
): ExtractionTargetSelectionReceipt {
  if (authority.kind === "same_root_continuation") {
    return createSameRootContinuationTargetSelectionReceipt({
      predecessor: authority.predecessorSelection,
      predecessorAuthorityReceiptDigest: authority.predecessorAuthority.receipt_digest,
      observation
    });
  }
  if (authority.kind === "materialized_successor") {
    return createMaterializedSuccessorTargetSelectionReceipt({
      predecessor: authority.commit.target_selection,
      materializationCommitDigest: authority.commit.commit_digest,
      observation
    });
  }
  return authority.kind === "retired_source_rebuild"
    ? createRetiredSourceRebuildTargetSelectionReceipt({
        operator: authority.operator, targetRoot: requireFreshTargetRoot(freshTargetRoot), observation
      })
    : createExtractionTargetSelectionReceipt({
        auditReceipt: authority.auditReceipt,
        targetRoot: requireFreshTargetRoot(freshTargetRoot), observation
      });
}

function requireFreshTargetRoot(
  targetRoot: ExtractionTargetRootBinding | undefined
): ExtractionTargetRootBinding {
  if (targetRoot === undefined) {
    throw new Error("Fresh target-root binding was not created");
  }
  return targetRoot;
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
  for (const flag of [
    "--predecessor-target-selection", "--extraction-predecessor-authority",
    "--adopt-existing-child-target-selection", "--adopt-existing-child-authority"
  ]) assertFlagAtMostOnce(args, flag);
  const auditReceiptPath = optionalRequiredString(args, "--cache-audit-receipt");
  const materializationReceiptPath = optionalRequiredString(
    args, "--materialization-receipt"
  );
  const retiredSourceRebuildOperator = optionalRequiredString(
    args, "--retired-source-rebuild-operator"
  );
  const predecessorSelectionPath = optionalRequiredString(
    args, "--predecessor-target-selection"
  );
  const predecessorAuthorityPath = optionalRequiredString(
    args, "--extraction-predecessor-authority"
  );
  const adoptChildSelectionPath = optionalRequiredString(
    args, "--adopt-existing-child-target-selection"
  );
  const adoptChildAuthorityPath = optionalRequiredString(
    args, "--adopt-existing-child-authority"
  );
  const authority = parseTargetSelectionAuthority({
    auditReceiptPath, materializationReceiptPath, retiredSourceRebuildOperator,
    predecessorSelectionPath, predecessorAuthorityPath,
    adoptChildSelectionPath, adoptChildAuthorityPath
  });
  return {
    authority,
    ...(adoptChildSelectionPath === undefined ? {} : {
      adoption: {
        childSelectionPath: adoptChildSelectionPath,
        childAuthorityPath: adoptChildAuthorityPath!
      }
    }),
    outputPath: requiredString(args, "--target-selection-out")
  };
}

function parseTargetSelectionAuthority(input: {
  readonly auditReceiptPath: string | undefined;
  readonly materializationReceiptPath: string | undefined;
  readonly retiredSourceRebuildOperator: string | undefined;
  readonly predecessorSelectionPath: string | undefined;
  readonly predecessorAuthorityPath: string | undefined;
  readonly adoptChildSelectionPath: string | undefined;
  readonly adoptChildAuthorityPath: string | undefined;
}): TargetSelectionAuthority {
  const { auditReceiptPath, materializationReceiptPath, retiredSourceRebuildOperator,
    predecessorSelectionPath, predecessorAuthorityPath,
    adoptChildSelectionPath, adoptChildAuthorityPath } = input;
  if ((predecessorSelectionPath === undefined) !== (predecessorAuthorityPath === undefined)) {
    throw new Error("same-root continuation requires both predecessor receipt paths");
  }
  if ((adoptChildSelectionPath === undefined) !== (adoptChildAuthorityPath === undefined) ||
      (adoptChildSelectionPath !== undefined && predecessorSelectionPath === undefined)) {
    throw new Error(
      "existing-child adoption requires both adoption receipts on a continuation route"
    );
  }
  const routeCount = Number(auditReceiptPath !== undefined) +
    Number(materializationReceiptPath !== undefined) +
    Number(retiredSourceRebuildOperator !== undefined) +
    Number(predecessorSelectionPath !== undefined);
  if (routeCount !== 1) {
    throw new Error(
      "select-extraction-target requires exactly one fresh or continuation authority"
    );
  }
  return predecessorSelectionPath !== undefined
    ? {
        kind: "same_root_continuation", predecessorSelectionPath,
        predecessorAuthorityPath: predecessorAuthorityPath!
      }
    : materializationReceiptPath !== undefined
    ? { kind: "materialized_successor", receiptPath: materializationReceiptPath }
    : auditReceiptPath === undefined
    ? { kind: "retired_source_rebuild", operator: retiredSourceRebuildOperator! }
    : { kind: "cache_audit", receiptPath: auditReceiptPath };
}

function prepareExplicitExistingChild(
  adoption: NonNullable<TargetSelectionArgs["adoption"]>,
  successor: Extract<ResolvedTargetSelectionAuthority, { kind: "same_root_continuation" }>,
  cacheRoot: string,
  deps: TargetSelectionDependencies
): ExtractionContinuationChildClaim {
  const childSelection = (deps.readSelection ?? readExtractionTargetSelectionReceipt)(
    adoption.childSelectionPath
  );
  const childAuthority = (deps.readAuthority ?? readExtractionAuthorityReceipt)(
    adoption.childAuthorityPath
  );
  assertImmediateContinuationAdoptionParent({
    parent: childAuthority,
    parentTargetSelection: childSelection,
    child: successor.predecessorAuthority,
    childTargetSelection: successor.predecessorSelection
  });
  const claim = (deps.prepareExistingChild ?? prepareExistingContinuationChildAdoption)({
    cacheRoot,
    child: childAuthority,
    childTargetSelection: childSelection
  });
  if (claim === undefined) {
    throw new Error("explicit continuation adoption child must itself be a continuation");
  }
  return claim;
}

function claimPreparedExistingChild(
  claim: ExtractionContinuationChildClaim | undefined,
  cacheRoot: string,
  deps: TargetSelectionDependencies
): void {
  if (claim === undefined) return;
  (deps.claimExistingChild ?? claimExtractionContinuationChild)({ cacheRoot, claim });
}

function resolveTargetSelectionAuthority(
  authority: TargetSelectionAuthority,
  cacheRoot: string,
  deps: TargetSelectionDependencies
): ResolvedTargetSelectionAuthority {
  if (authority.kind === "retired_source_rebuild") return authority;
  if (authority.kind === "same_root_continuation") {
    const predecessorSelection = (deps.readSelection ?? readExtractionTargetSelectionReceipt)(
      authority.predecessorSelectionPath
    );
    const predecessorAuthority = (deps.readAuthority ?? readExtractionAuthorityReceipt)(
      authority.predecessorAuthorityPath
    );
    if (predecessorAuthority.target_selection_digest !== predecessorSelection.receipt_digest) {
      throw new Error("predecessor authority does not bind the predecessor target selection");
    }
    return { kind: authority.kind, predecessorSelection, predecessorAuthority };
  }
  if (authority.kind === "materialized_successor") {
    const receipt = (deps.readMaterializationReceipt ??
      readExtractionCacheMaterializationReceipt)(authority.receiptPath);
    const commit = (deps.verifyMaterializedSuccessor ??
      verifyCommittedAuditedExtractionCacheSuccessor)({ targetRoot: cacheRoot });
    if (!isDeepStrictEqual(receipt, materializationReceiptFromCommit(commit))) {
      throw new Error("materialization receipt does not bind the verified successor");
    }
    return { kind: authority.kind, commit };
  }
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

function assertFlagAtMostOnce(args: ReadonlyArray<string>, flag: string): void {
  const count = args.filter((token) => token === flag || token.startsWith(`${flag}=`)).length;
  if (count > 1) throw new Error(`${flag} may be provided only once`);
}
