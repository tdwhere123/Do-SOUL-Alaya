import {
  readErrorMessage,
  SignalEventType,
  SignalState,
  SoulSignalMaterializedPayloadSchema,
  SoulSignalTriagedPayloadSchema,
  type CandidateMemorySignal,
  type EventLogEntry
} from "@do-soul/alaya-protocol";
import {
  buildSignalWarningMeta
} from "./signal-service-helpers.js";
import {
  buildSignalMaterializationEvent,
  completeDeferredMaterialization,
  completeSuccessfulSourceGroundingRedrive,
  recordFailedSourceGroundingRedrive
} from "./signal-service-grounding-defer.js";
import type {
  SignalMaterializationContext,
  SignalMaterializationFailureResult,
  SignalMaterializationResult,
  SignalServiceDependencies,
  SignalServicePostTriageMaterializer,
  SignalServiceReceiveResult,
  SignalServiceStateCasInput,
  SignalServiceWarnPort,
  SignalTriageResult
} from "./signal-service-types.js";
import { CoreError } from "../shared/errors.js";
import { bindEventPublisher } from "../runtime/event-publisher.js";

export interface MaterializationAttempt {
  readonly materializingSignal: CandidateMemorySignal;
  readonly materialization: SignalMaterializationResult;
  readonly caughtMaterializationError: boolean;
  readonly lostCompiledFence: boolean;
}

const INTERRUPTED_MATERIALIZATION_REASON = "materialization_interrupted";
const RESUMED_MATERIALIZATION_REASON = "resumed_from_materialization_audit";

export async function materializeAcceptedSignal(
  dependencies: SignalServiceDependencies,
  warn: SignalServiceWarnPort,
  triagedSignal: CandidateMemorySignal,
  triageResult: SignalTriageResult,
  context: SignalMaterializationContext,
  claimToken?: string
): Promise<SignalServiceReceiveResult> {
  const materializer = dependencies.postTriageMaterializer;
  if (materializer === undefined) {
    return {
      signal: triagedSignal,
      triage_result: triageResult,
      materialization: null
    };
  }

  const attempt = await runMaterializationAttempt(
    dependencies,
    warn,
    triagedSignal,
    materializer,
    context,
    claimToken !== undefined
  );
  if (attempt.lostCompiledFence) {
    return await resumeAfterLostCompiledFence(dependencies, warn, triagedSignal);
  }
  return await completeMaterializationAttempt(
    dependencies,
    warn,
    triagedSignal,
    triageResult,
    attempt,
    claimToken
  );
}

async function completeMaterializationAttempt(
  dependencies: SignalServiceDependencies,
  warn: SignalServiceWarnPort,
  triagedSignal: CandidateMemorySignal,
  triageResult: SignalTriageResult,
  attempt: MaterializationAttempt,
  claimToken?: string
): Promise<SignalServiceReceiveResult> {
  if (attempt.materialization.success !== true) {
    if (claimToken !== undefined) {
      return await recordFailedSourceGroundingRedrive({
        dependencies,
        warn,
        signal: attempt.materializingSignal,
        materialization: attempt.materialization,
        claimToken
      });
    }
    await appendMaterializationEvent(
      dependencies,
      triagedSignal,
      attempt.materialization
    );
    return await completeFailedMaterialization(dependencies, warn, triageResult, attempt);
  }

  if (attempt.materialization.target_kind === "deferred") {
    return await completeDeferredMaterialization({
      dependencies,
      warn,
      signal: attempt.materializingSignal,
      materialization: attempt.materialization,
      ...(claimToken === undefined ? {} : { claimToken })
    });
  }

  if (claimToken !== undefined) {
    return await completeSuccessfulSourceGroundingRedrive({
      dependencies,
      warn,
      signal: attempt.materializingSignal,
      materialization: attempt.materialization,
      claimToken
    });
  }
  await appendMaterializationEvent(
    dependencies,
    triagedSignal,
    attempt.materialization
  );
  return await completeSuccessfulMaterialization(dependencies, triageResult, attempt);
}

async function runMaterializationAttempt(
  dependencies: SignalServiceDependencies,
  warn: SignalServiceWarnPort,
  triagedSignal: CandidateMemorySignal,
  materializer: SignalServicePostTriageMaterializer,
  context: SignalMaterializationContext,
  alreadyClaimed: boolean
): Promise<MaterializationAttempt> {
  const materializingSignal = alreadyClaimed
    ? triagedSignal
    : claimCompiledFence(dependencies, triagedSignal);
  if (materializingSignal === null) {
    return {
      materializingSignal: triagedSignal,
      materialization: {
        signal_id: triagedSignal.signal_id,
        target_kind: "unknown",
        routing_reason: "compiled_fence_lost",
        created_objects: [],
        success: false,
        error: "Another receiver already owns compiled materialization."
      },
      caughtMaterializationError: true,
      lostCompiledFence: true
    };
  }

  try {
    return {
      materializingSignal,
      materialization: await materializer.materialize(materializingSignal, context),
      caughtMaterializationError: false,
      lostCompiledFence: false
    };
  } catch (error) {
    const materialization = {
      signal_id: triagedSignal.signal_id,
      target_kind: "evidence_only",
      routing_reason: "materialization_exception",
      created_objects: [],
      success: false,
      error: readErrorMessage(error, "Unknown materialization error")
    } satisfies SignalMaterializationFailureResult;

    warn(
      "Signal materialization failed.",
      buildSignalWarningMeta({
        phase: "materialization",
        code: "MATERIALIZER_THROW",
        detail: readErrorMessage(error, "Unknown materialization error")
      })
    );

    return {
      materializingSignal,
      materialization,
      caughtMaterializationError: true,
      lostCompiledFence: false
    };
  }
}

