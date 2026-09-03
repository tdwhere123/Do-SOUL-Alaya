import { createHash } from "node:crypto";
import { readdirSync, realpathSync } from "node:fs";
import { z } from "zod";
import { readBoundedCanonicalUtf8Artifact, withRootBoundDirectory } from
  "../cache-audit/bounded-artifact-reader.js";
import { publishBytesExclusiveDurable } from "./manifest/durable-exclusive-publication.js";
import { semanticTaskIdentity } from
  "../cache/semantic-artifact/admission-identity.js";
import {
  digestSemanticCacheState,
  digestSemanticOverlayState,
  inspectSemanticArtifact,
  recordedSourceBindings
} from "../cache/semantic-artifact/store.js";
import {
  assertLazySemanticAuthorityMatchesExtraction,
  captureSemanticRunSourceAuthority,
  SemanticRunSourceAuthoritySchema,
  substrateAuthorityIdentity
} from "./semantic-fill-authority.js";
import type { SemanticFillEnvelope } from "./semantic-fill-executor.js";
import {
  unwrapVerifiedSemanticFillExecution,
  type VerifiedSemanticFillExecution
} from "./semantic-fill-execution-authority.js";
import type { ExtractionCacheWriteLease } from "./manifest/fill-root-guard.js";
import { readExtractionCacheManifestIdentity } from
  "../cache/extraction-cache-manifest.js";
import {
  assertReceiptLedgerMemberOutcomes,
  publishLedgerBoundReceiptReplica
} from "./semantic-fill-receipt-ledger-bind.js";
import {
  semanticReplayIdentityDigest,
  unwrapSemanticReplayAuthority,
  type VerifiedSemanticReplayAuthority
} from "../cache/semantic-artifact/replay-authority.js";

const Hex64 = z.string().regex(/^[a-f0-9]{64}$/u);
const BoundedIdentityLabel = z.string().min(1).max(512);
export const MAX_LAZY_SEMANTIC_RUN_RECEIPT_BYTES = 64 * 1024 * 1024;
export const CENSUS_LAZY_SEMANTIC_OCCURRENCE_COUNT = 37_623;
export const CENSUS_LAZY_SEMANTIC_UNIQUE_COUNT = 35_946;
const TransportPolicySchema = z.union([
  z.object({ kind: z.literal("reference_batch_8") }).strict(),
  z.object({
    kind: z.literal("reference_batch"), assertionsPerPack: z.union([
      z.literal(8), z.literal(16), z.literal(24), z.literal(32)
    ])
  }).strict(),
  z.object({
    kind: z.literal("token_aware"),
    maxAssertions: z.number().int().positive(),
    maxInputTokens: z.number().int().positive(),
    expectedOutputCap: z.number().int().positive(),
    systemPromptChars: z.number().int().nonnegative()
  }).strict()
]);

