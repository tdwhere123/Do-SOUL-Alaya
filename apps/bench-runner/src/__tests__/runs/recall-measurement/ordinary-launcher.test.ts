import { afterAll, beforeAll, expect, it, vi } from "vitest";

const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});

import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StorageDatabase } from "@do-soul/alaya-storage";
import { canonicalJson, SoulMemorySearchResponseSchema } from "@do-soul/alaya-protocol";
import { sourceLookupStores } from "../../../runs/snapshot/source-records/publish.js";
import { readChainArtifact } from "../../../runs/recall-measurement/contract.js";
import {
  OrdinaryRecallEntryInputSchema, ORDINARY_RECALL_OBSERVED_SLOT_TARGET, ORDINARY_RECALL_PUBLIC_PAGE_SLOTS,
  buildOrdinaryRecallRequest, mapOrdinaryRecallScope
} from "../../../runs/recall-measurement/ordinary/ordinary-entry-contract.js";
import {
  executeOrdinaryRecallEntry, ordinaryEntryStatusReason
} from "../../../runs/recall-measurement/ordinary/ordinary-entry-execution.js";
import { admitOrdinaryEntryCursor, type OrdinaryEntryCursorSeen }
  from "../../../runs/recall-measurement/ordinary/ordinary-entry-policy.js";
import { ordinaryIndexedSnapshot, simulateIndexedQueryPreparation } from "./ordinary-indexed-snapshot.test-support.js";
import { HIDDEN_GOLD, QUESTION } from "./native-recall.test-support.js";

const PROJECTS = ["Aster", "Birch", "Cedar", "Dock", "Elm", "Fir", "Gum", "Hickory"] as const;

let base: Awaited<ReturnType<typeof ordinaryIndexedSnapshot>>;
let preparation: ReturnType<typeof simulateIndexedQueryPreparation>;
beforeAll(async () => {
  preparation = simulateIndexedQueryPreparation();
  base = await ordinaryIndexedSnapshot(PROJECTS.map(name => `Project ${name} was mentioned.`));
}, 120000);
afterAll(() => {
  preparation?.mockRestore();
  if (base !== undefined) rmSync(base.root, { recursive: true, force: true });
  isolation.restore(); expect(isolation.violations).toEqual([]);
});

it("maps a single named project scope onto public scope_class and keeps library budgets off the wire", () => {
  expect(mapOrdinaryRecallScope({ mode: "named", scopes: ["project"] })).toEqual({ status: "mapped", scope_class: "project" });
  expect(mapOrdinaryRecallScope({ mode: "unrestricted" })).toEqual({ status: "mapped", scope_class: null });
  const request = buildOrdinaryRecallRequest({
    query: QUESTION, scope_class: "project", source_observed_at: "2026-09-13T00:00:00.000Z"
  });
  expect(request.max_results).toBe(ORDINARY_RECALL_PUBLIC_PAGE_SLOTS);
  expect(request.max_results).toBe(5);
  expect(request.result_kind_view).toBe("source_only");
  expect(JSON.stringify(request)).not.toMatch(/work_units|memory_bytes|authorized_scopes|output_byte_limit|page_budget/u);
});

it("refuses denied and multi-scope authorization instead of silently broadening", () => {
  expect(mapOrdinaryRecallScope({ mode: "denied" })).toMatchObject({ status: "not_run" });
  expect(mapOrdinaryRecallScope({ mode: "named", scopes: ["project", "global_domain"] })).toMatchObject({ status: "not_run" });
  expect(OrdinaryRecallEntryInputSchema.safeParse({
    config: {}, root: "/tmp/ordinary-entry", queries: [{ query_key: "a".repeat(64), original_query: QUESTION }],
    gold: [{ query_key: "a".repeat(64) }]
  }).success).toBe(false);
});

