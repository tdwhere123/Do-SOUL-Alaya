import childProcess from "node:child_process";
import workerThreads from "node:worker_threads";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

type FixtureDirectory = Readonly<{ dev: number; ino: number }>;

/** Install before application imports. The portable unit entry may admit files
 * inside fresh directories created by that test process; existing temp paths,
 * substituted directories, external symlinks and shared credential inodes are
 * not fixture ownership. Native CLI fixtures retain their named config owner. */
export function installProviderFreeBoundary(options: Readonly<{ ownedTemporaryFixtures?: boolean; descendantPreload?: string }> = {}) {
  const restores: (() => void)[] = [], violations: string[] = [];
  const fixtures = new Map<string, FixtureDirectory>();
  const deny = (kind: string): never => {
    violations.push(kind);
    throw new Error(`Provider-free test refused ${kind}`);
  };
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) deny("non-loopback fetch");
    return nativeFetch(input, { ...init, redirect: "error" });
  };
  restores.push(() => { globalThis.fetch = nativeFetch; });
  const environment = process.env;
  // Test fixtures can install local authentication after real credentials are removed.
  process.env = Object.fromEntries(Object.keys(environment)
    .filter(key => !/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/iu.test(key))
    .map(key => [key, environment[key]]));
  restores.push(() => { process.env = environment; });
  if (options.descendantPreload !== undefined) {
    const preload = `--import=${options.descendantPreload}`;
    process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ""} ${preload}`.trim();
    const argv = (supplied?: readonly string[]) => {
      // Repeated valued flags (for example --conditions) must keep their order
      // and multiplicity. Only our complete preload token is idempotent.
      const selected = [...(supplied ?? process.execArgv)];
      return selected.includes(preload) ? selected : [...selected, preload];
    };
    // ONNX deliberately clears inherited loader flags; recall workers supply
    // explicit argv. Apply the fixture guard at those actual creation boundaries.
    const fork = childProcess.fork;
    childProcess.fork = ((modulePath, argsOrOptions, suppliedOptions) => {
      const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
      const selected = Array.isArray(argsOrOptions) ? suppliedOptions : argsOrOptions;
      const settings = selected as import("node:child_process").ForkOptions | undefined;
      return fork(modulePath, args, { ...settings, execArgv: argv(settings?.execArgv) });
    }) as typeof childProcess.fork;
    restores.push(() => { childProcess.fork = fork; });
    const Worker = workerThreads.Worker;
    workerThreads.Worker = new Proxy(Worker, { construct(target, [filename, settings = {}]) {
      // Node does not run --import preloads for CommonJS eval workers (the
      // native SQLite lease uses one). Install synchronously before their body.
      const guarded = settings.eval === true
        ? `require(${JSON.stringify(fileURLToPath(options.descendantPreload!))});\n${filename}` : filename;
      return new target(guarded, { ...settings, execArgv: argv(settings.execArgv) });
    } });
    restores.push(() => { workerThreads.Worker = Worker; });
  }

  const remember = (value: unknown) => {
    const path = fs.realpathSync(String(value)), stat = fs.lstatSync(path);
    if (stat.isDirectory()) fixtures.set(path, { dev: stat.dev, ino: stat.ino });
  };
  if (options.ownedTemporaryFixtures) {
    // Admit only successful fresh allocations, never a preexisting /tmp prefix.
    for (const [owner, key, mode] of [[fs, "mkdtempSync", "sync"], [fs, "mkdtemp", "callback"],
      [fsp, "mkdtemp", "promise"]] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, key)!;
      Object.defineProperty(owner, key, { ...descriptor, value: new Proxy(descriptor.value, {
        apply(target, receiver, args) {
          if (mode === "callback") {
            const callback = args.at(-1);
            if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [...args.slice(0, -1), (...values: unknown[]) => {
              if (values[0] === null) remember(values[1]);
              return Reflect.apply(callback, undefined, values);
            }]);
          }
          const result = Reflect.apply(target, receiver, args);
          if (mode === "promise") return Promise.resolve(result).then(value => { remember(value); return value; });
          remember(result); return result;
        }
      }) });
      restores.push(() => Object.defineProperty(owner, key, descriptor));
    }
  }

  for (const owner of [fs, fsp]) {
    for (const key of ["readFile", "readFileSync", "open", "openSync", "createReadStream"]) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, key);
      if (typeof descriptor?.value !== "function") continue;
      Object.defineProperty(owner, key, { ...descriptor, value: new Proxy(descriptor.value, {
        apply(target, receiver, args) {
          const filename = String(args[0]);
          if (/(?:^|[/\\])(?:[^/\\]+\.env|\.env(?:\.[^/\\]+)?|\.aws|\.azure|credentials(?:\.json)?|auth\.json)(?:$|[/\\])/iu.test(filename)) {
            const path = resolve(args[0] instanceof URL ? fileURLToPath(args[0]) : filename);
            // Atomic .env.<uuid>.tmp siblings belong to the same native config lease.
            const native = /^(.*[/\\]alaya-bench-config-[a-f0-9-]+)[/\\]\.env(?:\.[a-f0-9-]+\.tmp)?$/u.exec(path)?.[1];
            const nativeFixture = native !== undefined && containedFixtureFile(path, native);
            const ownedFixture = options.ownedTemporaryFixtures && [...fixtures].some(([root, identity]) => {
              try {
                const stat = fs.lstatSync(root);
                return stat.isDirectory() && !stat.isSymbolicLink() && stat.dev === identity.dev && stat.ino === identity.ino
                  && containedFixtureFile(path, root);
              } catch { return false; }
            });
            if (!nativeFixture && !ownedFixture) deny("credential file");
          }
          return Reflect.apply(target, receiver, args);
        }
      }) });
      restores.push(() => Object.defineProperty(owner, key, descriptor));
    }
  }
  syncBuiltinESMExports();
  return { violations, restore: () => {
    for (const restore of restores.reverse()) restore();
    syncBuiltinESMExports();
  } };
}

function containedFixtureFile(path: string, root: string): boolean {
  try {
    if (fs.realpathSync(root) !== root) return false;
    const stat = fs.lstatSync(path, { throwIfNoEntry: false });
    // A fixture can read its own ordinary files, not a hard link to another owner.
    if (stat?.isFile() && stat.nlink > 1) return false;
    let ancestor = path;
    const suffix: string[] = [];
    for (;;) {
      try { ancestor = fs.realpathSync(ancestor); break; }
      catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") return false;
        // A dangling symlink is not an owned missing file.
        if (fs.lstatSync(ancestor, { throwIfNoEntry: false })?.isSymbolicLink()) return false;
        const parent = dirname(ancestor);
        if (parent === ancestor) return false;
        suffix.unshift(relative(parent, ancestor)); ancestor = parent;
      }
    }
    const target = resolve(ancestor, ...suffix), within = relative(root, target);
    return within !== ".." && !within.startsWith(`..${sep}`) && !isAbsolute(within);
  } catch { return false; }
}