export const LazySemanticRunReceiptSchema = z.object({
  schemaVersion: z.literal(3),
  status: z.literal("replayable"),
  runIdentity: Hex64,
  receiptDigest: Hex64,
  ledgerScopeIdentity: Hex64,
  startingCacheIdentity: Hex64,
  endingCacheIdentity: Hex64,
  startingOverlayIdentity: Hex64,
  endingOverlayIdentity: Hex64,
  sourceAuthority: SemanticRunSourceAuthoritySchema,
  transportPolicy: TransportPolicySchema,
  replaySemantics: z.object({
    systemPromptSha256: Hex64,
    parserSemanticsVersion: BoundedIdentityLabel,
    projectionSemanticsVersion: BoundedIdentityLabel,
    materializerSemanticsVersion: BoundedIdentityLabel,
    governanceSemanticsVersion: BoundedIdentityLabel
  }).strict(),
  capabilityPolicy: z.array(BoundedIdentityLabel).min(1),
  budget: z.object({
    maxCalls: z.number().int().nonnegative(),
    maxFailures: z.number().int().nonnegative()
  }).strict(),
  demandTraceIdentity: Hex64,
  demandUnits: z.array(z.object({
    compatibilityIdentity: Hex64,
    semanticKey: Hex64,
    capability: BoundedIdentityLabel,
    occurrenceIdentity: Hex64,
    sourceCorpusIdentity: Hex64
  }).strict()).min(1),
  attempts: z.array(z.object({
    semanticKey: Hex64,
    capability: BoundedIdentityLabel,
    outcome: z.enum(["admitted", "unresolved", "skipped", "failed"]),
    reason: z.string().min(1).max(16_384).optional()
  }).strict()),
  uniqueUnits: z.number().int().nonnegative(),
  occurrenceCount: z.number().int().nonnegative(),
  bindingCount: z.number().int().nonnegative(),
  cold: z.number().int().nonnegative(),
  warm: z.number().int().nonnegative(),
  calls: z.number().int().nonnegative(),
  failures: z.number().int().nonnegative(),
  failedUnits: z.number().int().nonnegative(),
  unavailable: z.number().int().nonnegative(),
  attemptCount: z.number().int().nonnegative()
}).strict().superRefine((receipt, ctx) => {
  const { runIdentity, receiptDigest, ...unsigned } = receipt;
  if (runIdentity !== computeLazySemanticRunIdentity(unsigned)) {
    ctx.addIssue({ code: "custom", message: "lazy semantic run identity mismatch" });
  }
  if (receiptDigest !== digest(JSON.stringify({ ...unsigned, runIdentity }))) {
    ctx.addIssue({ code: "custom", message: "lazy semantic receipt digest mismatch" });
  }
  const demandTraceIdentity = digest(receipt.demandUnits.map((unit) =>
    `${unit.semanticKey}\u0000${unit.capability}\u0000${unit.occurrenceIdentity}` +
      `\u0000${unit.sourceCorpusIdentity}`
  ).join("\n"));
  const cold = receipt.attempts.filter((attempt) => attempt.outcome === "admitted").length;
  const warm = receipt.attempts.filter((attempt) => attempt.outcome === "skipped").length;
  const failedUnits = receipt.attempts.filter((attempt) => attempt.outcome === "failed").length;
  const unavailable = receipt.attempts.filter((attempt) =>
    attempt.outcome === "unresolved" || attempt.outcome === "failed").length;
  const uniqueDemand = new Map(receipt.demandUnits.map((unit) => [
    unit.compatibilityIdentity,
    `${unit.semanticKey}\u0000${unit.capability}`
  ]));
  const demandedAttempts = [...uniqueDemand.values()].sort();
  const actualAttempts = receipt.attempts.map((attempt) =>
    `${attempt.semanticKey}\u0000${attempt.capability}`).sort();
  const compatibilityMappingIsConsistent = receipt.demandUnits.every((unit) =>
    uniqueDemand.get(unit.compatibilityIdentity) === `${unit.semanticKey}\u0000${unit.capability}`);
  const capabilityPolicy = [...new Set(receipt.demandUnits.map((unit) => unit.capability))].sort();
  const reasonsAreConservative = receipt.attempts.every((attempt) =>
    attempt.outcome === "admitted" || attempt.outcome === "skipped"
      ? attempt.reason === undefined
      : attempt.reason !== undefined);
  const demandedCorpora = [...new Set(receipt.demandUnits.map(
    (unit) => unit.sourceCorpusIdentity
  ))].sort();
  const authorizedCorpora = receipt.sourceAuthority.sourceCorpora.map(
    (entry) => entry.sourceCorpusIdentity
  );
  if (receipt.demandTraceIdentity !== demandTraceIdentity ||
      receipt.occurrenceCount !== receipt.demandUnits.length ||
      receipt.bindingCount !== receipt.demandUnits.length ||
      receipt.uniqueUnits !== uniqueDemand.size ||
      !compatibilityMappingIsConsistent ||
      receipt.attemptCount !== receipt.attempts.length || receipt.attemptCount !== receipt.uniqueUnits ||
      JSON.stringify(demandedAttempts) !== JSON.stringify(actualAttempts) ||
      JSON.stringify(receipt.capabilityPolicy) !== JSON.stringify(capabilityPolicy) ||
      JSON.stringify(demandedCorpora) !== JSON.stringify(authorizedCorpora) ||
      receipt.cold !== cold || receipt.warm !== warm || receipt.failedUnits !== failedUnits ||
      receipt.calls > receipt.budget.maxCalls || receipt.failures > receipt.budget.maxFailures ||
      receipt.failures > receipt.calls || receipt.failures > receipt.unavailable ||
      receipt.unavailable !== unavailable || cold + warm + unavailable !== receipt.uniqueUnits ||
      !reasonsAreConservative) {
    ctx.addIssue({ code: "custom", message: "lazy semantic demand conservation mismatch" });
  }
});

