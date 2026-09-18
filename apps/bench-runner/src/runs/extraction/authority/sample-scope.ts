import { z } from "zod";
import { computeExtractionKeySetSha256 } from "../content-closure.js";
import type { ExtractionAuthorityInspection } from "./inspection.js";
import type { ExtractionAuthorityReceipt } from "./receipt.js";
import type { ExtractionFillOptions } from "../extraction-fill.js";

const SampleKeysSchema = z.array(z.string().regex(/^[a-f0-9]{64}$/u)).min(1).readonly();
const SampleScopeSchema = z.object({
  keys: SampleKeysSchema,
  key_set_sha256: z.string().regex(/^[a-f0-9]{64}$/u)
}).strict().readonly();

export type ExtractionSampleScope = z.infer<typeof SampleScopeSchema>;

/** A syntactic key proposal has no authority until a receipt binds its inspected scope. */
export function parseExtractionSampleKeys(value: unknown): readonly string[] {
  const keys = SampleKeysSchema.parse(value);
  if (new Set(keys).size !== keys.length) throw new Error("sample scope requires distinct canonical keys");
  return Object.freeze([...keys].sort());
}

/** Proposed keys become authority only after the native full-window inspection. */
export function createExtractionSampleScope(
  proposedKeys: unknown, inspection: ExtractionAuthorityInspection
): ExtractionSampleScope {
  const keys = parseExtractionSampleKeys(proposedKeys);
  const scope = Object.freeze({
    keys: Object.freeze([...keys].sort()),
    key_set_sha256: computeExtractionKeySetSha256(keys)
  });
  assertExtractionSampleScope(scope);
  assertSampleInspection(scope, inspection);
  return scope;
}

export function assertExtractionSampleScope(value: unknown): asserts value is ExtractionSampleScope {
  const scope = SampleScopeSchema.parse(value);
  const sorted = [...scope.keys].sort();
  if (new Set(scope.keys).size !== scope.keys.length ||
      scope.keys.some((key, index) => key !== sorted[index]) ||
      computeExtractionKeySetSha256(scope.keys) !== scope.key_set_sha256) {
    throw new Error("sample scope requires distinct canonical keys and their exact key-set digest");
  }
}

export function assertSampleReceipt(receipt: ExtractionAuthorityReceipt): void {
  if (receipt.action !== "sample") {
    if (receipt.sample_scope !== undefined) throw new Error("sample scope requires the sample action");
    return;
  }
  assertExtractionSampleScope(receipt.sample_scope);
  const count = receipt.sample_scope.keys.length;
  const dataset = receipt.observation.dataset;
  if (receipt.schema_version !== 5 || receipt.target_selection_digest === undefined ||
      receipt.direct_spend !== undefined || receipt.repair_scope !== undefined ||
      receipt.catalog_refill !== undefined || receipt.continuation !== undefined ||
      receipt.probe_key !== undefined || dataset.variant !== "longmemeval_s" ||
      dataset.windowOffset !== 0 || dataset.windowLimit !== 100 ||
      receipt.observation.inventory.invalidTurns !== 0 ||
      count > receipt.observation.inventory.missingTurns ||
      receipt.limits.starting_missing !== receipt.observation.inventory.missingTurns || receipt.limits.maximum_attempts !== count ||
      receipt.limits.successful_shard_ceiling !== count) {
    throw new Error("sample authority requires an isolated first-100 selection and scope-derived limits");
  }
}

export function assertSampleInspection(
  scope: ExtractionSampleScope,
  inspection: ExtractionAuthorityInspection,
  successfulKeys: readonly string[] = []
): void {
  assertExtractionSampleScope(scope);
  const dataset = inspection.observation.dataset;
  const eligible = new Set(inspection.nonemptyKeys ?? []);
  const missing = new Set(inspection.missingKeys);
  const successful = new Set(successfulKeys);
  if (dataset.variant !== "longmemeval_s" || dataset.windowOffset !== 0 ||
      dataset.windowLimit !== 100 || inspection.observation.inventory.invalidTurns !== 0 ||
      scope.keys.some((key) => !eligible.has(key) || (!missing.has(key) && !successful.has(key)))) {
    throw new Error("sample keys must be native nonempty missing requests in the full first-100 inventory");
  }
}

export function assertSampleKeys(scope: ExtractionSampleScope, keys: readonly string[]): void {
  assertExtractionSampleScope(scope);
  if (keys.length !== scope.keys.length || new Set(keys).size !== keys.length ||
      computeExtractionKeySetSha256(keys) !== scope.key_set_sha256) {
    throw new Error("sample execution requires exactly the authority key set, once each");
  }
}

export function assertSampleKey(scope: ExtractionSampleScope | undefined, key: string): void {
  if (scope !== undefined && !scope.keys.includes(key)) {
    throw new Error("sample authority refused an out-of-scope request");
  }
}

export function assertSampleExecutionOptions(
  receipt: ExtractionAuthorityReceipt, options: ExtractionFillOptions
): void {
  if (receipt.action !== "sample") return;
  assertSampleReceipt(receipt);
  const batch = options.batch;
  if (batch === undefined || batch.limits.maxJobs !== 1 ||
      batch.limits.maxRequestsPerJob !== receipt.sample_scope!.keys.length ||
      batch.requestLimit !== undefined || options.questionBatchLimit !== undefined ||
      options.cacheKeyAllowlist !== undefined || options.predecessorAuthorityReceiptPath !== undefined ||
      options.ingestionMode === "lazy_field" || options.expansionCapability !== undefined || options.r3SpendApproval !== undefined) {
    throw new Error("sample authority requires one exact Batch job without alternate selection or continuation");
  }
}
