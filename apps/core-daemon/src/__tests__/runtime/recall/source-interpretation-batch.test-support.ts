import { expect } from "vitest";
import { join } from "node:path";
import { batchDigest, canonicalBatchPlan } from "../../../../../bench-runner/src/runs/extraction/fill/batch/plan.js";
import { executeGeminiBatchOperation } from "../../../../../bench-runner/src/runs/extraction/fill/batch/executor.js";
import { acquireExtractionCacheWriteLease, withExtractionCacheWriteLease } from "../../../../../bench-runner/src/runs/extraction/fill/manifest/fill-root-guard.js";
import { receiveSourceInterpretationPacketBatchLine } from "../../../../../bench-runner/src/runs/extraction/fill/batch/source-interpretation-packet.js";
import type { GeminiBatchHttp, GeminiBatchInvocation, GeminiBatchLine } from "../../../../../bench-runner/src/runs/extraction/fill/batch/contract.js";

/** Exercises the real durable Batch state machine with an offline transport port. */
export async function publishOfflineBatchPacket(input: {
  directory: string; line: GeminiBatchLine; rawJson: string; sourceCorpus: string; artifactKey: string;
  publish: (draft: Extract<ReturnType<typeof receiveSourceInterpretationPacketBatchLine>, { status: "received" }>["draft"]) => Promise<string>;
}): Promise<string> {
  const plan = canonicalBatchPlan({ identity: batchDigest(JSON.stringify(input.line)), model: "gemini-2.5-flash",
    requestProfile: "gemini-2.5-nonthinking-v1", lines: [input.line], limits: {
      maxJobs: 1, maxRequestsPerJob: 1, maxFileBytes: 1000000, maxInputTokensPerJob: 1000000,
      maxEnqueuedTokens: 1000000, maxOutputTokens: 8192, maxUsd: 1, inputUsdPerMillion: 0, outputUsdPerMillion: 0,
      deadlineMs: 60000, requestTimeoutMs: 1000, maxPolls: 2
    } });
  const root = join(input.directory, `batch-${input.line.key}`);
  let uploaded = "";
  let display = "";
  let publication = "";
  let imports = 0;
  const outcomes: unknown[] = [];
  const response = { candidates: [{ finishReason: "STOP", content: { parts: [{ text: input.rawJson }] } }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10, totalTokenCount: 20 } };
  const raw = JSON.stringify({ key: input.line.key, response }) + "\n";
  const http: GeminiBatchHttp = { endpoint: "https://offline.invalid",
    upload: async (wire) => { uploaded = wire; return "files/offline-input"; },
    create: async (_model, _file, displayName) => { display = displayName; return { name: "batches/offline" }; },
    get: async () => ({ name: "batches/offline", metadata: { displayName: display, model: plan.model,
      inputConfig: { fileName: "files/offline-input" }, state: "BATCH_STATE_SUCCEEDED",
      output: { responsesFile: "files/offline-output" } } }),
    download: async () => raw, cancel: async () => { throw new Error("unexpected cancellation"); } };
  const importLine: GeminiBatchInvocation["importLine"] = async ({ line, rawJson, provenance }) => {
    imports += 1;
    expect(provenance).toMatchObject({ attemptOrdinal: 1, inputSha256: batchDigest(uploaded),
      outputSha256: batchDigest(raw), responseSha256: batchDigest(JSON.stringify(response)), finishReason: "STOP" });
    const received = receiveSourceInterpretationPacketBatchLine({ config: plan, line, rawJson, sourceCorpus: input.sourceCorpus,
      artifactKey: input.artifactKey, producerId: "authored-offline-batch", retained: { plan, provenance } });
    if (received.status !== "received") throw new Error("Batch packet missing");
    expect(received.draft.provenance.transport).toMatchObject({ kind: "gemini_batch", plan_identity: plan.identity,
      request_sha256: line.requestSha256, input_sha256: provenance.inputSha256, attempt_ordinal: 1 });
    publication = await input.publish(received.draft);
  };
  const run = (operation: GeminiBatchInvocation["operation"]) => {
    const lease = acquireExtractionCacheWriteLease(root);
    return withExtractionCacheWriteLease(lease, () => executeGeminiBatchOperation({ operation, root, lease, plan, http, importLine,
      reserveSubmission: async (lines) => Object.fromEntries(lines.map((line) => [line.key, 1])),
      recordLineOutcome: (key, status, usage, binding) => { outcomes.push({ key, status, usage, binding }); } }));
  };
  expect((await run("prepare")).jobs[0]?.status).toBe("prepared");
  expect(uploaded).toBe("");
  await run("submit");
  const completed = await run("resume");
  expect(completed.jobs[0]?.outcomes[input.line.key]?.status).toBe("admitted");
  expect(outcomes).toContainEqual(expect.objectContaining({ key: input.line.key, status: "success",
    binding: expect.objectContaining({ attemptOrdinal: 1 }) }));
  await run("import");
  expect(imports).toBe(1);
  expect(publication).not.toBe("");
  return publication;
}