export type LazySemanticRunReceipt = z.infer<typeof LazySemanticRunReceiptSchema>;
export interface VerifiedLazySemanticRunReceipt {
  readonly kind: "verified-lazy-semantic-run-receipt";
}
const verifiedReceipts = new WeakMap<object, Readonly<{ root: string; runIdentity: string }>>();

export function persistLazySemanticRunReceipt(input: {
  readonly root: string;
  readonly endingCacheIdentity: string;
  readonly endingOverlayIdentity: string;
  readonly envelope: SemanticFillEnvelope;
  readonly execution: VerifiedSemanticFillExecution;
  readonly replayAuthority: VerifiedSemanticReplayAuthority;
  readonly lease: ExtractionCacheWriteLease;
  readonly maxReceiptBytes?: number;
}): VerifiedLazySemanticRunReceipt {
  input.lease.assertOwned();
  const execution = structuredClone(unwrapVerifiedSemanticFillExecution(input.execution));
  const envelope = structuredClone(input.envelope);
  const endingCacheIdentity = input.endingCacheIdentity;
  const endingOverlayIdentity = input.endingOverlayIdentity;
  input.lease.assertRoot(input.root);
  const capturedOccurrences = new Set(execution.tasks.map(
    (task) => task.binding.occurrenceIdentity
  ));
  const capabilityPolicy = [...new Set(execution.tasks.map((task) => task.capability))].sort();
  if (capabilityPolicy.length === 0) {
    throw new Error("NOT_REPLAYABLE: empty demand has no persisted lazy receipt");
  }
  const sourceAuthority = captureSemanticRunSourceAuthority(execution.tasks);
  const demandUnits = execution.tasks.map((task) => ({
    compatibilityIdentity: digest(semanticTaskIdentity(task)),
    semanticKey: task.semanticKey,
    capability: task.capability,
    occurrenceIdentity: task.binding.occurrenceIdentity,
    sourceCorpusIdentity: task.binding.sourceCorpusIdentity
  }));
  if (demandUnits.some((unit) => !capturedOccurrences.has(unit.occurrenceIdentity))) {
    throw new Error("lazy semantic demand unit occurrence is not in captured execution tasks");
  }
  const demandTraceIdentity = digest(demandUnits.map((unit) =>
    `${unit.semanticKey}\u0000${unit.capability}\u0000${unit.occurrenceIdentity}` +
      `\u0000${unit.sourceCorpusIdentity}`
  ).join("\n"));
  const counts = {
    cold: execution.attempts.filter((attempt) => attempt.outcome === "admitted").length,
    warm: execution.attempts.filter((attempt) => attempt.outcome === "skipped").length,
    calls: execution.calls,
    failures: execution.failures,
    failedUnits: execution.attempts.filter((attempt) => attempt.outcome === "failed").length,
    unavailable: execution.attempts.filter((attempt) =>
      attempt.outcome === "unresolved" || attempt.outcome === "failed").length,
    attemptCount: execution.attempts.length
  };
  const unsigned = {
    schemaVersion: 3 as const,
    status: "replayable" as const,
    ledgerScopeIdentity: execution.ledgerScopeIdentity,
    startingCacheIdentity: execution.startingCacheIdentity,
    endingCacheIdentity,
    startingOverlayIdentity: execution.startingOverlayIdentity,
    endingOverlayIdentity,
    sourceAuthority,
    transportPolicy: envelope.transportPolicy,
    replaySemantics: unwrapSemanticReplayAuthority(input.replayAuthority),
    capabilityPolicy,
    budget: { maxCalls: envelope.maxCalls, maxFailures: envelope.maxFailures },
    demandTraceIdentity,
    demandUnits,
    attempts: execution.attempts.map((attempt) => ({ ...attempt })),
    uniqueUnits: execution.uniqueUnits,
    occurrenceCount: execution.occurrenceCount,
    bindingCount: execution.bindingCount,
    ...counts
  };
  const receipt = sealLazySemanticRunReceipt(unsigned);
  publishLazyReceipt(input.root, receipt.runIdentity, receipt, input.maxReceiptBytes);
  publishLedgerBoundReceiptReplica({
    root: input.root,
    lease: input.lease,
    runIdentity: receipt.runIdentity,
    ledgerScopeIdentity: receipt.ledgerScopeIdentity,
    attempts: receipt.attempts
  });
  readPersistedLazySemanticRunReceipt(input.root, receipt.runIdentity);
  const handle = Object.freeze({ kind: "verified-lazy-semantic-run-receipt" as const });
  verifiedReceipts.set(handle, Object.freeze({
    root: input.lease.cacheRoot, runIdentity: receipt.runIdentity
  }));
  return handle;
}

