import fs from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";

/** Install in vi.hoisted, before any application imports or provider construction. */
export function installProviderFreeBoundary() {
  const restores: (() => void)[] = [], violations: string[] = [];
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
  for (const owner of [fs, fsp]) {
    for (const key of ["readFile", "readFileSync", "open", "openSync", "createReadStream"]) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, key);
      if (typeof descriptor?.value !== "function") continue;
      Object.defineProperty(owner, key, { ...descriptor, value: new Proxy(descriptor.value, {
        apply(target, receiver, args) {
          const filename = String(args[0]);
          const nativeFixture = /[/\\]alaya-bench-config-[a-f0-9-]+[/\\]\.env$/u.test(filename);
          if (!nativeFixture && /(?:^|[/\\])(?:[^/\\]+\.env|\.env(?:\.[^/\\]+)?|\.aws|\.azure|credentials(?:\.json)?|auth\.json)(?:$|[/\\])/iu.test(filename)) {
            deny("credential file");
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
