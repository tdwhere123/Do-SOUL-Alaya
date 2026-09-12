import type { GeminiBatchJob, GeminiBatchPlan } from "./contract.js";
import { record, resourceName } from "./native-codec.js";

export const terminalBatchStates = new Set(["succeeded", "failed", "cancelled", "expired"]);

export function batchRemoteWitness(job: GeminiBatchJob, plan: GeminiBatchPlan, operation: unknown): object {
  return { binding: remoteBinding(job, plan), operation };
}

export function readBatchRemoteWitness(job: GeminiBatchJob, plan: GeminiBatchPlan, value: unknown): unknown {
  const witness = record(value);
  if (JSON.stringify(witness.binding) !== JSON.stringify(remoteBinding(job, plan))) {
    throw new Error("Batch durable remote receipt binding mismatch");
  }
  assertRemoteBatchBinding(job, plan, witness.operation);
  return witness.operation;
}

function remoteBinding(job: GeminiBatchJob, plan: GeminiBatchPlan): object {
  return { jobId: job.id, model: plan.model, displayName: job.displayName,
    inputFile: job.inputFile, inputSha256: job.inputSha256, attemptOrdinals: job.attemptOrdinals };
}

/** Creation may return only a name; supplied identity fields must always agree. */
export function assertRemoteBatchBinding(job: GeminiBatchJob, plan: GeminiBatchPlan,
  value: unknown, requireFullIdentity = false): Record<string, unknown> {
  const operation = record(value);
  const name = resourceName(operation.name, "batches");
  if (job.remoteJob !== undefined && job.remoteJob !== name) throw new Error("foreign Batch operation identity");
  const metadata = operation.metadata === undefined ? {} : record(operation.metadata);
  const input = metadata.inputConfig === undefined ? {} : record(metadata.inputConfig);
  if ((requireFullIdentity || metadata.displayName !== undefined) && metadata.displayName !== job.displayName ||
      (requireFullIdentity || input.fileName !== undefined) && input.fileName !== job.inputFile ||
      (requireFullIdentity || metadata.model !== undefined) &&
        ![plan.model, `models/${plan.model}`].includes(String(metadata.model))) {
    throw new Error("Batch remote model/input-file/display-name binding mismatch");
  }
  return operation;
}

export function applyRemoteOperation(job: GeminiBatchJob, plan: GeminiBatchPlan, value: unknown): void {
  const operation = assertRemoteBatchBinding(job, plan, value);
  const metadata = record(operation.metadata);
  const state = typeof metadata.state === "string"
    ? metadata.state.replace(/^(BATCH|JOB)_STATE_/u, "") : "";
  const statuses: Record<string, GeminiBatchJob["status"]> = {
    PENDING: "submitted", QUEUED: "submitted", RUNNING: "running", SUCCEEDED: "succeeded",
    FAILED: "failed", CANCELLED: "cancelled", CANCELLING: "cancel_requested", EXPIRED: "expired"
  };
  const status = statuses[state];
  if (status === undefined) throw new Error("unknown Gemini Batch remote state");
  if ((terminalBatchStates.has(status) && operation.done === false) ||
      (status === "succeeded" && operation.error !== undefined)) {
    throw new Error("contradictory Gemini Batch terminal state");
  }
  const output = operation.response === undefined ? undefined : record(operation.response).responsesFile;
  const metadataOutput = metadata.output === undefined ? undefined : record(metadata.output).responsesFile;
  if (output !== undefined && metadataOutput !== undefined && output !== metadataOutput) {
    throw new Error("conflicting Gemini Batch output identities");
  }
  const file = output ?? metadataOutput;
  if (file !== undefined) {
    const outputFile = resourceName(file, "files");
    if (job.outputFile !== undefined && job.outputFile !== outputFile) throw new Error("Batch output identity changed");
    job.outputFile = outputFile;
  }
  if (status === "succeeded" && job.outputFile === undefined) throw new Error("successful Gemini Batch job has no output file");
  job.status = status;
}
