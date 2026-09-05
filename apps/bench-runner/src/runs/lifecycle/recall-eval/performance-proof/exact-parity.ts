import {
  freezeDeep,
  freezePerformanceAttributionReceipt,
  P00_PERFORMANCE_PROOF_CONTRACT,
  type ObservedFiniteNumber,
  type PerformanceAttributionReceipt
} from "./attribution-receipt.js";

export const RECALL_EVAL_EXACT_PARITY_RECEIPT =
  P00_PERFORMANCE_PROOF_CONTRACT.paritySchema;

export interface ExactParityInputIdentity {
  readonly datasetRevision: string;
  readonly questionIds: readonly string[];
  readonly providerKind: string;
  readonly providerLabel: string;
  readonly cacheKeyAlgo: string;
  readonly embeddingMode: string;
}

export interface ProviderOrCacheCall {
  readonly kind: "provider" | "cache";
  readonly name: string;
  readonly parameterDigest: string;
}

export interface ProcessExitRecord {
  readonly pid: number | null;
  readonly code: number | null;
  readonly signal: string | null;
}

export interface ArchiveEntry {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface ExactParityObservedResult {
  readonly deliveredObjectIds: readonly string[];
  readonly deliveryBytes: number;
  readonly captureBytes: number;
  readonly diagnosticsDigest: string;
  readonly providerCalls: readonly ProviderOrCacheCall[];
  readonly cacheCalls: readonly ProviderOrCacheCall[];
  readonly sourceDigestBefore: string;
  readonly sourceDigestAfter: string;
  readonly overlayDigestBefore: string;
  readonly overlayDigestAfter: string;
  readonly processExits: readonly ProcessExitRecord[];
  readonly archiveContents: readonly ArchiveEntry[];
}

export interface ExactParityReceipt {
  readonly schema: typeof RECALL_EVAL_EXACT_PARITY_RECEIPT;
  readonly identity: ExactParityInputIdentity;
  readonly result: ExactParityObservedResult;
  readonly attribution: PerformanceAttributionReceipt;
}

export interface ParityMismatch {
  readonly path: string;
  readonly left: unknown;
  readonly right: unknown;
}

export interface ExactParityComparison {
  readonly identityBound: boolean;
  readonly resultEquivalent: boolean;
  readonly byteCountEquivalent: boolean;
  readonly diagnosticTimersExcluded: true;
  readonly mismatches: readonly ParityMismatch[];
}

const IDENTITY_KEYS = [
  "datasetRevision",
  "questionIds",
  "providerKind",
  "providerLabel",
  "cacheKeyAlgo",
  "embeddingMode"
] as const;

export function freezeExactParityReceipt(input: {
  readonly identity: ExactParityInputIdentity;
  readonly result: ExactParityObservedResult;
  readonly attribution: PerformanceAttributionReceipt;
}): ExactParityReceipt {
  return freezeDeep({
    schema: RECALL_EVAL_EXACT_PARITY_RECEIPT,
    identity: freezeIdentity(input.identity),
    result: freezeResult(input.result),
    attribution: freezePerformanceAttributionReceipt(input.attribution)
  });
}

export function compareExactParity(
  left: ExactParityReceipt,
  right: ExactParityReceipt
): ExactParityComparison {
  const identityMismatches = compareJson("identity", left.identity, right.identity);
  const resultMismatches = compareResult(left.result, right.result);
  const countMismatches = compareAttributionCounts(left.attribution, right.attribution);
  const identityBound = identityMismatches.length === 0;
  const resultEquivalent = identityBound && resultMismatches.length === 0;
  const byteCountEquivalent = resultEquivalent && countMismatches.length === 0;
  return Object.freeze({
    identityBound,
    resultEquivalent,
    byteCountEquivalent,
    diagnosticTimersExcluded: true as const,
    mismatches: Object.freeze([
      ...identityMismatches,
      ...resultMismatches,
      ...countMismatches
    ])
  });
}

function freezeIdentity(identity: ExactParityInputIdentity): ExactParityInputIdentity {
  const frozen = Object.freeze({
    datasetRevision: requireToken(identity.datasetRevision, "identity.datasetRevision"),
    questionIds: Object.freeze(identity.questionIds.map((id, index) =>
      requireToken(id, `identity.questionIds[${index}]`)
    )),
    providerKind: requireToken(identity.providerKind, "identity.providerKind"),
    providerLabel: requireToken(identity.providerLabel, "identity.providerLabel"),
    cacheKeyAlgo: requireToken(identity.cacheKeyAlgo, "identity.cacheKeyAlgo"),
    embeddingMode: requireToken(identity.embeddingMode, "identity.embeddingMode")
  });
  assertNoExecutionArch(frozen);
  return frozen;
}

function freezeResult(result: ExactParityObservedResult): ExactParityObservedResult {
  return {
    deliveredObjectIds: Object.freeze(result.deliveredObjectIds.map((id, index) =>
      requireToken(id, `result.deliveredObjectIds[${index}]`)
    )),
    deliveryBytes: requireNonNegativeInt(result.deliveryBytes, "result.deliveryBytes"),
    captureBytes: requireNonNegativeInt(result.captureBytes, "result.captureBytes"),
    diagnosticsDigest: requireDigest(result.diagnosticsDigest, "result.diagnosticsDigest"),
    providerCalls: Object.freeze(result.providerCalls.map(freezeCall)),
    cacheCalls: Object.freeze(result.cacheCalls.map(freezeCall)),
    sourceDigestBefore: requireDigest(result.sourceDigestBefore, "result.sourceDigestBefore"),
    sourceDigestAfter: requireDigest(result.sourceDigestAfter, "result.sourceDigestAfter"),
    overlayDigestBefore: requireDigest(result.overlayDigestBefore, "result.overlayDigestBefore"),
    overlayDigestAfter: requireDigest(result.overlayDigestAfter, "result.overlayDigestAfter"),
    processExits: Object.freeze(result.processExits.map(freezeExit)),
    archiveContents: Object.freeze(result.archiveContents.map(freezeArchiveEntry))
  };
}

function freezeCall(call: ProviderOrCacheCall): ProviderOrCacheCall {
  if (call.kind !== "provider" && call.kind !== "cache") {
    throw new Error("parity call kind must be provider or cache");
  }
  return Object.freeze({
    kind: call.kind,
    name: requireToken(call.name, "call.name"),
    parameterDigest: requireDigest(call.parameterDigest, "call.parameterDigest")
  });
}

function freezeExit(exit: ProcessExitRecord): ProcessExitRecord {
  return Object.freeze({
    pid: requireNullableInt(exit.pid, "processExits.pid"),
    code: requireNullableInt(exit.code, "processExits.code"),
    signal: exit.signal === null ? null : requireToken(exit.signal, "processExits.signal")
  });
}

function freezeArchiveEntry(entry: ArchiveEntry): ArchiveEntry {
  return Object.freeze({
    path: requireToken(entry.path, "archiveContents.path"),
    sha256: requireDigest(entry.sha256, "archiveContents.sha256"),
    bytes: requireNonNegativeInt(entry.bytes, "archiveContents.bytes")
  });
}

function compareResult(
  left: ExactParityObservedResult,
  right: ExactParityObservedResult
): readonly ParityMismatch[] {
  return [
    ...compareJson("result.deliveredObjectIds", left.deliveredObjectIds, right.deliveredObjectIds),
    ...compareJson("result.deliveryBytes", left.deliveryBytes, right.deliveryBytes),
    ...compareJson("result.captureBytes", left.captureBytes, right.captureBytes),
    ...compareJson("result.diagnosticsDigest", left.diagnosticsDigest, right.diagnosticsDigest),
    ...compareJson("result.providerCalls", left.providerCalls, right.providerCalls),
    ...compareJson("result.cacheCalls", left.cacheCalls, right.cacheCalls),
    ...compareJson("result.sourceDigestBefore", left.sourceDigestBefore, right.sourceDigestBefore),
    ...compareJson("result.sourceDigestAfter", left.sourceDigestAfter, right.sourceDigestAfter),
    ...compareJson("result.overlayDigestBefore", left.overlayDigestBefore, right.overlayDigestBefore),
    ...compareJson("result.overlayDigestAfter", left.overlayDigestAfter, right.overlayDigestAfter),
    ...compareJson("result.processExits", left.processExits, right.processExits),
    ...compareJson("result.archiveContents", left.archiveContents, right.archiveContents)
  ];
}

function compareAttributionCounts(
  left: PerformanceAttributionReceipt,
  right: PerformanceAttributionReceipt
): readonly ParityMismatch[] {
  return [
    ...compareQuantity("attribution.pager.childSpawnCount",
      left.pager.childSpawnCount, right.pager.childSpawnCount),
    ...compareQuantity("attribution.pager.modelChildSpawnCount",
      left.pager.modelChildSpawnCount, right.pager.modelChildSpawnCount),
    ...compareQuantity("attribution.pager.modelReadinessCount",
      left.pager.modelReadinessCount, right.pager.modelReadinessCount),
    ...compareQuantity("attribution.workspace.receiptVerificationCount",
      left.workspace.receiptVerificationCount, right.workspace.receiptVerificationCount),
    ...compareJson("attribution.workspace.receiptVerification",
      left.workspace.receiptVerification, right.workspace.receiptVerification),
    ...compareJson("attribution.disk.clone", cloneCountView(left.disk.clone),
      cloneCountView(right.disk.clone)),
    ...compareQuantity("attribution.disk.fsyncCount", left.disk.fsyncCount, right.disk.fsyncCount),
    ...compareQuantity("attribution.disk.sqliteReopenCount",
      left.disk.sqliteReopenCount, right.disk.sqliteReopenCount),
    ...compareQuantity("attribution.disk.daemonRestartCount",
      left.disk.daemonRestartCount, right.disk.daemonRestartCount),
    ...compareQuantity("attribution.disk.questionExecutionCount",
      left.disk.questionExecutionCount, right.disk.questionExecutionCount),
    ...compareQuantity("attribution.retained.compactRowCount",
      left.retained.compactRowCount, right.retained.compactRowCount),
    ...compareQuantity("attribution.retained.shardPayloadBytes",
      left.retained.shardPayloadBytes, right.retained.shardPayloadBytes)
  ];
}

function cloneCountView(clone: PerformanceAttributionReceipt["disk"]["clone"]): unknown {
  if (clone.status === "not_observed") {
    return { status: clone.status, reason: clone.reason };
  }
  return {
    status: clone.status,
    mode: clone.mode,
    logicalBytes: clone.logicalBytes,
    physicalBytesWritten: clone.physicalBytesWritten
  };
}

function compareQuantity(
  path: string,
  left: ObservedFiniteNumber,
  right: ObservedFiniteNumber
): readonly ParityMismatch[] {
  return compareJson(path, left, right);
}

function compareJson(path: string, left: unknown, right: unknown): readonly ParityMismatch[] {
  if (stableStringify(left) === stableStringify(right)) return [];
  return [Object.freeze({ path, left, right })];
}

function assertNoExecutionArch(identity: ExactParityInputIdentity): void {
  const blob = `${IDENTITY_KEYS.map((key) => {
    const value = identity[key];
    return Array.isArray(value) ? value.join(",") : value;
  }).join("\0")}`;
  if (blob.includes("execution_arch") || /reference\s*\|\s*optimized/u.test(blob)) {
    throw new Error("exact-parity identity must not encode execution_arch or reference|optimized");
  }
}

function requireToken(value: string, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function requireDigest(value: string, path: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${path} must be a lowercase sha256 hex digest`);
  }
  return value;
}

function requireNonNegativeInt(value: number, path: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${path} must be a non-negative integer`);
  }
  return value;
}

function requireNullableInt(value: number | null, path: string): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${path} must be an integer or null`);
  }
  return value;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value);
}
