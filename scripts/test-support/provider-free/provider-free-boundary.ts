import fs from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installProviderFreeTransport } from "./provider-free-transport.mjs";
import { containedFixtureFile, isNativeConfigFixtureFile } from "./provider-free-fixture-files.mjs";
import { ProviderFreeIsolation, ISOLATION_SIGNAL_FAILURE_EXIT } from "./provider-free-isolation.mjs";
import { installProviderFreeDescendants, providerFreeDescendantPreload } from "./provider-free-descendants.mjs";

type FixtureDirectory = Readonly<{ dev: number; ino: number }>;
const installationKey = Symbol.for("alaya.provider-free-boundary-installations");
const actor = process as typeof process & { [installationKey]?: symbol[] };
// Native preloads and Vitest share the process hooks even when their module caches differ.
const installations = actor[installationKey] ??= [];

/** Install before application imports. The portable unit entry may admit files
 * inside fresh directories created by that test process; existing temp paths,
 * substituted directories, external symlinks and shared credential inodes are
 * not fixture ownership. Native CLI fixtures retain their named config owner. */
export function installProviderFreeBoundary(options: Readonly<{ ownedTemporaryFixtures?: boolean; descendantPreload?: string }> = {}) {
  const restores: (() => void)[] = [], violations: string[] = [];
  const isolation = new ProviderFreeIsolation();
  const installation = Symbol("provider-free-boundary");
  let restored = false;
  const fixtures = new Map<string, FixtureDirectory>();
  const deny = (kind: string): never => {
    violations.push(kind);
    isolation.violation(kind);
    throw new Error(`Provider-free test refused ${kind}`);
  };
  restores.push(installProviderFreeTransport(deny));
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) deny("non-loopback fetch");
    if (url.hostname === "localhost") {
      url.hostname = "127.0.0.1";
      input = typeof input === "string" ? url.href : input instanceof URL ? url : new Request(url, input);
    }
    return nativeFetch(input, { ...init, redirect: "error" });
  };
  restores.push(() => { globalThis.fetch = nativeFetch; });
  const environment = process.env;
  // Test fixtures can install local authentication after real credentials are removed.
  process.env = Object.fromEntries(Object.keys(environment)
    .filter(key => !/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/iu.test(key))
    .map(key => [key, environment[key]]));
  process.env = isolation.environment(process.env);
  restores.push(() => { process.env = environment; });
  const descendantPreload = options.descendantPreload ?? providerFreeDescendantPreload;
  const preload = `--import=${descendantPreload}`;
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ""} ${preload}`.trim();
  restores.push(installProviderFreeDescendants(isolation, descendantPreload));

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
            const nativeFixture = isNativeConfigFixtureFile(path);
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
  isolation.ready();
  installations.push(installation);
  return { violations, evidence: { ...isolation.binding }, signalFailureExitCode: ISOLATION_SIGNAL_FAILURE_EXIT,
    assertSafe: (requireSettled = false) => isolation.assertSafe(requireSettled), restore: () => {
    if (restored) return;
    if (installations.at(-1) !== installation) throw new Error("Provider-free boundaries must restore in reverse installation order");
    installations.pop(); restored = true;
    for (const restore of restores.reverse()) restore();
    syncBuiltinESMExports();
  } };
}