async function appendMaterializationEvent(
  dependencies: SignalServiceDependencies,
  triagedSignal: CandidateMemorySignal,
  materialization: SignalMaterializationResult
): Promise<EventLogEntry> {
  return await bindEventPublisher({
    eventLogRepo: dependencies.eventLogRepo,
    runtimeNotifier: dependencies.runtimeNotifier,
    purpose: "SignalService"
  }).publish(buildSignalMaterializationEvent(triagedSignal, materialization));
}

async function completeFailedMaterialization(
  dependencies: SignalServiceDependencies,
  warn: SignalServiceWarnPort,
  triageResult: SignalTriageResult,
  attempt: MaterializationAttempt
): Promise<SignalServiceReceiveResult> {
  const failedSignal = await completeCompiledTransition(
    dependencies,
    attempt.materializingSignal,
    SignalState.FAILED
  );

  if (!attempt.caughtMaterializationError) {
    warn(
      "Signal materialization returned unsuccessful result.",
      buildSignalWarningMeta({
        phase: "materialization",
        code: "MATERIALIZATION_UNSUCCESSFUL",
        detail: attempt.materialization.success
          ? attempt.materialization.routing_reason
          : attempt.materialization.error,
        itemCount: attempt.materialization.created_objects.length
      })
    );
  }

  return {
    signal: failedSignal,
    triage_result: triageResult,
    materialization: attempt.materialization
  };
}

async function completeSuccessfulMaterialization(
  dependencies: SignalServiceDependencies,
  triageResult: SignalTriageResult,
  attempt: MaterializationAttempt
): Promise<SignalServiceReceiveResult> {
  const materializedSignal = await completeCompiledTransition(
    dependencies,
    attempt.materializingSignal,
    SignalState.MATERIALIZED
  );

  return {
    signal: materializedSignal,
    triage_result: triageResult,
    materialization: attempt.materialization
  };
}

/**
 * COMPILED is the durable in-flight fence, claimed by CAS from TRIAGED or
 * DEFERRED. Resume must not call the materializer and must not invent FAILED
 * while that fence can still belong to a live owner.
 */
export async function resumeCompiledSignal(
  dependencies: SignalServiceDependencies,
  warn: SignalServiceWarnPort,
  existingSignal: CandidateMemorySignal
): Promise<SignalServiceReceiveResult> {
  const events = await dependencies.eventLogRepo.queryByEntity(
    "candidate_memory_signal",
    existingSignal.signal_id
  );
  const witness = latestApplicableTerminalWitness(events);
  if (witness?.kind === "materialized_success") {
    return {
      signal: await completeCompiledTransition(
        dependencies,
        existingSignal,
        SignalState.MATERIALIZED
      ),
      triage_result: "accepted",
      materialization: materializationFromAudit(existingSignal, witness.payload, true)
    };
  }
  if (witness?.kind === "materialized_failure") {
    return {
      signal: await completeCompiledTransition(dependencies, existingSignal, SignalState.FAILED),
      triage_result: "accepted",
      materialization: materializationFromAudit(existingSignal, witness.payload, false)
    };
  }

  warn(
    "Signal replay found a post-triage signal; not replaying materialization side effects.",
    buildSignalWarningMeta({
      phase: "signal_replay",
      code: "POST_TRIAGE_REPLAY_SKIPPED",
      detail: `${existingSignal.signal_id}:${existingSignal.signal_state}`
    })
  );
  return {
    signal: existingSignal,
    triage_result: "deferred",
    materialization: null
  };
}

export async function resumeFailedSignal(
  dependencies: SignalServiceDependencies,
  existingSignal: CandidateMemorySignal
): Promise<SignalServiceReceiveResult> {
  const events = await dependencies.eventLogRepo.queryByEntity(
    "candidate_memory_signal",
    existingSignal.signal_id
  );
  const witness = latestApplicableTerminalWitness(events);
  return {
    signal: existingSignal,
    triage_result: "accepted",
    materialization: witness?.kind === "materialized_failure"
      ? materializationFromAudit(existingSignal, witness.payload, false)
      : recoveredUnknownFailure(existingSignal)
  };
}

