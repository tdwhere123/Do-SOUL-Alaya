import {
  parseOfficialApiSignals,
  parseOfficialApiSourceLocator
} from "@do-soul/alaya-soul";
import {
  admitProviderRaw,
  type AdmissionTask
} from "../cache/semantic-artifact/admit.js";
import {
  admitSemanticArtifact,
  inspectSemanticArtifact,
  recordSourceBinding,
  releaseSemanticArtifactReservation,
  reserveSemanticArtifact
} from "../cache/semantic-artifact/store.js";
import {
  demultiplexTransportPack,
  planTurnTransportPacks,
  type TransportPack
} from "../../../../../../packages/soul/src/garden/ingestion/official-api/transport-pack.js";
import type { SemanticArtifactSourceBinding } from "../cache/semantic-artifact/contract.js";

export interface SemanticFillTask {
  readonly semanticKey: string;
  readonly capability: string;
  readonly semanticContract: string;
  readonly modelFamily: string;
  readonly modelId: string;
  readonly requestProfile: string;
  readonly providerUrlSha256: string;
  readonly binding: SemanticArtifactSourceBinding;
  readonly assertionId: number;
  readonly text: string;
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
  readonly complete: (pack: readonly SemanticFillTask[]) => SemanticFillTransportResult;
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
  const pending: SemanticFillTask[] = [];
  for (const task of input.tasks) {
    const existing = inspectSemanticArtifact(input.root, task.semanticKey, task.capability);
    if (existing.status === "provider_backed" || existing.status === "deterministic_empty") {
      recordSourceBinding(input.root, task.semanticKey, task.capability, task.binding);
      attempts.push({ semanticKey: task.semanticKey, capability: task.capability, outcome: "skipped" });
      continue;
    }
    if (existing.status === "reserved") {
      attempts.push({
        semanticKey: task.semanticKey,
        capability: task.capability,
        outcome: "unresolved",
        reason: "reservation held"
      });
      unresolved += 1;
      continue;
    }
    pending.push(task);
  }
  const planned = planTurnTransportPacks(
    pending.map((task) => ({
      semanticKey: task.semanticKey,
      assertionId: task.assertionId,
      text: task.text
    })),
    { kind: "reference_batch_8" }
  );
  const byKey = new Map(pending.map((task) => [task.semanticKey, task]));
  const packs: SemanticFillTask[][] = planned.packs.map((pack) =>
    pack.semantic_keys.map((key) => {
      const task = byKey.get(key);
      if (task === undefined) throw new Error("transport pack referenced a missing fill task");
      return task;
    })
  );
  for (const [packIndex, members] of packs.entries()) {
    if (members.length === 0) continue;
    if (stopLoss || calls >= input.envelope.maxCalls || failures >= input.envelope.maxFailures) {
      stopLoss = true;
      for (const task of members) {
        attempts.push({
          semanticKey: task.semanticKey,
          capability: task.capability,
          outcome: "unresolved",
          reason: "stop-loss"
        });
        unresolved += 1;
      }
      continue;
    }
    const reserved: { task: SemanticFillTask; token: string }[] = [];
    try {
      for (const task of members) {
        reserved.push({
          task,
          token: reserveSemanticArtifact(input.root, task.semanticKey, task.capability)
        });
      }
      calls += 1;
      const result = input.transport.complete(members);
      if (result.kind === "raw") {
        const pack = planned.packs[packIndex];
        if (pack === undefined || !demuxMatchesPack(pack, result.rawJson, members)) {
          for (const held of reserved) {
            releaseSemanticArtifactReservation(input.root, held.task.semanticKey, held.task.capability, held.token);
            attempts.push({
              semanticKey: held.task.semanticKey,
              capability: held.task.capability,
              outcome: "unresolved",
              reason: "mismatched pack identity"
            });
            unresolved += 1;
          }
          continue;
        }
      }
      if (result.kind === "failure") {
        failures += 1;
        for (const held of reserved) {
          releaseSemanticArtifactReservation(input.root, held.task.semanticKey, held.task.capability, held.token);
          attempts.push({
            semanticKey: held.task.semanticKey,
            capability: held.task.capability,
            outcome: "failed",
            reason: result.reason
          });
          unresolved += 1;
        }
        continue;
      }
      const admissions = admitProviderRaw({
        root: input.root,
        rawJson: result.rawJson,
        tasks: members.map(toAdmissionTask)
      });
      for (const held of reserved) {
        const admission = admissions.find((item) => item.semanticKey === held.task.semanticKey)
          ?? admissions.find((item) => item.kind === "unresolved");
        if (admission === undefined || admission.kind === "unresolved") {
          releaseSemanticArtifactReservation(input.root, held.task.semanticKey, held.task.capability, held.token);
          attempts.push({
            semanticKey: held.task.semanticKey,
            capability: held.task.capability,
            outcome: "unresolved",
            reason: admission?.kind === "unresolved" ? admission.reason : "unresolved"
          });
          unresolved += 1;
          continue;
        }
        admitSemanticArtifact({
          root: input.root,
          artifact: admission.artifact,
          reservationToken: held.token
        });
        admitted += 1;
        attempts.push({
          semanticKey: held.task.semanticKey,
          capability: held.task.capability,
          outcome: "admitted"
        });
      }
    } catch (cause) {
      for (const held of reserved) {
        try {
          releaseSemanticArtifactReservation(input.root, held.task.semanticKey, held.task.capability, held.token);
        } catch { /* reservation may already be released or admitted */ }
      }
      throw cause;
    }
  }
  return { admitted, unresolved, calls, failures, stopLoss, attempts };
}

function demuxMatchesPack(
  pack: TransportPack,
  rawJson: string,
  members: readonly SemanticFillTask[]
): boolean {
  try {
    const drafts = parseOfficialApiSignals(rawJson);
    const mapped = drafts.map((draft) => {
      const locator = parseOfficialApiSourceLocator(draft.source_locator);
      const task = locator === null
        ? undefined
        : members.find((member) => member.assertionId === locator.assertion_id);
      return {
        semanticKey: task?.semanticKey,
        assertionId: locator?.assertion_id
      };
    });
    return demultiplexTransportPack(pack, mapped).rejections.length === 0;
  } catch {
    return false;
  }
}

function toAdmissionTask(task: SemanticFillTask): AdmissionTask {
  return {
    semanticKey: task.semanticKey,
    capability: task.capability,
    semanticContract: task.semanticContract,
    modelFamily: task.modelFamily,
    modelId: task.modelId,
    requestProfile: task.requestProfile,
    providerUrlSha256: task.providerUrlSha256,
    binding: task.binding,
    assertionId: task.assertionId
  };
}
