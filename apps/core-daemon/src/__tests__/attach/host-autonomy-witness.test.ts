import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #BL-038 regression: an attached host (Codex / Claude Code over MCP stdio)
// autonomously called soul.recall and then soul.report_context_usage with
// usage_state == "used" during a normal conversation, and the EventLog records
// the linked chain. The fixture is a snapshot of real attached-host usage —
// not a synthetic capture — produced by scripts/export-host-autonomy-witness.mjs
// and refreshed by re-running it. This test pins the chain shape so a future
// daemon change that breaks the recall -> usage telemetry contract is caught
// offline, without a live host. When the upstream host model changes its
// autonomous tool-selection behaviour the *recording* ages out and a fresh one
// is exported; the assertions below stay the same.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const fixtureDir = path.join(repoRoot, "docs/archive/v0.3-historical/v0.3.0/host-autonomy-fixtures/claude-code-live");

interface FixtureEvent {
  readonly event_type: string;
  readonly entity_id: string;
  readonly run_id: string | null;
  readonly caused_by: string;
  readonly created_at: string;
  readonly payload_json: Record<string, unknown>;
}

function loadFixtureEvents(): readonly FixtureEvent[] {
  const raw = readFileSync(path.join(fixtureDir, "event-log.jsonl"), "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as FixtureEvent);
}

// Surfaces a real CLI host attached over MCP stdio. "mcp" is the generic
// attached-host bucket used before the v0.3.0 attach env stamp; "claude-code"
// and "codex" are the labelled buckets. None of these are produced by a test
// harness — the daemon's only path to these targets is `alaya mcp stdio`.
const HOST_AGENT_TARGETS = new Set(["mcp", "claude-code", "codex"]);

describe("host-autonomy witness (#BL-038)", () => {
  it("fixture metadata describes a live-usage witness", () => {
    const metadata = JSON.parse(readFileSync(path.join(fixtureDir, "metadata.json"), "utf8")) as {
      capture_kind: string;
      chain_count: number;
      delivery_ids: readonly string[];
    };
    expect(metadata.capture_kind).toBe("live-usage-witness");
    expect(metadata.chain_count).toBeGreaterThanOrEqual(1);
    expect(metadata.delivery_ids.length).toBe(metadata.chain_count);
  });

  it("records at least one host-originated recall -> usage chain with usage_state=used", () => {
    const events = loadFixtureEvents();
    const recalls = events.filter((e) => e.event_type === "soul.recall.delivered");
    const usages = events.filter((e) => e.event_type === "soul.context_usage.reported");
    expect(recalls.length).toBeGreaterThanOrEqual(1);
    expect(usages.length).toBeGreaterThanOrEqual(1);

    const usedByDelivery = new Map<string, FixtureEvent>();
    for (const usage of usages) {
      expect(HOST_AGENT_TARGETS.has(String(usage.payload_json.agent_target))).toBe(true);
      if (usage.payload_json.usage_state === "used") {
        usedByDelivery.set(String(usage.payload_json.delivery_id), usage);
      }
    }
    expect(usedByDelivery.size).toBeGreaterThanOrEqual(1);

    const linkedChains = recalls.filter((recall) => {
      const deliveryId = String(recall.payload_json.delivery_id);
      const usage = usedByDelivery.get(deliveryId);
      if (usage === undefined) return false;
      expect(recall.entity_id).toBe(deliveryId);
      expect(usage.entity_id).toBe(deliveryId);
      expect(HOST_AGENT_TARGETS.has(String(recall.payload_json.agent_target))).toBe(true);
      expect(Number(recall.payload_json.pointer_count)).toBeGreaterThanOrEqual(1);
      // The host received the recall and then reported it used — usage cannot
      // precede delivery.
      expect(usage.created_at >= recall.created_at).toBe(true);
      return true;
    });
    expect(linkedChains.length).toBeGreaterThanOrEqual(1);
  });
});
