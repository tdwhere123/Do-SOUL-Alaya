import {
  readErrorMessage,
  SignalState,
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

export interface MaterializationAttempt {
  readonly materializingSignal: CandidateMemorySignal;
  readonly materialization: SignalMaterializationResult;
  readonly caughtMaterializationError: boolean;
}

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
    const matEvent = await appendMaterializationEvent(
      dependencies,
      triagedSignal,
      attempt.materialization
    );
    return await completeFailedMaterialization(dependencies, warn, triageResult, attempt, matEvent);
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
  const matEvent = await appendMaterializationEvent(
    dependencies,
    triagedSignal,
    attempt.materialization
  );
  return await completeSuccessfulMaterialization(dependencies, triageResult, attempt, matEvent);
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
  return await dependencies.eventLogRepo.append(
    buildSignalMaterializationEvent(triagedSignal, materialization)
  );
}

async function completeFailedMaterialization(
  dependencies: SignalServiceDependencies,
  warn: SignalServiceWarnPort,
  triageResult: SignalTriageResult,
  attempt: MaterializationAttempt,
  matEvent: EventLogEntry
): Promise<SignalServiceReceiveResult> {
  const failedSignal = await dependencies.signalRepo.updateState(
    attempt.materializingSignal.signal_id,
    SignalState.FAILED
  );
  await notifyRunBoundEvent(dependencies, matEvent);

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
  attempt: MaterializationAttempt,
  matEvent: EventLogEntry
): Promise<SignalServiceReceiveResult> {
  const materializedSignal = await dependencies.signalRepo.updateState(
    attempt.materializingSignal.signal_id,
    SignalState.MATERIALIZED
  );
  await notifyRunBoundEvent(dependencies, matEvent);

  return {
    signal: materializedSignal,
    triage_result: triageResult,
    materialization: attempt.materialization
  };
}

async function notifyRunBoundEvent(
  dependencies: SignalServiceDependencies,
  event: EventLogEntry
): Promise<void> {
  if (event.run_id !== null) {
    await dependencies.runtimeNotifier.notifyEntry(event);
  }
}
