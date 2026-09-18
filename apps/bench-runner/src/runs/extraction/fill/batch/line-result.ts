import type { GeminiBatchInvocation, GeminiBatchJob, GeminiBatchPlan } from "./contract.js";
import { decodeGeminiGenerateContent } from "./native-codec.js";
import { batchDigest } from "./plan.js";

/** Shared import and durable replay authority for one provider result. */
export function batchLineResult(plan: GeminiBatchPlan, job: GeminiBatchJob, key: string, response: unknown):
  Parameters<GeminiBatchInvocation["importLine"]>[0] {
  const decoded = decodeGeminiGenerateContent(response);
  if (decoded.usage !== undefined && decoded.usage.outputTokens > plan.limits.maxOutputTokens) {
    throw new Error("provider output exceeds authorized token cap");
  }
  const line = plan.lines.find((candidate) => candidate.key === key);
  if (line === undefined || !job.lineKeys.includes(key) || job.remoteJob === undefined ||
      job.inputFile === undefined || job.rawOutputSha256 === undefined) throw new Error("Batch admission lost retained line binding");
  return { line, rawJson: decoded.rawJson, provenance: {
    transport: "gemini-batch", job: job.remoteJob, inputFile: job.inputFile,
    inputSha256: job.inputSha256, outputSha256: job.rawOutputSha256,
    responseSha256: batchDigest(JSON.stringify(response)), finishReason: "STOP",
    ...(job.attemptOrdinals?.[key] === undefined ? {} : { attemptOrdinal: job.attemptOrdinals[key] }),
    ...(decoded.usage === undefined ? {} : { usage: decoded.usage })
  } };
}
