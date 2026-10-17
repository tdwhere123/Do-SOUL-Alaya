import childProcess from "node:child_process";
import dns from "node:dns";
import dgram from "node:dgram";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import http2 from "node:http2";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import { installProviderFreeBoundary } from "../../../../../apps/bench-runner/src/__tests__/support/provider-free-boundary.ts";

// The shared guard owns credential filtering/file refusal. This stricter local
// inference fixture also forbids loopback and non-fetch transports.
const shared = installProviderFreeBoundary();
const restores = [];
const childMode = process.env.ALAYA_SOURCE_EMBEDDING_OFFLINE_CHILD === "1";
const nativeSend = process.send?.bind(process);
const transportGuards = [];
const children = [];
const childHandles = [];
const childReports = [];
const requests = [];
const attemptedSends = [];
const dispatchedSends = [];
const blockedSends = [];
const readOnlyGitCalls = [];
const allowReadOnlyGit = !childMode && process.env.ALAYA_SOURCE_EMBEDDING_OFFLINE_ALLOW_GIT === "1";
const ALLOWED_CHILD_OPS = new Set(["warmup", "bind_source", "embed_source", "close"]);
let responses = 0;
let restored = false;
let explicitRunInputs = 0;
let warmupAttempted = 0;
let warmupDispatched = 0;
let observedApplicationReplies = 0;
let reportedOutcome = null;
const preloadSpecifier = import.meta.url;
const childImportArgv = ["--import", preloadSpecifier];
const reportedOutcomes = new Set(["success", "failure", "probe_failure"]);
const credentialKey = key => /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/iu.test(key);
const credentialCount = (env = process.env) => Object.keys(env).filter(credentialKey).length;
const snapshot = phase => {
  const common = {
    kind: "alaya-source-embedding-offline-guard", phase, pid: process.pid,
    preload_specifier: preloadSpecifier,
    credential_environment_count: credentialCount(),
    transport_guards: [...transportGuards], violations: [...shared.violations],
    local_responses: responses
  };
  return childMode
    ? { ...common, exec_argv: [...process.execArgv] }
    : {
      ...common,
      configured_child_exec_argv: [...childImportArgv],
      observed_application_replies: observedApplicationReplies
    };
};
const report = phase => {
  if (childMode && nativeSend && process.connected) nativeSend(snapshot(phase));
};
const appendViolation = shared.violations.push.bind(shared.violations);
shared.violations.push = (...entries) => {
  const length = appendViolation(...entries);
  report("violation");
  return length;
};
const deny = kind => {
  shared.violations.push(kind);
  throw new Error(`Offline Source embedding test refused ${kind}`);
};
function replace(owner, key, value) {
  const descriptor = Object.getOwnPropertyDescriptor(owner, key);
  if (!descriptor || typeof descriptor.value !== "function") {
    throw new Error(`Cannot establish offline guard for ${key}`);
  }
  Object.defineProperty(owner, key, { ...descriptor, value });
  restores.push(() => Object.defineProperty(owner, key, descriptor));
}
function block(owner, key, label) {
  replace(owner, key, function () { return deny(label); });
  transportGuards.push(label);
}
block(globalThis, "fetch", "fetch");
for (const [owner, keys, label] of [
  [http, ["request", "get"], "http"], [https, ["request", "get"], "https"],
  [http2, ["connect"], "http2"], [net.Socket.prototype, ["connect"], "socket"],
  [tls, ["connect"], "tls"], [dgram, ["createSocket"], "datagram"],
  [dns, ["lookup", "resolve", "resolve4", "resolve6"], "dns"],
  [dns.promises, ["lookup", "resolve", "resolve4", "resolve6"], "dns.promise"]
]) {
  for (const key of keys) block(owner, key, `${label}.${key}`);
}
for (const key of ["WebSocket", "EventSource"]) {
  if (typeof globalThis[key] === "function") block(globalThis, key, key);
}
for (const key of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync"]) {
  if (allowReadOnlyGit && ["execFile", "execFileSync"].includes(key)) {
    const native = childProcess[key];
    replace(childProcess, key, function (command, args, options, ...rest) {
      const authorityConfig = ["-c", "core.autocrlf=true", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false",
        "-c", "credential.helper=", "-c", "core.askPass="];
      const isAuthority = authorityConfig.every((value, index) => args?.[index] === value);
      const query = isAuthority ? args.slice(authorityConfig.length).filter(value => value !== "--no-pager") : args;
      const exact = expected => JSON.stringify(query) === JSON.stringify(expected);
      const permitted = key === "execFile" ? exact(["worktree", "list", "--porcelain"]) : isAuthority && (
        exact(["rev-parse", "HEAD", "--show-toplevel"]) || exact(["diff", "--no-ext-diff", "--binary", "HEAD", "--"]) ||
        exact(["ls-files", "--others", "--exclude-standard", "-z"]) ||
        query?.slice(0, 3).join(" ") === "hash-object --no-filters --" && query.length > 3 &&
          query.slice(3).every(path => !/(?:^|[/\\])(?:\.env(?:\.[^/\\]+)?|credentials(?:\.json)?|auth\.json)(?:$|[/\\])/iu.test(path)));
      if (command !== "git" || !permitted || options?.shell) return deny(`unexpected ${key}`);
      const offered = options?.env ?? {};
      const env = Object.fromEntries(Object.entries(offered).filter(([name]) =>
        !/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|NODE_OPTIONS)/iu.test(name)));
      Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" });
      readOnlyGitCalls.push({ command, args, credential_environment_count: credentialCount(env) });
      return Reflect.apply(native, this, [command, args, { ...options, env }, ...rest]);
    });
    transportGuards.push(`subprocess.${key}.read-only-git-only`);
  } else block(childProcess, key, `subprocess.${key}`);
}

