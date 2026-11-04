import {
  readErrorMessage, SignalState, type CandidateMemorySignal
} from "@do-soul/alaya-protocol";
import { buildSignalWarningMeta } from "./signal-service-helpers.js";
import {
  completeDeferredMaterialization,
  completeSuccessfulSourceGroundingRedrive,
  recordFailedSourceGroundingRedrive
} from "./signal-service-grounding-defer.js";
import type {
  SignalMaterializationContext, SignalMaterializationResult, SignalServiceDependencies,
  SignalServiceReceiveResult, SignalServiceWarnPort, SignalTriageResult
} from "./signal-service-types.js";
import { commitSignalMaterializationOutcome, requireSignalStateCas } from "./signal-materialization-outcome.js";
import { CoreError } from "../shared/errors.js";
export { resumeCompiledSignal, resumeFailedSignal } from "./signal-materialization-recovery.js";
import { resumeCompiledSignal, resumeFailedSignal } from "./signal-materialization-recovery.js";

export async function materializeAcceptedSignal(
  dependencies: SignalServiceDependencies,
  warn: SignalServiceWarnPort,
  signal: CandidateMemorySignal,
  triageResult: SignalTriageResult,
  context: SignalMaterializationContext,
  claimToken?: string
): Promise<SignalServiceReceiveResult> {
  const materializer = dependencies.postTriageMaterializer;
  if (materializer === undefined) return { signal, triage_result: triageResult, materialization: null };
  if (claimToken === undefined && signal.signal_state !== SignalState.TRIAGED && signal.signal_state !== SignalState.DEFERRED) {
    throw new CoreError("CONFLICT", "Materialization requires an unclaimed triaged or eligible deferred signal.");
  }
  // The source-grounding redrive has its own durable claim and stays DEFERRED.
  const claimed = claimToken !== undefined ? signal : requireSignalStateCas(dependencies)({
    signalId: signal.signal_id, workspaceId: signal.workspace_id,
    expectedState: signal.signal_state, nextState: SignalState.COMPILED
  });
  if (claimed === null) return await resumeLostClaim(dependencies, warn, signal);

  let result: SignalMaterializationResult;
  try {
    result = await materializer.materialize(claimed, context);
  } catch (error) {
    result = {
      signal_id: signal.signal_id, target_kind: "unknown", routing_reason: "materialization_exception",
      created_objects: [], success: false, error: readErrorMessage(error, "Unknown materialization error")
    };
    warn("Signal materialization failed.", buildSignalWarningMeta({
      phase: "materialization", code: "MATERIALIZER_THROW", detail: result.error
    }));
  }
  if (claimToken !== undefined && !result.success) {
    return await recordFailedSourceGroundingRedrive({ dependencies, warn, signal: claimed,
      materialization: result, claimToken });
  }
  if (result.success && result.target_kind === "deferred") {
    return await completeDeferredMaterialization({ dependencies, warn, signal: claimed,
      materialization: result, ...(claimToken === undefined ? {} : { claimToken }) });
  }
  if (claimToken !== undefined) {
    return await completeSuccessfulSourceGroundingRedrive({ dependencies, warn, signal: claimed,
      materialization: result, claimToken });
  }
  if (!result.success && result.routing_reason !== "materialization_exception") {
    warn("Signal materialization returned unsuccessful result.", buildSignalWarningMeta({
      phase: "materialization", code: "MATERIALIZATION_UNSUCCESSFUL",
      detail: result.error, itemCount: result.created_objects.length
    }));
  }
  return await commitSignalMaterializationOutcome(dependencies, claimed, result);
}

async function resumeLostClaim(
  dependencies: SignalServiceDependencies,
  warn: SignalServiceWarnPort,
  signal: CandidateMemorySignal
): Promise<SignalServiceReceiveResult> {
  const current = await dependencies.signalRepo.getById(signal.signal_id);
  if (current?.signal_state === SignalState.COMPILED) return await resumeCompiledSignal(dependencies, warn, current);
  if (current?.signal_state === SignalState.FAILED) return await resumeFailedSignal(dependencies, current);
  return { signal: current ?? signal,
    triage_result: current?.signal_state === SignalState.MATERIALIZED ? "accepted" : "deferred",
    materialization: null };
}
