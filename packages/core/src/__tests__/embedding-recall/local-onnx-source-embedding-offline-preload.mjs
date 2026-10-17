import childProcess from "node:child_process";
import dns from "node:dns";
import dgram from "node:dgram";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import http2 from "node:http2";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import { installProviderFreeBoundary } from "../../../../../apps/bench-runner/src/__tests__/support/provider-free-boundary.ts";
import { createReadOnlyGitExecutionPolicy } from "../../../../../apps/bench-runner/src/__tests__/support/read-only-git-boundary.mjs";

const preloadSpecifier = import.meta.url;
const sourceAllocation = parseSourceAllocation(new URL(preloadSpecifier));
const allocatedInputCap = sourceAllocation === null ? null : Object.freeze(parseInputCap());
if (sourceAllocation !== null && allocatedInputCap === null) throw new Error("Invalid offline inference input cap");
// Query configuration is a test-launch capability, not an application/env API.
// A different import URL must not create a fresh allocation in the same process.
const installation = Symbol.for("alaya.source-embedding-offline-guard");
if (globalThis[installation]) throw new Error("Offline Source guard is already installed");
const instance = Object.freeze({});
Object.defineProperty(globalThis, installation, { value: instance });

// The shared guard owns credential filtering/file refusal. This stricter local
// inference fixture also forbids loopback and non-fetch transports.
const shared = installProviderFreeBoundary();
const activeReferences = [];
for (const owner of [fs, fsp]) for (const key of ["readFile", "readFileSync", "open", "openSync", "createReadStream"]) {
  if (typeof owner[key] === "function") activeReferences.push({ owner, key, value: owner[key] });
}
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
const reservedSends = [];
const forwardUnknownSends = [];
let explicitRunInputs = 0;
let reservedBytes = 0;
const readOnlyGitCalls = [];
const allowReadOnlyGit = !childMode && process.env.ALAYA_SOURCE_EMBEDDING_OFFLINE_ALLOW_GIT === "1";
const readOnlyGitPolicy = allowReadOnlyGit ? createReadOnlyGitExecutionPolicy() : null;
const ALLOWED_CHILD_OPS = new Set(["warmup", "bind_source", "embed_source", "close"]);
let responses = 0;
let restored = false;
let warmupAttempted = 0;
let warmupDispatched = 0;
let observedApplicationReplies = 0;
let reportedOutcome = null;
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
    local_responses: responses,
    ...allocationRecord()
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
  activeReferences.push({ owner, key, value });
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
        exact(["rev-parse", "HEAD", "--show-toplevel"]) || exact(["diff", "--no-ext-diff", "--no-textconv", "--binary", "HEAD", "--"]) ||
        exact(["ls-files", "--others", "--exclude-standard", "-z"]) ||
        query?.slice(0, 3).join(" ") === "hash-object --no-filters --" && query.length > 3 &&
          query.slice(3).every(path => !/(?:^|[/\\])(?:\.env(?:\.[^/\\]+)?|credentials(?:\.json)?|auth\.json)(?:$|[/\\])/iu.test(path)));
      if (command !== "git" || !permitted || options?.shell) return deny(`unexpected ${key}`);
      let invocation;
      try { invocation = readOnlyGitPolicy.prepare(command, options); }
      catch { return deny(`unexpected ${key} execution context`); }
      readOnlyGitCalls.push({ ...invocation.receipt, args });
      return Reflect.apply(native, this, [invocation.executable, args, invocation.options, ...rest]);
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

function parseSourceAllocation(url) {
  const names = ["source_input_cap", "source_utf8_byte_cap"];
  if (names.every(name => !url.searchParams.has(name))) return null;
  const values = names.map(name => {
    const entries = url.searchParams.getAll(name);
    const raw = entries[0];
    const value = Number(raw);
    if (entries.length !== 1 || !/^(?:0|[1-9][0-9]*)$/u.test(raw ?? "") || !Number.isSafeInteger(value)) {
      throw new Error(`Invalid offline Source allocation: ${name}`);
    }
    return value;
  });
  return Object.freeze({ source_inputs: values[0], utf8_bytes: values[1] });
}

function cumulativeInputCap(inputCap) {
  const explicitCap = inputCap?.explicit ? inputCap.cap : null;
  if (sourceAllocation === null) return explicitCap;
  // An allocation adds a constraint; it never enlarges an explicit legacy ceiling.
  return explicitCap === null ? sourceAllocation.source_inputs : Math.min(sourceAllocation.source_inputs, explicitCap);
}

