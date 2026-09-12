import type { GeminiBatchInvocation, GeminiBatchJob, GeminiBatchState } from "./contract.js";
import { record, decodeGeminiGenerateContent, geminiUsage } from "./native-codec.js";
import { batchDigest } from "./plan.js";
import { publishRetainedBatchOutput, readRetainedBatchOutput, saveBatchState } from "./store.js";
import { deriveBatchUsage, parseOutputInventory } from "./output-inventory.js";

export async function importBatchJob(
  input: GeminiBatchInvocation, state: GeminiBatchState, job: GeminiBatchJob
): Promise<void> {
  if (!["succeeded", "failed", "cancelled", "expired"].includes(job.status)) return;
  if (job.remoteJob === undefined || job.inputFile === undefined) return;
  if (job.outputFile === undefined) {
    await reportTransportOutcomes(input, job, new Map());
    for (const key of job.lineKeys) job.outcomes[key] ??= { status: "failed", reason: `remote job ${job.status} without output` };
    saveBatchState(input.lease, input.plan, state);
    return;
  }
  const raw = await retainBatchOutput(input, job);
  saveBatchState(input.lease, input.plan, state);
  let entries: Map<string, Record<string, unknown>>;
  try {
    entries = parseOutputInventory(raw, job);
  } catch (cause) {
    await reportTransportOutcomes(input, job, new Map());
    for (const key of job.lineKeys) {
      if (job.outcomes[key]?.status !== "admitted") {
        job.outcomes[key] = { status: "quarantined", reason: message(cause) };
      }
    }
    job.usageUnknown = true;
    job.diagnostic = message(cause);
    saveBatchState(input.lease, input.plan, state);
    return;
  }
  Object.assign(job, deriveBatchUsage(raw, job));
  saveBatchState(input.lease, input.plan, state);
  await reportTransportOutcomes(input, job, entries);
  for (const key of job.lineKeys) {
    input.signal?.throwIfAborted();
    input.lease.assertOwned();
    if (job.outcomes[key] !== undefined) continue;
    const entry = entries.get(key);
    if (entry === undefined) {
      job.outcomes[key] = { status: "failed", reason: "missing provider result" };
    } else if (entry.error !== undefined) {
      job.outcomes[key] = { status: "failed", reason: "provider error result" };
    } else {
      await importSuccessfulLine(input, job, key, entry.response);
    }
    saveBatchState(input.lease, input.plan, state);
  }
}

async function retainBatchOutput(input: GeminiBatchInvocation, job: GeminiBatchJob): Promise<string> {
  const raw = readRetainedBatchOutput(input.lease, job) ??
    await input.http.download(job.outputFile!, input.signal);
  input.lease.assertOwned();
  job.rawOutputSha256 = publishRetainedBatchOutput(input.lease, job, raw);
  return raw;
}

async function reportTransportOutcomes(input: GeminiBatchInvocation, job: GeminiBatchJob,
  entries: Map<string, Record<string, unknown>>): Promise<void> {
  if (input.recordLineOutcome === undefined) return;
  for (const key of job.lineKeys) {
    input.signal?.throwIfAborted();
    input.lease.assertOwned();
    const entry = entries.get(key);
    const attemptOrdinal = job.attemptOrdinals?.[key];
    if (attemptOrdinal === undefined) throw new Error("Batch result has no bound accounting attempt");
    const binding = { jobId: job.id, attemptOrdinal };
    if (entry === undefined || entry.error !== undefined) {
      await input.recordLineOutcome(key, entry === undefined ? "missing" : "provider_error", undefined, binding);
      continue;
    }
    let usage: ReturnType<typeof geminiUsage>;
    try { usage = geminiUsage(record(entry.response)); } catch { usage = undefined; }
    let outcome: "success" | "invalid" = "success";
    try {
      decodeGeminiGenerateContent(entry.response);
      if (usage !== undefined && usage.outputTokens > input.plan.limits.maxOutputTokens) outcome = "invalid";
    } catch { outcome = "invalid"; }
    await input.recordLineOutcome(key, outcome, usage, binding);
  }
}

async function importSuccessfulLine(
  input: GeminiBatchInvocation, job: GeminiBatchJob, key: string, response: unknown
): Promise<void> {
  let decoded: ReturnType<typeof decodeGeminiGenerateContent>;
  try {
    decoded = decodeGeminiGenerateContent(response);
    if (decoded.usage !== undefined && decoded.usage.outputTokens > input.plan.limits.maxOutputTokens) {
      throw new Error("provider output exceeds authorized token cap");
    }
  } catch (cause) {
    job.outcomes[key] = { status: "quarantined", reason: message(cause) };
    return;
  }
  const line = input.plan.lines.find((candidate) => candidate.key === key);
  if (line === undefined) throw new Error("Batch admission lost selected line");
  // Callback failures remain retryable: a cache commit may have preceded the interruption.
  // The shared owner distinguishes semantic rejection from an interrupted publication.
  const admission = await input.importLine({
    line, rawJson: decoded.rawJson,
    provenance: {
      transport: "gemini-batch", job: job.remoteJob!, inputFile: job.inputFile!,
      inputSha256: job.inputSha256, outputSha256: job.rawOutputSha256!,
      responseSha256: batchDigest(JSON.stringify(response)), finishReason: "STOP",
      ...(job.attemptOrdinals?.[key] === undefined ? {} : { attemptOrdinal: job.attemptOrdinals[key] }),
      ...(decoded.usage === undefined ? {} : { usage: decoded.usage })
    }
  });
  input.lease.assertOwned();
  input.signal?.throwIfAborted();
  job.outcomes[key] = admission ?? { status: "admitted" };
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Batch result failed validation";
}