it("derives partial and failure reasons from the actual stop and last response", () => {
  const observed = { observation: "observed" as const, response_state: "success" as const, reason: null };
  const errorPage = {
    observation: "unobserved" as const, response_state: "public_error" as const,
    reason: "ordinary public soul.recall returned an error envelope"
  };
  const transport = {
    observation: "unobserved" as const, response_state: "transport_error" as const,
    reason: "ordinary public soul.recall transport did not yield an envelope"
  };
  const missing = {
    observation: "unobserved" as const, response_state: "success" as const,
    reason: "ordinary public soul.recall did not supply required first-exposure or source-interval evidence"
  };
  expect(ordinaryEntryStatusReason("partial", "no_issued_continuation", observed))
    .toBe("ordinary public membership issued no continuation before ten occupied slots");
  expect(ordinaryEntryStatusReason("partial", "membership_page_bound", observed))
    .toBe("ordinary public membership reached the page bound before ten occupied slots");
  expect(ordinaryEntryStatusReason("partial", "terminal_index", observed))
    .toBe("ordinary public membership stopped at a terminal index before ten occupied slots");
  expect(ordinaryEntryStatusReason("partial", "failed", errorPage)).toBe(errorPage.reason);
  expect(ordinaryEntryStatusReason("partial", "unavailable", transport)).toBe(transport.reason);
  expect(ordinaryEntryStatusReason("partial", "unavailable", missing)).toBe(missing.reason);
  expect(ordinaryEntryStatusReason("failed", "failed", errorPage))
    .toBe("ordinary public soul.recall returned an error envelope");
  expect(ordinaryEntryStatusReason("unavailable", "unavailable", transport))
    .toBe("ordinary public soul.recall transport did not yield an envelope");
  expect(ordinaryEntryStatusReason("complete", "occupancy_tail_exhausted", observed))
    .toBe("ordinary public occupancy tail exhausted");
  expect(ordinaryEntryStatusReason("complete", "observed_ten_slot_prefix", observed))
    .toBe("ordinary public membership window captured");
  for (const cause of ["no_issued_continuation", "membership_page_bound", "terminal_index", "failed", "unavailable"] as const) {
    const last = cause === "failed" ? errorPage : cause === "unavailable" ? transport : observed;
    expect(ordinaryEntryStatusReason("partial", cause, last)).not.toMatch(/continuation was issued/iu);
  }
});

it("fails closed on repeated cursors and does not treat replayed positions as fresh", () => {
  const seen = (): OrdinaryEntryCursorSeen => ({ deliveries: new Set(), continuations: new Set(), positions: new Set() });
  const first = seen();
  expect(admitOrdinaryEntryCursor(first, {
    delivery_id: "d1", request_continuation: null, issued_continuation: { token: "c1" }, positions: ["p1", "p2"]
  })).toBeNull();
  expect(first.positions.size).toBe(2);
  expect(admitOrdinaryEntryCursor(first, {
    delivery_id: "d1", request_continuation: { token: "c1" }, issued_continuation: { token: "c2" }, positions: ["p3"]
  })).toBe("ordinary public membership repeated a delivery identity");
  expect(first.positions.has("p3")).toBe(false);
  const issued = seen();
  expect(admitOrdinaryEntryCursor(issued, {
    delivery_id: "d1", request_continuation: null, issued_continuation: { token: "c1" }, positions: ["p1"]
  })).toBeNull();
  expect(admitOrdinaryEntryCursor(issued, {
    delivery_id: "d2", request_continuation: { token: "c1" }, issued_continuation: { token: "c1" }, positions: ["p2"]
  })).toBe("ordinary public membership repeated an issued continuation");
  expect(issued.positions.has("p2")).toBe(false);
  const positions = seen();
  expect(admitOrdinaryEntryCursor(positions, {
    delivery_id: "d1", request_continuation: null, issued_continuation: { token: "c1" }, positions: ["p1"]
  })).toBeNull();
  expect(admitOrdinaryEntryCursor(positions, {
    delivery_id: "d2", request_continuation: { token: "c1" }, issued_continuation: { token: "c2" }, positions: ["p1"]
  })).toBe("ordinary public membership repeated a delivery position");
  expect(admitOrdinaryEntryCursor(seen(), {
    delivery_id: "d1", request_continuation: { token: "c1" }, issued_continuation: { token: "c2" }, positions: ["p1"]
  })).toBe("ordinary public membership used a continuation that was not issued");
  const fresh = seen();
  expect(admitOrdinaryEntryCursor(fresh, {
    delivery_id: "d1", request_continuation: null, issued_continuation: { token: "c1" }, positions: ["p1"]
  })).toBeNull();
  expect(admitOrdinaryEntryCursor(fresh, {
    delivery_id: "d2", request_continuation: { token: "c1" }, issued_continuation: { token: "c2" }, positions: ["p2"]
  })).toBeNull();
  expect(fresh.positions.size).toBe(2);
});

