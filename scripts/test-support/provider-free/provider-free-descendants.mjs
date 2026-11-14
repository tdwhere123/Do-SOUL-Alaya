import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import workers from "node:worker_threads";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ProviderFreeIsolation, ISOLATION_SIGNAL_FAILURE_EXIT } from "./provider-free-isolation.mjs";

export const providerFreeDescendantPreload = new URL("./provider-free-descendant-bootstrap.mjs", import.meta.url).href;
const ownerKey = Symbol.for("alaya.provider-free-descendant-owner");
// Native --import and Vitest can evaluate this module in separate caches while
// mutating the same builtins. Share both the wrappers and their preload leases.
const owner = process[ownerKey] ??= { installed: undefined };

/** Neutral and CLI --import share this owner so a child can enroll its own descendants. */
export function installProviderFreeActor(preload) {
  const isolation = new ProviderFreeIsolation();
  // Same-process boundary re-entry must join this journal; wrap already injects it into children.
  process.env = isolation.environment(process.env);
  isolation.ready();
  installProviderFreeDescendants(isolation, preload);
  process.on("exit", () => {
    try { isolation.assertSafe(); }
    catch { if (process.exitCode !== ISOLATION_SIGNAL_FAILURE_EXIT) process.exitCode = 1; }
  });
  return isolation;
}

/** Propagation and lifetime evidence belong to the isolation guard, not product reap callbacks. */
export function installProviderFreeDescendants(signal, preload) {
  const binding = JSON.stringify(signal.binding);
  if (owner.installed !== undefined) {
    if (owner.installed.binding !== binding) throw new Error("Conflicting descendant isolation owner");
    owner.installed.preloads.set(preload, (owner.installed.preloads.get(preload) ?? 0) + 1);
    owner.installed.ownedPreloads.add(preload);
    return () => release(preload);
  }
  const restores = [], preloads = new Map([[preload, 1]]), ownedPreloads = new Set([preload]);
  // A stricter fixture owns its child entry; neutral registration is the fallback.
  const activePreloads = () => preloads.size > 1
    ? [...preloads.keys()].filter(value => value !== providerFreeDescendantPreload) : [...preloads.keys()];
  const hasImport = (args, value) => args.some((argument, index) =>
    argument === `--import=${value}` || argument === "--import" && args[index + 1] === value);
  const argv = (supplied) => {
    const offered = supplied ?? process.execArgv, selected = [];
    for (let index = 0; index < offered.length; index++) {
      const argument = offered[index], value = argument === "--import" ? offered[index + 1]
        : argument.startsWith("--import=") ? argument.slice(9) : undefined;
      if (value !== undefined && ownedPreloads.has(value) && !activePreloads().includes(value)) {
        if (argument === "--import") index++;
      } else selected.push(argument);
    }
    for (const value of activePreloads()) {
      if (!hasImport(selected, value)) selected.push(`--import=${value}`);
    }
    return selected;
  };
  const processArgv = (supplied) => [
    ...activePreloads().filter(value => !hasImport(supplied, value)).map(value => `--import=${value}`), ...supplied
  ];
  const env = (supplied, member) => {
    const selected = signal.environment(supplied, member);
    selected.NODE_OPTIONS = [filterOwnedNodeImports(selected.NODE_OPTIONS ?? "", ownedPreloads),
      ...activePreloads().map(value => `--import=${value}`)].join(" ").trim();
    return selected;
  };
  const monitor = (child, member, key) => {
    const emit = child.emit;
    child.emit = function (event, ...args) {
      if (event === "exit") signal.exited(member, args[0], args[1] ?? null);
      if (event === "error" && "pid" in child && child.pid === undefined) signal.spawnFailed(member);
      return Reflect.apply(emit, this, [event, ...args]);
    };
    const cancel = Reflect.get(child, key);
    Reflect.set(child, key, new Proxy(cancel, { apply(target, receiver, args) {
      if (args[0] !== 0) signal.cancelled(member);
      return Reflect.apply(target, receiver, args);
    } }));
    return child;
  };

  const fork = cp.fork;
  cp.fork = (modulePath, argsOrOptions, suppliedOptions) => {
    const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
    const settings = Array.isArray(argsOrOptions) ? suppliedOptions : argsOrOptions;
    const member = signal.reserve("fork");
    try { return monitor(fork(modulePath, args, { ...settings, env: env(settings?.env, member),
      execArgv: argv(settings?.execArgv) }), member, "kill"); }
    catch (error) { signal.spawnFailed(member); throw error; }
  };
  restores.push(() => { cp.fork = fork; });

  const Worker = workers.Worker;
  workers.Worker = new Proxy(Worker, { construct(target, [filename, settings = {}], newTarget) {
    if (settings.env === workers.SHARE_ENV) {
      signal.violation("unverifiable shared Worker environment");
      throw new Error("Provider-free Worker requires an isolated environment");
    }
    const member = signal.reserve("worker");
    // Node omits --import execution for CommonJS eval workers.
    const guarded = settings.eval === true
      ? `${activePreloads().map(value => `require(${JSON.stringify(fileURLToPath(value))});`).join("\n")}\n${filename}` : filename;
    try { return monitor(Reflect.construct(target,
      [guarded, { ...settings, env: env(settings.env, member), execArgv: argv(settings.execArgv) }], newTarget), member, "terminate"); }
    catch (error) { signal.spawnFailed(member); throw error; }
  } });
  restores.push(() => { workers.Worker = Worker; });

  restores.push(...installProcessLaunches(signal, processArgv, env, monitor));
  // ESM named imports bind the builtin snapshot; CJS namespace mutation is not enough.
  syncBuiltinESMExports();
  owner.installed = { binding, preloads, ownedPreloads, restore: () => {
    for (const restore of restores.reverse()) restore();
    syncBuiltinESMExports();
  } };
  return () => release(preload);
}