export function sealLazySemanticRunReceipt(
  unsigned: Omit<LazySemanticRunReceipt, "runIdentity" | "receiptDigest">
): LazySemanticRunReceipt {
  const runIdentity = computeLazySemanticRunIdentity(unsigned);
  return LazySemanticRunReceiptSchema.parse({
    ...unsigned,
    runIdentity,
    receiptDigest: digest(JSON.stringify({ ...unsigned, runIdentity }))
  });
}

function publishLazyReceipt(
  root: string,
  runIdentity: string,
  receipt: LazySemanticRunReceipt,
  maxReceiptBytes?: number
): void {
  const bytes = serializeLazySemanticRunReceipt(receipt, maxReceiptBytes);
  withRootBoundDirectory({
    root, segments: ["receipts"], createSegments: true,
    label: "lazy semantic receipt root"
  }, (directory, stableRoot) => {
    withRootBoundDirectory({
      root: stableRoot, segments: [".tmp"], createSegments: true,
      label: "lazy semantic receipt temporary root"
    }, (temporaryDirectory) => publishBytesExclusiveDurable({
      destination: `${directory}/${runIdentity}.json`,
      bytes,
      ownerIdentity: runIdentity,
      temporaryDirectory,
      allowExistingExact: true
    }));
  });
}

export function readPersistedLazySemanticRunReceipt(
  root: string,
  runIdentity: string
): LazySemanticRunReceipt {
  if (!/^[a-f0-9]{64}$/u.test(runIdentity)) throw new Error("lazy semantic run identity is invalid");
  const receipt = withRootBoundDirectory({
    root, segments: ["receipts"], label: "lazy semantic receipt root"
  }, (directory) => LazySemanticRunReceiptSchema.parse(JSON.parse(
    readBoundedCanonicalUtf8Artifact({
      path: `${directory}/${runIdentity}.json`,
      maxBytes: MAX_LAZY_SEMANTIC_RUN_RECEIPT_BYTES,
      label: "lazy semantic persisted receipt"
    })
  )));
  if (receipt.runIdentity !== runIdentity) throw new Error("lazy semantic receipt path identity mismatch");
  assertReceiptLedgerAuthority(root, receipt);
  if (receipt.endingCacheIdentity !== digestSemanticCacheState(root) ||
      receipt.endingOverlayIdentity !== digestSemanticOverlayState(root)) {
    throw new Error("lazy semantic receipt ending cache or overlay identity is stale");
  }
  assertReceiptArtifactsAvailable(root, receipt);
  return receipt;
}

