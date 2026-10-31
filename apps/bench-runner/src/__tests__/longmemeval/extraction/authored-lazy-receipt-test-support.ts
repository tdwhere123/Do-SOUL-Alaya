/**
 * Authored historical-format lazy receipt, ledger, and artifact fixtures.
 * These bytes are not genuine producer history and do not authorize replay.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { transportPackIdentity } from "@do-soul/alaya-soul";
import { sealSemanticArtifact } from
  "../../../runs/extraction/cache/semantic-artifact/contract.js";
import { semanticTaskIdentity } from
  "../../../runs/extraction/cache/semantic-artifact/admission-identity.js";
import {
  currentSemanticReplayAuthority,
  semanticReplayIdentityDigest,
  unwrapSemanticReplayAuthority
} from "../../../runs/extraction/cache/semantic-artifact/replay-authority.js";
import {
  digestSemanticCacheState,
  digestSemanticOverlayState,
  ensureSemanticArtifactRoot,
  persistRawArtifact,
  recordSourceBinding,
  semanticArtifactPath
} from "../../../runs/extraction/cache/semantic-artifact/store.js";
import {
  captureSemanticRunSourceAuthority,
  substrateAuthorityIdentity,
  type SemanticFillTask
} from "../../../runs/extraction/fill/semantic-fill-authority.js";
import {
  SEMANTIC_FILL_ATTEMPT_SCHEMA_VERSION,
  assertSemanticFillAttemptEvidence,
  freezeDurableSemanticPack,
  type SemanticFillAttempt,
  type SemanticFillDurableAttemptEvidence
} from "../../../runs/extraction/fill/semantic-fill-attempt-evidence.js";
import {
  sealLazySemanticRunReceipt,
  serializeLazySemanticRunReceipt,
  type LazySemanticRunReceipt
} from "../../../runs/extraction/fill/semantic-fill-receipt.js";
import {
  SEMANTIC_RAW,
  TOKEN_AWARE_POLICY,
  semanticArtifactUnsigned
} from "./semantic-artifact-fixture.js";

const AUTHORED_WRITER = "authored-historical-format";
const AUTHORED_FAILURE = "sealed offline failure";

export function plantAuthoredProviderBackedArtifact(
  root: string,
  task: SemanticFillTask,
  rawJson = SEMANTIC_RAW
): void {
  const digest = persistRawArtifact(root, rawJson);
  const sealed = sealSemanticArtifact(semanticArtifactUnsigned(task, {
    raw_response_digest: digest
  }));
  const path = semanticArtifactPath(root, task.semanticKey, task.capability);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(sealed, null, 2)}\n`);
  recordSourceBinding(root, task.semanticKey, task.capability, task.binding);
}

export function writeAuthoredFailedLazyReceipt(
  root: string,
  task: SemanticFillTask
): LazySemanticRunReceipt {
  ensureSemanticArtifactRoot(root);
  const identity = snapshotIdentities(root);
  return writeAuthoredLazyReceipt(root, {
    tasks: [task],
    identity,
    attempts: [failedAttempt(task)],
    ledgerAttempts: [{
      task,
      response: { kind: "failure", reason: AUTHORED_FAILURE },
      memberOutcomes: [failedAttempt(task)]
    }],
    calls: 1,
    failures: 1
  });
}

export function writeAuthoredAdmittedLazyReceipt(
  root: string,
  tasks: readonly SemanticFillTask[],
  rawJson = SEMANTIC_RAW
): LazySemanticRunReceipt {
  for (const task of tasks) plantAuthoredProviderBackedArtifact(root, task, rawJson);
  const identity = snapshotIdentities(root);
  return writeAuthoredLazyReceipt(root, {
    tasks,
    identity,
    attempts: tasks.map(admittedAttempt),
    ledgerAttempts: tasks.map((task) => ({
      task,
      response: rawResponse(rawJson),
      memberOutcomes: [admittedAttempt(task)]
    })),
    calls: tasks.length,
    failures: 0
  });
}

export function writeAuthoredSkippedLazyReceipt(
  root: string,
  task: SemanticFillTask,
  rawJson = SEMANTIC_RAW
): LazySemanticRunReceipt {
  plantAuthoredProviderBackedArtifact(root, task, rawJson);
  const identity = snapshotIdentities(root);
  return writeAuthoredLazyReceipt(root, {
    tasks: [task],
    identity,
    attempts: [skippedAttempt(task)],
    ledgerAttempts: [],
    calls: 0,
    failures: 0
  });
}

export function writeSealedLazyReceipt(root: string, receipt: LazySemanticRunReceipt): void {
  const directory = join(root, "receipts");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${receipt.runIdentity}.json`),
    serializeLazySemanticRunReceipt(receipt));
}

function writeAuthoredLazyReceipt(root: string, input: {
  readonly tasks: readonly SemanticFillTask[];
  readonly identity: ReturnType<typeof snapshotIdentities>;
  readonly attempts: readonly SemanticFillAttempt[];
  readonly ledgerAttempts: readonly {
    readonly task: SemanticFillTask;
    readonly response: SemanticFillDurableAttemptEvidence["response"];
    readonly memberOutcomes: readonly SemanticFillAttempt[];
  }[];
  readonly calls: number;
  readonly failures: number;
}): LazySemanticRunReceipt {
  const sourceAuthority = captureSemanticRunSourceAuthority(input.tasks);
  const replaySemantics = unwrapSemanticReplayAuthority(currentSemanticReplayAuthority());
  const transportPolicy = TOKEN_AWARE_POLICY;
  const demandUnits = input.tasks.map((task) => ({
    compatibilityIdentity: digest(semanticTaskIdentity(task)),
    semanticKey: task.semanticKey,
    capability: task.capability,
    occurrenceIdentity: task.binding.occurrenceIdentity,
    sourceCorpusIdentity: task.binding.sourceCorpusIdentity
  }));
  const uniqueDemand = new Map(demandUnits.map((unit) => [
    unit.compatibilityIdentity,
    `${unit.semanticKey}\u0000${unit.capability}`
  ]));
  const scopeIdentity = digest([
    "authored.historical.lazy_semantic_ledger.v1",
    ...input.tasks.map((task) => `${task.semanticKey}:${task.capability}`)
  ].join("\u0000"));
  const plans = input.ledgerAttempts.map(({ task }) => freezeDurableSemanticPack({
    pack_id: transportPackIdentity("token_aware", [task.semanticKey]),
    policy_kind: "token_aware",
    assertion_ids: [task.assertionId],
    semantic_keys: [task.semanticKey]
  }));
  writeLedgerMeta(root, {
    schemaVersion: SEMANTIC_FILL_ATTEMPT_SCHEMA_VERSION,
    scopeIdentity,
    replayIdentityDigest: semanticReplayIdentityDigest(replaySemantics),
    transportPolicyDigest: digest(JSON.stringify(transportPolicy)),
    sourceAuthorityIdentity: substrateAuthorityIdentity(sourceAuthority.substrateManifest),
    startingCacheIdentity: input.identity.cache,
    startingOverlayIdentity: input.identity.overlay,
    maxCalls: Math.max(1, input.calls),
    maxFailures: Math.max(1, input.failures),
    plans
  });
  input.ledgerAttempts.forEach((attempt, index) => {
    writeAttemptRecord(root, scopeIdentity, {
      schemaVersion: SEMANTIC_FILL_ATTEMPT_SCHEMA_VERSION,
      scopeIdentity,
      ordinal: index + 1,
      pack: plans[index]!,
      requestSha256: digest(plans[index]!.pack_id),
      writerGeneration: AUTHORED_WRITER,
      reservationHistory: Object.freeze([{
        writerGeneration: AUTHORED_WRITER,
        members: Object.freeze([{
          semanticKey: attempt.task.semanticKey,
          capability: attempt.task.capability,
          tokenSha256: digest(`${AUTHORED_WRITER}:${attempt.task.semanticKey}`)
        }])
      }]),
      response: attempt.response,
      memberOutcomes: Object.freeze(attempt.memberOutcomes.map((outcome) => Object.freeze({ ...outcome }))),
      packComplete: true
    });
  });
  const receipt = sealLazySemanticRunReceipt({
    schemaVersion: 3,
    status: "replayable",
    ledgerScopeIdentity: scopeIdentity,
    startingCacheIdentity: input.identity.cache,
    endingCacheIdentity: input.identity.cache,
    startingOverlayIdentity: input.identity.overlay,
    endingOverlayIdentity: input.identity.overlay,
    sourceAuthority,
    transportPolicy,
    replaySemantics,
    capabilityPolicy: [...new Set(input.tasks.map((task) => task.capability))].sort(),
    budget: {
      maxCalls: Math.max(1, input.calls),
      maxFailures: Math.max(1, input.failures)
    },
    demandTraceIdentity: digest(demandUnits.map((unit) =>
      `${unit.semanticKey}\u0000${unit.capability}\u0000${unit.occurrenceIdentity}` +
        `\u0000${unit.sourceCorpusIdentity}`
    ).join("\n")),
    demandUnits,
    attempts: [...input.attempts],
    uniqueUnits: uniqueDemand.size,
    occurrenceCount: demandUnits.length,
    bindingCount: demandUnits.length,
    cold: input.attempts.filter((attempt) => attempt.outcome === "admitted").length,
    warm: input.attempts.filter((attempt) => attempt.outcome === "skipped").length,
    calls: input.calls,
    failures: input.failures,
    failedUnits: input.attempts.filter((attempt) => attempt.outcome === "failed").length,
    unavailable: input.attempts.filter((attempt) =>
      attempt.outcome === "unresolved" || attempt.outcome === "failed").length,
    attemptCount: input.attempts.length
  });
  writeSealedLazyReceipt(root, receipt);
  return receipt;
}

function writeLedgerMeta(root: string, meta: unknown): void {
  const parsed = meta as { readonly scopeIdentity: string };
  const directory = join(root, ".semantic-fill-private", "attempts", parsed.scopeIdentity);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "ledger.json"), `${JSON.stringify(meta, null, 2)}\n`);
}

function writeAttemptRecord(
  root: string,
  scopeIdentity: string,
  record: SemanticFillDurableAttemptEvidence
): void {
  assertSemanticFillAttemptEvidence(record, scopeIdentity);
  const directory = join(root, ".semantic-fill-private", "attempts", scopeIdentity);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, `attempt-${String(record.ordinal).padStart(12, "0")}.json`),
    `${JSON.stringify(record, null, 2)}\n`
  );
}

function snapshotIdentities(root: string): { readonly cache: string; readonly overlay: string } {
  return {
    cache: digestSemanticCacheState(root),
    overlay: digestSemanticOverlayState(root)
  };
}

function failedAttempt(task: SemanticFillTask): SemanticFillAttempt {
  return {
    semanticKey: task.semanticKey,
    capability: task.capability,
    outcome: "failed",
    reason: AUTHORED_FAILURE
  };
}

function admittedAttempt(task: SemanticFillTask): SemanticFillAttempt {
  return { semanticKey: task.semanticKey, capability: task.capability, outcome: "admitted" };
}

function skippedAttempt(task: SemanticFillTask): SemanticFillAttempt {
  return { semanticKey: task.semanticKey, capability: task.capability, outcome: "skipped" };
}

function rawResponse(rawJson: string): SemanticFillDurableAttemptEvidence["response"] {
  const bytes = Buffer.from(rawJson, "utf8");
  return {
    kind: "raw",
    rawUtf8: rawJson,
    rawSha256: createHash("sha256").update(bytes).digest("hex"),
    rawBytes: bytes.byteLength
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
