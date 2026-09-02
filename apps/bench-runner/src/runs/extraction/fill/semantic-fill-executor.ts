import {
  admitSemanticArtifact,
  inspectSemanticArtifact,
  releaseSemanticArtifactReservation,
  reserveSemanticArtifact
} from "../cache/semantic-artifact/store.js";
import {
  sealSemanticArtifact,
  type SemanticArtifact,
  type SemanticArtifactSourceBinding
} from "../cache/semantic-artifact/contract.js";
import { createHash } from "node:crypto";

export interface SemanticFillTask {
  readonly semanticKey: string;
  readonly capability: string;
  readonly semanticContract: string;
  readonly modelFamily: string;
  readonly modelId: string;
  readonly binding: SemanticArtifactSourceBinding;
}

export interface SemanticFillEnvelope {
  readonly mode: "offline-only";
  readonly maxCalls: number;
  readonly maxFailures: number;
}

export type SemanticFillTransportResult =
  | { readonly kind: "raw"; readonly rawJson: string }
  | { readonly kind: "failure"; readonly reason: string };

export interface SemanticFillTransport {
  readonly complete: (task: SemanticFillTask) => SemanticFillTransportResult;
}

export interface SemanticFillReport {
  readonly admitted: number;
  readonly unresolved: number;
  readonly calls: number;
  readonly failures: number;
  readonly stopLoss: boolean;
  readonly attempts: readonly SemanticFillAttempt[];
}

export interface SemanticFillAttempt {
  readonly semanticKey: string;
  readonly capability: string;
  readonly outcome: "admitted" | "unresolved" | "skipped" | "failed";
  readonly reason?: string;
}

export function runSemanticFill(input: {
  readonly root: string;
  readonly tasks: readonly SemanticFillTask[];
  readonly envelope: SemanticFillEnvelope;
  readonly transport: SemanticFillTransport;
}): SemanticFillReport {
  if (input.envelope.mode !== "offline-only") {
    throw new Error("semantic fill requires the offline-only envelope");
  }
  const attempts: SemanticFillAttempt[] = [];
  let calls = 0;
  let failures = 0;
  let admitted = 0;
  let unresolved = 0;
  let stopLoss = false;
  for (const task of input.tasks) {
    if (stopLoss || calls >= input.envelope.maxCalls || failures >= input.envelope.maxFailures) {
      stopLoss = true;
      attempts.push({ semanticKey: task.semanticKey, capability: task.capability, outcome: "unresolved", reason: "stop-loss" });
      unresolved += 1;
      continue;
    }
    const existing = inspectSemanticArtifact(input.root, task.semanticKey, task.capability);
    if (existing.status === "provider_backed" || existing.status === "deterministic_empty") {
      attempts.push({ semanticKey: task.semanticKey, capability: task.capability, outcome: "skipped" });
      continue;
    }
    let token: string;
    try {
      token = reserveSemanticArtifact(input.root, task.semanticKey, task.capability);
    } catch (cause) {
      const inspected = inspectSemanticArtifact(input.root, task.semanticKey, task.capability);
      if (inspected.status === "provider_backed" || inspected.status === "deterministic_empty") {
        attempts.push({ semanticKey: task.semanticKey, capability: task.capability, outcome: "skipped" });
        continue;
      }
      attempts.push({
        semanticKey: task.semanticKey,
        capability: task.capability,
        outcome: "unresolved",
        reason: cause instanceof Error ? cause.message : String(cause)
      });
      unresolved += 1;
      continue;
    }
    calls += 1;
    const result = input.transport.complete(task);
    if (result.kind === "failure") {
      failures += 1;
      releaseSemanticArtifactReservation(input.root, task.semanticKey, task.capability, token);
      attempts.push({
        semanticKey: task.semanticKey,
        capability: task.capability,
        outcome: "failed",
        reason: result.reason
      });
      unresolved += 1;
      continue;
    }
    const artifact = artifactFromRaw(task, result.rawJson);
    admitSemanticArtifact({ root: input.root, artifact, reservationToken: token });
    admitted += 1;
    attempts.push({ semanticKey: task.semanticKey, capability: task.capability, outcome: "admitted" });
  }
  return { admitted, unresolved, calls, failures, stopLoss, attempts };
}

function artifactFromRaw(task: SemanticFillTask, rawJson: string): SemanticArtifact {
  return sealSemanticArtifact({
    schema_version: 1,
    kind: "assertion_semantic_artifact_v1",
    semantic_key: task.semanticKey,
    semantic_contract: task.semanticContract,
    capability: task.capability,
    capability_set: [task.capability],
    model_family: task.modelFamily,
    model_id: task.modelId,
    admission_state: "provider_backed",
    source_bindings: [task.binding],
    raw_response_digest: createHash("sha256").update(rawJson, "utf8").digest("hex")
  });
}
