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
  SignalServiceWarnPort,
  SignalTriageResult
} from "./signal-service-types.js";
import { bindEventPublisher } from "../runtime/event-publisher.js";

export interface MaterializationAttempt {
  readonly materializingSignal: CandidateMemorySignal;
  readonly materialization: SignalMaterializationResult;
  readonly caughtMaterializationError: boolean;
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
    : await dependencies.signalRepo.updateState(triagedSignal.signal_id, SignalState.COMPILED);

  try {
    return {
      materializingSignal,
      materialization: await materializer.materialize(materializingSignal, context),
      caughtMaterializationError: false
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
      caughtMaterializationError: true
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
  const failedSignal = await dependencies.signalRepo.updateState(
    attempt.materializingSignal.signal_id,
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
  const materializedSignal = await dependencies.signalRepo.updateState(
    attempt.materializingSignal.signal_id,
    SignalState.MATERIALIZED
  );

  return {
    signal: materializedSignal,
    triage_result: triageResult,
    materialization: attempt.materialization
  };
}

/**
 * COMPILED means the materializer may already have started. Resume from the
 * signal's EventLog instead of calling it again.
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
  if (events.some(isDeferredTriageEvent)) {
    const deferred = await dependencies.signalRepo.updateState(
      existingSignal.signal_id,
      SignalState.DEFERRED
    );
    return {
      signal: deferred,
      triage_result: "deferred",
      materialization: null
    };
  }

  const audit = latestMaterializationAudit(events);
  if (audit !== null && audit.success) {
    const materialized = await dependencies.signalRepo.updateState(
      existingSignal.signal_id,
      SignalState.MATERIALIZED
    );
    return {
      signal: materialized,
      triage_result: "accepted",
      materialization: materializationFromAudit(existingSignal, audit.payload, true)
    };
  }
  if (audit !== null) {
    const failed = await dependencies.signalRepo.updateState(
      existingSignal.signal_id,
      SignalState.FAILED
    );
    return {
      signal: failed,
      triage_result: "accepted",
      materialization: materializationFromAudit(existingSignal, audit.payload, false)
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
  const interrupted = interruptedMaterialization(existingSignal);
  await appendMaterializationEvent(dependencies, existingSignal, interrupted);
  return await completeFailedMaterialization(dependencies, warn, "accepted", {
    materializingSignal: existingSignal,
    materialization: interrupted,
    caughtMaterializationError: true
  });
}

export async function resumeFailedSignal(
  dependencies: SignalServiceDependencies,
  existingSignal: CandidateMemorySignal
): Promise<SignalServiceReceiveResult> {
  const events = await dependencies.eventLogRepo.queryByEntity(
    "candidate_memory_signal",
    existingSignal.signal_id
  );
  const audit = latestMaterializationAudit(events);
  return {
    signal: existingSignal,
    triage_result: "accepted",
    materialization: audit === null || audit.success
      ? interruptedMaterialization(existingSignal)
      : materializationFromAudit(existingSignal, audit.payload, false)
  };
}

function interruptedMaterialization(
  signal: CandidateMemorySignal
): SignalMaterializationFailureResult {
  return {
    signal_id: signal.signal_id,
    target_kind: "evidence_only",
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
    target_kind: "evidence_only" as const,
    routing_reason: success ? RESUMED_MATERIALIZATION_REASON : INTERRUPTED_MATERIALIZATION_REASON,
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

function latestMaterializationAudit(events: readonly EventLogEntry[]): {
  readonly success: boolean;
  readonly payload: ReturnType<typeof SoulSignalMaterializedPayloadSchema.parse>;
} | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined) continue;
    if (
      event.event_type !== SignalEventType.SOUL_SIGNAL_MATERIALIZED &&
      event.event_type !== SignalEventType.SOUL_SIGNAL_MATERIALIZATION_FAILED
    ) {
      continue;
    }
    const parsed = SoulSignalMaterializedPayloadSchema.safeParse(event.payload_json);
    if (!parsed.success) continue;
    return {
      success:
        event.event_type === SignalEventType.SOUL_SIGNAL_MATERIALIZED && parsed.data.success === true,
      payload: parsed.data
    };
  }
  return null;
}

function isDeferredTriageEvent(event: EventLogEntry): boolean {
  if (event.event_type !== SignalEventType.SOUL_SIGNAL_TRIAGED) {
    return false;
  }
  const parsed = SoulSignalTriagedPayloadSchema.safeParse(event.payload_json);
  return parsed.success && parsed.data.triage_result === "deferred";
}