async function resumeAfterLostCompiledFence(
  dependencies: SignalServiceDependencies,
  warn: SignalServiceWarnPort,
  signal: CandidateMemorySignal
): Promise<SignalServiceReceiveResult> {
  const current = await dependencies.signalRepo.getById(signal.signal_id);
  if (current === null) {
    throw new CoreError("NOT_FOUND", `Signal ${signal.signal_id} was not found after compiled CAS.`)
  }
  if (current.signal_state === SignalState.COMPILED) {
    return await resumeCompiledSignal(dependencies, warn, current);
  }
  if (current.signal_state === SignalState.FAILED) {
    return await resumeFailedSignal(dependencies, current);
  }
  if (current.signal_state === SignalState.DEFERRED) {
    return {
      signal: current,
      triage_result: "deferred",
      materialization: null
    };
  }
  if (current.signal_state === SignalState.MATERIALIZED) {
    return {
      signal: current,
      triage_result: "accepted",
      materialization: null
    };
  }
  return {
    signal: current,
    triage_result: "deferred",
    materialization: null
  };
}

function claimCompiledFence(
  dependencies: SignalServiceDependencies,
  signal: CandidateMemorySignal
): CandidateMemorySignal | null {
  const compareAndSwap = requireCompareAndSwap(dependencies);
  return compareAndSwap({
    signalId: signal.signal_id,
    workspaceId: signal.workspace_id,
    expectedState: SignalState.TRIAGED,
    nextState: SignalState.COMPILED
  }) ?? compareAndSwap({
    signalId: signal.signal_id,
    workspaceId: signal.workspace_id,
    expectedState: SignalState.DEFERRED,
    nextState: SignalState.COMPILED
  });
}

async function completeCompiledTransition(
  dependencies: SignalServiceDependencies,
  signal: CandidateMemorySignal,
  nextState: typeof SignalState.MATERIALIZED | typeof SignalState.FAILED
): Promise<CandidateMemorySignal> {
  const swapped = requireCompareAndSwap(dependencies)({
    signalId: signal.signal_id,
    workspaceId: signal.workspace_id,
    expectedState: SignalState.COMPILED,
    nextState
  });
  if (swapped !== null) {
    return swapped;
  }
  const current = await dependencies.signalRepo.getById(signal.signal_id);
  if (current?.signal_state === nextState) {
    return current;
  }
  throw new CoreError(
    "CONFLICT",
    `Signal ${signal.signal_id} left compiled before ${nextState} could be committed.`,
    { subCode: "CONCURRENT_MODIFICATION" }
  );
}

function requireCompareAndSwap(
  dependencies: SignalServiceDependencies
): (input: SignalServiceStateCasInput) => CandidateMemorySignal | null {
  const compareAndSwapState = dependencies.signalRepo.compareAndSwapState;
  if (compareAndSwapState === undefined) {
    throw new CoreError("CONFLICT", "Signal materialization CAS port is not available", {
      subCode: "PORT_UNAVAILABLE"
    });
  }
  return (input) => compareAndSwapState.call(dependencies.signalRepo, input);
}

function recoveredUnknownFailure(
  signal: CandidateMemorySignal
): SignalMaterializationFailureResult {
  return {
    signal_id: signal.signal_id,
    target_kind: "unknown",
    routing_reason: INTERRUPTED_MATERIALIZATION_REASON,
    created_objects: [],
    success: false,
    error: "Compiled signal has no materialization result."
  };
}

function materializationFromAudit(
  signal: CandidateMemorySignal,
  payload: ReturnType<typeof SoulSignalMaterializedPayloadSchema.parse>,
  success: boolean
): SignalMaterializationResult {
  const fields = {
    signal_id: signal.signal_id,
    target_kind: "unknown" as const,
    routing_reason: RESUMED_MATERIALIZATION_REASON,
    created_objects: payload.created_objects
  };
  if (success) {
    return { ...fields, success: true };
  }
  return {
    ...fields,
    success: false,
    error: payload.error ?? "Compiled signal has no materialization result."
  };
}

type TerminalMaterializationWitness =
  | {
      readonly kind: "materialized_success" | "materialized_failure";
      readonly payload: ReturnType<typeof SoulSignalMaterializedPayloadSchema.parse>;
    }
  | { readonly kind: "deferred_triage" };

function latestApplicableTerminalWitness(
  events: readonly EventLogEntry[]
): TerminalMaterializationWitness | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined) continue;
    if (event.event_type === SignalEventType.SOUL_SIGNAL_TRIAGED) {
      const triaged = SoulSignalTriagedPayloadSchema.safeParse(event.payload_json);
      if (triaged.success && triaged.data.triage_result === "deferred") {
        // Historical write-path / source-grounding deferral is not the current
        // compiled attempt. A later materialized success (redrive) wins above.
        return { kind: "deferred_triage" };
      }
      continue;
    }
    if (
      event.event_type !== SignalEventType.SOUL_SIGNAL_MATERIALIZED &&
      event.event_type !== SignalEventType.SOUL_SIGNAL_MATERIALIZATION_FAILED
    ) {
      continue;
    }
    const parsed = SoulSignalMaterializedPayloadSchema.safeParse(event.payload_json);
    if (!parsed.success) continue;
    const success =
      event.event_type === SignalEventType.SOUL_SIGNAL_MATERIALIZED && parsed.data.success === true;
    return {
      kind: success ? "materialized_success" : "materialized_failure",
      payload: parsed.data
    };
  }
  return null;
}
