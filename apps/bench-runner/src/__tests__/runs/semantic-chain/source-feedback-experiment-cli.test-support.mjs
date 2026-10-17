/** Authored-fixture child only: install transport/credential guards before app imports. */
import "../../support/strict-provider-free-cli-bootstrap.mjs";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { Worker } from "node:worker_threads";

const refusals = [];
function refuse(kind) { refusals.push(kind); throw new Error(`Feedback fixture forbids ${kind}`); }
// Package metadata lookup is inert. Loading a model-runtime module is not.
registerHooks({ load(url, context, next) {
  if (/(?:\/node_modules\/)(?:@huggingface\/transformers|@xenova\/transformers|onnxruntime-node|onnxruntime-web)(?:\/|$)/u.test(url)) refuse("model runtime load");
  return next(url, context);
} });
const cacheRoots = JSON.parse(process.env.SOURCE_FEEDBACK_FIXTURE_READONLY_CACHES ?? "[]").map(path => resolve(path));
const isCache = value => typeof value === "string" && cacheRoots.some(root => resolve(value) === root || resolve(value).startsWith(root + sep));
for (const owner of [fs, fsp]) {
  for (const name of ["writeFile", "writeFileSync", "appendFile", "appendFileSync", "unlink", "unlinkSync", "rm", "rmSync", "mkdir", "mkdirSync"]) {
    if (typeof owner[name] !== "function") continue;
    const original = owner[name];
    owner[name] = function (path, ...rest) { if (isCache(path)) refuse("cache write"); return original.call(this, path, ...rest); };
  }
  for (const name of ["open", "openSync"]) {
    if (typeof owner[name] !== "function") continue;
    const original = owner[name];
    owner[name] = function (path, flags, ...rest) {
      const writes = typeof flags === "number" ? (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) !== 0
        : typeof flags === "string" && /[wa+]/u.test(flags);
      if (isCache(path) && writes) refuse("writable cache open");
      return original.call(this, path, flags, ...rest);
    };
  }
  for (const name of ["rename", "renameSync", "link", "linkSync", "copyFile", "copyFileSync"]) {
    if (typeof owner[name] !== "function") continue;
    const original = owner[name];
    owner[name] = function (source, destination, ...rest) {
      if (isCache(destination) || name.startsWith("rename") && isCache(source)) refuse("cache mutation");
      return original.call(this, source, destination, ...rest);
    };
  }
}
process.on("exit", () => { if (refusals.length > 0) process.exitCode = 1; });

// The existing bench harness snapshots these absent embedding credentials/control
// references and creates a synthetic reviewer token. Never consult ambient secrets.
const fixtureControls = new Map([
  ["OPENAI_API_KEY", undefined], ["ALAYA_OPENAI_SECRET_REF", undefined],
  ["ALAYA_REQUEST_TOKEN", undefined], ["ALAYA_REQUEST_TOKEN_WORKSPACES", undefined],
  ["ALAYA_REVIEWER_TOKEN", undefined], ["ALAYA_MCP_TOOL_CONFIRMATION_TOKEN", undefined],
  ["ALAYA_E2E_EVENT_TRIGGER_TOKEN", undefined]
]);
const guarded = process.env;
process.env = new Proxy(guarded, {
  get(target, key) { return fixtureControls.has(key) ? fixtureControls.get(key) : Reflect.get(target, key); },
  set(target, key, value) {
    if (fixtureControls.has(key)) fixtureControls.set(key, String(value));
    return Reflect.set(target, key, value);
  },
  deleteProperty(target, key) {
    if (fixtureControls.has(key)) fixtureControls.set(key, undefined);
    return Reflect.deleteProperty(target, key);
  }
});
Object.assign(process.env, { ALAYA_ENABLE_EMBEDDING_SUPPLEMENT: "false", ALAYA_EMBEDDING_PROVIDER: "local_onnx",
  ALAYA_SQLITE_WRITE_QUEUE: "0", ALAYA_CONFLICT_LLM_PROVIDER_URL: "", ALAYA_CONFLICT_LLM_MODEL: "",
  ALAYA_ENABLE_E2E_EVENT_TRIGGERS: "false", ALAYA_RECALL_READ_WORKER_REQUEST_TIMEOUT_MS: "30000" });

// Faults exercise real compiled filesystem/lifetime boundaries, not a fake worker.
const fault = process.env.SOURCE_FEEDBACK_FIXTURE_FAULT, caller = new AbortController();
const post = Worker.prototype.postMessage;
Worker.prototype.postMessage = function (message, ...rest) {
  const result = post.call(this, message, ...rest);
  if (message?.operation === "conditionalField.sourceSemantics") {
    if (fault === "worker_loss") void this.terminate();
    if (fault === "caller_abort") caller.abort({ fixture: "caller_abort", detail: 7n });
  }
  return result;
};
const mkdtemp = fs.mkdtempSync;
fs.mkdtempSync = function (prefix, ...rest) {
  if (["after_reservation", "forbid_start"].includes(fault) && String(prefix).includes("native-session-")) {
    throw Object.assign(new Error("fixture refuses daemon startup"), { code: "FIXTURE_START_REFUSAL" });
  }
  const directory = mkdtemp.call(this, prefix, ...rest);
  if (String(prefix).endsWith("native-session-")) fs.appendFileSync(
    `${String(prefix).slice(0, -"native-session-".length)}fixture-daemon-starts.jsonl`, `${JSON.stringify({ pid: process.pid, directory })}\n`);
  return directory;
};
const link = fs.linkSync;
fs.linkSync = function (source, destination) {
  if (fault === "projection" && String(destination).endsWith("/initial-reason.json")) {
    throw Object.assign(new Error("fixture refuses legacy projection"), { code: "FIXTURE_PROJECTION_REFUSAL" });
  }
  return link.call(this, source, destination);
};
const remove = fs.rmSync;
fs.rmSync = function (path, ...rest) {
  if (fault === "cleanup" && /[/\\]native-session-[^/\\]+$/u.test(String(path))) {
    throw Object.assign(new Error("fixture refuses session-directory cleanup", { cause: new Error("authored cleanup cause") }),
      { code: "FIXTURE_CLEANUP_REFUSAL" });
  }
  return remove.call(this, path, ...rest);
};
syncBuiltinESMExports();

// The direct registered consumer accepts a caller signal without a new CLI flag.
// Workers inherit the bootstrap but never enter this parent-only invocation.
if (fault === "caller_abort" && process.argv[1] === fileURLToPath(import.meta.url)) {
  const { reasonInitialRecovery } = await import("../../../../dist/runs/semantic-chain/recovery-reason.js");
  process.stdout.write(`${JSON.stringify(await reasonInitialRecovery(process.argv[2], { signal: caller.signal }))}\n`);
}
