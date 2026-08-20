import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { readBoundedCanonicalUtf8Artifact } from
  "../../cache-audit/bounded-artifact-reader.js";
import type { ExtractionAuthorityInspection } from "../inspection.js";
import type { ExtractionAuthorityObservation } from "../receipt.js";
import {
  assertExtractionPreservedValidClosure,
  assertPreservedValidClosureUnchanged,
  type ExtractionPreservedValidClosure
} from "../repair/preserved-valid-closure.js";

const MAX_CATALOG_REFILL_ALLOWLIST_BYTES = 32 * 1024 * 1024;

export interface ExtractionCatalogRefillScope {
  readonly kind: "audited-missing-cache-keys-v1";
  readonly root_binding: ExtractionCatalogRefillRootBinding;
  readonly expected_key_set_sha256: string;
  readonly initial_manifest_sha256: string;
  readonly initial_raw_content_closure_sha256: string;
  readonly preserved_valid_closure: ExtractionPreservedValidClosure;
  readonly shard_count: number;
  readonly key_set_sha256: string;
  readonly keys: readonly string[];
}

export interface ExtractionCatalogRefillRootBinding {
  readonly cache_root_sha256: string;
  readonly device: string;
  readonly inode: string;
}

export interface ExtractionCatalogRefillAllowlist {
  readonly kind: string;
  readonly expected_turns: number;
  readonly cached_turns: number;
  readonly missing_turns: number;
  readonly expected_key_set_sha256: string;
  readonly cache_keys: readonly string[];
}

export interface ExtractionCatalogRefillLedgerProgress {
  readonly attempts: number;
  readonly successfulKeys: readonly string[];
  readonly pendingKeys?: readonly string[];
  readonly unresolvedAttempts?: number;
}

export function readExtractionCatalogRefillAllowlist(
  path: string
): ExtractionCatalogRefillAllowlist {
  let value: unknown;
  try {
    value = JSON.parse(readBoundedCanonicalUtf8Artifact({
      path,
      maxBytes: MAX_CATALOG_REFILL_ALLOWLIST_BYTES,
      label: "catalog refill allowlist"
    }));
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`catalog refill allowlist is unreadable: ${path}: ${detail}`, { cause });
  }
  if (!isCatalogRefillAllowlist(value)) {
    throw new Error("catalog refill allowlist is invalid");
  }
  return Object.freeze({
    ...value,
    cache_keys: Object.freeze([...value.cache_keys])
  });
}

export function createExtractionCatalogRefillScope(input: {
  readonly cacheRoot: string;
  readonly inspection: ExtractionAuthorityInspection;
  readonly allowlist: ExtractionCatalogRefillAllowlist;
}): ExtractionCatalogRefillScope {
  const keys = normalizeKeys(input.allowlist.cache_keys);
  assertInitialInventory(input.inspection, input.allowlist, keys);
  const scope = {
    kind: "audited-missing-cache-keys-v1" as const,
    root_binding: createCatalogRefillRootBinding(input.cacheRoot),
    expected_key_set_sha256: input.inspection.observation.dataset.expectedKeySetSha256,
    initial_manifest_sha256: input.inspection.observation.extraction.manifestSha256!,
    initial_raw_content_closure_sha256:
      input.inspection.observation.extraction.rawContentClosureSha256!,
    preserved_valid_closure: Object.freeze({ ...input.inspection.preservedValidClosure }),
    shard_count: keys.length,
    key_set_sha256: digest(keys.join("\n")),
    keys: Object.freeze(keys)
  };
  assertExtractionCatalogRefillScope(scope);
  return Object.freeze(scope);
}

export function assertExtractionCatalogRefillScope(
  value: unknown
): asserts value is ExtractionCatalogRefillScope {
  if (!isObject(value)) throw invalidScope();
  const scope = value as Partial<ExtractionCatalogRefillScope>;
  if (scope.kind !== "audited-missing-cache-keys-v1" ||
      !isRootBinding(scope.root_binding) || !isDigest(scope.expected_key_set_sha256) ||
      !isDigest(scope.initial_manifest_sha256) ||
      !isDigest(scope.initial_raw_content_closure_sha256) ||
      !Number.isSafeInteger(scope.shard_count) || (scope.shard_count ?? 0) < 1 ||
      !isDigest(scope.key_set_sha256) || !Array.isArray(scope.keys) ||
      scope.keys.length !== scope.shard_count) {
    throw invalidScope();
  }
  assertExtractionPreservedValidClosure(scope.preserved_valid_closure);
  const keys = normalizeKeys(scope.keys);
  if (!sameOrderedKeys(scope.keys, keys) || scope.key_set_sha256 !== digest(keys.join("\n"))) {
    throw invalidScope();
  }
}

