import {
  officialApiSemanticWorksetFromUnits,
  planOfficialApiTransport,
  type TransportPack
} from "@do-soul/alaya-soul";
import {
  inspectSemanticArtifact,
  reclaimAbandonedReservation,
  recordSourceBinding
} from "../cache/semantic-artifact/store.js";
import { inspectCurrentOrReplayDerived, materializeDerivedReplayFromRaw } from
  "../cache/semantic-artifact/derived-replay.js";
import {
  assertSemanticArtifactCompatibility,
  semanticTaskIdentity
} from "../cache/semantic-artifact/admission-identity.js";
import type { SemanticArtifactSourceBinding } from
  "../cache/semantic-artifact/contract.js";
import type { SemanticTransportPolicy } from "./semantic-fill-envelope.js";
import type { SemanticFillAttempt, SemanticFillTask } from "./semantic-fill-executor.js";
import type { ExtractionCacheWriteLease } from "./manifest/fill-root-guard.js";

export interface PreparedSemanticFill {
  readonly demand: readonly SemanticFillTask[];
  readonly packs: { readonly members: SemanticFillTask[]; readonly pack: TransportPack }[];
  readonly extraBindings: ReadonlyMap<string, readonly SemanticArtifactSourceBinding[]>;
  readonly unresolved: number;
  readonly uniqueUnits: number;
  readonly occurrenceCount: number;
  readonly bindingCount: number;
}

export function prepareSemanticFill(
  root: string,
  tasks: readonly SemanticFillTask[],
  attempts: SemanticFillAttempt[],
  policy: SemanticTransportPolicy,
  lease: ExtractionCacheWriteLease
): PreparedSemanticFill {
  const { unique, extraBindings } = deduplicateTasks(tasks);
  const pending: SemanticFillTask[] = [];
  let unresolved = 0;
  const pathCounts = new Map<string, number>();
  for (const task of unique) {
    const pathIdentity = `${task.semanticKey}\u0000${task.capability}`;
    pathCounts.set(pathIdentity, (pathCounts.get(pathIdentity) ?? 0) + 1);
  }
  for (const task of unique) {
    const identity = semanticTaskIdentity(task);
    if (pathCounts.get(`${task.semanticKey}\u0000${task.capability}`) !== 1) {
      attempts.push({
        semanticKey: task.semanticKey, capability: task.capability,
        outcome: "unresolved", reason: "semantic path has incompatible task identities"
      });
      unresolved += 1;
      continue;
    }
    const state = classifyTask(root, task, attempts, extraBindings.get(identity) ?? [], lease);
    if (state === "pending") pending.push(task);
    if (state === "unresolved") unresolved += 1;
  }
  const planned = planPacks(pending, policy, attempts);
  return {
    demand: Object.freeze([...tasks]),
    packs: planned.packs,
    extraBindings,
    unresolved: unresolved + planned.unpackable,
    uniqueUnits: unique.length,
    occurrenceCount: tasks.length,
    bindingCount: tasks.length
  };
}

