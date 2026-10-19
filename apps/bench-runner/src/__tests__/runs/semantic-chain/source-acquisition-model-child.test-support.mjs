/** Synthetic model-child IPC only, installed in a test-owned physical candidate.
 * It imports no model runtime, opens no operator cache and cannot fall back to inference. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
assert(globalThis[Symbol.for("alaya.source-embedding-offline-guard")], "guard must precede fixture child entry");
process.on("disconnect", () => process.exit(0));
let queue = Promise.resolve();
process.on("message", message => { queue = queue.then(() => handle(message)); });
function handle(message) {
  const { id, op, cacheDir } = message;
  if (op === "close") { process.send({ id, ok: true }); process.exit(0); }
  const fixture = JSON.parse(readFileSync(join(cacheDir, "synthetic-profile.json"), "utf8"));
  appendFileSync(join(cacheDir, "synthetic-dispatch.jsonl"), JSON.stringify({ op, pid: process.pid }) + "\n");
  if (op === "warmup") { process.send({ id, ok: true }); return; }
  const sourceBinding = { status: "ready", binding_id: "synthetic-binding", profile: fixture.profile, profile_id: fixture.profile_id };
  if (op === "bind_source") {
    process.send({ id, ok: true, sourceBinding: fixture.unavailable
      ? { status: "unavailable", reason: "synthetic_unavailable" } : sourceBinding });
    return;
  }
  assert.equal(op, "embed_source");
  const respond = () => {
    // The IPC owner ignores an unrequested id, but the guard observes this real
    // extra reply. Send it before the awaited reply so shutdown cannot race it.
    if (fixture.unsolicited_embedding_reply) process.send({ id: 0, ok: true });
    process.send({ id, ok: true, sourceBinding, sourceResults: message.inputs.map(input => ({
    status: "embedded", input_id: input.input_id,
    input_digest: "sha256:" + createHash("sha256").update(input.text).digest("hex"),
    vector: Array.from({ length: 384 }, (_, index) => index === 0 ? 1 : 0), token_count: 2, truncated: false
    })) });
  };
  if (fixture.delay_ms) setTimeout(respond, fixture.delay_ms); else respond();
}
