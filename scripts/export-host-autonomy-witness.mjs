#!/usr/bin/env node
// Snapshot the #BL-038 host-autonomy chain from a live Alaya EventLog into a
// repo fixture. The witness is intentionally drawn from real attached-host
// usage (a normal Codex / Claude Code conversation that called soul.recall and
// then soul.report_context_usage), not a synthetic capture session — see
// docs/v0.3/v0.3.0/host-autonomy-fixtures/README.md.
//
// Usage:
//   node scripts/export-host-autonomy-witness.mjs [db-path] [host-label]
//
// Defaults: db-path = $ALAYA_CONFIG_DIR/alaya.db or ~/.config/alaya/alaya.db;
//           host-label = claude-code. Output lands in
//           docs/v0.3/v0.3.0/host-autonomy-fixtures/<host-label>-live/.
//
// Re-running refreshes the fixture from current EventLog state. Only the
// structured soul.recall.delivered + soul.context_usage.reported rows are
// exported (delivery/session/run ids, agent_target, query_hash, pointer
// counts, usage_state) — no recalled content and no free-text fields.

import { createRequire } from "node:module";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function resolveBetterSqlite3() {
  // The driver is a workspace dependency of @do-soul/alaya-storage; resolve it
  // from there so this script works without its own package manifest.
  const candidates = [
    "better-sqlite3",
    path.join(repoRoot, "node_modules/.pnpm/better-sqlite3@12.9.0/node_modules/better-sqlite3")
  ];
  for (const id of candidates) {
    try {
      return require(id);
    } catch {
      /* try next */
    }
  }
  throw new Error("Cannot resolve better-sqlite3. Run `rtk pnpm install` first.");
}

function resolveDbPath(arg) {
  if (arg) return path.resolve(arg);
  const fromEnv = process.env.ALAYA_CONFIG_DIR?.trim();
  if (fromEnv) return path.join(path.resolve(fromEnv), "alaya.db");
  return path.join(homedir(), ".config", "alaya", "alaya.db");
}

function daemonVersion() {
  try {
    return JSON.parse(readFileSync(path.join(repoRoot, "apps/core-daemon/package.json"), "utf8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

const dbPath = resolveDbPath(process.argv[2]);
const hostLabel = (process.argv[3] ?? "claude-code").trim();
const Database = resolveBetterSqlite3();
const db = new Database(dbPath, { readonly: true });

const rows = db
  .prepare(
    `SELECT event_id, event_type, entity_type, entity_id, workspace_id, run_id, caused_by, payload_json, created_at
       FROM event_log
      WHERE event_type IN ('soul.recall.delivered', 'soul.context_usage.reported')
      ORDER BY created_at`
  )
  .all();

const byDelivery = new Map();
for (const row of rows) {
  let payload;
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    continue;
  }
  const deliveryId = payload.delivery_id;
  if (typeof deliveryId !== "string" || deliveryId.length === 0) continue;
  if (!byDelivery.has(deliveryId)) byDelivery.set(deliveryId, { delivered: null, used: null });
  const slot = byDelivery.get(deliveryId);
  if (row.event_type === "soul.recall.delivered") {
    if (slot.delivered === null && Number(payload.pointer_count) >= 1) slot.delivered = { row, payload };
  } else if (slot.used === null && payload.usage_state === "used") {
    slot.used = { row, payload };
  }
}

const chains = [...byDelivery.entries()].filter(([, slot]) => slot.delivered !== null && slot.used !== null);
if (chains.length === 0) {
  console.error(
    `No complete host-autonomy chain found in ${dbPath}.\n` +
      "Need at least one soul.recall.delivered (pointer_count >= 1) followed by a\n" +
      "matching soul.context_usage.reported with usage_state == \"used\". Attach a host\n" +
      "(alaya attach claude / codex), have a recall-worthy conversation, then re-run."
  );
  process.exit(1);
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
const fixtureDir = path.join(repoRoot, "docs/v0.3/v0.3.0/host-autonomy-fixtures", `${hostLabel}-live`);
mkdirSync(fixtureDir, { recursive: true });

const eventLogPath = path.join(fixtureDir, "event-log.jsonl");
writeFileSync(eventLogPath, eventRows.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");

const metadata = {
  host: hostLabel,
  capture_kind: "live-usage-witness",
  note:
    "Snapshot of real attached-host soul.recall -> soul.report_context_usage chains from a normal conversation; not a synthetic capture. agent_target=mcp rows pre-date the v0.3.0 attach env stamp; re-attach + refresh to get host-labelled rows.",
  daemon_version: daemonVersion(),
  source_db: dbPath,
  captured_at: new Date().toISOString(),
  chain_count: chains.length,
  agent_targets: agentTargets,
  delivery_ids: chains.map(([deliveryId]) => deliveryId)
};
writeFileSync(path.join(fixtureDir, "metadata.json"), JSON.stringify(metadata, null, 2) + "\n", "utf8");

console.log(`Wrote ${chains.length} chain(s) (${eventRows.length} events) to ${path.relative(repoRoot, eventLogPath)}`);
console.log(`agent_targets: ${agentTargets.join(", ") || "(none)"}`);
