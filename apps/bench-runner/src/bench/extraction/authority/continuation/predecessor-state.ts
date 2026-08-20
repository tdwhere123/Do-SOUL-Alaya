import type { ExtractionAttemptLedgerSnapshot } from "../attempt-ledger.js";
import type { ExtractionAuthorityInspection } from "../inspection.js";
import type { ExtractionAuthorityReceipt } from "../receipt.js";
import { assertPreservedValidClosureUnchanged } from
  "../repair/preserved-valid-closure.js";
import type { SameRootExtractionContinuation } from "./contract.js";

type CatalogScope = NonNullable<ExtractionAuthorityReceipt["catalog_refill"]>;

export function assertCatalogPredecessorState(input: {
  readonly inspection: ExtractionAuthorityInspection;
  readonly baseInspection: ExtractionAuthorityInspection | undefined;
  readonly predecessor: ExtractionAttemptLedgerSnapshot;
  readonly scope: CatalogScope;
}): void {
  const { inspection, baseInspection, predecessor, scope } = input;
  if (baseInspection === undefined) throw invalidPredecessor();
  const inventory = inspection.observation.inventory;
  const successful = new Set(predecessor.successfulKeys);
  const remaining = scope.keys.filter((key) => !successful.has(key));
  const expectedValid = scope.preserved_valid_closure.shard_count + successful.size;
  if (predecessor.successfulKeys.some((key) => !scope.keys.includes(key)) ||
      inventory.invalidTurns !== 0 || inventory.orphanTurns !== 0 ||
      inventory.expectedTurns !== scope.preserved_valid_closure.shard_count + scope.shard_count ||
      inventory.validTurns !== expectedValid ||
      inventory.missingTurns !== scope.shard_count - successful.size ||
      inspection.preservedValidClosure.shard_count !== expectedValid ||
      !sameOrderedKeys(inspection.missingKeys, remaining) ||
      baseInspection.observation.extraction.rawContentClosureSha256 !==
        scope.initial_raw_content_closure_sha256) {
    throw invalidPredecessor();
  }
  assertPreservedValidClosureUnchanged(
    scope.preserved_valid_closure, baseInspection.preservedValidClosure
  );
}

export function assertInheritedContinuationPredecessorState(input: {
  readonly inspection: ExtractionAuthorityInspection;
  readonly baseInspection: ExtractionAuthorityInspection | undefined;
  readonly predecessor: ExtractionAttemptLedgerSnapshot;
  readonly receipt: ExtractionAuthorityReceipt;
}): void {
  const inherited = input.receipt.continuation;
  if (inherited === undefined || input.baseInspection === undefined) throw invalidPredecessor();
  const newSuccessfulKeys = continuationPredecessorNewSuccessfulKeys(
    input.receipt, input.predecessor
  );
  const inventory = input.inspection.observation.inventory;
  const expectedValid = inherited.preserved_valid_closure.shard_count + newSuccessfulKeys.length;
  if (inventory.invalidTurns !== 0 || inventory.orphanTurns !== 0 ||
      inventory.validTurns !== expectedValid ||
      inventory.missingTurns !== inventory.expectedTurns - expectedValid ||
      input.inspection.preservedValidClosure.shard_count !== expectedValid ||
      newSuccessfulKeys.some((key) => input.inspection.missingKeys.includes(key))) {
    throw invalidPredecessor();
  }
  assertPreservedValidClosureUnchanged(
    inherited.preserved_valid_closure, input.baseInspection.preservedValidClosure
  );
}

export function continuationPredecessorNewSuccessfulKeys(
  receipt: ExtractionAuthorityReceipt,
  ledger: ExtractionAttemptLedgerSnapshot
): readonly string[] {
  const continuation = receipt.continuation;
  if (continuation === undefined) throw invalidPredecessor();
  const inherited = continuation.schema_version >= 6
    ? continuation.predecessor.successful_keys!
    : legacyInheritedKeys(continuation, ledger);
  const current = new Set(ledger.successfulKeys);
  if (inherited.some((key) => !current.has(key))) throw invalidPredecessor();
  const inheritedSet = new Set(inherited);
  return Object.freeze(ledger.successfulKeys.filter((key) => !inheritedSet.has(key)));
}

export function assertContinuationInventory(input: {
  readonly inspection: ExtractionAuthorityInspection;
  readonly continuation: SameRootExtractionContinuation;
  readonly predecessor: ExtractionAttemptLedgerSnapshot;
  readonly successor: ExtractionAttemptLedgerSnapshot;
}): void {
  const inventory = input.inspection.observation.inventory;
  const newSuccessful = input.successor.successfulShards - input.predecessor.successfulShards;
  const validTurns = input.continuation.preserved_valid_closure.shard_count + newSuccessful;
  if (inventory.invalidTurns !== 0 || inventory.orphanTurns !== 0 ||
      newSuccessful < 0 || inventory.validTurns !== validTurns ||
      inventory.missingTurns !== inventory.expectedTurns - validTurns) {
    throw new Error("same-root continuation inventory escaped its forked ledger");
  }
}

function legacyInheritedKeys(
  continuation: SameRootExtractionContinuation,
  ledger: ExtractionAttemptLedgerSnapshot
): readonly string[] {
  if (ledger.successfulShards !== continuation.predecessor.successful_shards) {
    throw new Error("legacy continuation cannot prove successful-key ancestry");
  }
  return ledger.successfulKeys;
}

function sameOrderedKeys(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

function invalidPredecessor(): Error {
  return new Error("current extraction cache is not the exact predecessor closure");
}
