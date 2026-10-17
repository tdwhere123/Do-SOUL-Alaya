/** Synthetic model-child IPC only. Replaces the built child bytes under serialized fixture tests.
 * It imports no model runtime, opens no operator cache and cannot fall back to inference. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
assert(globalThis[Symbol.for("alaya.source-embedding-offline-guard")], "guard must precede fixture child entry");
process.on("disconnect", () => process.exit(0));
let queue = Promise.resolve(), closeExitCode = 0;
process.on("message", message => { queue = queue.then(() => handle(message)); });
function handle(message) {
  const { id, op, cacheDir } = message;
  if (op === "close") { process.send({ id, ok: true }); process.exit(closeExitCode); }
  const fixture = JSON.parse(readFileSync(join(cacheDir, "synthetic-profile.json"), "utf8"));
  closeExitCode = fixture.close_exit_code ?? 0;
  if (closeExitCode !== 0 && process.listenerCount("SIGTERM") === 0) process.once("SIGTERM", () => process.exit(closeExitCode));
  appendFileSync(join(cacheDir, "synthetic-dispatch.jsonl"), JSON.stringify({ op, pid: process.pid }) + "\n");
  if (op === "warmup") { process.send({ id, ok: true }); return; }
  const sourceBinding = { status: "ready", binding_id: "synthetic-binding", profile: fixture.profile, profile_id: fixture.profile_id };
  if (op === "bind_source") {
    process.send({ id, ok: true, sourceBinding: fixture.unavailable
      ? { status: "unavailable", reason: "synthetic_unavailable" } : sourceBinding });
    return;
  }
  assert.equal(op, "embed_source");
  const respond = () => process.send({ id, ok: true, sourceBinding, sourceResults: message.inputs.map(input => ({
    status: "embedded", input_id: input.input_id,
    input_digest: "sha256:" + createHash("sha256").update(input.text).digest("hex"),
    vector: Array.from({ length: 384 }, (_, index) => index === 0 ? 1 : 0), token_count: 2, truncated: false
  })) });
  if (fixture.delay_ms) setTimeout(respond, fixture.delay_ms); else respond();
}
