#!/usr/bin/env node
// Snapshot the attached host-autonomy chain from a live Alaya EventLog into a
// repo fixture. The witness is intentionally drawn from real attached-host
// usage (a normal Codex / Claude Code conversation that called soul.recall and
// then soul.report_context_usage), not a synthetic capture session.
//
// Usage:
//   node scripts/export-host-autonomy-witness.mjs [db-path|-] [host-label]
//
// Defaults: db-path = resolveConfiguredDatabasePath(alaya.toml / DATA_DIR /
//           $ALAYA_CONFIG_DIR/alaya.db); host-label = claude-code. Output lands
//           in docs/archive/host-autonomy-fixtures/<host-label>-live/.
//
// Re-running refreshes the fixture from current EventLog state. Only the
// structured soul.recall.delivered + soul.context_usage.reported rows are
// exported (delivery/session/run ids, agent_target, query_hash, pointer
// counts, usage_state) — no recalled content and no free-text fields.

import { createRequire } from "node:module";
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAlayaConfigDir, resolveConfiguredDatabasePath } from "./configured-paths.mjs";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturesRoot = path.join(repoRoot, "docs/archive/host-autonomy-fixtures");

function fail(message) {
  console.error(message);
  process.exit(1);
}

function resolveBetterSqlite3() {
  // Normal repo installs expose better-sqlite3 to this root script. Keep the
  // pnpm-store fallback for older workspace-only layouts.
  try {
    return require("better-sqlite3");
  } catch {
    /* not hoisted — look in the pnpm store */
  }
  try {
    const pnpmDir = path.join(repoRoot, "node_modules/.pnpm");
    const entry = readdirSync(pnpmDir).find((name) => name.startsWith("better-sqlite3@"));
    if (entry !== undefined) return require(path.join(pnpmDir, entry, "node_modules/better-sqlite3"));
  } catch {
    /* fall through to the error below */
  }
  fail("Cannot resolve better-sqlite3. Run `pnpm install` from the repo root first.");
}

function resolveDbPath(arg) {
  if (arg) return path.resolve(arg);
  const configDir = resolveAlayaConfigDir(process.env);
  return resolveConfiguredDatabasePath(
    path.join(configDir, "alaya.toml"),
    process.env,
    path.join(configDir, "alaya.db")
  );
}

// The db path is recorded in metadata for provenance, but the repo fixture must
// not carry the operator's absolute home path (and hence username). Collapse a
// home-relative path to ~/..., and otherwise keep only the file name — split on
// both separators so a Windows-style path passed on a POSIX host can't leak the
// directory either.
function redactDbPath(dbPath) {
  const home = homedir();
  if (dbPath === home || dbPath.startsWith(home + path.sep)) {
    return path.posix.join("~", path.relative(home, dbPath).split(path.sep).join("/"));
  }
  return dbPath.split(/[\\/]/u).filter(Boolean).pop() ?? "alaya.db";
}

