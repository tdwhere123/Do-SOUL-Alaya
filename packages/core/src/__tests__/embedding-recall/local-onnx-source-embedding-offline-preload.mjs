import childProcess from "node:child_process";
import dns from "node:dns";
import dgram from "node:dgram";
import http from "node:http";
import https from "node:https";
import http2 from "node:http2";
import net from "node:net";
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
const childReports = [];
const requests = [];
let responses = 0;
const credentialCount = () => Object.keys(process.env)
  .filter(key => /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/iu.test(key)).length;
const snapshot = phase => ({
  kind: "alaya-source-embedding-offline-guard", phase, pid: process.pid,
  installed_before_entry: childMode, shared_credential_guard: true,
  credential_environment_count: credentialCount(),
  transport_guards: [...transportGuards], violations: [...shared.violations], responses
});
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
  block(childProcess, key, `subprocess.${key}`);
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
    ...options, execArgv: ["--import", import.meta.url],
    env: { ...options.env, ALAYA_SOURCE_EMBEDDING_OFFLINE_CHILD: "1" }
  });
  const observation = { pid: child.pid, script, preload: import.meta.url, exited: false, code: null, signal: null };
  children.push(observation);
  child.on("message", message => {
    if (message?.kind === "alaya-source-embedding-offline-guard") childReports.push(message);
  });
  child.on("exit", (code, signal) => Object.assign(observation, { exited: true, code, signal }));
  const send = child.send;
  child.send = function (message, ...rest) {
    if (typeof message?.op === "string") requests.push({ op: message.op, inputs: message.inputs?.length ?? 0 });
    return Reflect.apply(send, this, [message, ...rest]);
  };
  return child;
});
if (childMode) {
  if (!nativeSend || !process.execArgv.includes("--import")) {
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

export const isolation = {
  children, childReports, requests,
  snapshot: () => snapshot("parent_checkpoint"),
  restore() {
    for (const restore of restores.reverse()) restore();
    shared.restore();
    syncBuiltinESMExports();
  }
};