it("executes public soul.recall through MCP against the restored SQLite snapshot", async () => {
  const plan = base, query = plan.queries[0]!;
  expect(plan.config.budget.page_budget).not.toBe(ORDINARY_RECALL_PUBLIC_PAGE_SLOTS);
  const root = join(base.root, "ordinary-entry-success");
  const execution = await executeOrdinaryRecallEntry({
    config: plan.config, root,
    queries: [{ query_key: query.query_key, original_query: query.original_query }]
  });
  expect(execution.mapping).toMatchObject({
    status: "mapped", scope_class: "project", max_results: 5,
    observed_slot_target: ORDINARY_RECALL_OBSERVED_SLOT_TARGET
  });
  expect(execution.mapping.unmapped_dimensions).toEqual(expect.arrayContaining(["budget.page_budget", "output_byte_limit", "budget.work_units"]));
  expect(execution.consumer_model_calls).toBe(0);
  const row = execution.rows[0]!;
  expect(row.status).toBe("complete");
  expect(row.page_count).toBe(row.pages.length);
  expect(["observed_ten_slot_prefix", "occupancy_tail_exhausted"]).toContain(row.stop_cause);
  expect(row.unobserved_counters).toEqual(expect.arrayContaining(["work_units", "provider_calls"]));
  expect(row.unobserved_counters).not.toContain(0);
  expect(row.costs.work_units).toEqual({ status: "unavailable", reason: "public_soul_recall_omits_native_work" });
  expect(row.costs.read_bytes).toEqual({ status: "unavailable", reason: "public_soul_recall_omits_read_bytes" });
  expect(row.costs.latency_ms).toMatchObject({ status: "available", source: "client_mcp_elapsed" });
  expect(row.costs.work_units).not.toHaveProperty("value");
  expect(row.costs.read_bytes).not.toHaveProperty("value");
  expect(row.first_exposure?.initial).not.toBeNull();
  expect(row.pages[0]?.public_call?.request.name).toBe("soul.recall");
  expect(row.pages[0]?.envelope).not.toBeNull();
  expect(row.pages[0]?.request.continuation ?? null).toBeNull();
  expect(row.pages[0]?.observation).toBe("observed");
  expect(row.pages[0]?.occupied_slots).toBe(row.pages[0]?.output?.results.length);
  expect(row.pages[0]?.occupied_slots).toBeLessThanOrEqual(5);
  expect(JSON.stringify(execution)).not.toContain(HIDDEN_GOLD);
  const delivered = row.source_intervals.filter(interval => interval.span !== null);
  expect(delivered.length).toBeGreaterThan(0);
  for (const interval of delivered) {
    expect(interval.target.kind).toBe("source_evidence");
    if (interval.target.kind !== "source_evidence" || interval.span === null) continue;
    const preview = row.pages.flatMap(page => page.output?.results ?? [])
      .find(result => canonicalJson(result.target) === canonicalJson(interval.target));
    expect(preview).toBeDefined();
    const body = readSourceBody(plan.config.snapshot_path, plan.config.workspace_id, interval.target.root_id);
    expect(preview!.content_preview).toBe(Buffer.from(body).subarray(interval.span.content_start, interval.span.content_end).toString("utf8"));
  }
  const retained = await executeOrdinaryRecallEntry({
    config: plan.config, root,
    queries: [{ query_key: query.query_key, original_query: query.original_query }]
  });
  expect(canonicalJson(retained)).toBe(canonicalJson(execution));
  expect(canonicalJson(readChainArtifact(join(root, "ordinary-entry.json")))).toBe(canonicalJson(execution));
}, 120000);

