import cp from "node:child_process";
import dns from "node:dns";
import dgram from "node:dgram";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import http2 from "node:http2";
import net from "node:net";
import tls from "node:tls";
import workers from "node:worker_threads";
import { createRequire, registerHooks, syncBuiltinESMExports } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installProviderFreeBoundary } from "./provider-free-boundary.ts";
import { createReadOnlyGitExecutionPolicy } from "./read-only-git-boundary.mjs";
import { createAuthorityRevisionGitPolicy } from "./authority-revision-git-boundary.mjs";

// Install before application imports, in both the fixture process and its pinned
// SQLite read worker. This is a JS effect guard, not an OS sandbox or filesystem jail.
const shared = installProviderFreeBoundary();
export const operations = [];
const restores = [];
const require = createRequire(import.meta.url);
const readOnlyGitPolicy = workers.isMainThread ? createReadOnlyGitExecutionPolicy() : null;
const nativeExecFile = cp.execFile;
const nativeExecFileSync = cp.execFileSync;
// Only an explicit preload URL binding admits the production revision reader.
const authorityCheckout = new URL(import.meta.url).searchParams.get("authority_checkout");
const authorityGitPolicy = workers.isMainThread && authorityCheckout !== null
  ? createAuthorityRevisionGitPolicy(authorityCheckout) : null;
const readWorker = new URL("../../../../core-daemon/dist/runtime/recall/recall-read-worker.js", import.meta.url).href;
const platform = process.platform === "linux" && !process.report.getReport().header.glibcVersionRuntime
  ? "linuxmusl" : process.platform;
const sqlite = fs.realpathSync(fileURLToPath(new URL(`prebuilds/${platform}-${process.arch}.node`,
  pathToFileURL(require.resolve("better-sqlite3/package.json")))));
