import { writeSync } from "node:fs";
import { createHash } from "node:crypto";

const input = JSON.parse(process.env.ALAYA_TEST_CATALOG_REFILL_CRASH_CHILD ?? "null");
const phase = process.env.ALAYA_TEST_CATALOG_REFILL_SIGKILL_AFTER;
if (input === null || !["partial-result", "provider-failure"].includes(input.mode) ||
    !["in-progress-result-manifest-published", "failure-manifest-published"].includes(phase)) {
  throw new Error("catalog refill crash fixture environment is incomplete");
}
// Requires a fresh pnpm build, as CI performs; no nested test runner or compiler.
const { runExtractionFillWithDurableFailpoint } = await import(new URL(
  "../../../../../../dist/runs/extraction/extraction-fill.js", import.meta.url
));
let calls = 0;
await runExtractionFillWithDurableFailpoint({
  variant: input.variant, concurrency: 1, cacheRoot: input.cacheRoot,
  dataDir: input.dataDir, pinnedMetaRoot: input.pinnedMetaRoot,
  authorityReceiptPath: input.authorityReceiptPath,
  targetSelectionReceiptPath: input.targetSelectionReceiptPath,
  ...(input.mode === "partial-result" ? { questionBatchLimit: 1 } : {}),
  extractorFactory: () => ({ extract }), log: () => undefined
}, boundary => {
  if (boundary !== phase) return;
  writeSync(1, `CATALOG_REFILL_BOUNDARY:${boundary}\n`);
  process.kill(process.pid, "SIGKILL");
  throw new Error("durable failpoint SIGKILL was not delivered");
});
throw new Error("catalog refill SIGKILL failpoint was not reached");

async function extract(request) {
  calls += 1;
  await request.onTransportAttempt?.();
  if (input.mode === "provider-failure" && calls === 2) {
    throw Object.assign(new Error("provider timed out for this fixture"), {
      benchRetry: { retryCount: 0, rateLimitRetries: 0, retryClassification: "failure_timeout",
        transportFailures: [{ kind: "timeout", phase: "request", httpStatus: null,
          fingerprint: "f".repeat(64), attempt: 1 }] }
    });
  }
  const { source_assertions: assertions } = JSON.parse(request.userPrompt);
  if (assertions.length === 0) throw new Error("expected a source assertion");
  const rawJson = JSON.stringify({ interpretations: assertions.map(assertion => ({
    assertion_id: assertion.assertion_id,
    relations: [{ predicate: { text: assertion.text }, arguments: [], qualifiers: [] }]
  })) });
  const response = Response.json({ choices: [{ message: { content: rawJson }, finish_reason: "stop" }] });
  const bytes = Buffer.from(await response.arrayBuffer());
  return { rawJson,
    responseMetadata: { finishReason: "stop", completionContractVersion: 1, completionWitness: "message" },
    httpResponse: { contentType: response.headers.get("content-type"),
      bodyBase64: bytes.toString("base64"), bodyByteLength: bytes.length,
      bodySha256: createHash("sha256").update(bytes).digest("hex"),
      bodyTruncated: false, bodyComplete: true }
  };
}
