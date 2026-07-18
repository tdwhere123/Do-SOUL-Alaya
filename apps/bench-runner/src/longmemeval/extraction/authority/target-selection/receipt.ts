import { createHash, randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  assertFreshExtractionCacheRoot,
  type ExtractionCacheCompatibilityIdentity
} from "../../cache-audit/compatibility.js";
import type { ExtractionCacheAuditReceipt } from "../../cache-audit/receipt.js";
import type { ExtractionAuthorityObservation } from "../receipt.js";
import type { ExtractionCacheWriteLease } from "../../fill/manifest/fill-root-guard.js";
import {
  assertFreshExtractionTargetRootPath,
  assertExtractionTargetRootBinding,
  createFreshExtractionTargetRoot,
  discardFreshExtractionTargetRoot,
  type ExtractionTargetRootBinding
} from "../target-root-binding.js";

export type { ExtractionTargetRootBinding } from "../target-root-binding.js";

const TARGET_SELECTION_SCHEMA_VERSION = 2;
const targetRootMarker = {
  filename: ".alaya-extraction-target-root.json",
  kind: "alaya_extraction_target_root"
} as const;

export interface ExtractionTargetSelectionReceipt {
  readonly schema_version: typeof TARGET_SELECTION_SCHEMA_VERSION;
  readonly kind: "longmemeval-extraction-target-selection";
  readonly created_at: string;
  readonly selection_basis: ExtractionTargetSelectionBasis;
  readonly target_root: ExtractionTargetRootBinding;
  readonly final_identity: ExtractionTargetFinalIdentity;
  readonly initial_selection: ExtractionTargetInitialSelection;
  readonly receipt_digest: string;
}

export type ExtractionTargetSelectionBasis =
  | {
      readonly kind: "cache_audit";
      readonly audit_decision_digest: string;
    }
  | {
      readonly kind: "retired_source_rebuild";
      readonly operator: string;
    };

export interface ExtractionTargetFinalIdentity {
  readonly revision: string;
  readonly dataset_variant: string;
  readonly dataset_revision_sha256: string;
  readonly model: string;
  readonly model_family: string;
  readonly request_profile: string;
  readonly provider_url: string;
  readonly system_prompt_sha256: string;
  readonly cache_key_algorithm: string;
}

export interface ExtractionTargetInitialSelection {
  readonly selection_digest: string;
  readonly key_digest: string;
  readonly offset: number;
  readonly limit: number;
  readonly expected_turns: number;
}

export function requiresExtractionTargetSelection(
  observation: Pick<ExtractionAuthorityObservation, "dataset">
): boolean {
  const dataset = observation.dataset;
  return dataset.variant === "longmemeval_s" && dataset.windowOffset === 0 &&
    (dataset.windowLimit === 100 || dataset.windowLimit === 500);
}

export function createFreshExtractionTargetSelection(input: {
  readonly cacheRoot: string;
  readonly auditReceipt: ExtractionCacheAuditReceipt;
  readonly observation: ExtractionAuthorityObservation;
  readonly now?: Date;
}): ExtractionTargetSelectionReceipt {
  const targetRoot = createFreshExtractionTargetSelectionRoot({
    cacheRoot: input.cacheRoot,
    auditReceipt: input.auditReceipt
  });
  try {
    return createExtractionTargetSelectionReceipt({
      auditReceipt: input.auditReceipt,
      targetRoot,
      observation: input.observation,
      now: input.now
    });
  } catch (cause) {
    discardFreshExtractionTargetSelectionRoot({
      cacheRoot: input.cacheRoot,
      targetRoot
    });
    throw cause;
  }
}

export function createFreshRetiredSourceRebuildTargetSelection(input: {
  readonly cacheRoot: string;
  readonly operator: string;
  readonly observation: ExtractionAuthorityObservation;
  readonly now?: Date;
}): ExtractionTargetSelectionReceipt {
  const targetRoot = createFreshRetiredSourceRebuildTargetSelectionRoot({
    cacheRoot: input.cacheRoot,
    operator: input.operator
  });
  try {
    return createRetiredSourceRebuildTargetSelectionReceipt({
      operator: input.operator,
      targetRoot,
      observation: input.observation,
      now: input.now
    });
  } catch (cause) {
    discardFreshExtractionTargetSelectionRoot({
      cacheRoot: input.cacheRoot,
      targetRoot
    });
    throw cause;
  }
}

