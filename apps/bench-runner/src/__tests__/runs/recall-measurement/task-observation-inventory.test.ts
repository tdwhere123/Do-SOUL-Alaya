import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../../scripts/test-support/provider-free/provider-free-boundary.js");
  return installProviderFreeBoundary({
    descendantPreload: new URL("../../../../../../scripts/test-support/provider-free/provider-free-cli-bootstrap.mjs", import.meta.url).href
  });
});

import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import BetterSqlite3 from "better-sqlite3";
import { QUESTION_TIME_PROPOSAL_PRODUCER_ID } from "@do-soul/alaya-protocol";
import { executeOrdinaryRecallEntry } from "../../../runs/recall-measurement/ordinary/ordinary-entry-execution.js";
import type { OrdinaryEntryObservation } from "../../../runs/recall-measurement/ordinary/ordinary-entry-observation.js";
import { ordinaryIndexedSnapshot, simulateIndexedQueryPreparation } from "./ordinary-indexed-snapshot.test-support.js";

const roots: string[] = [];
afterEach(() => { expect(isolation.violations).toEqual([]); vi.restoreAllMocks(); });
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  try { isolation.assertSafe(true); } finally { isolation.restore(); }
});

const poolModule = () => import(pathToFileURL(fileURLToPath(new URL("../../../../scripts/recall-harness-pool.mjs", import.meta.url))).href);
const ids = (rows: readonly { target: { root_id: string } }[]) => rows.map(source => source.target.root_id);