/** Node process creation has callback, Promise and synchronous surfaces; all
 * must enroll the same guarded actor before its executable can start. */
function installProcessLaunches(signal, argv, env, monitor) {
  const restores = [];
  for (const key of ["exec", "execSync"]) {
    const original = cp[key];
    Reflect.set(cp, key, () => {
      signal.violation("unverifiable shell dispatch");
      throw new Error("Provider-free descendants require direct execution");
    });
    restores.push(() => { Reflect.set(cp, key, original); });
  }

  for (const key of ["spawn", "spawnSync", "execFile", "execFileSync"]) {
    const original = cp[key];
    let custom;
    // execFile has a non-configurable custom-promisifier property. A callable
    // forwarding target avoids Proxy invariants while preserving its metadata.
    const guarded = new Proxy((...args) => Reflect.apply(original, cp, args), {
      get(_target, property) {
        // Node's custom promisifier closes over its original execFile, so merely
        // proxying apply would leave the Promise-based creation path unregistered.
        if (key === "execFile" && property === promisify.custom) return custom ??= (...args) => {
          let child;
          const result = new Promise((resolve, reject) => {
            child = Reflect.apply(guarded, cp, [...args, (error, stdout, stderr) => {
              if (error) { Object.assign(error, { stdout, stderr }); reject(error); }
              else resolve({ stdout, stderr });
            }]);
          });
          return Object.assign(result, { child });
        };
        return Reflect.get(original, property);
      },
      apply(_target, receiver, args) {
      const target = original;
      const command = args[0];
      const argumentsSupplied = Array.isArray(args[1]), optionsAt = argumentsSupplied ? 2 : 1;
      const supplied = args[optionsAt];
      const options = supplied !== null && typeof supplied === "object" ? supplied : {};
      if (options.shell) {
        signal.violation("unverifiable shell dispatch"); throw new Error("Provider-free descendants require direct execution");
      }
      if (typeof command !== "string" || command !== process.execPath && !/^(?:node|nodejs)(?:\.exe)?$/u.test(basename(command))) {
        return Reflect.apply(target, receiver, args);
      }
      const member = signal.reserve(key);
      const childArgs = argumentsSupplied ? args[1] : [];
      const forwarded = [command, argv(childArgs), { ...options, env: env(options.env, member) },
        ...args.slice(optionsAt + (supplied === options ? 1 : 0))];
      const sync = key.endsWith("Sync");
      try {
        const result = Reflect.apply(target, receiver, forwarded);
        if (!sync) return monitor(result, member, "kill");
        if (key === "spawnSync" && result.error) signal.spawnFailed(member);
        signal.exited(member, key === "spawnSync" ? result.status : 0, key === "spawnSync" ? result.signal : null);
        return result;
      } catch (error) {
        if (sync) signal.exited(member, error.status ?? null, error.signal ?? null);
        else signal.spawnFailed(member);
        throw error;
      }
    } });
    Reflect.set(cp, key, guarded);
    restores.push(() => { Reflect.set(cp, key, original); });
  }
  return restores;
}

function release(preload) {
  if (owner.installed === undefined) return;
  const references = owner.installed.preloads.get(preload) ?? 0;
  if (references > 1) owner.installed.preloads.set(preload, references - 1);
  else owner.installed.preloads.delete(preload);
  if (owner.installed.preloads.size === 0) { owner.installed.restore(); owner.installed = undefined; }
}

/** Remove only this journal's injected imports; preserve other options and quoted values verbatim. */
function filterOwnedNodeImports(value, owned) {
  const parts = value.match(/(?:[^\s"'\\]|\\.|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')+|\s+/gu);
  if (parts === null || parts.join("") !== value) return value;
  for (let index = 0; index < parts.length; index++) {
    const part = decodeNodeOption(parts[index]);
    if (part.startsWith("--import=") && owned.has(part.slice(9))) parts[index] = "";
    else if (part === "--import" && /^\s+$/u.test(parts[index + 1] ?? "") && owned.has(decodeNodeOption(parts[index + 2] ?? ""))) {
      parts[index] = ""; parts[index + 2] = "";
    }
  }
  return parts.join("");
}

function decodeNodeOption(token) {
  let value = "", quote;
  for (let index = 0; index < token.length; index++) {
    const character = token[index];
    if (character === "\\" && index + 1 < token.length) value += token[++index];
    else if (quote !== undefined) { if (character === quote) quote = undefined; else value += character; }
    else if (character === '"' || character === "'") quote = character;
    else value += character;
  }
  return value;
}
