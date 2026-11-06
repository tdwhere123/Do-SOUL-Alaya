// Instrument the shipped Worker, not a substitute runtime or retention owner.
import { installProviderFreeBoundary } from "../../../../../bench-runner/src/__tests__/support/provider-free-boundary.ts";
const boundary = installProviderFreeBoundary();
import { parentPort, workerData } from "node:worker_threads";
import { appendFileSync } from "node:fs";
const { recallExecutionRetention } = await import("@do-soul/alaya-core");
const output = `${workerData.databaseFilename}.profile.jsonl`;
function record(kind, extra = {}) {
  appendFileSync(output, JSON.stringify({ kind, at: performance.now(), memory: process.memoryUsage(), ...extra }) + "\n");
}
record("before-runtime", { accounting: recallExecutionRetention.snapshot() });
// Memory-only samples MUST NOT call snapshot(): snapshot itself sweeps expiry.
const timer = setInterval(() => record("sample"), 25);
timer.unref();
recallExecutionRetention.subscribe(event => record("removal", { event }));
const post = parentPort.postMessage.bind(parentPort);
parentPort.postMessage = (message, ...args) => {
  if (typeof message.id === "number") record("response", {
    id: message.id, ok: message.ok, accounting: recallExecutionRetention.snapshot(), violations: boundary.violations
  });
  return post(message, ...args);
};
await import("../../../../dist/runtime/recall/recall-read-worker.js");
record("runtime-imported");
