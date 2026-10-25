import http from "node:http";
import https from "node:https";
import http2 from "node:http2";
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns";
import dgram from "node:dgram";
import { syncBuiltinESMExports } from "node:module";
import { installProviderFreeBoundary } from "../../../../../apps/bench-runner/src/__tests__/support/provider-free-boundary.ts";

// Shared by the test host and its authored IPC child; installed before application imports.
const boundary = installProviderFreeBoundary();
const restores = [];
const deny = () => { boundary.violations.push("network"); throw new Error("Authored embedding fixture forbids network"); };
for (const [owner, keys] of [[globalThis, ["fetch"]], [http, ["request", "get"]],
  [https, ["request", "get"]], [http2, ["connect"]], [net.Socket.prototype, ["connect"]],
  [tls, ["connect"]], [dns, ["lookup", "resolve", "resolve4", "resolve6"]],
  [dns.promises, ["lookup", "resolve", "resolve4", "resolve6"]], [dgram, ["createSocket"]]]) {
  for (const key of keys) {
    const previous = owner[key]; owner[key] = deny;
    restores.push(() => { owner[key] = previous; });
  }
}
syncBuiltinESMExports();
export const isolation = { violations: boundary.violations, restore() {
  for (const restore of restores.reverse()) restore();
  boundary.restore(); syncBuiltinESMExports();
} };