export function isExtractionCatalogRefillScope(
  value: unknown
): value is ExtractionCatalogRefillScope {
  try {
    assertExtractionCatalogRefillScope(value);
    return true;
  } catch {
    return false;
  }
}

export function catalogRefillScopeKeys(
  scope: ExtractionCatalogRefillScope
): ReadonlySet<string> {
  assertExtractionCatalogRefillScope(scope);
  return new Set(scope.keys);
}

export function assertCatalogRefillScopeMatchesReceipt(
  scope: ExtractionCatalogRefillScope,
  observation: ExtractionAuthorityObservation
): void {
  assertExtractionCatalogRefillScope(scope);
  const inventory = observation.inventory;
  if (inventory.invalidTurns !== 0 || inventory.orphanTurns !== 0 ||
      inventory.missingTurns !== scope.shard_count ||
      inventory.validTurns !== scope.preserved_valid_closure.shard_count ||
      observation.dataset.expectedKeySetSha256 !== scope.expected_key_set_sha256 ||
      observation.extraction.manifestSha256 !== scope.initial_manifest_sha256 ||
      observation.extraction.rawContentClosureSha256 !==
        scope.initial_raw_content_closure_sha256) {
    throw new Error("catalog refill authority scope does not match its inspected cache");
  }
}

export function assertCatalogRefillScopeMatchesInspection(input: {
  readonly scope: ExtractionCatalogRefillScope;
  readonly cacheRoot: string;
  readonly inspection: ExtractionAuthorityInspection;
  readonly pinnedManifestSha256?: string;
  readonly resumeManifestSha256?: string;
  readonly settledManifestSha256?: string;
  readonly ledgerProgress?: ExtractionCatalogRefillLedgerProgress;
}): void {
  const { scope, inspection } = input;
  assertExtractionCatalogRefillScope(scope);
  assertCatalogRefillRootBinding(scope.root_binding, input.cacheRoot);
  const progress = normalizeLedgerProgress(input.ledgerProgress);
  const remainingKeys = scope.keys.filter((key) => !progress.successfulKeys.includes(key));
  if (progress.successfulKeys.some((key) => !scope.keys.includes(key))) {
    throw new Error("catalog refill attempt ledger contains an out-of-scope success");
  }
  if (remainingKeys.length === 0) {
    assertSettledCatalogRefillInspection(input, progress);
    return;
  }
  if (input.resumeManifestSha256 !== undefined && !isDigest(input.resumeManifestSha256)) {
    throw invalidScope();
  }
  const manifest = inspection.observation.extraction.manifestSha256;
  if (manifest === null || (manifest !== scope.initial_manifest_sha256 &&
      manifest !== input.pinnedManifestSha256 && manifest !== input.resumeManifestSha256)) {
    throw new Error("catalog refill authority cache manifest drifted after inspection");
  }
  assertInspectionInventory(scope, inspection, progress.successfulKeys);
  if (!sameOrderedKeys(remainingKeys, normalizeProgressKeys(inspection.missingKeys))) {
    throw new Error("catalog refill authority missing-key set drifted after inspection");
  }
  assertPreservedValidClosureUnchanged(
    scope.preserved_valid_closure,
    inspection.preservedValidClosure
  );
}

function normalizeLedgerProgress(
  progress: ExtractionCatalogRefillLedgerProgress | undefined
): {
  readonly attempts: number;
  readonly successfulKeys: readonly string[];
  readonly pendingKeys: readonly string[];
  readonly unresolvedAttempts: number;
} {
  if (progress === undefined) {
    return { attempts: 0, successfulKeys: [], pendingKeys: [], unresolvedAttempts: 0 };
  }
  if (!isNonNegativeSafeInteger(progress.attempts)) throw invalidScope();
  const successfulKeys = normalizeProgressKeys(progress.successfulKeys);
  const pendingKeys = normalizeProgressKeys(progress.pendingKeys ?? []);
  const unresolvedAttempts = progress.unresolvedAttempts ?? 0;
  if (!isNonNegativeSafeInteger(unresolvedAttempts)) throw invalidScope();
  if (successfulKeys.length > 0 && progress.attempts === 0) throw invalidScope();
  return { attempts: progress.attempts, successfulKeys, pendingKeys, unresolvedAttempts };
}

function assertSettledCatalogRefillInspection(
  input: Parameters<typeof assertCatalogRefillScopeMatchesInspection>[0],
  progress: ReturnType<typeof normalizeLedgerProgress>
): void {
  const manifest = input.inspection.observation.extraction.manifestSha256;
  if (progress.pendingKeys.length !== 0 || progress.unresolvedAttempts !== 0 ||
      input.settledManifestSha256 === undefined || manifest !== input.settledManifestSha256) {
    throw new Error("catalog refill authority has no remaining missing cache keys");
  }
  assertInspectionInventory(input.scope, input.inspection, progress.successfulKeys);
  if (input.inspection.missingKeys.length !== 0) {
    throw new Error("catalog refill authority missing-key set drifted after inspection");
  }
  assertPreservedValidClosureUnchanged(
    input.scope.preserved_valid_closure,
    input.inspection.preservedValidClosure
  );
}

