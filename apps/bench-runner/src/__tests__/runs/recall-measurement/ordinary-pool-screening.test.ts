import { afterAll, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});

import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import BetterSqlite3 from "better-sqlite3";
import { fieldContractSha256 } from "@do-soul/alaya-core";
import { warmCjkSegmentation } from "@do-soul/alaya-cjk-segmentation";
import { hashContentDigest, indexEntryCacheKey } from "@do-soul/alaya-protocol";
import { ordinaryIndexedSnapshot } from "./ordinary-indexed-snapshot.test-support.js";
import { executeOrdinaryRecallEntry } from "../../../runs/recall-measurement/ordinary/ordinary-entry-execution.js";
import type { OrdinaryEntryObservation } from "../../../runs/recall-measurement/ordinary/ordinary-entry-observation.js";
import { observeOrdinaryEntry } from "../../../runs/recall-measurement/ordinary/ordinary-entry-observation.js";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  isolation.restore();
  expect(isolation.violations).toEqual([]);
});

it("captures and re-encodes the actual MCP/SQLite order, and refuses scoring on a mismatched baseline", async () => {
  const texts = ["Aster", "Birch", "Cedar", "Dock", "Elm", "Fir", "Gum", "Hickory", "Iris", "Juniper", "Kite", "Larch"]
    .map(name => `Project ${name} was mentioned.`);
  const fixture = await ordinaryIndexedSnapshot(texts); roots.push(fixture.root);
  const query = fixture.queries[0]!;
  const input = { config: fixture.config, queries: [{ query_key: query.query_key, original_query: query.original_query }] };
  const plainExecution = await executeOrdinaryRecallEntry({ ...input, root: join(fixture.root, "plain") });
  const plain = plainExecution.rows[0]!;
  const observations: OrdinaryEntryObservation[] = [];
  const capturedExecution = await executeOrdinaryRecallEntry({ ...input, root: join(fixture.root, "observed") }, (key, value) => {
    expect(key).toBe(query.query_key); observations.push(value);
  });
  const captured = capturedExecution.rows[0]!;
  const observed = observations[0];
  expect(captured.status, JSON.stringify({ stop: captured.stop_cause, reason: captured.reason, pages: captured.page_count,
    slots: captured.source_intervals.length })).toBe("complete");
  expect(captured.source_intervals).toEqual(plain.source_intervals);
  const throwing = (await executeOrdinaryRecallEntry({ ...input, root: join(fixture.root, "throwing-observer") }, () => {
    throw new Error("diagnostic callback failed");
  })).rows[0]!;
  expect(throwing.status).toBe("complete");
  expect(throwing.source_intervals).toEqual(plain.source_intervals);
  expect(observed?.status).toBe("available");
  expect(observed?.observations.flatMap(frame => frame.events).some(event => event.kind === "field_nomination"),
    JSON.stringify(observed?.observations.map(frame => ({ status: frame.status, binding: frame.facts?.binding,
      issues: frame.issues, events: frame.events.map(event => event.kind) })))).toBe(true);
  expect(observed?.observations.flatMap(frame => frame.events).some(event => event.kind === "field_access_order")).toBe(true);

  const pool = await import(pathToFileURL(fileURLToPath(new URL("../../../../scripts/recall-harness-pool.mjs", import.meta.url))).href);
  const delivery = await import(pathToFileURL(fileURLToPath(new URL("../../../../scripts/recall-simulator-delivery.mjs", import.meta.url))).href);
  const policy = await import(pathToFileURL(fileURLToPath(new URL("../../../../scripts/recall-simulator-policies.mjs", import.meta.url))).href);
  const simulator = await import(pathToFileURL(fileURLToPath(new URL("../../../../scripts/recall-harness-simulator.mjs", import.meta.url))).href);
  const row = { question_id: "project", question_type: "fixture", arm: "capture", status: captured.status,
    stop_cause: captured.stop_cause,
    snapshot: fixture.config.snapshot_path, snapshot_sha256: fixture.config.snapshot_sha256,
    workspace: fixture.config.workspace_id, intervals: captured.source_intervals, arm_identity: "same-arm",
    input_identity: capturedExecution.input_identity, initial_request: captured.pages[0]?.request,
    snapshot_identity: captured.snapshot_identity };
  const plainRow = { ...row, input_identity: plainExecution.input_identity, initial_request: plain.pages[0]?.request,
    snapshot_identity: plain.snapshot_identity };
  expect(() => simulator.assertPairedScreenInputs(row, plainRow)).not.toThrow();
  for (const changed of [
    { input_identity: "different" }, { arm_identity: "different" }, { snapshot_sha256: "different" },
    { initial_request: { ...plainRow.initial_request, query: "different" } }, { snapshot_identity: null }
  ]) expect(() => simulator.assertPairedScreenInputs(row, { ...plainRow, ...changed })).toThrow("do not bind the same inputs");
  const poolCapture = await pool.captureRecallPool({ row, query: captured, observation: observed });
  expect(poolCapture.status).toBe("captured");
  expect(poolCapture.pool.length).toBeGreaterThan(0);
  expect(poolCapture.diagnostic_beyond_allowance.rankings.status).toBe("unavailable");
  const nativeIndex = observed!.observations.find(frame => frame.events.some(event => event.kind === "field_nomination"))?.facts?.binding?.index;
  expect(nativeIndex).toBeTruthy();
  const db = new BetterSqlite3(fixture.config.snapshot_path, { readonly: true, fileMustExist: true });
  try {
    const generation = db.prepare("SELECT generation_id,profile_id,configuration_json FROM source_index_generations WHERE workspace_id=? AND status='ready'")
      .get(row.workspace) as { generation_id: string; profile_id: string; configuration_json: string };
    const queryVector = { status: "available", profile: JSON.parse(generation.configuration_json).profile,
      profile_id: generation.profile_id, input_digest: hashContentDigest(query.original_query, fieldContractSha256), embedding: [0, 1, 0] };
    expect(await warmCjkSegmentation()).toBe(true);
    const ranking = await pool.diagnosticRanking(db, row.snapshot, row.workspace, query.original_query, queryVector,
      generation, pool.readInventory(db, row.workspace), undefined, new Map(), nativeIndex);
    expect(ranking.diagnostic_beyond_allowance).toBe(true);
    expect(ranking.vector_completion).toBe("complete");
    expect(ranking.vector).toHaveLength(texts.length);
    expect(ranking.vector.map((item: { rank: number }) => item.rank)).toEqual(texts.map((_, index) => index + 1));
    const keys = ranking.vector.map((item: { root_key: string }) => item.root_key);
    expect(keys).toEqual([...keys].sort());
    expect((await pool.diagnosticRanking(db, row.snapshot, row.workspace, query.original_query,
      { ...queryVector, profile_id: "wrong" }, generation, new Map(), undefined, new Map(), nativeIndex)).status).toBe("unavailable");
    expect((await pool.diagnosticRanking(db, row.snapshot, row.workspace, query.original_query, queryVector,
      { ...generation, generation_id: "wrong" }, new Map(), undefined, new Map(), nativeIndex)).reason).toBe("native_index_binding_mismatch");
  } finally { db.close(); }
  const completed = { ...row, pool_capture: poolCapture };
  const order = delivery.observedAccessOrder(poolCapture);
  expect(delivery.simulateRecallDelivery(completed, order).intervals).toEqual(plain.source_intervals);
  const group = new Map(order.slice(0, 5).map((id: string) => [id, { container: "shared" }]));
  const reordered = policy.anchored([order[2], order[1], ...order.slice(3)], { intervals: plain.source_intervals }, order, group);
  expect(() => delivery.simulateRecallDelivery(completed, reordered)).toThrow("counterfactual projection attempts were not observed");
  const altered = structuredClone(poolCapture);
  const attempt = altered.page_attempts[0].attempts[0];
  const entry = attempt.index.entries[0];
  const entryKey = indexEntryCacheKey(entry);
  attempt.metadata[entryKey] = { ...(attempt.metadata[entryKey] ?? {}), evidence_refs: ["x".repeat(4000)] };
  expect(() => delivery.simulateRecallDelivery({ ...row, pool_capture: altered }, order)).toThrow("native page fit replay differs");
  const unseen = order.find((id: string) => !plain.source_intervals.some(interval =>
    interval.target.kind === "source_evidence" && interval.target.root_id === id));
  expect(unseen).toBeDefined();
  expect(() => delivery.simulateRecallDelivery(completed, [unseen, ...order.filter((id: string) => id !== unseen)]))
    .toThrow("counterfactual projection attempts were not observed");
  const changedSnapshot = join(fixture.root, "changed.sqlite");
  copyFileSync(row.snapshot, changedSnapshot);
  const changedDb = new BetterSqlite3(changedSnapshot);
  changedDb.prepare("UPDATE source_records SET source_body=replace(source_body, 'Project', 'ProjeCt') WHERE workspace_id=?")
    .run(row.workspace);
  changedDb.close();
  expect(() => delivery.simulateRecallDelivery({ ...completed, snapshot: changedSnapshot }, order))
    .toThrow("captured snapshot digest changed");
  const unsealed = join(fixture.root, "unsealed.sqlite");
  copyFileSync(row.snapshot, unsealed);
  writeFileSync(`${unsealed}-wal`, "uncheckpointed");
  expect(() => delivery.simulateRecallDelivery({ ...completed, snapshot: unsealed }, order)).toThrow();

  const frame = observed!.observations.find(item => item.events.some(event => event.kind === "field_nomination"))!;
  const bad = { ...frame, request_id: -1, status: "partial", execution: "failure", issues: ["failed"],
    events: frame.events.map(event => event.kind === "field_nomination" ? { ...event, data: { result: null } } : event) };
  const unknown = { ...bad, request_id: -2, status: "unavailable", execution: "unknown", facts: undefined, events: [] };
  const failed = { ...observed!, observations: [bad, unknown, ...observed!.observations] };
  const withFailure = await pool.captureRecallPool({ row, query: captured, observation: failed });
  expect(withFailure.status).toBe("partial");
  expect(withFailure.issues).toContain("ordinary_capture_frame_rejected");
  expect(withFailure.rejected_frames[0].execution).toBe("failure");
  expect(withFailure.rejected_frames[1].execution).toBe("unknown");
  expect(withFailure.pool).toEqual(poolCapture.pool);

  const capturePath = join(fixture.root, "capture.jsonl"), basePath = join(fixture.root, "base.jsonl");
  const datasetPath = join(fixture.root, "scoring.json");
  const questions = JSON.parse(readFileSync(join(fixture.root, "data/longmemeval_s.json"), "utf8"));
  questions[0].haystack_sessions[0][0].has_answer = true;
  writeFileSync(datasetPath, JSON.stringify(questions));
  writeFileSync(capturePath, `${JSON.stringify(completed)}\n`);
  writeFileSync(basePath, `${JSON.stringify({ ...row, arm: "plain", intervals: plain.source_intervals })}\n`);
  const result = await simulator.runRecallSimulation({ capture: capturePath, baseline: basePath, out: join(fixture.root, "screen"),
    dataset: datasetPath, mode: "verify", expectedCount: 1, policies: [] });
  expect(result.parity).toEqual([{ question_id: "project", status: "matched" }]);
  expect(result.authorization).toBe("none");
  expect(existsSync(join(fixture.root, "screen", "scores.jsonl"))).toBe(false);
  await expect(simulator.runRecallSimulation({ capture: capturePath, baseline: capturePath, out: join(fixture.root, "self"),
    mode: "verify", expectedCount: 1 })).rejects.toThrow("independent files");
  await expect(simulator.runRecallSimulation({ capture: capturePath, baseline: basePath, out: join(fixture.root, "one-screen"),
    expectedCount: 1 })).rejects.toThrow("cannot override cohort size");
  const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../../../../../../docs/bench-history/datasets/longmemeval_s.stratified-100.v1.json", import.meta.url)), "utf8"));
  const oldCapture = join(fixture.root, "old-capture.jsonl"), plain100 = join(fixture.root, "plain-100.jsonl");
  writeFileSync(oldCapture, manifest.question_ids.map((id: string) => JSON.stringify({ ...completed,
    question_id: id, capture_requested: true, implementation_revision: "old-revision" })).join("\n") + "\n");
  writeFileSync(plain100, manifest.question_ids.map((id: string) => JSON.stringify({ ...row, question_id: id })).join("\n") + "\n");
  await expect(simulator.runRecallSimulation({ capture: oldCapture, baseline: plain100, out: join(fixture.root, "old-revision") }))
    .rejects.toThrow("capture revision does not match the loaded simulator checkout");
  const authority = await import(pathToFileURL(fileURLToPath(new URL("../../../../dist/runs/extraction/authority/inspection.js", import.meta.url))).href);
  const currentRevision = authority.readCurrentExtractionAuthorityRevision();
  writeFileSync(oldCapture, manifest.question_ids.map((id: string) => JSON.stringify({ ...completed,
    question_id: id, capture_requested: true, implementation_revision: currentRevision })).join("\n") + "\n");
  writeFileSync(plain100, manifest.question_ids.map((id: string, index: number) => JSON.stringify({ ...plainRow,
    question_id: id, ...(index === 0 ? {} : { implementation_revision: currentRevision }) })).join("\n") + "\n");
  await expect(simulator.runRecallSimulation({ capture: oldCapture, baseline: plain100, out: join(fixture.root, "missing-plain-revision") }))
    .rejects.toThrow("plain baseline revision is missing or differs");
  writeFileSync(plain100, manifest.question_ids.map((id: string, index: number) => JSON.stringify({ ...plainRow,
    question_id: id, implementation_revision: index === 0 ? "different" : currentRevision })).join("\n") + "\n");
  await expect(simulator.runRecallSimulation({ capture: oldCapture, baseline: plain100, out: join(fixture.root, "different-plain-revision") }))
    .rejects.toThrow("plain baseline revision is missing or differs");
  expect(simulator.signTest(4, 0)).toBe(0.0625);
  writeFileSync(basePath, `${JSON.stringify({ ...row, intervals: [] })}\n`);
  const refused = join(fixture.root, "refused");
  await expect(simulator.runRecallSimulation({ capture: capturePath, baseline: basePath, out: refused,
    dataset: datasetPath, mode: "verify", expectedCount: 1, policies: [] })).rejects.toThrow("native parity failed");
  expect(existsSync(join(refused, "scores.jsonl"))).toBe(false);
  expect(JSON.parse(readFileSync(join(refused, "parity.json"), "utf8")).matched).toBe(0);

  const resume = join(fixture.root, "resume"), arms = join(fixture.root, "arms.json");
  mkdirSync(resume);
  writeFileSync(join(resume, "rows.jsonl"), `${JSON.stringify({ question_id: "project", arm: "plain", status: "complete" })}\n`);
  writeFileSync(arms, JSON.stringify([{ name: "plain" }]));
  const harness = fileURLToPath(new URL("../../../../scripts/recall-harness.mjs", import.meta.url));
  const error = await promisify(execFile)(process.execPath, [harness, "--out", resume, "--arms", arms, "--capture-pool",
    "--dataset", join(fixture.root, "data/longmemeval_s.json"), "--cache", join(fixture.root, "cache")])
    .then(() => { throw new Error("plain rows must not satisfy a capture request"); }, (cause: Error & { stderr: string }) => cause);
  expect(error.stderr).toContain("existing rows use a different pool-capture mode");
  const unresolved = join(fixture.root, "unresolved"), oldRoot = join(unresolved, "runs/project/plain");
  mkdirSync(oldRoot, { recursive: true });
  writeFileSync(join(oldRoot, "reservation"), "preserve");
  await promisify(execFile)(process.execPath, [harness, "--out", unresolved, "--arms", arms, "--capture-pool", "--ids", "project",
    "--dataset", join(fixture.root, "data/longmemeval_s.json"), "--cache", join(fixture.root, "cache")]);
  expect(readFileSync(join(oldRoot, "reservation"), "utf8")).toBe("preserve");
  expect(JSON.parse(readFileSync(join(unresolved, "rows.jsonl"), "utf8")).error).toContain("prior first exposure may be unresolved");
}, 120000);

