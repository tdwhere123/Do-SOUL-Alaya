// This preload runs before the real bin imports, including in inherited workers.
import "./provider-free-cli.mjs";
import { appendFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";

function denyTransport() {
  appendFileSync(process.env.ALAYA_TEST_TRANSPORT_WITNESS, "transport attempted\n");
  throw new Error("CLI bootstrap transport tripwire");
}
globalThis.fetch = denyTransport;
http.request = http.get = https.request = https.get = denyTransport;
net.Socket.prototype.connect = denyTransport;
for (const owner of [dns, dns.promises]) {
  for (const name of Object.keys(owner)) {
    if (/^(lookup|resolve|reverse)/u.test(name) && typeof owner[name] === "function") owner[name] = denyTransport;
  }
}
syncBuiltinESMExports();

// Synthetic probe capability, installed only after the existing credential guard.
// No actual credential or reachable provider endpoint is used.
if (process.env.ALAYA_TEST_EMBEDDING_CAPABILITY === "1") {
  process.env.ALAYA_OPENAI_SECRET_REF = "env:ALAYA_TEST_SYNTHETIC_KEY";
  process.env.ALAYA_TEST_SYNTHETIC_KEY = "synthetic-no-provider";
}