function classifyTask(
  root: string,
  task: SemanticFillTask,
  attempts: SemanticFillAttempt[],
  extraBindings: readonly SemanticArtifactSourceBinding[],
  lease: ExtractionCacheWriteLease
): "pending" | "handled" | "unresolved" {
  let existing = inspectCurrentOrReplayDerived(root, task);
  if (existing.status === "missing") {
    try {
      const artifact = materializeDerivedReplayFromRaw({ root, task, lease });
      existing = { status: artifact.admission_state, artifact };
    } catch (cause) {
      if (!(cause instanceof Error && /derived replay requires persisted raw/u.test(cause.message))) {
        throw cause;
      }
    }
  }
  if ((existing.status === "provider_backed") &&
      existing.artifact !== undefined) {
    try {
      assertSemanticArtifactCompatibility(task, existing.artifact, false);
    } catch (cause) {
      attempts.push({
        semanticKey: task.semanticKey, capability: task.capability, outcome: "unresolved",
        reason: cause instanceof Error ? cause.message : String(cause)
      });
      return "unresolved";
    }
    recordSourceBinding(root, task.semanticKey, task.capability, task.binding);
    for (const binding of extraBindings) {
      recordSourceBinding(root, task.semanticKey, task.capability, binding);
    }
    attempts.push({ semanticKey: task.semanticKey, capability: task.capability, outcome: "skipped" });
    return "handled";
  }
  if (existing.status === "reserved") {
    reclaimAbandonedReservation(root, task.semanticKey, task.capability, lease);
    existing = inspectCurrentOrReplayDerived(root, task);
    if (existing.status === "missing") {
      try {
        const artifact = materializeDerivedReplayFromRaw({ root, task, lease });
        existing = { status: artifact.admission_state, artifact };
      } catch (cause) {
        if (!(cause instanceof Error && /derived replay requires persisted raw/u.test(cause.message))) {
          throw cause;
        }
      }
    }
  }
  if (existing.status === "missing") return "pending";
  if (existing.status === "quarantined") {
    attempts.push({
      semanticKey: task.semanticKey,
      capability: task.capability,
      outcome: "unresolved",
      reason: existing.reason ?? "quarantined provider result"
    });
    return "handled";
  }
  attempts.push({
    semanticKey: task.semanticKey,
    capability: task.capability,
    outcome: "unresolved",
    reason: existing.status === "reserved" ? "reservation held" : existing.reason ?? existing.status
  });
  return "unresolved";
}

function deduplicateTasks(tasks: readonly SemanticFillTask[]): {
  readonly unique: SemanticFillTask[];
  readonly extraBindings: Map<string, SemanticArtifactSourceBinding[]>;
} {
  const extraBindings = new Map<string, SemanticArtifactSourceBinding[]>();
  const unique: SemanticFillTask[] = [];
  for (const task of tasks) {
    const id = semanticTaskIdentity(task);
    const extras = extraBindings.get(id);
    if (extras !== undefined) {
      extras.push(task.binding);
    } else {
      extraBindings.set(id, []);
      unique.push(task);
    }
  }
  return { unique, extraBindings };
}

function planPacks(
  tasks: readonly SemanticFillTask[],
  policy: SemanticTransportPolicy,
  attempts: SemanticFillAttempt[]
): { readonly packs: PreparedSemanticFill["packs"]; readonly unpackable: number } {
  const packs: { members: SemanticFillTask[]; pack: TransportPack }[] = [];
  const byCorpus = new Map<string, SemanticFillTask[]>();
  let unpackable = 0;
  for (const task of tasks) {
    const group = byCorpus.get(task.binding.sourceCorpusIdentity) ?? [];
    group.push(task);
    byCorpus.set(task.binding.sourceCorpusIdentity, group);
  }
  for (const group of byCorpus.values()) {
    const planned = planOfficialApiTransport(
      officialApiSemanticWorksetFromUnits(group.map(toWorkUnit)), policy
    );
    const byKey = new Map(group.map((task) => [task.semanticKey, task]));
    for (const item of planned.unpackable) {
      const task = byKey.get(item.semanticKey);
      if (task === undefined) continue;
      unpackable += 1;
      attempts.push({
        semanticKey: task.semanticKey, capability: task.capability,
        outcome: "unresolved", reason: `unpackable transport item: ${item.reason}`
      });
    }
    for (const pack of planned.packs) {
      const members = pack.semantic_keys.map((key) => {
        const task = byKey.get(key);
        if (task === undefined) throw new Error("transport pack referenced a missing fill task");
        return task;
      });
      if (members.length > 0) packs.push({ pack, members });
    }
  }
  return { packs, unpackable };
}

export function toWorkUnit(task: SemanticFillTask) {
  return {
    semanticKey: task.semanticKey,
    assertionId: task.assertionId,
    text: task.text,
    sourceCorpus: task.sourceCorpus,
    semanticIdentity: task.semanticIdentity,
    binding: task.binding
  };
}