it("captures displaced original identities and the paid incumbent before any task proposal through MCP and Worker", async () => {
  const texts = [
    ...Array.from({ length: 16 }, (_, index) => `Which project was mentioned? Original item ${index}.`),
    ...Array.from({ length: 16 }, (_, index) => `Which project was mentioned? Dated item ${index}. ${"noise ".repeat(80)}`)
  ];
  const fixture = await ordinaryIndexedSnapshot(texts, {
    dates: texts.map((_, index) => index < 16 ? "2023/09/01 (Fri) 00:00" : "2023/09/12 (Tue) 00:00"),
    vectors: texts.map((_, index) => index < 16 ? [0, 1, 0] : [0, -1, 0])
  });
  roots.push(fixture.root);
  simulateIndexedQueryPreparation();
  const query = fixture.queries[0]!, clock = fixture.config.interpretation_clock;
  const proposal = { schema_version: 1, producer_id: QUESTION_TIME_PROPOSAL_PRODUCER_ID,
    original_query_digest: `sha256:${createHash("sha256").update(query.original_query).digest("hex")}`,
    question_time: { interpretation_clock: clock, intervals: [{ start: "2023-09-12", end: "2023-09-12" }] } };
  const entry = { config: fixture.config, queries: [{ query_key: query.query_key, original_query: query.original_query,
    interpretation_proposal: proposal }] };
  const plain = (await executeOrdinaryRecallEntry({ ...entry, root: join(fixture.root, "plain") })).rows[0]!;
  const observed: OrdinaryEntryObservation[] = [];
  const captured = (await executeOrdinaryRecallEntry({ ...entry, root: join(fixture.root, "observed") },
    (_key, value) => observed.push(value))).rows[0]!;
  expect(captured.status).toBe("complete");
  expect(captured.source_intervals).toEqual(plain.source_intervals);
  const pool = await poolModule();
  const row = { snapshot: fixture.config.snapshot_path, snapshot_sha256: fixture.config.snapshot_sha256,
    workspace: fixture.config.workspace_id };
  const capture = await pool.captureRecallPool({ row, query: captured, observation: observed[0] });
  const inventory = capture.task_observation_inventory;
  expect(inventory.status, JSON.stringify(inventory)).toBe("complete");
  expect(inventory.original_prefix).toHaveLength(16);
  expect(inventory.time_preferred_incumbent).toHaveLength(16);
  const displaced = inventory.original_prefix.filter((source: { target: { root_id: string } }) =>
    !ids(inventory.time_preferred_incumbent).includes(source.target.root_id));
  expect(displaced.length).toBeGreaterThan(0);
  const db = new BetterSqlite3(row.snapshot, { readonly: true, fileMustExist: true });
  try {
    for (const source of displaced) {
      expect(inventory.eligibility).toContainEqual(source);
      expect(source.target).toMatchObject({ kind: "source_evidence", workspace_id: row.workspace,
        root_id: expect.any(String), source_version: expect.any(String), content_digest: expect.any(String) });
      const indexed = db.prepare("SELECT target_json FROM source_index_roots WHERE workspace_id=? AND root_key=?")
        .get(row.workspace, source.root_key) as { target_json: string } | undefined;
      expect(indexed).toBeDefined();
      expect(source).toEqual(JSON.parse(indexed!.target_json));
      expect(capture.pool.map((item: { source: { target: { root_id: string } } }) => item.source.target.root_id))
        .not.toContain(source.target.root_id);
    }
  } finally { db.close(); }
  expect(inventory.eligibility.length).toBeGreaterThan(16);
  expect(captured.pages[0]!.request.interpretation_proposal).not.toHaveProperty("source_task_observation");
  expect(capture.route_phases[0].original.allowance).toMatchObject({ max_attempts: 128, max_roots: 16, max_vector_windows: 4096 });
  expect(capture.route_phases[0].original.supplemental).toBeUndefined();

  const frame = observed[0]!.observations.find(item => item.events.some(event => event.kind === "field_nomination"))!;
  const inventoryEvent = frame.events.find(event => event.kind === "source_index_acquisition"
    && (event.data as { kind?: string }).kind === "source_task_inventory")!;
  const withEvent = (event: typeof inventoryEvent) => ({ ...observed[0]!, observations: observed[0]!.observations.map(item =>
    item === frame ? { ...item, events: item.events.map(row => row === inventoryEvent ? event : row) } : item) });
  const unavailable = await pool.captureRecallPool({ row, query: captured, observation: { ...observed[0], observations: [] } });
  expect(unavailable.task_observation_inventory).toEqual({ status: "unavailable", reason: "inventory_not_observed" });
  const base = inventoryEvent.data as Record<string, unknown>;
  const partial = await pool.captureRecallPool({ row, query: captured,
    observation: withEvent({ ...inventoryEvent, data: { ...base, coverage: "partial" } }) });
  expect(partial.task_observation_inventory.status).toBe("partial");
  const corrupted = await pool.captureRecallPool({ row, query: captured,
    observation: withEvent({ ...inventoryEvent, data: { ...base, eligible: [{ root_key: "incomplete" }] } }) });
  expect(corrupted.task_observation_inventory).toEqual({ status: "unavailable", reason: "inventory_invalid" });
  const blocked = await pool.captureRecallPool({ row, query: captured,
    observation: withEvent({ ...inventoryEvent, data: { ...base, coverage: "partial", context: { block: "source_guard", source_id: null } } }) });
  expect(blocked.task_observation_inventory).toMatchObject({ status: "not_applicable", reason: "source_guard", coverage: "partial" });
  expect(blocked.task_observation_inventory).not.toHaveProperty("eligibility");
}, 120_000);