it("captures an actual continuation page without replacing first exposure", async () => {
  const plan = base, query = plan.queries[0]!;
  const execution = await executeOrdinaryRecallEntry({
    config: plan.config, root: join(base.root, "ordinary-entry-pages"),
    queries: [{ query_key: query.query_key, original_query: query.original_query }]
  });
  const row = execution.rows[0]!;
  const first = row.pages[0]!;
  expect(first.observation).toBe("observed");
  expect(first.occupied_slots).toBe(5);
  expect(first.output?.results.length).toBe(5);
  expect(first.output?.index?.continuation).not.toBeNull();
  expect(row.page_count).toBe(row.pages.length);
  expect(row.pages.length).toBeGreaterThanOrEqual(2);
  const second = row.pages[1]!;
  expect(second.request.continuation).toEqual(first.output?.index?.continuation);
  expect(second.first_exposure?.initial).toEqual(first.first_exposure?.initial);
  expect(second.first_exposure?.request_continuation).toEqual(first.output?.index?.continuation);
  expect(second.occupied_slots).toBeGreaterThan(0);
  const occupied = row.pages.reduce((sum, page) => sum + page.occupied_slots, 0);
  expect(occupied).toBeGreaterThan(5);
  expect(row.source_intervals.length).toBeGreaterThan(5);
  expect(new Set(row.source_intervals.flatMap(interval => interval.target.kind === "source_evidence" ? [interval.target.root_id] : [])).size)
    .toBe(row.source_intervals.length);
  if (row.stop_cause === "occupancy_tail_exhausted") {
    expect(row.pages.at(-1)?.terminal_tail.status).toBe("exhausted");
    expect(row.pages.at(-1)?.continuation).toBe("none");
  } else {
    expect(occupied).toBeGreaterThanOrEqual(ORDINARY_RECALL_OBSERVED_SLOT_TARGET);
  }
  expect(row.reason ?? "").not.toMatch(/continuation was issued/iu);
}, 120000);

it.each([
  { page: "first", defect: "malformed-envelope", status: "failed", count: 1 },
  { page: "later", defect: "malformed-envelope", status: "partial", count: 2 },
  { page: "first", defect: "malformed-output", status: "failed", count: 1 },
  { page: "later", defect: "malformed-output", status: "partial", count: 2 },
  { page: "first", defect: "malformed-continuation", status: "failed", count: 1 },
  { page: "later", defect: "malformed-continuation", status: "partial", count: 2 },
  { page: "first", defect: "non-ok-output", status: "failed", count: 1 },
  { page: "later", defect: "non-ok-output", status: "partial", count: 2 },
  { page: "first", defect: "public-error", status: "failed", count: 1 },
  { page: "later", defect: "public-error", status: "partial", count: 2 },
  { page: "first", defect: "missing-index-identity", status: "unavailable", count: 1 },
  { page: "later", defect: "missing-index-identity", status: "partial", count: 2 }
] as const)("keeps a $page-page $defect as an unobserved attempted page with raw frame and timing",
  async ({ page, defect, status, count }) => {
    const plan = base, query = plan.queries[0]!;
    const original = Client.prototype.callTool;
    const injected: unknown[] = [];
    let recalls = 0;
    const spy = vi.spyOn(Client.prototype, "callTool").mockImplementation(function (this: Client, params, resultSchema, options) {
      return original.call(this, params, resultSchema, options).then(result => {
        if (params.name !== "soul.recall") return result;
        recalls += 1;
        const next = (page === "first" ? recalls === 1 : recalls >= 2)
          ? corruptSoulRecallResult(defect, result) : result;
        injected.push(next);
        return next as typeof result;
      });
    });
    try {
      const input = { config: plan.config, root: join(base.root, `ordinary-entry-${page}-${defect}`),
        queries: [{ query_key: query.query_key, original_query: query.original_query }] };
      const execution = await executeOrdinaryRecallEntry(input);
      const row = execution.rows[0]!;
      const attempted = row.pages.at(-1)!;
      expect(row.status).toBe(status);
      expect(row.stop_cause).toBe(defect === "missing-index-identity" ? "unavailable" : "failed");
      expect(row.page_count).toBe(count);
      expect(row.pages).toHaveLength(count);
      expect(injected).toHaveLength(count);
      expect(attempted.observation).toBe("unobserved");
      expect(attempted.response_state).toBe(defect === "missing-index-identity" ? "success"
        : defect === "public-error" ? "public_error" : "invalid_response");
      expect(attempted.occupied_slots).toBe(0);
      expect(attempted.source_intervals).toEqual([]);
      expect(attempted.complete).toBe(false);
      expect(attempted.public_call?.response).toEqual(JSON.parse(JSON.stringify(injected.at(-1))));
      expect(row.costs.latency_ms).toMatchObject({ status: "available", source: "client_mcp_elapsed" });
      expect(row.costs.latency_ms).toHaveProperty("value");
      if (page === "later") {
        expect(row.pages[0]?.observation).toBe("observed");
        expect(row.pages[0]?.occupied_slots).toBeGreaterThan(0);
        expect(row.pages[0]?.public_call?.response).toEqual(JSON.parse(JSON.stringify(injected[0])));
      } else {
        expect(row.first_exposure).toBeNull();
        expect(row.pages.every(item => item.observation !== "observed")).toBe(true);
      }
      if (defect === "malformed-envelope") {
        expect(attempted.envelope).toBeNull();
        expect(attempted.output).toBeNull();
      } else if (defect !== "missing-index-identity") {
        expect(attempted.envelope).not.toBeNull();
        expect(attempted.output).toBeNull();
      } else {
        expect(attempted.output).not.toBeNull();
        expect(attempted.output?.index?.interpretation_id).toBeUndefined();
        expect(attempted.output?.index?.as_of).toBeUndefined();
      }
      const retained = await executeOrdinaryRecallEntry(input);
      expect(retained).toEqual(execution);
      expect(recalls).toBe(count);
    } finally {
      spy.mockRestore();
    }
  }, 120000);

