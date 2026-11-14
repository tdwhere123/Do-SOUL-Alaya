import "../../support/provider-free-cli.mjs";
import { appendFileSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";
// Only the lock gate is synthetic. Dispatch, snapshots, recall and retention use the shipped Worker.
const gate = new Database(`${workerData.databaseFilename}.gate`, { readonly: true });
gate.pragma("busy_timeout = 2147483647");
const on = parentPort.on.bind(parentPort);
parentPort.on = (event, listener) => on(event, event !== "message" ? listener : message => {
  if (message.operation === "conditionalField.recall") {
    appendFileSync(`${workerData.databaseFilename}.entered`, "entered\n");
    gate.prepare("SELECT value FROM gate").get();
  }
  return listener(message);
});
await import("../../../../dist/runtime/recall/recall-read-worker.js");