function assertInspectionInventory(
  scope: ExtractionCatalogRefillScope,
  inspection: ExtractionAuthorityInspection,
  successfulKeys: readonly string[]
): void {
  const { inventory } = inspection.observation;
  if (inventory.invalidTurns !== 0 || inventory.orphanTurns !== 0 ||
      inventory.missingTurns !== scope.shard_count - successfulKeys.length ||
      inventory.validTurns !== scope.preserved_valid_closure.shard_count + successfulKeys.length ||
      inspection.observation.dataset.expectedKeySetSha256 !== scope.expected_key_set_sha256 ||
      inspection.observation.extraction.rawContentClosureSha256 !==
        scope.initial_raw_content_closure_sha256) {
    throw new Error("catalog refill authority scope does not match its inspected cache");
  }
}

export function assertCatalogRefillRootBinding(
  binding: ExtractionCatalogRefillRootBinding,
  cacheRoot: string
): void {
  if (!isRootBinding(binding)) throw invalidScope();
  const current = createCatalogRefillRootBinding(cacheRoot);
  if (binding.cache_root_sha256 !== current.cache_root_sha256 ||
      binding.device !== current.device || binding.inode !== current.inode) {
    throw new Error("catalog refill authority cache root binding drifted");
  }
}

export function createCatalogRefillRootBinding(
  cacheRoot: string
): ExtractionCatalogRefillRootBinding {
  const canonical = realpathSync(cacheRoot);
  const stat = statSync(canonical);
  return Object.freeze({
    cache_root_sha256: digest(canonical),
    device: String(stat.dev),
    inode: String(stat.ino)
  });
}

function assertInitialInventory(
  inspection: ExtractionAuthorityInspection,
  allowlist: ExtractionCatalogRefillAllowlist,
  keys: readonly string[]
): void {
  const { observation } = inspection;
  const { inventory } = observation;
  if (observation.extraction.manifestSha256 === null ||
      observation.extraction.rawContentClosureSha256 === null ||
      inventory.invalidTurns !== 0 || inventory.orphanTurns !== 0 ||
      allowlist.expected_turns !== inventory.expectedTurns ||
      allowlist.cached_turns !== inventory.validTurns ||
      allowlist.missing_turns !== inventory.missingTurns ||
      allowlist.expected_key_set_sha256 !== observation.dataset.expectedKeySetSha256 ||
      !sameOrderedKeys(keys, normalizeKeys(inspection.missingKeys)) ||
      inspection.preservedValidClosure.shard_count !== inventory.validTurns) {
    throw new Error("catalog refill allowlist does not match the current audited cache state");
  }
}

function isCatalogRefillAllowlist(value: unknown): value is ExtractionCatalogRefillAllowlist {
  if (!isObject(value)) return false;
  const allowlist = value as Partial<ExtractionCatalogRefillAllowlist>;
  return typeof allowlist.kind === "string" && allowlist.kind.length > 0 &&
    isNonNegativeSafeInteger(allowlist.expected_turns) &&
    isNonNegativeSafeInteger(allowlist.cached_turns) &&
    isNonNegativeSafeInteger(allowlist.missing_turns) &&
    isDigest(allowlist.expected_key_set_sha256) && Array.isArray(allowlist.cache_keys) &&
    allowlist.cache_keys.every(isDigest);
}

function isRootBinding(value: unknown): value is ExtractionCatalogRefillRootBinding {
  if (!isObject(value)) return false;
  const binding = value as Partial<ExtractionCatalogRefillRootBinding>;
  return isDigest(binding.cache_root_sha256) && typeof binding.device === "string" &&
    binding.device.length > 0 && typeof binding.inode === "string" && binding.inode.length > 0;
}

function normalizeKeys(keys: readonly string[]): string[] {
  if (keys.length === 0) throw invalidScope();
  return normalizeProgressKeys(keys);
}

function normalizeProgressKeys(keys: readonly string[]): string[] {
  if (keys.some((key) => !isDigest(key))) throw invalidScope();
  const sorted = [...keys].sort((left, right) => left.localeCompare(right));
  if (new Set(sorted).size !== sorted.length) throw invalidScope();
  return sorted;
}

function sameOrderedKeys(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function invalidScope(): Error {
  return new Error("catalog refill authority scope is invalid");
}
