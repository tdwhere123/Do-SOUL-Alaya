import { createHash } from "node:crypto";
import {
  officialApiSemanticWorksetFromUnits,
  parseOfficialApiSignals,
  planOfficialApiTransport,
  type TransportPack
} from "@do-soul/alaya-soul";
import { admitProviderRaw, unwrapVerifiedSemanticArtifactAdmission, type AdmissionTask } from
  "../cache/semantic-artifact/admit.js";
import { semanticTaskIdentity } from
  "../cache/semantic-artifact/admission-identity.js";
import {
  admitSemanticArtifact,
  inspectSemanticArtifact,
  recordSourceBinding,
  releaseSemanticArtifactReservation,
  reserveSemanticArtifact
} from "../cache/semantic-artifact/store.js";
import { replayOfflineSemanticPack } from "./semantic-fill-envelope.js";
import type { PreparedSemanticFill } from "./semantic-fill-plan.js";
import { toWorkUnit } from "./semantic-fill-plan.js";
import type {
  SemanticFillAttempt,
  SemanticFillEnvelope,
  SemanticFillTask,
  SemanticFillTransport
} from "./semantic-fill-executor.js";
import type { ExtractionCacheWriteLease } from "./manifest/fill-root-guard.js";
import type { VerifiedSemanticReplayAuthority } from
  "../cache/semantic-artifact/replay-authority.js";
import type {
  SemanticFillAttemptLedger,
  SemanticFillDurableAttemptEvidence
} from "./semantic-fill-attempt-ledger.js";
import {
  sealVerifiedSemanticFillExecution,
  type VerifiedSemanticFillExecution
} from "./semantic-fill-execution-authority.js";

export interface SemanticFillExecutionState {
  calls: number;
  failures: number;
  admitted: number;
  unresolved: number;
  stopLoss: boolean;
  readonly attempts: SemanticFillAttempt[];
}

export type { VerifiedSemanticFillExecution } from
  "./semantic-fill-execution-authority.js";

type PendingPack = {
  readonly members: SemanticFillTask[];
  readonly requestMembers: SemanticFillTask[];
  readonly pack: TransportPack;
};
export type SemanticPackReservation = {
  readonly task: SemanticFillTask;
  readonly token: string;
};
type Reservation = SemanticPackReservation;

type ExecutionInput = Readonly<{
  root: string;
  envelope: SemanticFillEnvelope;
  transport: SemanticFillTransport;
  replayAuthority: VerifiedSemanticReplayAuthority;
  lease: ExtractionCacheWriteLease;
  prepared: PreparedSemanticFill;
  state: SemanticFillExecutionState;
  attemptLedger: SemanticFillAttemptLedger;
  signal?: AbortSignal;
}>;

export async function executeSemanticPacks(
  input: ExecutionInput
): Promise<VerifiedSemanticFillExecution> {
  const packs = durablePendingPacks(input);
  for (const pending of packs) {
    input.signal?.throwIfAborted();
    if (pending.members.length !== 0) {
      const existing = input.attemptLedger.attemptFor(pending.pack);
      if (stopLossReached(input.envelope, input.state) && existing === undefined) {
        markStopLoss(pending.members, input.state);
      } else {
        executeOnePack(input, pending, packs);
      }
    }
    await yieldToCancellation(input.signal);
  }
  return sealVerifiedSemanticFillExecution({
    tasks: Object.freeze([...input.prepared.demand]),
    attempts: Object.freeze(input.state.attempts.map((attempt) => Object.freeze({ ...attempt }))),
    uniqueUnits: input.prepared.uniqueUnits,
    occurrenceCount: input.prepared.occurrenceCount,
    bindingCount: input.prepared.bindingCount,
    calls: input.state.calls,
    failures: input.state.failures,
    ledgerScopeIdentity: input.attemptLedger.scopeIdentity,
    startingCacheIdentity: input.attemptLedger.startingCacheIdentity,
    startingOverlayIdentity: input.attemptLedger.startingOverlayIdentity
  });
}

async function yieldToCancellation(signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  signal?.throwIfAborted();
}

