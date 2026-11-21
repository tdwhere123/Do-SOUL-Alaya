#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { pairWitnessChains, withEventLog } from "./export-host-autonomy-witness.mjs";

const script = fileURLToPath(new URL("./export-host-autonomy-witness.mjs", import.meta.url));
const repoRoot = path.resolve(path.dirname(script), "..");
const fixturesRoot = path.join(repoRoot, "docs/archive/host-autonomy-fixtures");
const require = createRequire(import.meta.url);

function schemaSql() {
  return `CREATE TABLE event_log (
    event_id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    run_id TEXT,
    caused_by TEXT,
    revision INTEGER NOT NULL DEFAULT 0,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );`;
}

function payload(deliveryId, extra = {}) {
  return JSON.stringify({
    delivery_id: deliveryId,
    pointer_count: 1,
    usage_state: "used",
    agent_target: "claude-code",
    ...extra
  });
}

function insert(db, row) {
  db.prepare(
    `INSERT INTO event_log(event_id, event_type, entity_type, entity_id, workspace_id, run_id, caused_by, payload_json, created_at)
     VALUES (?, ?, 'context_delivery', ?, ?, ?, 'mcp', ?, ?)`
  ).run(
    row.event_id,
    row.event_type,
    row.entity_id,
    row.workspace_id,
    row.run_id,
    row.payload_json,
    row.created_at
  );
}

function seedDb(dbPath, rows) {
  const Database = require("better-sqlite3");
  const db = new Database(dbPath);
  try {
    db.exec(schemaSql());
    for (const row of rows) insert(db, row);
  } finally {
    db.close();
  }
}

function delivered(id, workspace, run, at, extra = {}) {
  return {
    event_id: `del-${id}-${workspace}`,
    event_type: "soul.recall.delivered",
    entity_id: id,
    workspace_id: workspace,
    run_id: run,
    payload_json: payload(id, extra),
    created_at: at
  };
}

function used(id, workspace, run, at) {
  return {
    event_id: `use-${id}-${workspace}`,
    event_type: "soul.context_usage.reported",
    entity_id: id,
    workspace_id: workspace,
    run_id: run,
    payload_json: payload(id),
    created_at: at
  };
}

function uniqueHost() {
  return `wit${process.pid}${Date.now().toString(36)}`;
}

function runExport(dbPath, host, env = {}) {
  const merged = { ...process.env, ...env };
  if (!Object.hasOwn(env, "ALAYA_WORKSPACE_ID")) delete merged.ALAYA_WORKSPACE_ID;
  return spawnSync(process.execPath, [script, dbPath, host], {
    encoding: "utf8",
    env: merged
  });
}

test("withEventLog closes the database after success and after a query error", () => {
  let closed = 0;
  const db = {
    close() {
      closed += 1;
    },
    prepare() {
      throw new Error("boom");
    }
  };
  assert.throws(
    () => withEventLog("unused.db", (opened) => opened.prepare("select 1"), () => db),
    /boom/
  );
  assert.equal(closed, 1);

  closed = 0;
  const ok = {
    close() {
      closed += 1;
    },
    prepare() {
      return { all: () => [{ workspace_id: "ws" }] };
    }
  };
  const rows = withEventLog("unused.db", (opened) => opened.prepare("select 1").all(), () => ok);
  assert.deepEqual(rows, [{ workspace_id: "ws" }]);
  assert.equal(closed, 1);
});