it("keeps equal native lexical ranks in their own domains and matches windows only within that domain", async () => {
  const fixture = await ordinaryIndexedSnapshot(["Which project was mentioned? Project Alder."]);
  roots.push(fixture.root);
  simulateIndexedQueryPreparation();
  const query = fixture.queries[0]!, clock = fixture.config.interpretation_clock;
  const proposal = { schema_version: 1, producer_id: QUESTION_TIME_PROPOSAL_PRODUCER_ID,
    original_query_digest: `sha256:${createHash("sha256").update(query.original_query).digest("hex")}`,
    question_time: { interpretation_clock: clock, intervals: [{ start: "2023-09-12", end: "2023-09-12" }] } };
  const observed: OrdinaryEntryObservation[] = [];
  const captured = (await executeOrdinaryRecallEntry({ config: fixture.config, root: join(fixture.root, "capture"),
    queries: [{ query_key: query.query_key, original_query: query.original_query, interpretation_proposal: proposal }] },
  (_key, value) => observed.push(value))).rows[0]!;
  const frame = observed[0]!.observations.find(item => item.events.some(event => event.kind === "field_nomination"))!;
  const facts = frame.events.filter(event => event.kind === "source_index_acquisition"
    && (event.data as { kind?: string }).kind === "lexical_candidate").map(event => event.data as Record<string, unknown>);
  const plain = facts.find(fact => fact.rank === 1 && fact.domain === undefined)!;
  const restricted = facts.find(fact => fact.rank === 1 && fact.domain === "question_time")!;
  expect(plain.target).toEqual(restricted.target);
  const nomination = frame.events.find(event => event.kind === "field_nomination")!;
  const data = nomination.data as { witness: { domain?: string; route: Record<string, unknown> }[] };
  expect(data.witness.some(item => item.domain === undefined && item.route.native_rank === 1)).toBe(true);
  expect(data.witness.some(item => item.domain === "question_time" && item.route.native_rank === 1)).toBe(true);
  const updated = { ...frame, events: frame.events.map(event => event !== nomination ? event : { ...event, data: { ...data,
    witness: data.witness.map(item => item.route.kind !== "lexical" || item.route.native_rank !== 1 ? item : {
      ...item, route: { ...item.route, hit: { status: "available", start_byte: item.domain ? 10 : 0,
        end_byte: item.domain ? 15 : 5 } } }) } }) };
  const synthetic = { ...observed[0]!, observations: observed[0]!.observations.map(item => item === frame ? updated : item) };
  const row = { snapshot: fixture.config.snapshot_path, snapshot_sha256: fixture.config.snapshot_sha256,
    workspace: fixture.config.workspace_id };
  const capture = await (await poolModule()).captureRecallPool({ row, query: captured, observation: synthetic });
  const routes = capture.routes["original-lexical"].filter((item: { rank: number }) => item.rank === 1);
  expect(routes).toEqual(expect.arrayContaining([
    expect.objectContaining({ rank: 1, window: { status: "available", start_byte: 0, end_byte: 5 } }),
    expect.objectContaining({ rank: 1, domain: "question_time", window: { status: "available", start_byte: 10, end_byte: 15 } })
  ]));
  expect(routes.find((item: { domain?: string }) => item.domain === undefined)).not.toHaveProperty("domain");

  const future = { ...proposal, question_time: { ...proposal.question_time,
    intervals: [{ start: "2099-01-01", end: "2099-01-01" }] } };
  const observations: OrdinaryEntryObservation[] = [];
  const futureQuery = (await executeOrdinaryRecallEntry({ config: fixture.config, root: join(fixture.root, "future"),
    queries: [{ query_key: query.query_key, original_query: query.original_query, interpretation_proposal: future }] },
  (_key, value) => observations.push(value))).rows[0]!;
  const noTime = (await executeOrdinaryRecallEntry({ config: fixture.config, root: join(fixture.root, "no-time"),
    queries: [{ query_key: query.query_key, original_query: query.original_query }] })).rows[0]!;
  expect(futureQuery.source_intervals).toEqual(noTime.source_intervals);
  const futureCapture = await (await poolModule()).captureRecallPool({ row, query: futureQuery, observation: observations[0] });
  expect(futureCapture.task_observation_inventory).toMatchObject({ status: "not_applicable", reason: "question_time_no_recorded_domain" });
  expect(futureCapture.task_observation_inventory).not.toHaveProperty("eligibility");
}, 120_000);