function parseInputCap() {
  const raw = process.env.ALAYA_SOURCE_EMBEDDING_OFFLINE_INPUT_CAP;
  // Missing env is a default per-send bound of 2, never an unbounded payload.
  if (raw === undefined || raw === "") return { cap: 2, explicit: false };
  if (raw === "2" || raw === "3") return { cap: Number.parseInt(raw, 10), explicit: true };
  return null;
}

function payloadCounts(message) {
  if (message.inputs !== undefined && !Array.isArray(message.inputs)) {
    deny("opaque inference inputs");
  }
  if (message.texts !== undefined && !Array.isArray(message.texts)) {
    deny("opaque inference texts");
  }
  const inputs = Array.isArray(message.inputs) ? message.inputs.length : 0;
  const texts = Array.isArray(message.texts) ? message.texts.length : 0;
  return { inputs, texts, total: inputs + texts };
}

function sendMeta(op, payload) {
  return { op, inputs: payload.inputs, texts: payload.texts };
}

function refuseSend(kind, meta) {
  blockedSends.push({ ...meta, reason: kind });
  deny(kind);
}

function guardChildSend(message, send, rest) {
  if (typeof message?.op !== "string") {
    return Reflect.apply(send, this, [message, ...rest]);
  }
  const payload = payloadCounts(message);
  const meta = sendMeta(message.op, payload);
  attemptedSends.push(meta);
  if (message.op === "warmup") warmupAttempted += 1;
  const parsed = parseInputCap();
  if (parsed === null) refuseSend("invalid inference input cap", meta);
  const cap = parsed?.cap ?? 2;
  const explicit = parsed?.explicit === true;
  if (!ALLOWED_CHILD_OPS.has(message.op)) {
    refuseSend(`unexpected model-bearing op ${message.op}`, meta);
  }
  if (message.op !== "embed_source" && payload.total !== 0) {
    refuseSend(`${message.op} with model inputs`, meta);
  }
  if (message.op === "embed_source") {
    if (payload.total > cap) refuseSend("pre-send inference input cap", meta);
    if (explicit && explicitRunInputs + payload.total > cap) {
      refuseSend("pre-send inference input cap", meta);
    }
    if (explicit) explicitRunInputs += payload.total;
  }
  if (message.op === "warmup") warmupDispatched += 1;
  requests.push({ op: message.op, inputs: message.op === "embed_source" ? payload.total : payload.inputs });
  dispatchedSends.push(meta);
  return Reflect.apply(send, this, [message, ...rest]);
}

