/** Cheap --import body: mark ready and deny provider channels without application TypeScript. */
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { threadId } from "node:worker_threads";
import { installProviderFreeTransport } from "./provider-free-transport.mjs";

const SIGNAL_ENV = "ALAYA_PROVIDER_FREE_ISOLATION";

export function installProviderFreeChildGuard() {
  const inherited = process.env[SIGNAL_ENV];
  let binding;
  if (inherited !== undefined) {
    binding = JSON.parse(inherited);
    if (typeof binding?.root !== "string" || typeof binding.member !== "string") {
      throw new Error("Invalid isolation binding");
    }
    const ready = join(binding.root, binding.member, "ready.json");
    if (!fs.existsSync(ready)) {
      fs.writeFileSync(ready, `${JSON.stringify({ pid: process.pid, thread: threadId })}\n`);
    }
  }
  const deny = (kind) => {
    if (binding !== undefined) {
      fs.writeFileSync(join(binding.root, binding.member, `violation-${randomUUID()}.json`), `${JSON.stringify({ kind })}\n`);
    }
    throw new Error(`Provider-free test refused ${kind}`);
  };
  installProviderFreeTransport(deny);
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
  const environment = process.env;
  process.env = Object.fromEntries(Object.keys(environment)
    .filter(key => !/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/iu.test(key))
    .map(key => [key, environment[key]]));
  const temp = tmpdir();
  process.env.TMPDIR ??= temp;
  process.env.TEMP ??= temp;
  process.env.TMP ??= temp;
  if (inherited !== undefined) process.env[SIGNAL_ENV] = inherited;
  for (const owner of [fs]) {
    for (const key of ["readFile", "readFileSync", "open", "openSync", "createReadStream"]) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, key);
      if (typeof descriptor?.value !== "function") continue;
      Object.defineProperty(owner, key, { ...descriptor, value: new Proxy(descriptor.value, {
        apply(target, receiver, args) {
          const filename = String(args[0]);
          if (/(?:^|[/\\])(?:[^/\\]+\.env|\.env(?:\.[^/\\]+)?|\.aws|\.azure|credentials(?:\.json)?|auth\.json)(?:$|[/\\])/iu.test(filename)) {
            const path = resolve(args[0] instanceof URL ? fileURLToPath(args[0]) : filename);
            const native = /^(.*[/\\]alaya-bench-config-[a-f0-9-]+)[/\\]\.env(?:\.[a-f0-9-]+\.tmp)?$/u.exec(path)?.[1];
            if (native === undefined || !containedFixtureFile(path, native)) deny("credential file");
          }
          return Reflect.apply(target, receiver, args);
        }
      }) });
    }
  }
  // ESM named imports bind the builtin snapshot; CJS namespace mutation is not enough.
  syncBuiltinESMExports();
}

function containedFixtureFile(path, root) {
  try {
    if (fs.realpathSync(root) !== root) return false;
    const stat = fs.lstatSync(path, { throwIfNoEntry: false });
    if (stat?.isFile() && stat.nlink > 1) return false;
    let ancestor = path;
    const suffix = [];
    for (;;) {
      try { ancestor = fs.realpathSync(ancestor); break; }
      catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") return false;
        if (fs.lstatSync(ancestor, { throwIfNoEntry: false })?.isSymbolicLink()) return false;
        const parent = dirname(ancestor);
        if (parent === ancestor) return false;
        suffix.unshift(relative(parent, ancestor)); ancestor = parent;
      }
    }
    const target = resolve(ancestor, ...suffix), within = relative(root, target);
    return within !== ".." && !within.startsWith(`..${sep}`) && !/^(?:[/\\]|[a-zA-Z]:)/u.test(within);
  } catch { return false; }
}