export function createFreshExtractionTargetSelectionRoot(input: {
  readonly cacheRoot: string;
  readonly auditReceipt: ExtractionCacheAuditReceipt;
}): ExtractionTargetRootBinding {
  assertRebuildAudit(input.auditReceipt);
  assertFreshExtractionCacheRoot({
    sourceRoot: input.auditReceipt.source_root,
    targetRoot: input.cacheRoot
  });
  return createFreshExtractionTargetRoot({
    cacheRoot: input.cacheRoot,
    marker: targetRootMarker,
    purpose: "extraction target selection"
  });
}

export function createFreshRetiredSourceRebuildTargetSelectionRoot(input: {
  readonly cacheRoot: string;
  readonly operator: string;
}): ExtractionTargetRootBinding {
  retiredSourceRebuildBasis(input.operator);
  assertFreshExtractionTargetRootPath(input.cacheRoot);
  return createFreshExtractionTargetRoot({
    cacheRoot: input.cacheRoot,
    marker: targetRootMarker,
    purpose: "extraction target selection"
  });
}

export function createExtractionTargetSelectionReceipt(input: {
  readonly auditReceipt: ExtractionCacheAuditReceipt;
  readonly targetRoot: ExtractionTargetRootBinding;
  readonly observation: ExtractionAuthorityObservation;
  readonly now?: Date;
}): ExtractionTargetSelectionReceipt {
  assertRebuildAudit(input.auditReceipt);
  assertAuditFinalIdentity(input.auditReceipt.decision.final, input.observation);
  return createTargetSelectionReceipt({
    selectionBasis: auditSelectionBasis(input.auditReceipt),
    targetRoot: input.targetRoot,
    observation: input.observation,
    now: input.now
  });
}

export function createRetiredSourceRebuildTargetSelectionReceipt(input: {
  readonly operator: string;
  readonly targetRoot: ExtractionTargetRootBinding;
  readonly observation: ExtractionAuthorityObservation;
  readonly now?: Date;
}): ExtractionTargetSelectionReceipt {
  return createTargetSelectionReceipt({
    selectionBasis: retiredSourceRebuildBasis(input.operator),
    targetRoot: input.targetRoot,
    observation: input.observation,
    now: input.now
  });
}

function createTargetSelectionReceipt(input: {
  readonly selectionBasis: ExtractionTargetSelectionBasis;
  readonly targetRoot: ExtractionTargetRootBinding;
  readonly observation: ExtractionAuthorityObservation;
  readonly now?: Date;
}): ExtractionTargetSelectionReceipt {
  assertFreshInitialSelection(input.observation);
  const unsigned = {
    schema_version: TARGET_SELECTION_SCHEMA_VERSION as typeof TARGET_SELECTION_SCHEMA_VERSION,
    kind: "longmemeval-extraction-target-selection" as const,
    created_at: (input.now ?? new Date()).toISOString(),
    selection_basis: Object.freeze({ ...input.selectionBasis }),
    target_root: Object.freeze({ ...input.targetRoot }),
    final_identity: finalIdentity(input.observation),
    initial_selection: initialSelection(input.observation)
  };
  return Object.freeze({ ...unsigned, receipt_digest: digest(unsigned) });
}

function auditSelectionBasis(
  auditReceipt: ExtractionCacheAuditReceipt
): ExtractionTargetSelectionBasis {
  return Object.freeze({
    kind: "cache_audit",
    audit_decision_digest: auditReceipt.decision_digest
  });
}

function retiredSourceRebuildBasis(operator: string): ExtractionTargetSelectionBasis {
  const normalized = operator.trim();
  if (normalized.length === 0 || normalized.length > 256) {
    throw new Error("retired-source rebuild operator must be a non-empty short string");
  }
  return Object.freeze({ kind: "retired_source_rebuild", operator: normalized });
}

export function assertExtractionTargetSelectionReceipt(input: {
  readonly receipt: ExtractionTargetSelectionReceipt;
  readonly cacheRoot: string;
  readonly observation: ExtractionAuthorityObservation;
  readonly writeLease?: ExtractionCacheWriteLease;
}): void {
  assertExtractionTargetSelectionRootBinding(input.receipt, input.cacheRoot, input.writeLease);
  assertFinalIdentity(input.receipt.final_identity, input.observation);
}