function durablePendingPacks(input: ExecutionInput): PendingPack[] {
  const pending = new Map(input.prepared.packs.flatMap(({ members }) =>
    members.map((task) => [task.semanticKey, task] as const)));
  const demand = new Map<string, SemanticFillTask>();
  for (const task of input.prepared.demand) {
    if (!demand.has(task.semanticKey)) demand.set(task.semanticKey, task);
  }
  const claimed = new Set<string>();
  const packs: PendingPack[] = [];
  for (const pack of input.attemptLedger.plans) {
    const requestMembers = pack.semantic_keys.flatMap((key) => {
      const task = demand.get(key);
      return task === undefined ? [] : [task];
    });
    if (requestMembers.length === 0) continue;
    const members = requestMembers.filter((task) => pending.has(task.semanticKey));
    for (const task of members) claimed.add(task.semanticKey);
    if (members.length > 0) packs.push({ pack, requestMembers, members });
  }
  for (const current of input.prepared.packs) {
    const members = current.members.filter((task) => !claimed.has(task.semanticKey));
    if (members.length > 0) packs.push({ pack: current.pack, requestMembers: members, members });
  }
  return packs;
}

function executeOnePack(
  input: ExecutionInput,
  pending: PendingPack,
  packs: PendingPack[]
): void {
  input.signal?.throwIfAborted();
  const reserved = reserveSemanticPack(input.root, pending.members, input.lease);
  const active = new Set(reserved);
  let attempt: SemanticFillDurableAttemptEvidence | undefined;
  try {
    input.signal?.throwIfAborted();
    const requestSha256 = requestIdentity(pending.pack, pending.requestMembers);
    attempt = input.attemptLedger.attemptFor(pending.pack);
    if (attempt === undefined) {
      attempt = input.attemptLedger.beginAttempt({
        pack: pending.pack, requestSha256, reservations: reserved
      });
      syncBudgetState(input);
    } else {
      attempt = input.attemptLedger.bindResumeReservations(attempt.ordinal, reserved);
    }
    if (attempt.response === undefined) {
      const result = replayOfflineSemanticPack(
        input.transport, pending.pack, pending.requestMembers
      );
      attempt = input.attemptLedger.sealResponse(attempt.ordinal, result);
      syncBudgetState(input);
    }
    input.lease.assertOwned();
    input.signal?.throwIfAborted();
    settleSealedResponse(input, pending, packs, attempt, reserved, active);
  } catch (cause) {
    throwAfterReservationCleanup(input.root, active, cause);
  }
}

function settleSealedResponse(
  input: ExecutionInput,
  pending: PendingPack,
  packs: PendingPack[],
  attempt: SemanticFillDurableAttemptEvidence,
  reserved: readonly Reservation[],
  active: Set<Reservation>
): void {
  const response = attempt.response;
  if (response === undefined) throw new Error("semantic transport attempt has no sealed response");
  if (response.kind === "size_failure") {
    releasePackAfterOutcome(input.root, reserved, active, response.reason);
    input.attemptLedger.completePack(attempt.ordinal);
    const retry = unresolvedRetryMembers(input.root, pending.members);
    if (retry.length > 0) {
      splitOrQuarantine(input, retry, response.reason, packs, attempt.ordinal);
    }
    return;
  }
  if (response.kind === "failure" || response.kind === "malformed_raw") {
    releasePackAfterOutcome(input.root, reserved, active, response.reason);
    markPack(reserved, "failed", response.reason, input.state, input.attemptLedger, attempt.ordinal);
    input.attemptLedger.completePack(attempt.ordinal);
    return;
  }
  try {
    parseOfficialApiSignals(response.rawUtf8);
  } catch (cause) {
    const reason = `parser drop: ${errorMessage(cause)}`;
    input.attemptLedger.markMalformedRaw(attempt.ordinal, reason);
    syncBudgetState(input);
    releasePackAfterOutcome(input.root, reserved, active, reason);
    markPack(reserved, "failed", reason, input.state, input.attemptLedger, attempt.ordinal);
    input.attemptLedger.completePack(attempt.ordinal);
    return;
  }
  admitPack(input, pending, reserved, active, response.rawUtf8, attempt);
  input.attemptLedger.completePack(attempt.ordinal);
}