export function loadVerifiedLazySemanticRunReceipt(input: {
  readonly semanticRoot: string;
  readonly extractionCacheRoot: string;
  readonly runIdentity: string;
}): VerifiedLazySemanticRunReceipt {
  const extraction = readExtractionCacheManifestIdentity(input.extractionCacheRoot);
  if (extraction === undefined) {
    throw new Error("lazy semantic receipt loader requires physical extraction authority");
  }
  const receipt = readPersistedLazySemanticRunReceipt(
    input.semanticRoot, input.runIdentity
  );
  assertLazySemanticAuthorityMatchesExtraction({
    receipt,
    extraction: {
      manifest_sha256: extraction.manifestSha256,
      ...extraction.manifest
    }
  });
  const stableRoot = withRootBoundDirectory({
    root: input.semanticRoot,
    label: "lazy semantic verified receipt root"
  }, (_directory, root) => realpathSync(root));
  const handle = Object.freeze({ kind: "verified-lazy-semantic-run-receipt" as const });
  verifiedReceipts.set(handle, Object.freeze({
    root: stableRoot,
    runIdentity: receipt.runIdentity
  }));
  return handle;
}

export function unwrapVerifiedLazySemanticRunReceipt(
  handle: VerifiedLazySemanticRunReceipt
): LazySemanticRunReceipt {
  const capture = verifiedReceipts.get(handle);
  if (capture === undefined) {
    throw new Error("lazy semantic provenance requires a verified persisted receipt handle");
  }
  return readPersistedLazySemanticRunReceipt(capture.root, capture.runIdentity);
}

export function computeLazySemanticRunIdentity(
  receipt: Omit<LazySemanticRunReceipt, "runIdentity" | "receiptDigest">
): string {
  return digest(JSON.stringify(receipt));
}

function assertReceiptArtifactsAvailable(root: string, receipt: LazySemanticRunReceipt): void {
  for (const attempt of receipt.attempts) {
    if (attempt.outcome !== "admitted" && attempt.outcome !== "skipped") continue;
    const inspected = inspectSemanticArtifact(root, attempt.semanticKey, attempt.capability);
    if (inspected.status !== "provider_backed" && inspected.status !== "deterministic_empty") {
      throw new Error("lazy semantic receipt claims warm or admitted work without an artifact");
    }
    const demanded = receipt.demandUnits.filter((unit) =>
      unit.semanticKey === attempt.semanticKey && unit.capability === attempt.capability);
    const bindings = recordedSourceBindings(root, attempt.semanticKey, attempt.capability);
    if (!demanded.every((unit) => bindings.some((binding) =>
      binding.occurrenceIdentity === unit.occurrenceIdentity &&
      binding.sourceCorpusIdentity === unit.sourceCorpusIdentity &&
      binding.datasetRevision === receipt.sourceAuthority.datasetRevision))) {
      throw new Error("lazy semantic receipt artifact closure lost a demanded source binding");
    }
  }
}

