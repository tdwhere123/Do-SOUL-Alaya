import { createHash, randomUUID } from "node:crypto";
import {
  existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";
import {
  readExtractionAttemptLedger,
  readSettledExtractionAttemptLedger,
  type ExtractionAttemptLedgerSnapshot
} from "../attempt-ledger.js";
import { assertMonotonicExtractionAttemptLedgerFork } from
  "../attempt-ledger/fork-contract.js";
import {
  assertExtractionAuthorityReceipt,
  type ExtractionAuthorityReceipt
} from "../receipt.js";
import {
  assertExtractionTargetSelectionReceipt,
  type ExtractionTargetSelectionReceipt
} from "../target-selection/receipt.js";

export interface ExtractionContinuationChildClaim {
  readonly schema_version: 1;
  readonly kind: "longmemeval-extraction-continuation-child";
  readonly predecessor: {
    readonly receipt_digest: string;
    readonly lineage_digest: string;
    readonly ledger_raw_sha256: string;
    readonly ledger_canonical_sha256: string;
    readonly starting_missing: number;
    readonly maximum_attempts: number;
    readonly successful_shard_ceiling: number;
    readonly attempts: number;
    readonly successful_shards: number;
    readonly pending_shards: number;
    readonly unresolved_attempts: number;
    readonly transport_failures: number;
    readonly retry_successes: number;
    readonly rate_limit_retries: number;
    readonly input_tokens: number;
    readonly output_tokens: number;
    readonly total_tokens: number;
    readonly usage_unavailable_requests: number;
  };
  readonly successor: {
    readonly target_selection_digest: string;
    readonly lineage_digest: string;
    readonly receipt_digest: string;
  };
  readonly claim_digest: string;
}

export function createExtractionContinuationChildClaim(input: {
  readonly predecessorReceiptDigest: string;
  readonly predecessorLedger: ExtractionAttemptLedgerSnapshot;
  readonly successor: ExtractionAuthorityReceipt;
}): ExtractionContinuationChildClaim {
  const targetSelectionDigest = input.successor.target_selection_digest;
  if (targetSelectionDigest === undefined || input.successor.continuation === undefined) {
    throw new Error("continuation child claim requires a target-selected successor receipt");
  }
  const unsigned = {
    schema_version: 1 as const,
    kind: "longmemeval-extraction-continuation-child" as const,
    predecessor: {
      receipt_digest: input.predecessorReceiptDigest,
      lineage_digest: input.predecessorLedger.lineageDigest,
      ledger_raw_sha256: input.predecessorLedger.rawLedgerSha256,
      ledger_canonical_sha256: input.predecessorLedger.ledgerSha256,
      starting_missing: input.predecessorLedger.startingMissing,
      maximum_attempts: input.predecessorLedger.maximumAttempts,
      successful_shard_ceiling: input.predecessorLedger.successfulShardCeiling,
      attempts: input.predecessorLedger.attempts,
      successful_shards: input.predecessorLedger.successfulShards,
      pending_shards: input.predecessorLedger.pendingKeys.length,
      unresolved_attempts: input.predecessorLedger.unresolvedAttempts.length,
      transport_failures: input.predecessorLedger.transportFailures.length,
      retry_successes: input.predecessorLedger.telemetry.retrySuccesses,
      rate_limit_retries: input.predecessorLedger.telemetry.rateLimitRetries,
      input_tokens: input.predecessorLedger.telemetry.inputTokens,
      output_tokens: input.predecessorLedger.telemetry.outputTokens,
      total_tokens: input.predecessorLedger.telemetry.totalTokens,
      usage_unavailable_requests:
        input.predecessorLedger.telemetry.usageUnavailableRequests
    },
    successor: {
      target_selection_digest: targetSelectionDigest,
      lineage_digest: input.successor.lineage_digest,
      receipt_digest: input.successor.receipt_digest
    }
  };
  return Object.freeze({ ...unsigned, claim_digest: digestClaim(unsigned) });
}

export function claimExtractionContinuationChild(input: {
  readonly cacheRoot: string;
  readonly claim: ExtractionContinuationChildClaim;
}): ExtractionContinuationChildClaim {
  assertExtractionContinuationChildClaim(input.claim);
  const path = continuationChildClaimPath(
    input.cacheRoot, input.claim.predecessor.lineage_digest
  );
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(input.claim, null, 2)}\n`, {
      encoding: "utf8", flag: "wx", mode: 0o600
    });
    try {
      linkSync(temporary, path);
      return input.claim;
    } catch (cause) {
      if (!isAlreadyExistsError(cause)) throw cause;
      const existing = readExtractionContinuationChildClaim(path);
      if (existing.claim_digest !== input.claim.claim_digest) {
        throw new Error("predecessor extraction authority already claimed by a sibling child");
      }
      return existing;
    }
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function assertContinuationChildClaimBinding(input: {
  readonly cacheRoot: string;
  readonly predecessorReceiptDigest: string;
  readonly predecessorLedger: ExtractionAttemptLedgerSnapshot;
  readonly successor: ExtractionAuthorityReceipt;
}): void {
  const expected = createExtractionContinuationChildClaim(input);
  const path = continuationChildClaimPath(
    input.cacheRoot, input.predecessorLedger.lineageDigest
  );
  if (!existsSync(path)) throw new Error("same-root continuation child claim is missing");
  const actual = readExtractionContinuationChildClaim(path);
  if (actual.claim_digest !== expected.claim_digest) {
    throw new Error("same-root continuation child claim binding drifted");
  }
}

export function assertExtractionAuthorityHasNoContinuationChild(input: {
  readonly cacheRoot: string;
  readonly authority: ExtractionAuthorityReceipt;
}): void {
  assertExtractionAuthorityReceipt(input.authority, input.authority.observation);
  const path = continuationChildClaimPath(input.cacheRoot, input.authority.lineage_digest);
  if (existsSync(path)) {
    const claim = readExtractionContinuationChildClaim(path);
    throw new Error(
      `extraction authority already delegated to child ${claim.successor.receipt_digest}`
    );
  }
}

export function adoptExistingContinuationChild(input: {
  readonly cacheRoot: string;
  readonly child: ExtractionAuthorityReceipt;
  readonly childTargetSelection: ExtractionTargetSelectionReceipt;
}): ExtractionContinuationChildClaim | undefined {
  const claim = prepareExistingContinuationChildAdoption(input);
  return claim === undefined
    ? undefined
    : claimExtractionContinuationChild({ cacheRoot: input.cacheRoot, claim });
}

export function prepareExistingContinuationChildAdoption(input: {
  readonly cacheRoot: string;
  readonly child: ExtractionAuthorityReceipt;
  readonly childTargetSelection: ExtractionTargetSelectionReceipt;
}): ExtractionContinuationChildClaim | undefined {
  const continuation = input.child.continuation;
  if (continuation === undefined) return undefined;
  assertExtractionAuthorityReceipt(input.child, input.child.observation);
  assertExtractionTargetSelectionReceipt({
    receipt: input.childTargetSelection,
    cacheRoot: input.cacheRoot,
    observation: input.child.observation
  });
  assertAdoptionSelection(input.child, input.childTargetSelection);
  const identity = input.child.observation.extraction;
  const predecessorLedger = readSettledExtractionAttemptLedger({
    cacheRoot: input.cacheRoot,
    lineageDigest: continuation.predecessor.lineage_digest,
    cacheIdentity: { model: identity.model, requestProfile: identity.requestProfile }
  });
  assertLedgerMatchesContinuation(predecessorLedger, continuation.predecessor);
  const childLedger = readExtractionAttemptLedger({
    cacheRoot: input.cacheRoot,
    lineageDigest: input.child.lineage_digest,
    cacheIdentity: { model: identity.model, requestProfile: identity.requestProfile }
  });
  if (childLedger === undefined) {
    throw new Error("existing continuation child ledger is missing during adoption");
  }
  assertMonotonicExtractionAttemptLedgerFork({
    predecessor: predecessorLedger,
    successor: childLedger,
    successorLineageDigest: input.child.lineage_digest
  });
  return createExtractionContinuationChildClaim({
    predecessorReceiptDigest: continuation.predecessor.receipt_digest,
    predecessorLedger,
    successor: input.child
  });
}

export function assertImmediateContinuationAdoptionParent(input: {
  readonly parent: Pick<ExtractionAuthorityReceipt,
    "receipt_digest" | "lineage_digest" | "target_selection_digest">;
  readonly parentTargetSelection: Pick<ExtractionTargetSelectionReceipt,
    "receipt_digest">;
  readonly child: Pick<ExtractionAuthorityReceipt,
    "receipt_digest" | "lineage_digest" | "target_selection_digest"> & {
      readonly continuation?: {
        readonly predecessor: Pick<ExtractionAuthorityReceipt,
          "receipt_digest" | "lineage_digest">;
      };
    };
  readonly childTargetSelection: Pick<ExtractionTargetSelectionReceipt,
    "receipt_digest" | "selection_basis">;
}): void {
  const basis = input.childTargetSelection.selection_basis;
  const predecessor = input.child.continuation?.predecessor;
  if (input.parent.target_selection_digest !== input.parentTargetSelection.receipt_digest ||
      input.child.target_selection_digest !== input.childTargetSelection.receipt_digest ||
      basis.kind !== "same_root_continuation" || predecessor === undefined ||
      basis.predecessor_target_selection_digest !== input.parentTargetSelection.receipt_digest ||
      basis.predecessor_authority_receipt_digest !== input.parent.receipt_digest ||
      predecessor.receipt_digest !== input.parent.receipt_digest ||
      predecessor.lineage_digest !== input.parent.lineage_digest) {
    throw new Error(
      "explicit continuation adoption must be the actual predecessor's immediate parent"
    );
  }
}

export function continuationChildClaimPath(
  cacheRoot: string,
  predecessorLineageDigest: string
): string {
  requireDigest(predecessorLineageDigest, "predecessor lineage digest");
  return join(cacheRoot, `continuation-child.${predecessorLineageDigest}.json`);
}

export function assertExtractionContinuationChildClaim(
  value: unknown
): asserts value is ExtractionContinuationChildClaim {
  if (!hasExactKeys(value, ["schema_version", "kind", "predecessor", "successor", "claim_digest"])) {
    throw invalidClaim();
  }
  const claim = value as unknown as ExtractionContinuationChildClaim;
  if (claim.schema_version !== 1 ||
      claim.kind !== "longmemeval-extraction-continuation-child" ||
      !hasExactKeys(claim.predecessor, [
        "receipt_digest", "lineage_digest", "ledger_raw_sha256",
        "ledger_canonical_sha256", "starting_missing", "maximum_attempts",
        "successful_shard_ceiling", "attempts", "successful_shards",
        "pending_shards", "unresolved_attempts", "transport_failures",
        "retry_successes", "rate_limit_retries", "input_tokens", "output_tokens",
        "total_tokens", "usage_unavailable_requests"
      ]) || !hasExactKeys(claim.successor, [
        "target_selection_digest", "lineage_digest", "receipt_digest"
      ]) || !claimDigestsValid(claim) || !claimCountersValid(claim) ||
      claim.claim_digest !== digestClaim({
        schema_version: claim.schema_version,
        kind: claim.kind,
        predecessor: claim.predecessor,
        successor: claim.successor
      })) {
    throw invalidClaim();
  }
}

function readExtractionContinuationChildClaim(path: string): ExtractionContinuationChildClaim {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  assertExtractionContinuationChildClaim(parsed);
  return parsed;
}

function assertAdoptionSelection(
  child: ExtractionAuthorityReceipt,
  selection: ExtractionTargetSelectionReceipt
): void {
  const basis = selection.selection_basis;
  if (child.target_selection_digest !== selection.receipt_digest ||
      basis.kind !== "same_root_continuation" ||
      basis.predecessor_authority_receipt_digest !==
        child.continuation?.predecessor.receipt_digest) {
    throw new Error("existing continuation child selection ancestry drifted");
  }
}

function assertLedgerMatchesContinuation(
  ledger: ExtractionAttemptLedgerSnapshot,
  bound: NonNullable<ExtractionAuthorityReceipt["continuation"]>["predecessor"]
): void {
  if (ledger.ledgerSha256 !== bound.ledger_sha256 ||
      (bound.ledger_raw_sha256 !== undefined &&
        ledger.rawLedgerSha256 !== bound.ledger_raw_sha256) ||
      ledger.attempts !== bound.attempts_consumed ||
      ledger.successfulShards !== bound.successful_shards ||
      ledger.maximumAttempts !== bound.maximum_attempts ||
      ledger.successfulShardCeiling !== bound.successful_shard_ceiling) {
    throw new Error("existing continuation predecessor ledger drifted before adoption");
  }
}

function claimDigestsValid(claim: ExtractionContinuationChildClaim): boolean {
  return [
    claim.predecessor.receipt_digest, claim.predecessor.lineage_digest,
    claim.predecessor.ledger_raw_sha256, claim.predecessor.ledger_canonical_sha256,
    claim.successor.target_selection_digest, claim.successor.lineage_digest,
    claim.successor.receipt_digest, claim.claim_digest
  ].every((value) => /^[a-f0-9]{64}$/u.test(value));
}

function claimCountersValid(claim: ExtractionContinuationChildClaim): boolean {
  const values = [
    claim.predecessor.starting_missing, claim.predecessor.maximum_attempts,
    claim.predecessor.successful_shard_ceiling, claim.predecessor.attempts,
    claim.predecessor.successful_shards, claim.predecessor.pending_shards,
    claim.predecessor.unresolved_attempts, claim.predecessor.transport_failures,
    claim.predecessor.retry_successes, claim.predecessor.rate_limit_retries,
    claim.predecessor.input_tokens, claim.predecessor.output_tokens,
    claim.predecessor.total_tokens, claim.predecessor.usage_unavailable_requests
  ];
  return values.every((value) => Number.isSafeInteger(value) && value >= 0) &&
    claim.predecessor.attempts <= claim.predecessor.maximum_attempts &&
    claim.predecessor.successful_shards <= claim.predecessor.successful_shard_ceiling &&
    claim.predecessor.pending_shards === 0 &&
    claim.predecessor.unresolved_attempts === 0;
}

function digestClaim(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function hasExactKeys<T extends string>(
  value: unknown,
  keys: readonly T[]
): value is Record<T, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function requireDigest(value: string, name: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${name} is invalid`);
}

function isAlreadyExistsError(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "EEXIST";
}

function invalidClaim(): Error {
  return new Error("extraction continuation child claim is invalid");
}
