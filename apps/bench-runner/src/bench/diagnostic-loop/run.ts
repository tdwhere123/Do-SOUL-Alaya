import { join } from "node:path";
import {
  addAvoidedWork,
  dependencyManifest,
  emptyAvoidedWork,
  invalidateFromPhase,
  loadCompletedCheckpoints,
  writeCheckpointAtomic,
  checkpointPath,
  checkpointDigest
} from "./checkpoint.js";
import { DiagnosticLoopFailure, wrapPhaseError } from "./failures.js";
import { assertDiagnosticLoopIdentity } from "./identity.js";
import {
  isExpensivePhase,
  phasesForMode,
  SMOKE_LIMIT_CEILING,
  type DiagnosticLoopPhase
} from "./phases.js";
import { writeDiagnosticLoopReport } from "./report.js";
import { persistRunRecord } from "./run-state.js";
import { readSmokeGate, writeSmokeGate } from "./smoke-gate.js";
import type {
  DiagnosticLoopAdapters,
  DiagnosticLoopAvoidedWork,
  DiagnosticLoopCheckpoint,
  DiagnosticLoopPhaseResult,
  DiagnosticLoopRequest,
  DiagnosticLoopRunInput,
  DiagnosticLoopRunResult
} from "./types.js";
import {
  resolveDiagnosticLoopIdentity,
  resolvedDiagnosticLoopIdentityDigest,
  type ResolvedDiagnosticLoopIdentity
} from "./authority/identity.js";
import { assertCheckpointAuthorities } from "./authority/checkpoint.js";
import { withDiagnosticLoopRunLock } from "./authority/run-lock.js";
import { canaryUnlockRequired } from "./canary-unlock-policy.js";

export async function runDiagnosticLoop(
  input: DiagnosticLoopRunInput
): Promise<DiagnosticLoopRunResult> {
  return await withDiagnosticLoopRunLock(
    input.workRoot,
    async () => await runDiagnosticLoopLocked(input)
  );
}

async function runDiagnosticLoopLocked(
  input: DiagnosticLoopRunInput
): Promise<DiagnosticLoopRunResult> {
  assertDiagnosticLoopIdentity(input.request);
  assertSmokeLimit(input);
  const resolvedIdentity = await resolveDiagnosticLoopIdentity(input.request);
  if (canaryUnlockRequired(input.request)) {
    const { assertCanaryDiagnosticUnlock } = await import("./canary-unlock-admission.js");
    await assertCanaryDiagnosticUnlock({
      unlockWorkRoot: input.canaryUnlockPath,
      currentRequest: input.request,
      currentIdentity: resolvedIdentity
    });
  }
  const identityDigest = persistRunRecord({
    workRoot: input.workRoot,
    identity: resolvedIdentity,
    mode: input.mode,
    argv: input.argv
  });
  if (input.fromPhase !== undefined) {
    invalidateFromPhase(input.workRoot, input.fromPhase);
  }
  const checkpoints = loadCompletedCheckpoints(input.workRoot, identityDigest);
  await assertCheckpointAuthorities(input.request, resolvedIdentity, checkpoints);
  const avoided = emptyAvoidedWork();
  const skipped: DiagnosticLoopPhase[] = [];
  const completed: DiagnosticLoopPhase[] = [];
  try {
    await executePhases({
      input, identityDigest, initialIdentity: resolvedIdentity,
      checkpoints, avoided, skipped, completed
    });
    if (input.mode === "smoke") {
      writeSmokeGate({
        workRoot: input.workRoot,
        status: "passed",
        identityDigest
      });
    }
    return {
      identityDigest,
      completedPhases: completed,
      skippedPhases: skipped,
      avoidedWork: avoided,
      reportPath: join(input.workRoot, "report.json"),
      smokeGate: readSmokeGate(input.workRoot)
    };
  } catch (error) {
    return failRun(input, identityDigest, error);
  }
}

async function executePhases(state: PhaseRunState): Promise<void> {
  for (const phase of phasesForMode(state.input.mode)) {
    await assertPhaseBoundary(state);
    assertSmokeAllowsPhase(state.input, phase);
    const existing = state.checkpoints.get(phase);
    if (existing !== undefined) {
      recordSkip(state, phase, existing);
      continue;
    }
    const result = await runPhase(state, phase);
    await assertPhaseBoundary(state);
    const checkpoint = toCheckpoint(state, phase, result);
    await assertProducedCheckpoint(state, phase, checkpoint);
    writeCheckpointAtomic(checkpointPath(state.input.workRoot, phase), checkpoint);
    state.checkpoints.set(phase, checkpoint);
    state.completed.push(phase);
    Object.assign(state.avoided, addAvoidedWork(state.avoided, result.avoidedWork));
  }
}

async function assertPhaseBoundary(state: PhaseRunState): Promise<void> {
  const current = await resolveDiagnosticLoopIdentity(state.input.request);
  if (resolvedDiagnosticLoopIdentityDigest(current) !==
      resolvedDiagnosticLoopIdentityDigest(state.initialIdentity)) {
    throw new Error("diagnostic-loop authority changed between phases");
  }
  await assertCheckpointAuthorities(state.input.request, current, state.checkpoints);
}

async function assertProducedCheckpoint(
  state: PhaseRunState,
  phase: DiagnosticLoopPhase,
  checkpoint: DiagnosticLoopCheckpoint
): Promise<void> {
  const candidate = new Map(state.checkpoints);
  candidate.set(phase, checkpoint);
  const current = await resolveDiagnosticLoopIdentity(state.input.request);
  await assertCheckpointAuthorities(state.input.request, current, candidate);
}

