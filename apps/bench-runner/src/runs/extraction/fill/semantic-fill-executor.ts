import {
  acquireExtractionCacheWriteLease,
  withExtractionCacheWriteLease,
  type ExtractionCacheWriteLease
} from "./manifest/fill-root-guard.js";
import { assertSemanticAdmissionIdentity } from
  "../cache/semantic-artifact/admission-identity.js";
import {
  digestSemanticCacheState,
  digestSemanticOverlayState,
  ensureSemanticArtifactRoot
} from "../cache/semantic-artifact/store.js";
import type { SemanticArtifactSourceBinding } from
  "../cache/semantic-artifact/contract.js";
import {
  captureSemanticRunSourceAuthority,
  type SemanticTaskSourceAuthority
} from "./semantic-fill-authority.js";
import {
  assertOfflineSemanticExecution,
  captureOfflineSemanticEnvelope,
  semanticReplayAuthorityForTransport,
  type SemanticTransportPolicy
} from "./semantic-fill-envelope.js";
import type { VerifiedSemanticReplayAuthority } from
  "../cache/semantic-artifact/replay-authority.js";
import {
  persistLazySemanticRunReceipt,
  unwrapVerifiedLazySemanticRunReceipt,
  type LazySemanticRunReceipt,
  type VerifiedLazySemanticRunReceipt
} from "./semantic-fill-receipt.js";
import { prepareSemanticFill } from "./semantic-fill-plan.js";
import {
  executeSemanticPacks,
  type SemanticFillExecutionState
} from "./semantic-fill-pack-execution.js";
import { openSemanticFillAttemptLedger } from "./semantic-fill-attempt-ledger.js";

export interface SemanticFillTask {
  readonly semanticKey: string;
  readonly capability: string;
  readonly semanticContract: string;
  readonly modelFamily: string;
  readonly modelId: string;
  readonly transportModelId: string;
  readonly requestProfile: string;
  readonly providerUrlSha256: string;
  readonly binding: SemanticArtifactSourceBinding;
  readonly assertionId: number;
  readonly text: string;
  readonly sourceCorpus: string;
  readonly semanticIdentity: NonNullable<
    import("@do-soul/alaya-soul").OfficialApiSemanticWorkUnit["semanticIdentity"]
  >;
  readonly sourceAuthority: SemanticTaskSourceAuthority;
}

export interface SemanticFillEnvelope {
  readonly mode: "offline-only";
  readonly maxCalls: number;
  readonly maxFailures: number;
  readonly transportPolicy: SemanticTransportPolicy;
}

export type SemanticFillTransportResult =
  | { readonly kind: "raw"; readonly rawJson: string }
  | { readonly kind: "size_failure"; readonly reason: string }
  | { readonly kind: "failure"; readonly reason: string };

export interface SemanticFillTransport {
  readonly kind: "sealed-local-replay";
}

export interface SemanticFillAttempt {
  readonly semanticKey: string;
  readonly capability: string;
  readonly outcome: "admitted" | "unresolved" | "skipped" | "failed";
  readonly reason?: string;
}

export interface SemanticFillReport {
  readonly admitted: number;
  readonly unresolved: number;
  readonly calls: number;
  readonly failures: number;
  readonly stopLoss: boolean;
  readonly attempts: readonly SemanticFillAttempt[];
  readonly lazyRunReceipt: LazySemanticRunReceipt;
  readonly lazyRunReceiptHandle: VerifiedLazySemanticRunReceipt;
}

type SemanticFillInvocation = Readonly<{
  root: string;
  tasks: readonly SemanticFillTask[];
  envelope: SemanticFillEnvelope;
  transport: SemanticFillTransport;
  signal?: AbortSignal;
  /** Optional tighter publication bound; it can never widen the production reader limit. */
  maxReceiptBytes?: number;
}>;

export async function runSemanticFill(input: SemanticFillInvocation): Promise<SemanticFillReport> {
  const captured = captureInvocation(input);
  assertOfflineSemanticExecution(captured.envelope, captured.transport);
  captured.signal?.throwIfAborted();
  const lease = acquireExtractionCacheWriteLease(captured.root);
  return withExtractionCacheWriteLease(
    lease,
    () => runSemanticFillWithLease(captured, lease)
  );
}

export async function runSemanticFillUnderLease(input: SemanticFillInvocation & Readonly<{
  lease: ExtractionCacheWriteLease;
}>): Promise<SemanticFillReport> {
  const lease = input.lease;
  const captured = captureInvocation(input);
  return runSemanticFillWithLease(captured, lease);
}

async function runSemanticFillWithLease(
  input: SemanticFillInvocation,
  lease: ExtractionCacheWriteLease
): Promise<SemanticFillReport> {
  assertOfflineSemanticExecution(input.envelope, input.transport);
  input.signal?.throwIfAborted();
  lease.assertOwned();
  for (const task of input.tasks) assertSemanticAdmissionIdentity(task);
  lease.assertRoot(input.root);
  return executeSemanticFill({
    ...input,
    lease,
    root: lease.stableRootPath,
    replayAuthority: semanticReplayAuthorityForTransport(input.transport)
  });
}

function captureInvocation(input: SemanticFillInvocation): SemanticFillInvocation {
  const tasks = Object.freeze(
    (structuredClone(input.tasks) as SemanticFillTask[]).map(canonicalizeFillTask)
  );
  return Object.freeze({
    root: input.root,
    tasks,
    envelope: canonicalizeEnvelope(captureOfflineSemanticEnvelope(input.envelope)),
    transport: input.transport,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.maxReceiptBytes === undefined ? {} : { maxReceiptBytes: input.maxReceiptBytes })
  });
}

