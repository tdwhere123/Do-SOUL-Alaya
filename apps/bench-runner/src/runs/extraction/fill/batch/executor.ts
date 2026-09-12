import type { GeminiBatchInvocation, GeminiBatchJob, GeminiBatchState } from "./contract.js";
import { resourceName } from "./native-codec.js";
import { importBatchJob } from "./import.js";
import { batchDigest, canonicalBatchPlan, encodeGeminiBatchLines } from "./plan.js";
import { openBatchState, publishArtifact, readRootBatchRuns, saveBatchState } from "./store.js";
import { applyRemoteOperation, assertRemoteBatchBinding, batchRemoteWitness, terminalBatchStates as terminal } from "./remote-operation.js";

export async function executeGeminiBatchOperation(invocation: GeminiBatchInvocation): Promise<GeminiBatchState> {
  const input = { ...invocation, plan: canonicalBatchPlan(invocation.plan) };
  input.signal?.throwIfAborted();
  input.lease.assertRoot(input.root);
  input.lease.assertOwned();
  const state = openBatchState({
    plan: input.plan, endpoint: input.http.endpoint, lease: input.lease,
    prepare: input.operation === "prepare"
  });
  for (const job of state.jobs) {
    const wire = encodeGeminiBatchLines(linesFor(input, job), input.plan);
    if (batchDigest(wire) !== job.inputSha256) throw new Error("Batch input binding mismatch");
    publishArtifact(input.lease, `batch-input-${job.id}.jsonl`, wire);
  }
  if (input.reconcile !== undefined) await reconcile(input, state);
  for (const job of state.jobs) {
    input.signal?.throwIfAborted();
    input.lease.assertOwned();
    if (input.operation === "cancel") await cancel(input, state, job);
    else if (input.operation === "status" || input.operation === "resume") {
      await poll(input, state, job);
    }
    if (input.operation === "submit") await submit(input, state, job);
    if (input.operation === "import" || input.operation === "resume") {
      await importBatchJob(input, state, job);
    }
  }
  return structuredClone(state);
}

async function submit(input: GeminiBatchInvocation, state: GeminiBatchState, job: GeminiBatchJob): Promise<void> {
  if (!["prepared", "uploading", "uploaded"].includes(job.status) || job.cancelRequested) return;
  const rootJobs = readRootBatchRuns(input.lease).flatMap((run) => run.state.jobs);
  if (rootJobs.some((other) => other.status === "submission_unknown")) {
    throw new Error("Batch submission is unknown; reconcile before further dispatch");
  }
  assertDispatchBudget(input, rootJobs, job);
  const lines = linesFor(input, job);
  if (job.inputFile === undefined) {
    job.status = "uploading";
    saveBatchState(input.lease, input.plan, state);
    job.inputFile = resourceName(await input.http.upload(
      encodeGeminiBatchLines(lines, input.plan), job.displayName, input.signal
    ), "files");
    input.lease.assertOwned();
    job.status = "uploaded";
    saveBatchState(input.lease, input.plan, state);
  }
  input.signal?.throwIfAborted();
  // Intent precedes even authority reservation: a partially committed reservation
  // cannot be blindly repeated after a crash. Creation itself is non-idempotent.
  job.status = "submission_unknown";
  job.submittedAt = Date.now();
  saveBatchState(input.lease, input.plan, state);
  try {
    const ordinals = await input.reserveSubmission(lines, job.costBoundUsd);
    if (ordinals !== undefined) {
      if (JSON.stringify(Object.keys(ordinals).sort()) !== JSON.stringify([...job.lineKeys].sort()) ||
          !Object.values(ordinals).every((ordinal) => Number.isSafeInteger(ordinal) && ordinal > 0) ||
          new Set(Object.values(ordinals)).size !== job.lineKeys.length) {
        throw new Error("Batch submission attempt bindings are invalid");
      }
      job.attemptOrdinals = Object.freeze({ ...ordinals });
      publishArtifact(input.lease, `batch-attempts-${job.id}.json`, JSON.stringify({
        jobId: job.id, planIdentity: input.plan.identity, inputSha256: job.inputSha256,
        attemptOrdinals: job.attemptOrdinals
      }));
      saveBatchState(input.lease, input.plan, state);
    }
    if (input.recordLineOutcome !== undefined && job.attemptOrdinals === undefined) {
      throw new Error("Batch submission requires stable accounting attempt bindings");
    }
    input.lease.assertOwned();
    input.signal?.throwIfAborted();
    const remote = await input.http.create(input.plan.model, job.inputFile, job.displayName, input.signal);
    input.lease.assertOwned();
    const operation = assertRemoteBatchBinding(job, input.plan, remote);
    const remoteJob = resourceName(operation.name, "batches");
    publishArtifact(input.lease, `batch-created-${job.id}.json`, JSON.stringify(batchRemoteWitness(job, input.plan, remote)));
    job.remoteJob = remoteJob;
    job.status = "submitted";
    saveBatchState(input.lease, input.plan, state);
  } catch (cause) {
    job.status = "submission_unknown";
    job.diagnostic = "submission acceptance unknown; reconcile exact remote job, never blindly resubmit";
    saveBatchState(input.lease, input.plan, state);
    throw cause;
  }
}