function admitPack(
  input: ExecutionInput,
  pending: PendingPack,
  reserved: readonly Reservation[],
  active: Set<Reservation>,
  rawJson: string,
  attempt: SemanticFillDurableAttemptEvidence
): void {
  const sourceCorpusIdentity = pending.requestMembers[0]?.binding.sourceCorpusIdentity;
  if (sourceCorpusIdentity === undefined) throw new Error("cannot admit an empty semantic pack");
  const admissions = admitProviderRaw({
    root: input.root,
    rawJson,
    tasks: pending.requestMembers.map(toAdmissionTask),
    rawBinding: {
      packIdentity: pending.pack.pack_id,
      requestSha256: attempt.requestSha256,
      sourceCorpusIdentity,
      policyKind: pending.pack.policy_kind
    },
    replayAuthority: input.replayAuthority
  });
  const attemptOrdinal = attempt.ordinal;
  for (const held of reserved) {
    input.signal?.throwIfAborted();
    const admission = admissions.find((item) => item.semanticKey === held.task.semanticKey);
    if (admission === undefined || admission.kind === "unresolved") {
      const reason = admission?.kind === "unresolved" ? admission.reason : "unresolved";
      releasePackAfterOutcome(input.root, [held], active, reason);
      recordOutcome(input, attemptOrdinal, held, "unresolved", reason);
      continue;
    }
    admitSemanticArtifact({
      root: input.root,
      admission: admission.admission,
      reservationToken: held.token,
      expectedIdentity: held.task
    });
    active.delete(held);
    for (const binding of input.prepared.extraBindings.get(semanticTaskIdentity(held.task)) ?? []) {
      recordSourceBinding(input.root, held.task.semanticKey, held.task.capability, binding);
    }
    if (admission.kind === "quarantined") {
      recordOutcome(
        input,
        attemptOrdinal,
        held,
        "unresolved",
        unwrapVerifiedSemanticArtifactAdmission(admission.admission).quarantine_reason ??
          "quarantined provider result"
      );
    } else {
      input.state.admitted += 1;
      const outcome: SemanticFillAttempt = {
        semanticKey: held.task.semanticKey,
        capability: held.task.capability,
        outcome: "admitted"
      };
      input.state.attempts.push(outcome);
      input.attemptLedger.recordMemberOutcome(attemptOrdinal, outcome);
    }
  }
}

function splitOrQuarantine(
  input: ExecutionInput,
  members: readonly SemanticFillTask[],
  reason: string,
  packs: PendingPack[],
  attemptOrdinal: number
): void {
  if (members.length === 1) {
    const held = { task: members[0]!, token: "released" };
    recordOutcome(input, attemptOrdinal, held, "unresolved",
      `unpackable transport item: ${reason}`);
    return;
  }
  const midpoint = Math.ceil(members.length / 2);
  for (const split of [members.slice(0, midpoint), members.slice(midpoint)]) {
    const plan = planOfficialApiTransport(
      officialApiSemanticWorksetFromUnits(split.map(toWorkUnit)),
      input.envelope.transportPolicy
    );
    for (const unpackable of plan.unpackable) {
      const task = split.find((member) => member.semanticKey === unpackable.semanticKey);
      if (task !== undefined) {
        const outcome: SemanticFillAttempt = {
          semanticKey: task.semanticKey, capability: task.capability,
          outcome: "unresolved", reason: `unpackable transport item: ${unpackable.reason}`
        };
        input.state.unresolved += 1;
        input.state.attempts.push(outcome);
      }
    }
    for (const pack of plan.packs) {
      const byKey = new Map(split.map((task) => [task.semanticKey, task]));
      const requestMembers = pack.semantic_keys.map((key) => {
        const task = byKey.get(key);
        if (task === undefined) throw new Error("split pack lost a semantic task");
        return task;
      });
      packs.push({ pack, requestMembers, members: requestMembers });
    }
  }
}

export function reserveSemanticPack(
  root: string,
  members: readonly SemanticFillTask[],
  lease?: ExtractionCacheWriteLease
): readonly Reservation[] {
  const reserved: Reservation[] = [];
  try {
    for (const task of members) {
      reserved.push({
        task,
        token: reserveSemanticArtifact(root, task.semanticKey, task.capability, lease)
      });
    }
    return reserved;
  } catch (cause) {
    const releaseFailures = releaseReservations(root, [...reserved].reverse());
    if (releaseFailures.length > 0) {
      throw new AggregateError([asError(cause), ...releaseFailures],
        "semantic pack reservation rollback failed");
    }
    throw cause;
  }
}