it.each(["query_id", "snapshot_id"] as const)("fails closed when a real continuation response changes %s", async field => {
  const plan = base, query = plan.queries[0]!;
  const root = join(base.root, `ordinary-entry-changed-${field}`);
  const input = { config: plan.config, root,
    queries: [{ query_key: query.query_key, original_query: query.original_query }] };
  const original = Client.prototype.callTool;
  let recalls = 0;
  const spy = vi.spyOn(Client.prototype, "callTool").mockImplementation(function (this: Client, params, resultSchema, options) {
    return original.call(this, params, resultSchema, options).then(result => {
      if (params.name !== "soul.recall" || ++recalls !== 2) return result;
      const clone = structuredClone(result) as typeof result & {
        structuredContent: { output: { index: { query_id: string; snapshot_id: string;
          continuation?: { query_id: string; snapshot_id: string } | null } } };
      };
      const index = clone.structuredContent.output.index;
      index[field] = `${index[field].slice(0, -1)}${index[field].endsWith("0") ? "1" : "0"}`;
      if (index.continuation != null) index.continuation[field] = index[field];
      expect(SoulMemorySearchResponseSchema.safeParse(clone.structuredContent.output).success).toBe(true);
      return clone;
    });
  });
  try {
    await expect(executeOrdinaryRecallEntry(input)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(recalls).toBe(2);
    const rowPath = join(root, "ordinary-entry", `${query.query_key}.json`);
    expect(readChainArtifact(rowPath)).toBeUndefined();
    expect(readChainArtifact(`${rowPath}.reserved`)).toBeDefined();
    await expect(executeOrdinaryRecallEntry(input)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(recalls).toBe(2);
  } finally { spy.mockRestore(); }
}, 120000);

it("follows public continuation past two pages until ten slots or admitted tail exhaustion", async () => {
  const names = ["Aster", "Birch", "Cedar", "Dock", "Elm", "Fir", "Gum", "Hickory",
    "Ironwood", "Juniper", "Kauri", "Larch", "Maple", "Nance", "Oak", "Pine"];
  const large = await ordinaryIndexedSnapshot(names.map(name => `Project ${name} was mentioned. ${"Encoding padding. ".repeat(400)}`));
  try {
    const plan = large, query = plan.queries[0]!;
    const execution = await executeOrdinaryRecallEntry({
      config: plan.config, root: join(large.root, "ordinary-entry-long-pages"),
      queries: [{ query_key: query.query_key, original_query: query.original_query }]
    });
    const row = execution.rows[0]!;
    expect(row.status).toBe("complete");
    expect(row.page_count).toBe(row.pages.length);
    expect(row.pages.length).toBeGreaterThan(2);
    expect(["observed_ten_slot_prefix", "occupancy_tail_exhausted"]).toContain(row.stop_cause);
    const occupied = row.pages.reduce((sum, page) => sum + page.occupied_slots, 0);
    const firstTwo = row.pages.slice(0, 2).reduce((sum, page) => sum + page.occupied_slots, 0);
    expect(firstTwo).toBeLessThan(ORDINARY_RECALL_OBSERVED_SLOT_TARGET);
    if (row.stop_cause === "observed_ten_slot_prefix") {
      expect(occupied).toBeGreaterThanOrEqual(ORDINARY_RECALL_OBSERVED_SLOT_TARGET);
    } else {
      expect(row.pages.at(-1)?.terminal_tail.status).toBe("exhausted");
      expect(row.pages.at(-1)?.continuation).toBe("none");
    }
    expect(row.costs.work_units.status).toBe("unavailable");
    expect(row.costs.read_bytes.status).toBe("unavailable");
    expect(row.costs.latency_ms.status).toBe("available");
    expect(row.costs.work_units).not.toHaveProperty("value");
    expect(row.costs.read_bytes).not.toHaveProperty("value");
    expect(row.reason ?? "").not.toMatch(/continuation was issued/iu);
    expect(JSON.stringify(execution)).not.toContain(HIDDEN_GOLD);
  } finally {
    rmSync(large.root, { recursive: true, force: true });
  }
}, 180000);

it("does not reuse an ordinary entry artifact for a different requested config", async () => {
  const plan = base, query = plan.queries[0]!;
  const root = join(base.root, "ordinary-entry-identity");
  const queries = [{ query_key: query.query_key, original_query: query.original_query }];
  const first = await executeOrdinaryRecallEntry({ config: plan.config, root, queries });
  expect(first.mapping.status).toBe("mapped");
  await expect(executeOrdinaryRecallEntry({
    config: { ...plan.config, authorized_scopes: { mode: "denied" } }, root, queries
  })).rejects.toThrow(/ordinary entry artifact does not bind the requested config and queries/u);
  expect((readChainArtifact(join(root, "ordinary-entry.json")) as { mapping: { status: string } }).mapping.status).toBe("mapped");
}, 120000);

it("returns not-run without intervals when ordinary entry cannot express authorized scopes", async () => {
  const plan = base, query = plan.queries[0]!;
  const root = join(base.root, "ordinary-entry-denied");
  const execution = await executeOrdinaryRecallEntry({
    config: { ...plan.config, authorized_scopes: { mode: "denied" } }, root,
    queries: [{ query_key: query.query_key, original_query: query.original_query }]
  });
  expect(execution.mapping.status).toBe("not_run");
  expect(execution.rows[0]).toMatchObject({
    status: "not_run", pages: [], page_count: 0, stop_cause: "not_run", source_intervals: [], first_exposure: null,
    costs: {
      work_units: { status: "unavailable", reason: "public_soul_recall_omits_native_work" },
      read_bytes: { status: "unavailable", reason: "public_soul_recall_omits_read_bytes" },
      latency_ms: { status: "unavailable", reason: "no_public_call_elapsed" }
    }
  });
  expect(execution.rows[0]?.pages.every(page => page.occupied_slots === 0) ?? true).toBe(true);
  expect(execution.rows[0]?.source_intervals).toEqual([]);
  expect(readdirSync(root).filter(name => name.startsWith("native-session-"))).toEqual([]);
}, 120000);

function corruptSoulRecallResult(
  defect: "malformed-envelope" | "malformed-output" | "malformed-continuation" | "non-ok-output" | "public-error" | "missing-index-identity", result: unknown
): unknown {
  if (defect === "non-ok-output") return { content: [], structuredContent: { ok: false } };
  if (defect === "public-error") return { content: [{ type: "text", text: "native rejection" }], isError: true };
  if (defect === "malformed-envelope") {
    return { structuredContent: { ok: true, output: { not_an_envelope: true } } };
  }
  if (defect === "malformed-output") {
    const envelope = result !== null && typeof result === "object" ? result as { content?: unknown } : {};
    return {
      content: Array.isArray(envelope.content) ? envelope.content : [{ type: "text", text: "malformed-output" }],
      structuredContent: { ok: true, output: { not_a_recall_response: true } }
    };
  }
  const clone = structuredClone(result) as {
    structuredContent?: { output?: { index?: { interpretation_id?: unknown; as_of?: unknown; continuation?: unknown } } };
  };
  const index = clone.structuredContent?.output?.index;
  if (index === undefined) throw new Error("native soul.recall result lacked an index to corrupt");
  if (defect === "malformed-continuation") index.continuation = { cursor: "not-an-issued-continuation" };
  else { delete index.interpretation_id; delete index.as_of; }
  return clone;
}

function readSourceBody(snapshotPath: string, workspaceId: string, rootId: string): string {
  const connection = new BetterSqlite3(snapshotPath, { readonly: true, fileMustExist: true });
  try {
    const stored = sourceLookupStores(new StorageDatabase(snapshotPath, connection)).getStoredRecord(workspaceId, rootId);
    if (stored === null) throw new Error(`sealed source ${rootId} is absent`);
    return stored.content_bytes;
  } finally { connection.close(); }
}