function assertReceiptLedgerAuthority(
  root: string,
  receipt: LazySemanticRunReceipt
): void {
  try {
    withRootBoundDirectory({
      root,
      segments: [".semantic-fill-private", "attempts", receipt.ledgerScopeIdentity],
      label: "lazy semantic receipt durable ledger authority"
    }, (directory) => {
      const meta = JSON.parse(readBoundedCanonicalUtf8Artifact({
        path: `${directory}/ledger.json`,
        maxBytes: 4 * 1024 * 1024,
        label: "lazy semantic receipt ledger metadata"
      })) as Record<string, unknown>;
      const replayIdentityDigest = semanticReplayIdentityDigest(receipt.replaySemantics);
      if (meta.scopeIdentity !== receipt.ledgerScopeIdentity ||
          meta.sourceAuthorityIdentity !==
            substrateAuthorityIdentity(receipt.sourceAuthority.substrateManifest) ||
          meta.startingCacheIdentity !== receipt.startingCacheIdentity ||
          meta.startingOverlayIdentity !== receipt.startingOverlayIdentity ||
          meta.transportPolicyDigest !== digest(JSON.stringify(receipt.transportPolicy)) ||
          meta.replayIdentityDigest !== replayIdentityDigest ||
          meta.maxCalls !== receipt.budget.maxCalls ||
          meta.maxFailures !== receipt.budget.maxFailures) {
        throw new Error("lazy semantic receipt differs from durable ledger authority");
      }
      const attempts = readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.name !== "ledger.json");
      if (attempts.some((entry) => !entry.isFile() || entry.isSymbolicLink() ||
          !/^attempt-\d{12}\.json$/u.test(entry.name))) {
        throw new Error("lazy semantic receipt durable ledger contains a foreign entry");
      }
      let failures = 0;
      for (const entry of attempts) {
        const attempt = JSON.parse(readBoundedCanonicalUtf8Artifact({
          path: `${directory}/${entry.name}`,
          maxBytes: 16 * 1024 * 1024,
          label: "lazy semantic receipt durable attempt"
        })) as { readonly response?: { readonly kind?: unknown } };
        if (attempt.response?.kind === "failure" ||
            attempt.response?.kind === "malformed_raw") failures += 1;
      }
      if (attempts.length !== receipt.calls || failures !== receipt.failures) {
        throw new Error("lazy semantic receipt call totals differ from durable ledger authority");
      }
    });
  } catch (cause) {
    if (cause instanceof Error &&
        /lacks durable ledger|differs from durable ledger|foreign entry|call totals/u.test(cause.message)) {
      throw cause;
    }
    throw new Error("lazy semantic receipt lacks durable ledger authority", { cause });
  }
  assertReceiptLedgerMemberOutcomes(root, receipt);
}

export function serializeLazySemanticRunReceipt(
  receipt: LazySemanticRunReceipt,
  maxBytes = MAX_LAZY_SEMANTIC_RUN_RECEIPT_BYTES
): Buffer {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 ||
      maxBytes > MAX_LAZY_SEMANTIC_RUN_RECEIPT_BYTES) {
    throw new Error("lazy semantic receipt publication bound is invalid");
  }
  const bytes = Buffer.from(`${JSON.stringify(receipt)}\n`, "utf8");
  if (bytes.byteLength > maxBytes) {
    throw new Error("lazy semantic receipt exceeds its bounded publication size");
  }
  return bytes;
}

export function estimateLazySemanticReceiptCensusBytes(input: {
  readonly occurrenceCount: number;
  readonly uniqueUnits: number;
  readonly sourceCorpusCount: number;
  readonly substrateCacheKeyCount: number;
}): number {
  for (const [label, value] of Object.entries(input)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`lazy semantic census ${label} is invalid`);
    }
  }
  // Compact JSON worst-case for successful census-scale receipts. The constants include
  // field names, punctuation, 64-byte digests, and the bounded 512-byte capability.
  return 64 * 1024 + input.occurrenceCount * 840 + input.uniqueUnits * 650 +
    input.sourceCorpusCount * 150 + input.substrateCacheKeyCount * 68;
}

export function assertCensusLazySemanticReceiptFitsBoundedSerialization(input: {
  readonly sourceCorpusCount: number;
  readonly substrateCacheKeyCount: number;
}): void {
  const estimated = estimateLazySemanticReceiptCensusBytes({
    occurrenceCount: CENSUS_LAZY_SEMANTIC_OCCURRENCE_COUNT,
    uniqueUnits: CENSUS_LAZY_SEMANTIC_UNIQUE_COUNT,
    ...input
  });
  if (estimated > MAX_LAZY_SEMANTIC_RUN_RECEIPT_BYTES) {
    throw new Error("lazy semantic receipt census exceeds the bounded reader limit");
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