function releasePack(
  root: string,
  reserved: readonly Reservation[],
  active: Set<Reservation>
): void {
  const failures: Error[] = [];
  for (const held of reserved) {
    if (!active.has(held)) continue;
    try {
      releaseSemanticArtifactReservation(
        root, held.task.semanticKey, held.task.capability, held.token
      );
      active.delete(held);
    } catch (cause) {
      failures.push(asError(cause));
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "semantic pack reservations failed to release");
  }
}

function releasePackAfterOutcome(
  root: string,
  reserved: readonly Reservation[],
  active: Set<Reservation>,
  primaryReason: string
): void {
  try {
    releasePack(root, reserved, active);
  } catch (releaseFailure) {
    throw new AggregateError(
      [new Error(primaryReason), asError(releaseFailure)],
      "semantic outcome and reservation release both failed"
    );
  }
}

function throwAfterReservationCleanup(
  root: string,
  active: Set<Reservation>,
  primary: unknown
): never {
  const failures = releaseReservations(root, [...active]);
  if (failures.length > 0) {
    throw new AggregateError(
      [asError(primary), ...failures],
      "semantic pack execution failed and reservation cleanup was incomplete"
    );
  }
  throw primary;
}

function releaseReservations(root: string, reservations: readonly Reservation[]): Error[] {
  const failures: Error[] = [];
  for (const held of reservations) {
    try {
      releaseSemanticArtifactReservation(
        root, held.task.semanticKey, held.task.capability, held.token
      );
    } catch (cause) {
      failures.push(asError(cause));
    }
  }
  return failures;
}

function markPack(
  reserved: readonly Reservation[],
  outcome: "unresolved" | "failed",
  reason: string,
  state: SemanticFillExecutionState,
  ledger: SemanticFillAttemptLedger,
  ordinal: number
): void {
  state.unresolved += reserved.length;
  for (const held of reserved) {
    const result: SemanticFillAttempt = {
      semanticKey: held.task.semanticKey,
      capability: held.task.capability,
      outcome,
      reason
    };
    state.attempts.push(result);
    ledger.recordMemberOutcome(ordinal, result);
  }
}

function recordOutcome(
  input: ExecutionInput,
  ordinal: number,
  held: Reservation,
  outcome: "unresolved" | "failed",
  reason: string
): void {
  input.state.unresolved += 1;
  const result: SemanticFillAttempt = {
    semanticKey: held.task.semanticKey,
    capability: held.task.capability,
    outcome,
    reason
  };
  input.state.attempts.push(result);
  input.attemptLedger.recordMemberOutcome(ordinal, result);
}

function syncBudgetState(input: ExecutionInput): void {
  const snapshot = input.attemptLedger.snapshot();
  input.state.calls = snapshot.calls;
  input.state.failures = snapshot.failures;
}

function stopLossReached(envelope: SemanticFillEnvelope, state: SemanticFillExecutionState): boolean {
  return state.stopLoss || state.calls >= envelope.maxCalls || state.failures >= envelope.maxFailures;
}

function markStopLoss(members: readonly SemanticFillTask[], state: SemanticFillExecutionState): void {
  state.stopLoss = true;
  state.unresolved += members.length;
  for (const task of members) {
    state.attempts.push({
      semanticKey: task.semanticKey,
      capability: task.capability,
      outcome: "unresolved",
      reason: "stop-loss"
    });
  }
}

function unresolvedRetryMembers(
  root: string,
  members: readonly SemanticFillTask[]
): readonly SemanticFillTask[] {
  return members.filter((task) => {
    const status = inspectSemanticArtifact(root, task.semanticKey, task.capability).status;
    return status !== "provider_backed";
  });
}

function requestIdentity(pack: TransportPack, members: readonly SemanticFillTask[]): string {
  return createHash("sha256").update(JSON.stringify({
    pack_id: pack.pack_id,
    source_corpus_identity: members[0]?.binding.sourceCorpusIdentity,
    source_authority: members[0]?.sourceAuthority,
    members: members.map((task) => ({
      semantic_key: task.semanticKey,
      assertion_id: task.assertionId,
      exact_text: task.text
    }))
  }), "utf8").digest("hex");
}

function toAdmissionTask(task: SemanticFillTask): AdmissionTask {
  return { ...task };
}
function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}
function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