function allocationRecord() {
  const inputCap = allocatedInputCap ?? parseInputCap();
  const totals = rows => rows.reduce((sum, row) => ({ sends: sum.sends + 1,
    source_inputs: sum.source_inputs + (row.inputs ?? 0) + (row.texts ?? 0), utf8_bytes: sum.utf8_bytes + (row.utf8_bytes ?? 0)
  }), { sends: 0, source_inputs: 0, utf8_bytes: 0 });
  return {
    input_cap: inputCap?.cap ?? null, input_cap_source: inputCap === null ? "invalid" : inputCap.explicit ? "explicit" : "default",
    input_cap_scope: "per_send",
    cumulative_input_cap: cumulativeInputCap(inputCap),
    cumulative_input_cap_source: sourceAllocation !== null
      ? inputCap?.explicit ? "allocation_and_explicit" : "allocation" : inputCap?.explicit ? "explicit" : "unconfigured",
    explicit_cumulative_input_cap: inputCap?.explicit ? inputCap.cap : null,
    cumulative_input_reserved: explicitRunInputs,
    source_allocation: sourceAllocation === null ? { status: "unconfigured" }
      : { status: "configured", scope: "per_process", ...sourceAllocation },
    allocation_usage: { reserved: totals(reservedSends), dispatched: totals(dispatchedSends),
      blocked: totals(blockedSends), forward_unknown: totals(forwardUnknownSends),
      inference_occupancy: requests.some(row => row.op !== "close") ? "unknown" : "none_observed" },
    warmup: { attempted: warmupAttempted, dispatched: warmupDispatched, model_execution_work: "unknown" },
    // Child checkpoints carry counts, not quadratic copies of the complete run.
    last_blocked_send: blockedSends.length > 0 ? { ...blockedSends.at(-1) } : null
  };
}

function payloadCounts(message) {
  let utf8Bytes = 0;
  for (const key of ["inputs", "texts"]) {
    if (message[key] === undefined) continue;
    if (!Array.isArray(message[key])) throw new Error(`opaque inference ${key}`);
    for (const input of message[key]) {
      const text = typeof input === "string" ? input : key === "inputs" ? input?.text : undefined;
      if (typeof text !== "string") throw new Error(`opaque inference ${key} text`);
      utf8Bytes += Buffer.byteLength(text, "utf8");
    }
  }
  const inputs = message.inputs?.length ?? 0;
  const texts = message.texts?.length ?? 0;
  return { inputs, texts, total: inputs + texts, utf8_bytes: utf8Bytes };
}

function refuseSend(kind, meta) {
  blockedSends.push({ ...meta, reason: kind });
  deny(kind);
}