const cjkRequire = createRequire(new URL("../../../../../packages/cjk-segmentation/package.json", import.meta.url));
const jiebaRequire = createRequire(cjkRequire.resolve("@node-rs/jieba"));
// Resolve the installed platform binary without loading it. CJK tokenization is
// not model execution; full daemon startup warms this existing native segmenter.
const nativePins = new Set([sqlite]);
const jiebaPackage = JSON.parse(fs.readFileSync(jiebaRequire.resolve("@node-rs/jieba/package.json"), "utf8"));
for (const name of Object.keys(jiebaPackage.optionalDependencies ?? {})) {
  try { nativePins.add(fs.realpathSync(jiebaRequire.resolve(name))); } catch { /* Other platforms are not installed. */ }
}
const forbiddenModule = value => /(?:@huggingface[+/]transformers|onnxruntime|@ai-sdk[+/](?:openai|anthropic|google)|(?:^|[/])(?:openai|@anthropic-ai)(?:[/]|$))/iu.test(value);
const record = (operation, detail = {}) => {
  const row = { operation, ...detail, stack: new Error(operation).stack };
  operations.push(row);
  return row;
};
const pushViolation = shared.violations.push.bind(shared.violations);
shared.violations.push = (...kinds) => {
  for (const kind of kinds) record(kind, { blocked: true });
  return pushViolation(...kinds);
};
const deny = (operation, detail = {}) => {
  const row = record(operation, { ...detail, blocked: true });
  process.stderr.write(`[source-import-guard] ${JSON.stringify(row)}\n`);
  throw new Error(`Source import fixture refused ${operation}`);
};
function replace(owner, key, value) {
  const descriptor = Object.getOwnPropertyDescriptor(owner, key);
  if (typeof descriptor?.value !== "function") throw new Error(`Cannot guard ${key}`);
  Object.defineProperty(owner, key, { ...descriptor, value });
  restores.push(() => Object.defineProperty(owner, key, descriptor));
}
function block(owner, key, label) { replace(owner, key, () => deny(label)); }
for (const [owner, keys, label] of [
  [globalThis, ["fetch"], "fetch"], [http, ["request", "get"], "http"],
  [https, ["request", "get"], "https"], [http2, ["connect"], "http2"],
  [net, ["connect", "createConnection"], "net"], [net.Socket.prototype, ["connect"], "socket"],
  [tls, ["connect"], "tls"], [dgram, ["createSocket"], "datagram"],
  [dns, ["lookup", "resolve", "resolve4", "resolve6"], "dns"],
  [dns.promises, ["lookup", "resolve", "resolve4", "resolve6"], "dns.promise"],
  [cp, ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"], "process"]
]) for (const key of keys) block(owner, key, `${label}.${key}`);
replace(cp, "execFile", function(command, args, options, ...rest) {
  const optionKeys = new Set(["encoding", "timeout", "windowsHide", "env", "cwd"]);
  if (!workers.isMainThread || command !== "git" || !Array.isArray(args) ||
      args.length !== 3 || args[0] !== "worktree" || args[1] !== "list" || args[2] !== "--porcelain" ||
      options === null || typeof options !== "object" || Object.keys(options).some(key => !optionKeys.has(key))) {
    return deny("process.execFile", { command: typeof command === "string" ? command : "invalid" });
  }
  let invocation;
  try { invocation = readOnlyGitPolicy.prepare(command, options, { rejectEnvironmentInjection: true }); }
  catch { return deny("process.execFile.context"); }
  record("process.execFile.read-only-git.allowed", { ...invocation.receipt, args: [...args] });
  return Reflect.apply(nativeExecFile, this, [invocation.executable, args, invocation.options, ...rest]);
});
replace(cp, "execFileSync", function(command, args, options) {
  if (!authorityGitPolicy) return deny("process.execFileSync");
  let operation, invocation;
  try {
    operation = authorityGitPolicy.prepare(command, args, options);
    invocation = readOnlyGitPolicy.prepare(command, options);
  } catch { return deny("process.execFileSync.authority-context"); }
  record("process.execFileSync.authority-git.allowed", { ...invocation.receipt, args: [...args] });
  const result = Reflect.apply(nativeExecFileSync, this, [invocation.executable, args, invocation.options]);
  try { authorityGitPolicy.observe(operation, result); }
  catch { return deny("process.execFileSync.authority-path"); }
  return result;
});
for (const key of ["WebSocket", "EventSource"]) if (typeof globalThis[key] === "function") block(globalThis, key, key);
const nativeDlopen = process.dlopen;
let samePhysicalLocation;
replace(process, "dlopen", function(module, filename, ...rest) {
  const path = fs.realpathSync(filename);
  if (!samePhysicalLocation || ![...nativePins].some(pin => samePhysicalLocation(pin, path))) {
    return deny("native-addon.load", { path });
  }
  record("native-addon.load.allowed", { path });
  return Reflect.apply(nativeDlopen, this, [module, filename, ...rest]);
});
const NativeWorker = workers.Worker;
replace(workers, "Worker", class extends NativeWorker {
  constructor(url, options = {}) {
    const workerURL = url instanceof URL ? url.href : String(url);
    if (workerURL !== readWorker || options.eval) deny("worker.create", { workerURL });
    record("worker.create.allowed", { workerURL });
    super(url, { ...options, execArgv: ["--import", import.meta.url] });
  }
});
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    if (forbiddenModule(specifier) || forbiddenModule(result.url)) {
      record("package.resolve.metadata", { specifier, url: result.url });
    }
    return result;
  },
  load(url, context, nextLoad) {
    if (forbiddenModule(url)) deny("model-provider.module.load", { url });
    return nextLoad(url, context);
  }
});
syncBuiltinESMExports();
// Load only the builtins-only physical-path owner, after all effect guards are active.
({ samePhysicalLocation } = await import("../../runs/fs/opened-contained-path.ts"));
export function receipt() {
  return { operations: [...operations], credential_file_violations: [...shared.violations],
    pinned_read_worker: readWorker, native_pins: [...nativePins], thread_id: workers.threadId };
}
const monitor = error => {
  process.stderr.write(`[source-import-guard] uncaught ${error.stack ?? String(error)}\n`);
};
const onExit = () => {
  process.stderr.write(`[source-import-guard-receipt] ${JSON.stringify(receipt())}\n`);
  if (shared.violations.length > 0 || operations.some(row => row.blocked)) {
    process.exitCode = 1;
  }
};
process.on("uncaughtExceptionMonitor", monitor);
process.on("exit", onExit);

/** Vitest callers restore process-wide effects after their isolated file. Child
 * fixture imports retain the guard until exit, as before. */
export function restore() {
  hooks.deregister();
  process.off("uncaughtExceptionMonitor", monitor); process.off("exit", onExit);
  for (const restore of restores.reverse()) restore();
  shared.restore(); syncBuiltinESMExports();
}
export const pinnedReadWorker = fileURLToPath(readWorker);