function daemonVersion() {
  try {
    return JSON.parse(readFileSync(path.join(repoRoot, "apps/core-daemon/package.json"), "utf8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export function withEventLog(dbPath, fn, openDatabase = resolveBetterSqlite3()) {
  const db = openDatabase(dbPath, { readonly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function listWorkspaceIds(db, workspaceFilter) {
  if (workspaceFilter) return [workspaceFilter];
  return db
    .prepare(
      `SELECT DISTINCT workspace_id
         FROM event_log
        WHERE event_type IN ('soul.recall.delivered', 'soul.context_usage.reported')
        ORDER BY workspace_id`
    )
    .all()
    .map((row) => row.workspace_id);
}

function readWorkspaceWitnessRows(db, workspaceId) {
  return db
    .prepare(
      `SELECT rowid AS sequence, event_id, event_type, entity_type, entity_id, workspace_id, run_id, caused_by, payload_json, created_at
         FROM event_log
        WHERE workspace_id = ?
          AND event_type IN ('soul.recall.delivered', 'soul.context_usage.reported')
        ORDER BY rowid`
    )
    .all(workspaceId);
}

export function pairWitnessChains(rows) {
  const byKey = new Map();
  for (const row of rows) {
    let payload;
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      continue;
    }
    const deliveryId = payload.delivery_id;
    if (typeof deliveryId !== "string" || deliveryId.length === 0) continue;
    const key = `${row.workspace_id}\0${row.run_id ?? ""}\0${deliveryId}`;
    if (!byKey.has(key)) byKey.set(key, { delivered: null, used: null });
    const slot = byKey.get(key);
    if (row.event_type === "soul.recall.delivered") {
      if (slot.delivered === null && Number(payload.pointer_count) >= 1) slot.delivered = { row, payload };
    } else if (slot.used === null && payload.usage_state === "used") {
      slot.used = { row, payload };
    }
  }
  return [...byKey.entries()].filter(([, slot]) => {
    if (slot.delivered === null || slot.used === null) return false;
    if (slot.delivered.row.workspace_id !== slot.used.row.workspace_id) return false;
    if (slot.delivered.row.run_id !== slot.used.row.run_id) return false;
    return Number(slot.used.row.sequence) > Number(slot.delivered.row.sequence);
  });
}

function loadWitnessRows(dbPath, workspaceFilter) {
  try {
    return withEventLog(dbPath, (db) => {
      const rows = [];
      for (const workspaceId of listWorkspaceIds(db, workspaceFilter)) {
        rows.push(...readWorkspaceWitnessRows(db, workspaceId));
      }
      return rows;
    });
  } catch (error) {
    fail(
      `Cannot read the Alaya EventLog at ${dbPath}: ${error instanceof Error ? error.message : String(error)}.\n` +
        "Pass an explicit db path, set ALAYA_CONFIG_DIR, or run `alaya install` first."
    );
  }
}

function writeWitnessFixture(dbPath, hostLabel, chains) {
  const fixtureDir = path.resolve(fixturesRoot, `${hostLabel}-live`);
  if (fixtureDir !== path.join(fixturesRoot, `${hostLabel}-live`) || !fixtureDir.startsWith(fixturesRoot + path.sep)) {
    fail(`Refusing to write outside ${path.relative(repoRoot, fixturesRoot)}.`);
  }

  const eventRows = [];
  for (const [, slot] of chains) {
    for (const { row } of [slot.delivered, slot.used]) {
      eventRows.push({
        event_id: row.event_id,
        event_type: row.event_type,
        entity_type: row.entity_type,
        entity_id: row.entity_id,
        workspace_id: row.workspace_id,
        run_id: row.run_id,
        caused_by: row.caused_by,
        created_at: row.created_at,
        payload_json: JSON.parse(row.payload_json)
      });
    }
  }
  eventRows.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));

  const agentTargets = [...new Set(eventRows.map((e) => e.payload_json.agent_target).filter(Boolean))];
  mkdirSync(fixtureDir, { recursive: true });

  const eventLogPath = path.join(fixtureDir, "event-log.jsonl");
  writeFileSync(eventLogPath, eventRows.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");

  const metadata = {
    host: hostLabel,
    capture_kind: "live-usage-witness",
    note:
      "Snapshot of real attached-host soul.recall -> soul.report_context_usage chains from a normal conversation; not a synthetic capture. agent_target=mcp rows pre-date the v0.3.0 attach env stamp; re-attach + refresh to get host-labelled rows.",
    daemon_version: daemonVersion(),
    source_db: redactDbPath(dbPath),
    captured_at: new Date().toISOString(),
    chain_count: chains.length,
    agent_targets: agentTargets,
    delivery_ids: chains.map(([, slot]) => slot.delivered.payload.delivery_id)
  };
  writeFileSync(path.join(fixtureDir, "metadata.json"), JSON.stringify(metadata, null, 2) + "\n", "utf8");
  return { fixtureDir, eventLogPath, eventRows, agentTargets };
}

function main() {
  const rawDbArg = process.argv[2];
  const useConfiguredDb = rawDbArg === undefined || rawDbArg === "-";
  const dbPath = resolveDbPath(useConfiguredDb ? undefined : rawDbArg);
  const hostLabel = (process.argv[3] ?? "claude-code").trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(hostLabel)) {
    fail(`Invalid host label ${JSON.stringify(hostLabel)}: use lower-case letters, digits, and dashes only.`);
  }

  const workspaceFilter = process.env.ALAYA_WORKSPACE_ID?.trim() || null;
  const rows = loadWitnessRows(dbPath, workspaceFilter);
  const chains = pairWitnessChains(rows);
  if (chains.length === 0) {
    fail(
      `No complete host-autonomy chain found in ${dbPath}.\n` +
        "Need at least one soul.recall.delivered (pointer_count >= 1) followed by a\n" +
        'matching soul.context_usage.reported with usage_state == "used". Attach a host\n' +
        "(alaya attach claude / codex), have a recall-worthy conversation, then re-run."
    );
  }

  const { eventLogPath, eventRows, agentTargets } = writeWitnessFixture(dbPath, hostLabel, chains);
  console.log(`Wrote ${chains.length} chain(s) (${eventRows.length} events) to ${path.relative(repoRoot, eventLogPath)}`);
  console.log(`agent_targets: ${agentTargets.join(", ") || "(none)"}`);
}

const isCli = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  main();
}