async function poll(input: GeminiBatchInvocation, state: GeminiBatchState, job: GeminiBatchJob): Promise<void> {
  if (job.remoteJob === undefined || terminal.has(job.status)) return;
  if (job.polls >= input.plan.limits.maxPolls ||
      Date.now() - job.submittedAt! >= input.plan.limits.deadlineMs) {
    job.diagnostic = "poll limit/deadline reached; remote work remains unresolved";
    saveBatchState(input.lease, input.plan, state);
    return;
  }
  job.polls += 1;
  saveBatchState(input.lease, input.plan, state);
  const operation = await input.http.get(job.remoteJob, input.signal);
  input.lease.assertOwned();
  applyRemoteOperation(job, input.plan, operation);
  publishArtifact(input.lease, `batch-poll-${batchDigest(`${job.id}:${job.polls}`)}.json`,
    JSON.stringify(batchRemoteWitness(job, input.plan, operation)));
  saveBatchState(input.lease, input.plan, state);
}

async function reconcile(input: GeminiBatchInvocation, state: GeminiBatchState): Promise<void> {
  const requested = input.reconcile!;
  const job = state.jobs.find((candidate) => candidate.id === requested.localJob);
  if (job === undefined || job.status !== "submission_unknown" || job.inputFile === undefined) {
    throw new Error("Batch reconciliation requires a known ambiguous submission and input file");
  }
  const remote = await input.http.get(resourceName(requested.remoteJob, "batches"), input.signal);
  const operation = assertRemoteBatchBinding(job, input.plan, remote, true);
  if (operation.name !== requested.remoteJob) {
    throw new Error("Batch reconciliation lacks exact model/input-file/display-name binding");
  }
  job.remoteJob = requested.remoteJob;
  job.status = "submitted";
  applyRemoteOperation(job, input.plan, remote);
  publishArtifact(input.lease, `batch-reconciled-${job.id}.json`, JSON.stringify(batchRemoteWitness(job, input.plan, remote)));
  saveBatchState(input.lease, input.plan, state);
  if (job.cancelRequested) await cancel(input, state, job);
}

async function cancel(input: GeminiBatchInvocation, state: GeminiBatchState, job: GeminiBatchJob): Promise<void> {
  if (terminal.has(job.status)) return;
  job.cancelRequested = true;
  if (job.submittedAt === undefined) {
    job.status = "cancelled";
    job.usageUnknown = false;
  } else if (job.remoteJob === undefined) {
    job.diagnostic = "cancellation pending: unknown submission requires remote reconciliation";
  } else {
    job.status = "cancel_requested";
  }
  saveBatchState(input.lease, input.plan, state);
  if (job.remoteJob !== undefined) {
    await input.http.cancel(job.remoteJob, input.signal);
    input.lease.assertOwned();
    // An accepted cancel request is not proof of cancellation or zero cost.
    saveBatchState(input.lease, input.plan, state);
  }
}

function assertDispatchBudget(input: GeminiBatchInvocation, rootJobs: readonly GeminiBatchJob[], job: GeminiBatchJob): void {
  const accepted = rootJobs.filter((candidate) => candidate.submittedAt !== undefined);
  const reserved = accepted.reduce((sum, candidate) => sum + accountedCost(candidate, input), 0);
  if (accepted.length >= input.plan.limits.maxJobs || reserved + job.costBoundUsd > input.plan.limits.maxUsd) {
    throw new Error("Batch cumulative attempt/spend ceiling reached");
  }
  const inFlight = accepted.filter((candidate) => !terminal.has(candidate.status))
    .reduce((sum, candidate) => sum + candidate.inputTokenBound, 0);
  if (inFlight + job.inputTokenBound > input.plan.limits.maxEnqueuedTokens) {
    throw new Error("Batch reserved in-flight token ceiling reached");
  }
}

export function accountedCost(job: GeminiBatchJob, input: Pick<GeminiBatchInvocation, "plan">): number {
  if (job.submittedAt === undefined) return 0;
  const observed = job.usage === undefined ? 0 :
    (job.usage.inputTokens * input.plan.limits.inputUsdPerMillion +
      job.usage.outputTokens * input.plan.limits.outputUsdPerMillion) / 1_000_000;
  return job.usageUnknown ? Math.max(job.costBoundUsd, observed) : observed;
}

function linesFor(input: GeminiBatchInvocation, job: GeminiBatchJob) {
  const byKey = new Map(input.plan.lines.map((line) => [line.key, line]));
  return job.lineKeys.map((key) => {
    const line = byKey.get(key);
    if (line === undefined) throw new Error("Batch job lost selected input line");
    return line;
  });
}
