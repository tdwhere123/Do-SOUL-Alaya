/** Clean external caller: strict guards precede application imports, no ambient loader arguments. */
import "../../support/strict-provider-free-cli-bootstrap.mjs";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { createRequire, syncBuiltinESMExports, registerHooks } from "node:module";
registerHooks({ load(url, context, next) {
  if (/(?:\/node_modules\/)(?:@huggingface\/transformers|@xenova\/transformers|onnxruntime-node|onnxruntime-web)(?:\/|$)/u.test(url)) {
    throw new Error("acquisition caller forbids model runtime loading");
  }
  return next(url, context);
} });
const caller = new AbortController();
process.on("message", message => { if (message === "cancel") caller.abort({ authored: "caller-cancel" }); });
const offered = JSON.parse(readFileSync(process.argv[2], "utf8"));
const input = offered.input ?? offered;
const queryRevisionObserverView = offered.runtimeView;
if (queryRevisionObserverView !== undefined) {
  const childProcess = createRequire(import.meta.url)("node:child_process"), spawn = childProcess.spawn;
  childProcess.spawn = function (executable, args, options) {
    assert(!args.join(" ").includes(queryRevisionObserverView.observations[0].text), "runtime view leaked into argv");
    const child = spawn(executable, args, options), send = child.send.bind(child);
    if (offered.bootstrapSendFailure) child.send = (message, callback) => {
      if (message.kind === "observer-runtime-bootstrap-v1") { callback(new Error("injected private IPC failure")); return false; }
      return send(message, callback);
    };
    return child;
  };
  syncBuiltinESMExports();
}
const { compareSemanticChainSourceAcquisition } = await import("../../../../dist/runs/semantic-chain/source-acquisition-experiment.js");
const pending = compareSemanticChainSourceAcquisition(input, input.root, { signal: caller.signal,
  ...(queryRevisionObserverView === undefined ? {} : { queryRevisionObserverView }) });
if (offered.mutateRuntimeViewAfterCall) queryRevisionObserverView.observations[0].text = "Mutated after synchronous capture.";
const state = await pending;
process.stdout.write(JSON.stringify(state));
process.disconnect?.();
