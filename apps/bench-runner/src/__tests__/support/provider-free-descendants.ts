import cp from "node:child_process";
import workers from "node:worker_threads";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ProviderFreeIsolation } from "./provider-free-isolation.js";

let installed: { binding: string; references: number; restore: () => void } | undefined;

/** Propagation and lifetime evidence belong to the isolation guard, not product reap callbacks. */
export function installProviderFreeDescendants(signal: ProviderFreeIsolation, preload: string): () => void {
  const binding = JSON.stringify(signal.binding);
  if (installed !== undefined) {
    if (installed.binding !== binding) throw new Error("Conflicting descendant isolation owner");
    installed.references++;
    return release;
  }
  const restores: (() => void)[] = [], flag = `--import=${preload}`;
  const argv = (supplied?: readonly string[]) => {
    const selected = [...(supplied ?? process.execArgv)];
    return selected.includes(flag) ? selected : [...selected, flag];
  };
  const env = (supplied: NodeJS.ProcessEnv | undefined, member: string) => {
    const selected = signal.environment(supplied, member);
    selected.NODE_OPTIONS = `${selected.NODE_OPTIONS ?? ""} ${flag}`.trim();
    return selected;
  };
  const monitor = (child: cp.ChildProcess | workers.Worker, member: string) => {
    const emit = child.emit;
    child.emit = function (event: string | symbol, ...args: unknown[]) {
      if (event === "exit") signal.exited(member, args[0] as number | null, (args[1] as string | null | undefined) ?? null);
      if (event === "error" && "pid" in child && child.pid === undefined) signal.spawnFailed(member);
      return Reflect.apply(emit, this, [event, ...args]);
    };
    const key = child instanceof workers.Worker ? "terminate" : "kill";
    const cancel = Reflect.get(child, key);
    Reflect.set(child, key, new Proxy(cancel, { apply(target, receiver, args) {
      if (args[0] !== 0) signal.cancelled(member);
      return Reflect.apply(target, receiver, args);
    } }));
    return child;
  };

  const fork = cp.fork;
  cp.fork = ((modulePath, argsOrOptions, suppliedOptions) => {
    const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
    const settings = (Array.isArray(argsOrOptions) ? suppliedOptions : argsOrOptions) as cp.ForkOptions | undefined;
    const member = signal.reserve("fork");
    try { return monitor(fork(modulePath, args, { ...settings, env: env(settings?.env, member),
      execArgv: argv(settings?.execArgv) }), member); }
    catch (error) { signal.spawnFailed(member); throw error; }
  }) as typeof cp.fork;
  restores.push(() => { cp.fork = fork; });

  const Worker = workers.Worker;
  workers.Worker = new Proxy(Worker, { construct(target, [filename, settings = {}]) {
    if (settings.env === workers.SHARE_ENV) {
      signal.violation("unverifiable shared Worker environment");
      throw new Error("Provider-free Worker requires an isolated environment");
    }
    const member = signal.reserve("worker");
    // Node omits --import execution for CommonJS eval workers.
    const guarded = settings.eval === true ? `require(${JSON.stringify(fileURLToPath(preload))});\n${filename}` : filename;
    try { return monitor(new target(guarded, { ...settings, env: env(settings.env, member), execArgv: argv(settings.execArgv) }), member); }
    catch (error) { signal.spawnFailed(member); throw error; }
  } });
  restores.push(() => { workers.Worker = Worker; });

  restores.push(...installProcessLaunches(signal, flag, env, monitor));
  installed = { binding, references: 1, restore: () => { for (const restore of restores.reverse()) restore(); } };
  return release;
}

/** Node process creation has callback, Promise and synchronous surfaces; all
 * must enroll the same guarded actor before its executable can start. */
function installProcessLaunches(signal: ProviderFreeIsolation, flag: string,
  env: (supplied: NodeJS.ProcessEnv | undefined, member: string) => NodeJS.ProcessEnv,
  monitor: (child: cp.ChildProcess | workers.Worker, member: string) => cp.ChildProcess | workers.Worker): (() => void)[] {
  const restores: (() => void)[] = [];
  for (const key of ["exec", "execSync"] as const) {
    const original = cp[key];
    Reflect.set(cp, key, () => {
      signal.violation("unverifiable shell dispatch");
      throw new Error("Provider-free descendants require direct execution");
    });
    restores.push(() => { Reflect.set(cp, key, original); });
  }

  for (const key of ["spawn", "spawnSync", "execFile", "execFileSync"] as const) {
    const original = cp[key];
    let custom: ((...args: unknown[]) => unknown) | undefined;
    // execFile has a non-configurable custom-promisifier property. A callable
    // forwarding target avoids Proxy invariants while preserving its metadata.
    const guarded = new Proxy((...args: unknown[]) => Reflect.apply(original, cp, args), {
      get(_target, property) {
        // Node's custom promisifier closes over its original execFile, so merely
        // proxying apply would leave the Promise-based creation path unregistered.
        if (key === "execFile" && property === promisify.custom) return custom ??= (...args: unknown[]) => {
          let child: unknown;
          const result = new Promise((resolve, reject) => {
            child = Reflect.apply(guarded, cp, [...args, (error: Error | null, stdout: unknown, stderr: unknown) => {
              if (error) { Object.assign(error, { stdout, stderr }); reject(error); }
              else resolve({ stdout, stderr });
            }]);
          });
          return Object.assign(result, { child });
        };
        return Reflect.get(original, property);
      },
      apply(_target, receiver, args: unknown[]) {
      const target = original;
      const command = args[0];
      const argumentsSupplied = Array.isArray(args[1]), optionsAt = argumentsSupplied ? 2 : 1;
      const supplied = args[optionsAt];
      const options = supplied !== null && typeof supplied === "object" ? supplied as cp.SpawnOptions : {};
      if (options.shell) {
        signal.violation("unverifiable shell dispatch"); throw new Error("Provider-free descendants require direct execution");
      }
      if (typeof command !== "string" || command !== process.execPath && !/^(?:node|nodejs)(?:\.exe)?$/u.test(basename(command))) {
        return Reflect.apply(target, receiver, args);
      }
      const member = signal.reserve(key);
      const childArgs = argumentsSupplied ? args[1] as unknown[] : [];
      const forwarded = [command, [flag, ...childArgs], { ...options, env: env(options.env, member) },
        ...args.slice(optionsAt + (supplied === options ? 1 : 0))];
      const sync = key.endsWith("Sync");
      try {
        const result = Reflect.apply(target, receiver, forwarded);
        if (!sync) return monitor(result as cp.ChildProcess, member);
        if (key === "spawnSync" && result.error) signal.spawnFailed(member);
        signal.exited(member, key === "spawnSync" ? result.status : 0, key === "spawnSync" ? result.signal : null);
        return result;
      } catch (error) {
        if (sync) {
          const failure = error as { status?: number; signal?: string };
          signal.exited(member, failure.status ?? null, failure.signal ?? null);
        } else signal.spawnFailed(member);
        throw error;
      }
    } });
    Reflect.set(cp, key, guarded);
    restores.push(() => { Reflect.set(cp, key, original); });
  }
  return restores;
}

function release(): void {
  if (installed !== undefined && --installed.references === 0) { installed.restore(); installed = undefined; }
}