it("ranks message units across the workspace and uses stable keys before root deduplication", async () => {
  const policy = await import(pathToFileURL(fileURLToPath(new URL("../../../../scripts/recall-simulator-policies.mjs", import.meta.url))).href);
  const ranked = await policy.messageFtsRanking([
    { id: "root-b", key: "b", text: "dolphin" },
    { id: "root-a", key: "a", text: "dolphin" },
    { id: "root-c", key: "c", text: "fern" }
  ], "dolphin");
  expect([...new Set(ranked.map((doc: { id: string }) => doc.id))]).toEqual(["root-a", "root-b"]);
});

it("keeps displaced anchor roots unique and rejects routes from another frozen Q sample", async () => {
  const policy = await import(pathToFileURL(fileURLToPath(new URL("../../../../scripts/recall-simulator-policies.mjs", import.meta.url))).href);
  const native = { intervals: ["a", "b"].map((id, slot_index) => ({ slot_index, target: { root_id: id } })) };
  const records = new Map(["a", "b", "x"].map(id => [id, { container: "same" }]));
  expect(policy.anchored(["x", "a", "b"], native, ["a", "b", "c"], records)).toEqual(["a", "x", "b", "c"]);
  const q1 = { evidence_statements: ["first"], time: { kind: "none" } };
  const q2 = { evidence_statements: ["second"], time: { kind: "none" } };
  const route = { status: "captured", roots: ["b"], coordinates: q1, generation_id: "g", profile_id: "p",
    input_digest: hashContentDigest("first", fieldContractSha256), completion: "complete" };
  const row = { question_id: "q", pool_capture: { generation: { generation_id: "g", profile_id: "p" },
    pages: [{ request: { query: "question" } }], access_orders: [{ status: "ordered", total: 1,
      entries: [{ target: { kind: "source_evidence", root_id: "a" }, access_ordinal: 0 }] }],
    diagnostic_beyond_allowance: { rankings: { qroute_ev: route } } } };
  const inputs = { coordinates: new Map([["q", { status: "formed", coordinates: q2 }]]), contexts: new Map([["q", {}]]) };
  expect((await policy.selectPolicy("qroute-ev", row, native, inputs)).status).toBe("unavailable");
  route.coordinates = q2;
  expect((await policy.selectPolicy("qroute-ev", row, native, inputs)).status).toBe("unavailable");
  inputs.contexts.set("q", { records: new Map([["a", { container: null }]]) });
  expect(await policy.selectPolicy("msg-lex-global-anchor", row, native, inputs)).toEqual({
    status: "unavailable", reason: "first-five host container unavailable or ambiguous" });
});