function childExitUnknown() {
  return children.some((child, index) => {
    if (child.exited) return false;
    const handle = childHandles[index];
    if (handle && handle.exitCode !== null && handle.exitCode !== undefined) {
      Object.assign(child, { exited: true, code: handle.exitCode, signal: handle.signalCode ?? null });
      return false;
    }
    return true;
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function reapChild(handle, observation) {
  if (!handle || observation.exited) return;
  if (handle.exitCode !== null && handle.exitCode !== undefined) {
    Object.assign(observation, { exited: true, code: handle.exitCode, signal: handle.signalCode ?? null });
    return;
  }
  const exited = new Promise(resolve => {
    handle.once("exit", (code, signal) => {
      Object.assign(observation, { exited: true, code, signal });
      resolve();
    });
  });
  try {
    handle.send?.({ op: "close", id: 0, modelId: "", cacheDir: null, schemaVersion: 0 });
  } catch {
    // Handle may already be disconnected; kill still owns the recorded process.
  }
  if (observation.exited) return;
  try { handle.kill("SIGTERM"); } catch { /* gone */ }
  if (observation.exited) return;
  if (await Promise.race([exited.then(() => true), sleep(5_000).then(() => false)])) return;
  try { handle.kill("SIGKILL"); } catch { /* gone */ }
  await Promise.race([exited.then(() => true), sleep(1_000).then(() => false)]);
}

function childExitRecord(child, index) {
  return {
    pid: child.pid ?? null, script: child.script ?? null, preload: child.preload ?? null,
    exited: child.exited === true, code: child.code, signal: child.signal,
    // exit_confirmed is process-exit observation only, not graceful handler completion.
    exit_confirmed: child.exited === true,
    exit_confirmed_scope: "process_exit_observed_not_handler_completion",
    handle_owned: childHandles[index] != null
  };
}

function receiptRecord(reason) {
  const parsed = parseInputCap();
  const unknown = childExitUnknown();
  return {
    kind: "alaya-source-embedding-offline-parent-guard-receipt",
    reason,
    reported_outcome: reportedOutcome,
    pid: process.pid,
    preload_specifier: preloadSpecifier,
    configured_child_exec_argv: [...childImportArgv],
    input_cap: parsed?.cap ?? null,
    input_cap_source: parsed === null ? "invalid" : parsed.explicit ? "explicit" : "default",
    attempted_sends: attemptedSends.map(row => ({ ...row })),
    dispatched_sends: dispatchedSends.map(row => ({ ...row })),
    blocked_sends: blockedSends.map(row => ({ ...row })),
    warmup: { attempted: warmupAttempted, dispatched: warmupDispatched, model_execution_work: "unknown" },
    credential_environment_count: credentialCount(),
    transport_guards: [...transportGuards],
    violations: [...shared.violations],
    children: children.map((child, index) => childExitRecord(child, index)),
    cleanup: unknown ? "exit_unknown" : "confirmed",
    read_only_git: readOnlyGitCalls.map(call => ({
      command: call.command, arg_count: call.args?.length ?? 0,
      credential_environment_count: call.credential_environment_count
    })),
    local_responses: responses,
    observed_application_replies: observedApplicationReplies
  };
}

function writeGuardReceipts(reason) {
  if (childMode) return;
  if (reportedOutcomes.has(reason)) reportedOutcome = reason;
  const dir = process.env.ALAYA_SOURCE_EMBEDDING_OFFLINE_GUARD_RECEIPT_DIR;
  if (typeof dir !== "string" || dir.length === 0) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "parent-guard-receipt.json"), JSON.stringify(receiptRecord(reason)));
  fs.writeFileSync(path.join(dir, "child-guard-receipt.json"), JSON.stringify({
    kind: "alaya-source-embedding-offline-child-guard-receipt", reason,
    reported_outcome: reportedOutcome,
    reports: childReports.map(row => ({
      phase: row.phase, pid: row.pid, preload_specifier: row.preload_specifier,
      exec_argv: row.exec_argv, credential_environment_count: row.credential_environment_count,
      transport_guards: row.transport_guards, violations: row.violations,
      local_responses: row.local_responses
    })),
    children: children.map((child, index) => childExitRecord(child, index))
  }));
}

// Production deliberately removes NODE_OPTIONS and execArgv. Instrument only
// its real default fork: retain its script/IPC implementation, add early preload.
const productionChild = fileURLToPath(new URL("../../../dist/embedding-recall/local-onnx-process/child.js", import.meta.url));
const nativeFork = childProcess.fork;
replace(childProcess, "fork", function (script, args, options) {
  if (childMode || children.length !== 0 || script !== productionChild || args?.length !== 0 ||
      options?.execArgv?.length !== 0 || options.env?.NODE_OPTIONS !== undefined) {
    return deny("unexpected subprocess or production fork configuration");
  }
  const child = nativeFork(script, args, {
    ...options, execArgv: [...childImportArgv],
    env: { ...options.env, ALAYA_SOURCE_EMBEDDING_OFFLINE_CHILD: "1" }
  });
  const observation = { pid: child.pid, script, preload: preloadSpecifier, exited: false, code: null, signal: null };
  childHandles.push(child);
  children.push(observation);
  child.on("message", message => {
    if (message?.kind === "alaya-source-embedding-offline-guard") {
      childReports.push(message);
      return;
    }
    if (Number.isInteger(message?.id) && typeof message.ok === "boolean") {
      observedApplicationReplies += 1;
    }
  });
  child.on("exit", (code, signal) => Object.assign(observation, { exited: true, code, signal }));
  const send = child.send?.bind(child);
  child.send = function (message, ...rest) {
    return guardChildSend.call(this, message, send, rest);
  };
  return child;
});
if (childMode) {
  const importIndex = process.execArgv.indexOf("--import");
  if (!nativeSend || importIndex < 0 || process.execArgv[importIndex + 1] !== preloadSpecifier) {
    throw new Error("Offline child preload has no guarded IPC establishment channel");
  }
  // A caught refusal still reaches the parent. Each application response carries
  // a preceding guard checkpoint; IPC cannot silently turn a refusal into green.
  replace(process, "send", function (message, ...rest) {
    if (Number.isInteger(message?.id) && typeof message.ok === "boolean") {
      responses += 1;
      report("application_response");
    }
    return nativeSend(message, ...rest);
  });
}
syncBuiltinESMExports();
if (credentialCount() !== 0) throw new Error("Offline credential environment filtering failed");
report("installed");
process.on("exit", () => {
  if (shared.violations.length > 0) process.exitCode = 1;
});

function restore() {
  if (restored) return;
  if (childExitUnknown()) {
    writeGuardReceipts("restore_refused_live_child");
    throw new Error("Offline isolation restore refused while a guarded child is live");
  }
  writeGuardReceipts("restore");
  restored = true;
  for (const undo of restores.reverse()) undo();
  shared.restore();
  syncBuiltinESMExports();
}

export const isolation = {
  children, childReports, requests, readOnlyGitCalls, attemptedSends, dispatchedSends, blockedSends,
  snapshot: () => snapshot("parent_checkpoint"),
  writeReceipts: writeGuardReceipts,
  async close() {
    if (restored) return;
    for (let index = 0; index < childHandles.length; index += 1) {
      await reapChild(childHandles[index], children[index]);
    }
    const unknown = childExitUnknown();
    writeGuardReceipts(unknown ? "close_exit_unknown" : "close");
    if (unknown) throw new Error("Offline isolation close did not confirm child exit");
    restore();
  },
  restore
};