function canonicalizeEnvelope(envelope: SemanticFillEnvelope): SemanticFillEnvelope {
  const policy = envelope.transportPolicy;
  const transportPolicy = policy.kind === "token_aware"
    ? Object.freeze({
        kind: policy.kind,
        maxAssertions: policy.maxAssertions,
        maxInputTokens: policy.maxInputTokens,
        expectedOutputCap: policy.expectedOutputCap,
        systemPromptChars: policy.systemPromptChars
      })
    : policy.kind === "reference_batch"
      ? Object.freeze({ kind: policy.kind, assertionsPerPack: policy.assertionsPerPack })
      : Object.freeze({ kind: policy.kind });
  return Object.freeze({ ...envelope, transportPolicy });
}

function canonicalizeFillTask(task: SemanticFillTask): SemanticFillTask {
  const manifest = task.sourceAuthority.substrateManifest;
  return Object.freeze({
    semanticKey: task.semanticKey,
    capability: task.capability,
    semanticContract: task.semanticContract,
    modelFamily: task.modelFamily,
    modelId: task.modelId,
    transportModelId: task.transportModelId,
    requestProfile: task.requestProfile,
    providerUrlSha256: task.providerUrlSha256,
    assertionId: task.assertionId,
    text: task.text,
    sourceCorpus: task.sourceCorpus,
    binding: Object.freeze({ ...task.binding, locator: Object.freeze({ ...task.binding.locator }) }),
    semanticIdentity: Object.freeze({ ...task.semanticIdentity }),
    sourceAuthority: Object.freeze({
      datasetRevision: task.sourceAuthority.datasetRevision,
      substrateCacheKeys: Object.freeze([...task.sourceAuthority.substrateCacheKeys]),
      substrateManifest: Object.freeze({
        schemaVersion: manifest.schemaVersion,
        manifestSha256: manifest.manifestSha256,
        dataset: manifest.dataset,
        datasetRevision: manifest.datasetRevision,
        extractionModel: manifest.extractionModel,
        modelFamily: manifest.modelFamily,
        requestProfile: manifest.requestProfile,
        systemPromptSha256: manifest.systemPromptSha256,
        cacheKeyAlgorithm: manifest.cacheKeyAlgorithm,
        expectedTurns: manifest.expectedTurns,
        expectedKeySetSha256: manifest.expectedKeySetSha256,
        contentClosureSha256: manifest.contentClosureSha256,
        contentClosureIndexSha256: manifest.contentClosureIndexSha256,
        windowOffset: manifest.windowOffset,
        windowLimit: manifest.windowLimit
      })
    })
  });
}

async function executeSemanticFill(input: {
  readonly root: string;
  readonly tasks: readonly SemanticFillTask[];
  readonly envelope: SemanticFillEnvelope;
  readonly transport: SemanticFillTransport;
  readonly replayAuthority: VerifiedSemanticReplayAuthority;
  readonly lease: ExtractionCacheWriteLease;
  readonly signal?: AbortSignal;
  readonly maxReceiptBytes?: number;
}): Promise<SemanticFillReport> {
  captureSemanticRunSourceAuthority(input.tasks);
  ensureSemanticArtifactRoot(input.root);
  const startingCacheIdentity = digestSemanticCacheState(input.root);
  const startingOverlayIdentity = digestSemanticOverlayState(input.root);
  const attempts: SemanticFillAttempt[] = [];
  const prepared = prepareSemanticFill(
    input.root, input.tasks, attempts, input.envelope.transportPolicy, input.lease
  );
  if (attempts.some((attempt) =>
      attempt.reason?.includes("semantic path has incompatible task identities"))) {
    throw new Error("semantic path has incompatible task identities");
  }
  const attemptLedger = openSemanticFillAttemptLedger({
    root: input.root,
    tasks: input.tasks,
    envelope: input.envelope,
    replayAuthority: input.replayAuthority,
    plans: prepared.packs.map(({ pack }) => pack),
    lease: input.lease,
    startingCacheIdentity,
    startingOverlayIdentity
  });
  const historical = attemptLedger.snapshot();
  if ((historical.calls >= input.envelope.maxCalls ||
      historical.failures >= input.envelope.maxFailures) &&
      prepared.packs.some(({ pack }) => attemptLedger.attemptFor(pack) === undefined)) {
    throw new Error("semantic fill durable stop-loss budget is exhausted");
  }
  const state: SemanticFillExecutionState = {
    calls: historical.calls,
    failures: historical.failures,
    admitted: 0,
    unresolved: prepared.unresolved,
    stopLoss: false,
    attempts
  };
  const execution = await executeSemanticPacks({
    ...input, prepared, state, attemptLedger
  });
  input.signal?.throwIfAborted();
  const lazyRunReceiptHandle = persistLazySemanticRunReceipt({
    root: input.root,
    endingCacheIdentity: digestSemanticCacheState(input.root),
    endingOverlayIdentity: digestSemanticOverlayState(input.root),
    envelope: input.envelope,
    execution,
    replayAuthority: input.replayAuthority,
    lease: input.lease,
    ...(input.maxReceiptBytes === undefined ? {} : { maxReceiptBytes: input.maxReceiptBytes })
  });
  const lazyRunReceipt = unwrapVerifiedLazySemanticRunReceipt(lazyRunReceiptHandle);
  return {
    admitted: state.admitted,
    unresolved: state.unresolved,
    calls: state.calls,
    failures: state.failures,
    stopLoss: state.stopLoss,
    attempts,
    lazyRunReceipt,
    lazyRunReceiptHandle
  };
}