it("reports unknown early-round roots and mixed occurrence roles explicitly", async () => {
  const pool = await import(pathToFileURL(fileURLToPath(new URL("../../../../scripts/recall-harness-pool.mjs", import.meta.url))).href);
  const simulator = await import(pathToFileURL(fileURLToPath(new URL("../../../../scripts/recall-harness-simulator.mjs", import.meta.url))).href);
  const host = pool.sourceFact({ record_id: "a", source_body: "abcdefghij", occurrences: [
    { role: "user", utf8_span: [0, 5] }, { role: "assistant", utf8_span: [5, 10] }
  ], units: [] });
  expect(host.role_status).toBe("mixed");
  expect(host.role).toBeNull();
  expect(pool.matchedRole({ start_byte: 5, end_byte: 10 }, host)).toEqual({ status: "known", role: "assistant" });
  const partial = pool.sourceFact({ record_id: "b", source_body: "abcdefghij", occurrences: [
    { role: "user", utf8_span: [0, 5] }, { utf8_span: [5, 10] }
  ], units: [] });
  expect(partial.role_status).toBe("partial");
  expect(partial.role).toBeNull();
  expect(pool.matchedRole({ start_byte: 0, end_byte: 10 }, partial)).toEqual({ status: "partial", roles: ["user"] });
  const capture = new Map([["q", { pool_capture: { pool: [{ host: { root_id: "a", round: 0 } }] } }]]);
  const intervals = ["a", "unknown"].map((id, slot_index) => ({ slot_index, target: { root_id: id }, span: {} }));
  const result = simulator.aggregate([], [{ question_id: "q", intervals }], capture);
  expect(result.early_first_five).toEqual({ first_round: 1, slots: 2, known: 1, unknown: 1,
    share: null, known_share: 1, lower_bound: 0.5, upper_bound: 1 });
  const hostContainer = await import(pathToFileURL(fileURLToPath(new URL("../../../../scripts/recall-host-container.mjs", import.meta.url))).href);
  const one = { container_ref: { scope: "workspace-a", id: "session" }, upstream_position: 2 };
  const other = { container_ref: { scope: "workspace-b", id: "session" }, upstream_position: 3 };
  expect(hostContainer.projectHostContainer([one, other])).toEqual({ status: "ambiguous", key: null, reference: null, position: null });
  expect(hostContainer.projectHostContainer([one, { ...one, upstream_position: 3 }])).toEqual({
    status: "available", key: JSON.stringify(["workspace-a", "session"]), reference: one.container_ref, position: 2 });
});

