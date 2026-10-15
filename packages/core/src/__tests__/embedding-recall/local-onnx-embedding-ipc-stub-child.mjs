import { createHash } from "node:crypto";

const DIMENSIONS = 384;
const sourceBindings = new Map();
let nextBinding = 0;

process.title = "alaya-local-onnx-embed-stub";

if (typeof process.send !== "function") {
  throw new Error("local ONNX embedding stub child requires IPC");
}

process.on("disconnect", () => process.exit(0));
process.on("message", (message) => {
  void handle(message);
});

async function handle(message) {
  const id = message?.id;
  if (typeof id !== "number" || typeof process.send !== "function") return;
  const op = message?.op;
  if (op === "close") {
    process.send({ id, ok: true });
    process.exit(0);
    return;
  }
  if (op === "warmup") {
    process.send({ id, ok: true });
    return;
  }
  if (op === "bind_source") {
    const profile = {
      provider_kind: "local_onnx", model_id: message.modelId, model_revision: "fork-fixture-only",
      artifact_digest: `sha256:${"a".repeat(64)}`, tokenizer_revision: "fork-fixture-tokenizer",
      dimensions: DIMENSIONS, preprocessing: "fixture-raw", normalization: "fixture-unit",
      max_input_tokens: message.bindingOptions.max_input_tokens ?? 32,
      windowing: "utf8-byte-windows.v1", window_bytes: message.bindingOptions.window_bytes
    };
    const binding = { status: "ready", profile,
      profile_id: `sha256:${sha256(JSON.stringify(["source-index-profile.v1", Object.fromEntries(Object.entries(profile).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))]))}`,
      binding_id: `fixture-${process.pid}-${++nextBinding}` };
    sourceBindings.set(binding.binding_id, binding);
    process.send({ id, ok: true, sourceBinding: binding });
    return;
  }
  if (op === "embed_source") {
    const binding = sourceBindings.get(message.binding_id);
    if (!binding || binding.profile_id !== message.profile_id) {
      process.send({ id, ok: false, error: { name: "Error", message: "stale or mismatched Source fixture binding" } });
      return;
    }
    const inputs = message.inputs ?? [];
    if (inputs[0]?.text === "__hang__") return;
    if (inputs[0]?.text === "__delay_exit__") {
      process.once("SIGTERM", () => setTimeout(() => process.exit(0), 150));
      process.send({ fixture: "source_running", id });
      return;
    }
    if (inputs[0]?.text === "__crash__") { process.exit(7); return; }
    process.send({ id, ok: true, sourceBinding: binding, sourceResults: inputs.map((input, index) => ({
      status: "embedded", input_id: input.input_id, input_digest: `sha256:${sha256(input.text)}`,
      vector: stubRow(index), token_count: 3, truncated: false
    })) });
    return;
  }
  if (op !== "embed") {
    process.send({
      id,
      ok: false,
      error: { name: "Error", message: "invalid local ONNX stub request" }
    });
    return;
  }
  const texts = Array.isArray(message.texts) ? message.texts : [];
  const probe = texts[0];
  if (probe === "__crash__") {
    process.exit(7);
    return;
  }
  if (probe === "__hang__") {
    return;
  }
  if (probe === "__empty__") {
    process.send({ id, ok: true, vectors: [] });
    return;
  }
  if (probe === "__empty_row__") {
    process.send({ id, ok: true, vectors: [[]] });
    return;
  }
  const vectors = texts.map((_, index) => stubRow(index));
  if (probe === "__non_finite__") vectors[0][0] = NaN;
  if (probe === "__overflow__") vectors[0][0] = Number.MAX_VALUE;
  if (probe === "__wrong_dimensions__") vectors[0] = [1, 0];
  process.send({ id, ok: true, vectors });
}

function sha256(text) { return createHash("sha256").update(text, "utf8").digest("hex"); }

function stubRow(seed) {
  return Array.from({ length: DIMENSIONS }, (_unused, index) =>
    Math.sin(seed + index + 1) * 0.01
  );
}