async function runPhase(
  state: PhaseRunState,
  phase: DiagnosticLoopPhase
): Promise<DiagnosticLoopPhaseResult> {
  try {
    if (phase === "report") {
      return writeDiagnosticLoopReport({
        workRoot: state.input.workRoot,
        identity: state.input.request,
        identityDigest: state.identityDigest,
        checkpoints: state.checkpoints,
        avoidedWork: state.avoided,
        skippedPhases: state.skipped
      });
    }
    return await state.input.adapters[phase]({
      workRoot: state.input.workRoot,
      request: state.input.request,
      mode: state.input.mode,
      checkpoints: state.checkpoints
    });
  } catch (error) {
    throw wrapPhaseError({
      phase,
      mode: state.input.mode,
      workRoot: state.input.workRoot,
      argv: state.input.argv,
      request: state.input.request,
      error
    });
  }
}

function recordSkip(
  state: PhaseRunState,
  phase: DiagnosticLoopPhase,
  existing: DiagnosticLoopCheckpoint
): void {
  state.skipped.push(phase);
  Object.assign(state.avoided, addAvoidedWork(state.avoided, {
    phasesSkipped: 1,
    ...skipAvoidedWork(phase, state.input.request, existing)
  }));
}

function skipAvoidedWork(
  phase: DiagnosticLoopPhase,
  request: DiagnosticLoopRequest,
  existing: DiagnosticLoopCheckpoint
): Partial<DiagnosticLoopAvoidedWork> {
  if (phase === "extraction") {
    return { providerCallsAvoided: request.requestedKeys.length };
  }
  if (phase === "snapshot") return { snapshotsReused: 1 };
  if (phase === "control_recall" || phase === "treatment_recall") {
    return { questionsSkipped: request.limit ?? request.requestedKeys.length };
  }
  return existing.avoided_work;
}

function toCheckpoint(
  state: PhaseRunState,
  phase: DiagnosticLoopPhase,
  result: DiagnosticLoopPhaseResult
): DiagnosticLoopCheckpoint {
  if (result.noProviderCallReceipt === undefined) {
    throw new Error(`diagnostic-loop phase ${phase} omitted no-provider-call receipt`);
  }
  const checkpoint: Omit<DiagnosticLoopCheckpoint, "checkpoint_digest"> = {
    schema_version: 3,
    kind: "diagnostic_loop_checkpoint",
    phase,
    status: "completed",
    identity_digest: state.identityDigest,
    content_identity: result.contentIdentity,
    depends_on: dependencyManifest(state.checkpoints),
    physical_calls: result.physicalCalls,
    avoided_work: addAvoidedWork(emptyAvoidedWork(), result.avoidedWork),
    artifact_paths: result.artifactPaths,
    details: {
      ...(result.details ?? {}),
      no_provider_call_receipt: result.noProviderCallReceipt
    },
    completed_at: state.input.now?.() ?? new Date().toISOString()
  };
  return { ...checkpoint, checkpoint_digest: checkpointDigest(checkpoint) };
}

function assertSmokeLimit(input: DiagnosticLoopRunInput): void {
  if (input.mode !== "smoke") return;
  const limit = input.request.limit ?? input.request.requestedKeys.length;
  if (limit > SMOKE_LIMIT_CEILING) {
    throw new Error(
      `smoke mode limit ${limit} exceeds ceiling ${SMOKE_LIMIT_CEILING}`
    );
  }
}

function assertSmokeAllowsPhase(
  input: DiagnosticLoopRunInput,
  phase: DiagnosticLoopPhase
): void {
  if (input.mode === "report-only" || input.mode === "smoke") return;
  if (!isExpensivePhase(phase)) return;
  if (readSmokeGate(input.workRoot) !== "failed") return;
  throw new DiagnosticLoopFailure({
    phase,
    classification: "infrastructure",
    message: "failed smoke gate blocks expensive fill or A/B work",
    resumeCommand: `alaya-bench-runner diagnostic-loop --work-root ${input.workRoot} --mode smoke`
  });
}

function failRun(
  input: DiagnosticLoopRunInput,
  identityDigest: string,
  error: unknown
): never {
  if (input.mode === "smoke") {
    const phase = error instanceof DiagnosticLoopFailure ? error.phase : "preflight";
    writeSmokeGate({
      workRoot: input.workRoot,
      status: "failed",
      identityDigest,
      failedPhase: phase
    });
  }
  throw error instanceof DiagnosticLoopFailure
    ? error
    : wrapPhaseError({
      phase: "preflight",
      mode: input.mode,
      workRoot: input.workRoot,
      argv: input.argv,
      request: input.request,
      error
    });
}

interface PhaseRunState {
  readonly input: DiagnosticLoopRunInput;
  readonly identityDigest: string;
  readonly initialIdentity: ResolvedDiagnosticLoopIdentity;
  readonly checkpoints: Map<DiagnosticLoopPhase, DiagnosticLoopCheckpoint>;
  readonly avoided: DiagnosticLoopAvoidedWork;
  readonly skipped: DiagnosticLoopPhase[];
  readonly completed: DiagnosticLoopPhase[];
}

export function sharedSubstrateIdentities(
  context: { readonly checkpoints: ReadonlyMap<DiagnosticLoopPhase, DiagnosticLoopCheckpoint> }
): { readonly cache_identity: string; readonly snapshot_identity: string } {
  return {
    cache_identity: context.checkpoints.get("extraction")?.content_identity ?? "",
    snapshot_identity: context.checkpoints.get("snapshot")?.content_identity ?? ""
  };
}

export type { DiagnosticLoopAdapters };
