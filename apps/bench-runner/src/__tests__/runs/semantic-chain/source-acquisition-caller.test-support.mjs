/** Clean external caller: strict guards precede application imports, no ambient loader arguments. */
import "../../support/strict-provider-free-cli-bootstrap.mjs";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
registerHooks({ load(url, context, next) {
  if (/(?:\/node_modules\/)(?:@huggingface\/transformers|@xenova\/transformers|onnxruntime-node|onnxruntime-web)(?:\/|$)/u.test(url)) {
    throw new Error("acquisition caller forbids model runtime loading");
  }
  return next(url, context);
} });
const caller = new AbortController();
process.on("message", message => { if (message === "cancel") caller.abort({ authored: "caller-cancel" }); });
const input = JSON.parse(readFileSync(process.argv[2], "utf8"));
const { compareSemanticChainSourceAcquisition } = await import("../../../../dist/runs/semantic-chain/source-acquisition-experiment.js");
const state = await compareSemanticChainSourceAcquisition(input, input.root, { signal: caller.signal });
process.stdout.write(JSON.stringify(state));
process.disconnect?.();