export function assertExtractionTargetSelectionRootBinding(
  receipt: ExtractionTargetSelectionReceipt,
  cacheRoot: string,
  writeLease: ExtractionCacheWriteLease | undefined = undefined
): void {
  assertReceiptIntegrity(receipt);
  assertExtractionTargetRootBinding({
    cacheRoot,
    marker: targetRootMarker,
    purpose: "extraction target selection",
    binding: receipt.target_root,
    ...(writeLease === undefined ? {} : { writeLease })
  });
}

export function assertExtractionTargetSelectionInitialWindow(
  receipt: ExtractionTargetSelectionReceipt,
  observation: ExtractionAuthorityObservation
): void {
  assertReceiptIntegrity(receipt);
  const current = initialSelection(observation);
  if (!matchesInitialSelection(receipt.initial_selection, current)) {
    throw new Error("extraction target selection does not match its initial 100Q window");
  }
}

export function assertExtractionTargetSelectionWindow(
  receipt: ExtractionTargetSelectionReceipt,
  observation: ExtractionAuthorityObservation
): void {
  assertReceiptIntegrity(receipt);
  if (matchesInitialSelection(receipt.initial_selection, initialSelection(observation))) return;
  if (requiresExtractionTargetSelection(observation) && observation.dataset.windowLimit === 500) return;
  throw new Error("extraction target selection only admits its initial 100Q window or canonical 500Q expansion");
}

export function readExtractionTargetSelectionReceipt(path: string): ExtractionTargetSelectionReceipt {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  assertReceiptIntegrity(parsed);
  return parsed;
}