function guardChildSend(offered, send, rest) {
  // Validate and forward the same capture: getters, mutation and toJSON cannot
  // change the charged strings after the admission decision.
  let message;
  try { message = structuredClone(offered); } catch { return refuseSend("uncapturable inference payload", {}); }
  if (typeof message?.op !== "string") return Reflect.apply(send, this, [message, ...rest]);
  let payload;
  try { payload = payloadCounts(message); } catch (error) { return refuseSend(error.message, { op: message.op }); }
  const inputCap = allocatedInputCap ?? parseInputCap();
  const meta = { op: message.op, inputs: payload.inputs, texts: payload.texts, utf8_bytes: payload.utf8_bytes,
    input_cap: inputCap?.cap ?? null, input_cap_source: inputCap === null ? "invalid" : inputCap.explicit ? "explicit" : "default" };
  attemptedSends.push(meta);
  if (message.op === "warmup") warmupAttempted += 1;
  if (inputCap === null) refuseSend("invalid inference input cap", meta);
  if (!ALLOWED_CHILD_OPS.has(message.op)) refuseSend(`unexpected model-bearing op ${message.op}`, meta);
  if (message.op !== "embed_source" && payload.total !== 0) refuseSend(`${message.op} with model inputs`, meta);
  if (message.op === "embed_source") {
    if (payload.total > inputCap.cap) refuseSend("pre-send inference input cap", meta);
    // Both constraints reserve against the existing run counter, never competing meters.
    const totalCap = cumulativeInputCap(inputCap);
    if (totalCap !== null && payload.total > totalCap - explicitRunInputs) {
      refuseSend(sourceAllocation === null ? "pre-send inference input cap" : "cumulative Source input cap", meta);
    }
    if (sourceAllocation !== null && payload.utf8_bytes > sourceAllocation.utf8_bytes - reservedBytes) {
      refuseSend("cumulative Source UTF-8 byte cap", meta);
    }
    // Reservation survives a throwing/unknown forward and cannot fund a retry.
    if (totalCap !== null) explicitRunInputs += payload.total;
    reservedBytes += payload.utf8_bytes;
    reservedSends.push(meta);
  }
  requests.push({ op: message.op, inputs: message.op === "embed_source" ? payload.total : payload.inputs });
  let result;
  try { result = Reflect.apply(send, this, [message, ...rest]); }
  catch (error) { forwardUnknownSends.push(meta); report("forward_unknown"); throw error; }
  if (message.op === "warmup") warmupDispatched += 1;
  dispatchedSends.push(meta);
  report("dispatch");
  return result;
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
  const unknown = childExitUnknown();
  return {
    kind: "alaya-source-embedding-offline-parent-guard-receipt",
    reason,
    reported_outcome: reportedOutcome,
    pid: process.pid,
    preload_specifier: preloadSpecifier,
    configured_child_exec_argv: [...childImportArgv],
    ...allocationRecord(),
    attempted_sends: attemptedSends.map(row => ({ ...row })),
    reserved_sends: reservedSends.map(row => ({ ...row })),
    dispatched_sends: dispatchedSends.map(row => ({ ...row })),
    blocked_sends: blockedSends.map(row => ({ ...row })),
    forward_unknown_sends: forwardUnknownSends.map(row => ({ ...row })),
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
      local_responses: row.local_responses,
      input_cap: row.input_cap, input_cap_source: row.input_cap_source, input_cap_scope: row.input_cap_scope,
      cumulative_input_cap: row.cumulative_input_cap, cumulative_input_cap_source: row.cumulative_input_cap_source,
      explicit_cumulative_input_cap: row.explicit_cumulative_input_cap,
      cumulative_input_reserved: row.cumulative_input_reserved, last_blocked_send: row.last_blocked_send,
      source_allocation: row.source_allocation, allocation_usage: row.allocation_usage, warmup: row.warmup
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
  const inputCap = allocatedInputCap ?? parseInputCap();
  if (inputCap === null) return deny("invalid inference input cap");
  const child = nativeFork(script, args, {
    ...options, execArgv: [...childImportArgv],
    env: { ...options.env, ALAYA_SOURCE_EMBEDDING_OFFLINE_CHILD: "1",
      ALAYA_SOURCE_EMBEDDING_OFFLINE_INPUT_CAP: inputCap.explicit ? String(inputCap.cap) : "" }
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
  // Guard the existing IPC ingress before any application listener/inference.
  const emit = process.emit;
  Object.defineProperty(process, "emit", { configurable: true, writable: true, value: function (event, ...args) {
    if (event !== "message") return Reflect.apply(emit, this, [event, ...args]);
    const forward = message => Reflect.apply(emit, this, [event, message, ...args.slice(1)]);
    return guardChildSend.call(this, args[0], forward, []);
  } });
  restores.push(() => { delete process.emit; });
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

export const isolation = Object.freeze({
  /** Owned launch admission checks the installed functions and this module instance, not a marker.
   * Recheck without unused after shutdown; the guard is retained until reconciliation completes. */
  assertActive({ preload, inputs, bytes, unused = false }) {
    if (restored || globalThis[installation] !== instance || preload !== preloadSpecifier || childMode ||
        sourceAllocation?.source_inputs !== inputs || sourceAllocation?.utf8_bytes !== bytes ||
        allocatedInputCap?.explicit !== false || allocatedInputCap?.cap !== 2 ||
        activeReferences.some(({ owner, key, value }) => owner[key] !== value) ||
        shared.violations.length !== 0 || credentialCount() !== 0 ||
        process.execArgv.length !== 2 || process.execArgv[0] !== "--import" || process.execArgv[1] !== preloadSpecifier ||
        unused && (childHandles.length !== 0 || children.length !== 0 || requests.length !== 0 || attemptedSends.length !== 0 ||
          warmupAttempted !== 0 || observedApplicationReplies !== 0 || responses !== 0 ||
          reservedSends.length !== 0 || blockedSends.length !== 0 || explicitRunInputs !== 0 || reservedBytes !== 0)) {
      throw new Error("Offline Source guard is not active with the expected unused launch allocation");
    }
    return { ...snapshot("active_inspection"), installed_references: activeReferences.length };
  },
  receipts: reason => ({ parent: receiptRecord(reason), child: {
    kind: "alaya-source-embedding-offline-child-guard-receipt", reports: structuredClone(childReports),
    children: children.map((child, index) => childExitRecord(child, index))
  } }),
  children, childReports, requests, readOnlyGitCalls, attemptedSends, dispatchedSends, blockedSends,
  snapshot: () => snapshot("parent_checkpoint"),
  writeReceipts: writeGuardReceipts,
  async closeChildren() {
    for (let index = 0; index < childHandles.length; index += 1) {
      await reapChild(childHandles[index], children[index]);
    }
    const unknown = childExitUnknown();
    writeGuardReceipts(unknown ? "close_exit_unknown" : "close");
    if (unknown) throw new Error("Offline isolation close did not confirm child exit");
  },
  async close() {
    if (restored) return;
    await this.closeChildren();
    restore();
  },
  restore
});