it("preserves the ordinary error when the observation callback also throws", async () => {
  const original = new Error("ordinary failure");
  const daemon = { observeSourceSemantics: async (_options: unknown, work: () => Promise<unknown>) => {
    try { return { status: "available", observations: [], outcome: { status: "success", value: await work() } }; }
    catch (error) { return { status: "available", observations: [], outcome: { status: "failure", error } }; }
  } } as unknown as Parameters<typeof observeOrdinaryEntry>[0];
  await expect(observeOrdinaryEntry(daemon, "q", async () => { throw original; }, () => { throw new Error("observer failure"); }))
    .rejects.toBe(original);
});

it("replays multiple native membership windows and keeps the final page past ten slots", async () => {
  const texts = Array.from({ length: 16 }, (_, index) => `Project item ${index}: ${"evidence ".repeat(38)}`);
  const fixture = await ordinaryIndexedSnapshot(texts); roots.push(fixture.root);
  const query = fixture.queries[0]!;
  const input = { config: fixture.config, queries: [{ query_key: query.query_key, original_query: query.original_query }] };
  const plain = (await executeOrdinaryRecallEntry({ ...input, root: join(fixture.root, "plain") })).rows[0]!;
  const observations: OrdinaryEntryObservation[] = [];
  const captured = (await executeOrdinaryRecallEntry({ ...input, root: join(fixture.root, "capture") },
    (_key, observation) => { observations.push(observation); })).rows[0]!;
  expect(captured.status).toBe("complete");
  expect(captured.source_intervals).toEqual(plain.source_intervals);
  expect(captured.source_intervals.length, JSON.stringify(captured.pages.map(page => page.occupied_slots))).toBeGreaterThan(10);
  expect(captured.pages.length).toBeGreaterThan(2);
  const pool = await import(pathToFileURL(fileURLToPath(new URL("../../../../scripts/recall-harness-pool.mjs", import.meta.url))).href);
  const delivery = await import(pathToFileURL(fileURLToPath(new URL("../../../../scripts/recall-simulator-delivery.mjs", import.meta.url))).href);
  const row = { snapshot: fixture.config.snapshot_path, snapshot_sha256: fixture.config.snapshot_sha256,
    workspace: fixture.config.workspace_id, stop_cause: captured.stop_cause };
  const poolCapture = await pool.captureRecallPool({ row, query: captured, observation: observations[0] });
  expect(poolCapture.status, JSON.stringify(poolCapture.issues)).toBe("captured");
  expect(poolCapture.page_attempts.length).toBe(captured.pages.length);
  expect(poolCapture.page_attempts.some((page: { attempts: { outcome: { fits: boolean } }[] }) =>
    page.attempts.some(attempt => !attempt.outcome.fits))).toBe(true);
  const order = delivery.observedAccessOrder(poolCapture), original = structuredClone(poolCapture);
  const replay = delivery.simulateRecallDelivery({ ...row, pool_capture: poolCapture }, order);
  expect(replay.intervals).toEqual(plain.source_intervals);
  expect(replay.intervals.length).toBeGreaterThan(10);
  expect(poolCapture).toEqual(original);
}, 120000);
