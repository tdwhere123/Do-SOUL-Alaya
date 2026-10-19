/** Provider-free compiled CLI fixture: guard before importing any application module. */
import { installProviderFreeBoundary } from "./provider-free-boundary.ts";
import { fetchLoopbackProvider } from "./loopback-provider-fetch.ts";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
import { types } from "node:util";

const isolation = installProviderFreeBoundary();
const mode = process.env.ALAYA_TEST_DIAGNOSTIC_MODE ?? "transport";
if (!["transport", "policy", "formatter-failure"].includes(mode)) throw new Error("unknown fixture mode");
const expectedAttempts = mode === "policy" ? 0 : 1;
let denied = false;
const refuse = () => { denied = true; throw new Error("Provider-free test refused external network"); };
for (const owner of [dns, dnsPromises]) {
  for (const key of Object.keys(owner)) {
    if (/^(lookup|resolve|reverse)/u.test(key) && typeof owner[key] === "function") owner[key] = refuse;
  }
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (typeof options !== "object" || options === null || options.host !== "127.0.0.1") refuse();
  return Reflect.apply(connect, this, args);
};
syncBuiltinESMExports();
process.env.NO_PROXY = "127.0.0.1";
process.env.no_proxy = "127.0.0.1";
const target = new URL(process.env.ALAYA_TEST_LOOPBACK_TARGET);
if (target.protocol !== "http:" || target.hostname !== "127.0.0.1") refuse();
const guardedFetch = globalThis.fetch;
let attempts = 0;
globalThis.fetch = (input, init) => {
  const original = new URL(String(input));
  if (original.origin !== "https://api.stepfun.com" || ++attempts !== expectedAttempts) refuse();
  return fetchLoopbackProvider(guardedFetch, new URL(original.pathname, target), init);
};
process.env.ALAYA_ALLOW_PRIVATE_PROVIDER_URL = "true";
process.env.ALAYA_OFFICIAL_GARDEN_SECRET_REF = "env:E0_TEST_GARDEN_KEY";
process.env.E0_TEST_GARDEN_KEY = "test-key";
if (mode === "formatter-failure") {
  types.isProxy = () => { throw new Error("fixture formatter unavailable"); };
}
process.on("exit", () => {
  if (denied || isolation.violations.length > 0 || attempts !== expectedAttempts) {
    process.stderr.write(`Provider-free guard failed: denied=${denied}, attempts=${attempts}\n`);
    process.exitCode = 1;
  }
});