test("pairWitnessChains requires matching workspace_id, run_id, and monotonic sequence", () => {
  const delivery = "delivery_shared";
  const crossed = pairWitnessChains([
    { ...delivered(delivery, "ws-a", "run-1", "2026-01-01T00:00:00.000Z"), sequence: 1, payload_json: payload(delivery) },
    { ...used(delivery, "ws-b", "run-1", "2026-01-01T00:00:01.000Z"), sequence: 2, payload_json: payload(delivery) }
  ]);
  assert.equal(crossed.length, 0);

  const mismatchedRun = pairWitnessChains([
    { ...delivered(delivery, "ws-a", "run-1", "2026-01-01T00:00:00.000Z"), sequence: 1, payload_json: payload(delivery) },
    { ...used(delivery, "ws-a", "run-2", "2026-01-01T00:00:01.000Z"), sequence: 2, payload_json: payload(delivery) }
  ]);
  assert.equal(mismatchedRun.length, 0);

  const reversed = pairWitnessChains([
    { ...used(delivery, "ws-a", "run-1", "2026-01-01T00:00:00.000Z"), sequence: 1, payload_json: payload(delivery) },
    { ...delivered(delivery, "ws-a", "run-1", "2026-01-01T00:00:01.000Z"), sequence: 2, payload_json: payload(delivery) }
  ]);
  assert.equal(reversed.length, 0);

  const matched = pairWitnessChains([
    { ...delivered(delivery, "ws-a", "run-1", "2026-01-01T00:00:00.000Z"), sequence: 1, payload_json: payload(delivery) },
    { ...used(delivery, "ws-a", "run-1", "2026-01-01T00:00:01.000Z"), sequence: 2, payload_json: payload(delivery) }
  ]);
  assert.equal(matched.length, 1);
});

test("export isolates workspaces and honors configured database resolution", () => {
  let Database;
  try {
    Database = require("better-sqlite3");
  } catch {
    assert.fail("better-sqlite3 is required to exercise EventLog workspace isolation");
  }
  void Database;

  const work = mkdtempSync(path.join(tmpdir(), "alaya-witness-"));
  const host = uniqueHost();
  const fixtureDir = path.join(fixturesRoot, `${host}-live`);
  try {
    const dbPath = path.join(work, "alaya.db");
    seedDb(dbPath, [
      delivered("delivery_keep", "ws-keep", "run-keep", "2026-01-01T00:00:00.000Z"),
      used("delivery_keep", "ws-keep", "run-keep", "2026-01-01T00:00:01.000Z"),
      delivered("delivery_shared", "ws-keep", "run-other", "2026-01-01T00:00:02.000Z"),
      used("delivery_shared", "ws-other", "run-other", "2026-01-01T00:00:03.000Z")
    ]);

    const isolated = runExport(dbPath, host, { ALAYA_WORKSPACE_ID: "ws-keep" });
    assert.equal(isolated.status, 0, isolated.stderr);
    const metadata = JSON.parse(readFileSync(path.join(fixtureDir, "metadata.json"), "utf8"));
    assert.equal(metadata.chain_count, 1);
    assert.deepEqual(metadata.delivery_ids, ["delivery_keep"]);
    const events = readFileSync(path.join(fixtureDir, "event-log.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(events.every((event) => event.workspace_id === "ws-keep"), true);

    const crossedHost = uniqueHost();
    const crossedDir = path.join(fixturesRoot, `${crossedHost}-live`);
    const crossed = runExport(dbPath, crossedHost, { ALAYA_WORKSPACE_ID: "ws-other" });
    try {
      assert.notEqual(crossed.status, 0);
      assert.match(crossed.stderr, /No complete host-autonomy chain/);
    } finally {
      rmSync(crossedDir, { recursive: true, force: true });
    }

    const configDir = path.join(work, "config");
    const dataDir = path.join(work, "data");
    mkdirSync(configDir);
    mkdirSync(dataDir);
    const configuredDb = path.join(dataDir, "alaya.db");
    seedDb(configuredDb, [
      delivered("delivery_cfg", "ws-cfg", "run-cfg", "2026-01-01T00:00:00.000Z"),
      used("delivery_cfg", "ws-cfg", "run-cfg", "2026-01-01T00:00:01.000Z")
    ]);
    writeFileSync(
      path.join(configDir, "alaya.toml"),
      `[storage]\ndb_path = ${JSON.stringify(configuredDb)}\n`
    );
    const configuredHost = uniqueHost();
    const configuredDir = path.join(fixturesRoot, `${configuredHost}-live`);
    const configured = spawnSync(process.execPath, [script, "-", configuredHost], {
      encoding: "utf8",
      cwd: work,
      env: { ...process.env, ALAYA_CONFIG_DIR: configDir, ALAYA_WORKSPACE_ID: "ws-cfg" }
    });
    try {
      assert.equal(configured.status, 0, configured.stderr);
      const configuredMeta = JSON.parse(readFileSync(path.join(configuredDir, "metadata.json"), "utf8"));
      assert.deepEqual(configuredMeta.delivery_ids, ["delivery_cfg"]);
    } finally {
      rmSync(configuredDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
