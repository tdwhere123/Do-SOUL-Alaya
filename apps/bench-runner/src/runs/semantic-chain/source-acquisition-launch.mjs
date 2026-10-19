/** Built-ins-only launch boundary. The application is imported only after active guard inspection. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

import { acquisitionRuntimeChannel, OBSERVER_BOOTSTRAP_MODE, observerBootstrapEnvelope, CONTEXT_BOOTSTRAP_MODE, contextBootstrapEnvelope }
  from "./source-acquisition-runtime-channel.mjs";
export { observerBootstrapEnvelope, contextBootstrapEnvelope };
export const contextBootstrapMode = CONTEXT_BOOTSTRAP_MODE;
export const observerBootstrapMode = OBSERVER_BOOTSTRAP_MODE;

const candidate = fileURLToPath(new URL("../../../../../", import.meta.url));
const guardPath = "packages/core/src/__tests__/embedding-recall/local-onnx-source-embedding-offline-preload.mjs";
const receiptPath = "packages/core/src/__tests__/embedding-recall/local-onnx-source-embedding-offline-receipts.mjs";
const applicationPath = "apps/bench-runner/dist/runs/semantic-chain/source-acquisition-experiment.js";
const pinnedPaths = [guardPath, receiptPath,
  "apps/bench-runner/src/__tests__/support/provider-free-boundary.ts",
  "apps/bench-runner/src/__tests__/support/read-only-git-boundary.mjs",
  "apps/bench-runner/src/runs/semantic-chain/source-acquisition-launch.mjs", applicationPath,
  "apps/bench-runner/dist/runs/semantic-chain/source-experiment.js",
  "apps/bench-runner/dist/runs/semantic-chain/source-qualified-selection-input.js",
  "apps/bench-runner/dist/runs/snapshot/source-records/native.js",
  "apps/bench-runner/src/runs/semantic-chain/source-acquisition-runtime-channel.mjs",
  "apps/bench-runner/dist/runs/semantic-chain/source-qualified-correspondence-context.js",
  "apps/bench-runner/dist/runs/semantic-proposal/correspondence-generation-context.js",
  "apps/bench-runner/dist/runs/semantic-proposal/attempt.js",
  "apps/bench-runner/dist/runs/semantic-proposal/query-revision-observer-view.js",
  "apps/bench-runner/dist/runs/semantic-proposal/fill.js",
  "apps/bench-runner/dist/runs/semantic-proposal/workset.js",
  "apps/bench-runner/dist/runs/semantic-chain/contract.js",
  "apps/bench-runner/dist/runs/semantic-chain/recovery-allowance.js",
  "apps/bench-runner/dist/runs/semantic-chain/source-index-binding.js",
  "apps/core-daemon/dist/runtime/recall/source-semantic-research-acquisition-controls.js",
  "apps/core-daemon/dist/runtime/recall/recall-read-worker-client.js",
  "apps/core-daemon/dist/runtime/recall/recall-read-worker-lifecycle.js",
  "apps/core-daemon/dist/runtime/recall/recall-read-worker-deadline.js",
  "apps/core-daemon/dist/runtime/recall/recall-read-worker.js",
  "apps/core-daemon/dist/runtime/recall-read-worker/operation-schemas.js",
  "apps/core-daemon/dist/runtime/recall-read-worker/source-semantic-qualified-selection-boundary.js",
  "apps/core-daemon/dist/runtime/recall-read-worker/source-semantic-qualified-selection.js",
  "apps/core-daemon/dist/runtime/recall-read-worker/source-semantic-joint-boundary.js",
  "apps/core-daemon/dist/runtime/recall-read-worker/source-semantic-research-joint-delivery.js",
  "packages/core/dist/recall/conditional-field/query/source-semantic-joint-witness.js",
  "packages/core/dist/recall/conditional-field/engine/derivation-provenance.js",
  "packages/core/dist/recall/runtime/source-semantic-withdrawal.js",
  "apps/core-daemon/dist/runtime/recall-read-worker/source-semantic-reasoning.js",
  "apps/core-daemon/dist/runtime/recall-read-worker/source-semantic-research-nominated-library.js",
  "apps/core-daemon/dist/runtime/recall-read-worker/source-semantic-research-pool.js",
  "apps/core-daemon/dist/runtime/recall-read-worker/source-semantic-library-recall.js",
  "apps/core-daemon/dist/runtime/recall-read-worker/source-semantic-library-delivery.js",
  "apps/core-daemon/dist/runtime/recall-read-worker/source-semantic-research-serialization.js",
  "packages/core/dist/recall/runtime/source-semantic-library-selection.js",
  "apps/core-daemon/dist/mcp-memory/tool/interpretation-handler.js",
  "packages/core/dist/embedding-recall/local-onnx-process/child.js"];
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

export function captureAcquisitionLaunchBinding() {
  assert.equal(realpathSync(candidate), candidate.replace(/\/$/u, ""));
  const modules = Object.fromEntries(pinnedPaths.map(relative => {
    const path = join(candidate, relative);
    assert.equal(realpathSync(path), path, "aliased acquisition module");
    assert(lstatSync(path).isFile(), "nonregular acquisition module");
    return [relative, digest(readFileSync(path))];
  }));
  return { candidate: candidate.replace(/\/$/u, ""), executable: realpathSync(process.execPath), modules };
}
export function assertAcquisitionLaunchBinding(binding) {
  assert.deepEqual(binding, captureAcquisitionLaunchBinding(), "acquisition candidate/module/executable pins changed");
}
export function acquisitionLaunchPaths(allocation) {
  const preload = pathToFileURL(join(candidate, guardPath));
  preload.searchParams.set("source_input_cap", String(allocation.source_inputs));
  preload.searchParams.set("source_utf8_byte_cap", String(allocation.utf8_bytes));
  return { preload: preload.href, launcher: fileURLToPath(import.meta.url) };
}

export async function inspectAcquisitionGuard(policy) {
  const { isolation } = await import(policy.preload);
  return isolation.assertActive(policy);
}
export async function reconcileAcquisitionGuard(parent, child, policy) {
  const { reconcileOfflineGuard } = await import("../../../../../packages/core/src/__tests__/embedding-recall/local-onnx-source-embedding-offline-receipts.mjs");
  return reconcileOfflineGuard(parent, child, policy);
}

let activeIsolation;
async function runOwnedChild() {
  const root = resolve(process.argv[2]), identity = process.argv[3], deadline = Number(process.argv[4]);
  const envelope = JSON.parse(readFileSync(join(root, "source-experiment-input.json"), "utf8"));
  assert.equal(envelope.identity, identity);
  assert.equal(envelope.payload.contract, "source-acquisition-experiment-v1");
  assert.equal(envelope.payload.root, root);
  assertAcquisitionLaunchBinding(envelope.payload.launch);
  const paths = acquisitionLaunchPaths(envelope.payload.guard_allocation);
  assert.deepEqual(process.execArgv, ["--import", paths.preload], "unguarded acquisition entry");
  assert(Number.isSafeInteger(deadline) && deadline > Date.now());
  const { isolation } = await import(paths.preload);
  activeIsolation = isolation;
  const policy = { preload: paths.preload, inputs: envelope.payload.guard_allocation.source_inputs,
    bytes: envelope.payload.guard_allocation.utf8_bytes };
  const active = isolation.assertActive({ ...policy, unused: true });
  assert(process.argv.length === 5 || process.argv.length === 6 && [OBSERVER_BOOTSTRAP_MODE, CONTEXT_BOOTSTRAP_MODE].includes(process.argv[5]),
    "invalid acquisition bootstrap mode");
  const caller = acquisitionRuntimeChannel({ identity, deadline, observer: process.argv[5] === OBSERVER_BOOTSTRAP_MODE, context: process.argv[5] === CONTEXT_BOOTSTRAP_MODE });
  try {
  await new Promise((resolve, reject) => process.send({ kind: "source_acquisition_guarded", identity, pid: process.pid, active, deadline },
    error => error ? reject(new Error("acquisition guarded acknowledgement failed")) : resolve()));
  const bootstrap = await caller.view;
  const runtimeOptions = process.argv[5] === CONTEXT_BOOTSTRAP_MODE ? bootstrap : { queryRevisionObserverView: bootstrap };
  caller.signal.throwIfAborted();
  // All application imports are below the actual active-reference inspection.
  if (envelope.payload.qualified_selection !== undefined) {
    assert.deepEqual(envelope.payload.guard_allocation, { source_inputs: 0, utf8_bytes: 0 });
    registerHooks({ load(url, context, next) {
      if (/(?:\/node_modules\/)(?:@huggingface\/transformers|@xenova\/transformers|onnxruntime-node|onnxruntime-web)(?:\/|$)/u.test(url)) {
        assert.fail("qualified selection forbids model runtime loading");
      }
      return next(url, context);
    } });
  }
  const application = await import(pathToFileURL(join(candidate, applicationPath)).href);
  await application.executeGuardedSourceAcquisition(root, identity, { signal: caller.signal, deadline, active, ...runtimeOptions });
  // No restoration here: enforcement remains installed through reconciliation and process exit.
  let failure;
  try {
    await isolation.closeChildren();
    isolation.assertActive(policy);
    caller.signal.throwIfAborted();
  } catch (error) { failure = error; }
  const receipts = isolation.receipts("acquisition_shutdown");
  await application.reconcileGuardedSourceAcquisition(root, identity, { receipts, policy, failure });
  } finally { caller.dispose(); }
  if (process.connected) process.disconnect();
}

// Do not keep this module in a top-level-await cycle with its application consumer.
if (process.argv[1] === fileURLToPath(import.meta.url)) void runOwnedChild().catch(async error => {
  process.stderr.write(`${error?.stack ?? String(error)}\n`);
  try { await activeIsolation?.closeChildren(); } catch (cleanup) { process.stderr.write(`${String(cleanup)}\n`); }
  activeIsolation?.writeReceipts("failure");
  process.exitCode = 1;
  if (process.connected) process.disconnect();
});