export function writeExtractionTargetSelectionReceipt(
  path: string,
  receipt: ExtractionTargetSelectionReceipt
): void {
  assertReceiptIntegrity(receipt);
  if (existsSync(path)) throw new Error("extraction target selection receipt already exists");
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    linkSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function discardFreshExtractionTargetSelection(input: {
  readonly receipt: ExtractionTargetSelectionReceipt;
  readonly cacheRoot: string;
}): void {
  discardFreshExtractionTargetSelectionRoot({
    cacheRoot: input.cacheRoot,
    targetRoot: input.receipt.target_root
  });
}

export function discardFreshExtractionTargetSelectionRoot(input: {
  readonly cacheRoot: string;
  readonly targetRoot: ExtractionTargetRootBinding;
}): void {
  discardFreshExtractionTargetRoot({
    cacheRoot: input.cacheRoot,
    marker: targetRootMarker,
    purpose: "extraction target selection",
    binding: input.targetRoot
  });
}

function assertRebuildAudit(auditReceipt: ExtractionCacheAuditReceipt): void {
  if (auditReceipt.decision.action !== "rebuild") {
    throw new Error("extraction target selection requires a rebuild cache audit receipt");
  }
}

function assertFreshInitialSelection(observation: ExtractionAuthorityObservation): void {
  const { dataset, extraction, inventory } = observation;
  if (dataset.variant !== "longmemeval_s" || dataset.windowOffset !== 0 ||
      dataset.windowLimit !== 100 || extraction.manifestSha256 !== null ||
      extraction.rawContentClosureSha256 !== null || inventory.validTurns !== 0 ||
      inventory.missingTurns !== inventory.expectedTurns || inventory.invalidTurns !== 0 ||
      inventory.orphanTurns !== 0) {
    throw new Error("extraction target selection requires a fresh canonical 100Q rebuild root");
  }
}

function assertAuditFinalIdentity(
  auditFinal: ExtractionCacheCompatibilityIdentity,
  observation: ExtractionAuthorityObservation
): void {
  const current = finalIdentity(observation);
  if (auditFinal.datasetRevision !== current.dataset_revision_sha256 ||
      auditFinal.model !== current.model || auditFinal.modelFamily !== current.model_family ||
      auditFinal.requestProfile !== current.request_profile ||
      auditFinal.providerUrl !== current.provider_url ||
      auditFinal.systemPromptSha256 !== current.system_prompt_sha256 ||
      auditFinal.cacheKeyAlgorithm !== current.cache_key_algorithm) {
    throw new Error("extraction target selection audit final identity does not match the live target");
  }
}

function assertFinalIdentity(
  expected: ExtractionTargetFinalIdentity,
  observation: ExtractionAuthorityObservation
): void {
  const current = finalIdentity(observation);
  if (expected.revision !== current.revision ||
      expected.dataset_variant !== current.dataset_variant ||
      expected.dataset_revision_sha256 !== current.dataset_revision_sha256 ||
      expected.model !== current.model || expected.model_family !== current.model_family ||
      expected.request_profile !== current.request_profile ||
      expected.provider_url !== current.provider_url ||
      expected.system_prompt_sha256 !== current.system_prompt_sha256 ||
      expected.cache_key_algorithm !== current.cache_key_algorithm) {
    throw new Error("extraction target selection final identity drifted");
  }
}

function finalIdentity(observation: ExtractionAuthorityObservation): ExtractionTargetFinalIdentity {
  return Object.freeze({
    revision: observation.revision,
    dataset_variant: observation.dataset.variant,
    dataset_revision_sha256: observation.dataset.revisionSha256,
    model: observation.extraction.model,
    model_family: observation.extraction.modelFamily,
    request_profile: observation.extraction.requestProfile,
    provider_url: observation.extraction.providerUrl,
    system_prompt_sha256: observation.extraction.systemPromptSha256,
    cache_key_algorithm: observation.extraction.cacheKeyAlgorithm
  });
}

function initialSelection(observation: ExtractionAuthorityObservation): ExtractionTargetInitialSelection {
  return Object.freeze({
    selection_digest: observation.selectionDigest,
    key_digest: observation.keyDigest,
    offset: observation.dataset.windowOffset,
    limit: observation.dataset.windowLimit,
    expected_turns: observation.inventory.expectedTurns
  });
}

function matchesInitialSelection(
  expected: ExtractionTargetInitialSelection,
  current: ExtractionTargetInitialSelection
): boolean {
  return expected.selection_digest === current.selection_digest &&
    expected.key_digest === current.key_digest && expected.offset === current.offset &&
    expected.limit === current.limit && expected.expected_turns === current.expected_turns;
}

function assertReceiptIntegrity(value: unknown): asserts value is ExtractionTargetSelectionReceipt {
  if (!isReceipt(value)) throw new Error("invalid extraction target selection receipt");
  const receipt = value;
  if (receipt.receipt_digest !== digest(withoutDigest(receipt))) {
    throw new Error("extraction target selection receipt digest is invalid");
  }
}

function withoutDigest(
  receipt: ExtractionTargetSelectionReceipt
): Omit<ExtractionTargetSelectionReceipt, "receipt_digest"> {
  const { receipt_digest: _receiptDigest, ...unsigned } = receipt;
  return unsigned;
}

function digest(value: object): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function isReceipt(value: unknown): value is ExtractionTargetSelectionReceipt {
  if (!isRecord(value) || value.schema_version !== TARGET_SELECTION_SCHEMA_VERSION ||
      value.kind !== "longmemeval-extraction-target-selection" || !isIsoDate(value.created_at) ||
      !isSelectionBasis(value.selection_basis) || !isTargetRootBinding(value.target_root) ||
      !isFinalIdentity(value.final_identity) || !isInitialSelection(value.initial_selection) ||
      !isSha256(value.receipt_digest)) return false;
  return true;
}

function isSelectionBasis(value: unknown): value is ExtractionTargetSelectionBasis {
  if (!isRecord(value)) return false;
  if (value.kind === "cache_audit") return isSha256(value.audit_decision_digest);
  return value.kind === "retired_source_rebuild" && typeof value.operator === "string" &&
    value.operator.trim().length > 0 && value.operator.length <= 256;
}

function isTargetRootBinding(value: unknown): value is ExtractionTargetRootBinding {
  return isRecord(value) && isSha256(value.cache_root_sha256) &&
    isNonnegativeIntegerString(value.cache_root_device) &&
    isNonnegativeIntegerString(value.cache_root_inode) &&
    isSha256(value.cache_root_marker_sha256);
}

function isFinalIdentity(value: unknown): value is ExtractionTargetFinalIdentity {
  return isRecord(value) && typeof value.revision === "string" &&
    typeof value.dataset_variant === "string" && isSha256(value.dataset_revision_sha256) &&
    typeof value.model === "string" && typeof value.model_family === "string" &&
    typeof value.request_profile === "string" && typeof value.provider_url === "string" &&
    isSha256(value.system_prompt_sha256) && typeof value.cache_key_algorithm === "string";
}

function isInitialSelection(value: unknown): value is ExtractionTargetInitialSelection {
  return isRecord(value) && isSha256(value.selection_digest) && isSha256(value.key_digest) &&
    isNonnegativeInteger(value.offset) && isNonnegativeInteger(value.limit) &&
    isNonnegativeInteger(value.expected_turns);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNonnegativeIntegerString(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/u.test(value);
}
