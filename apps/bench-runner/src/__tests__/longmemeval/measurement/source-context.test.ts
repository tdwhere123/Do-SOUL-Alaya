import { afterAll, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const guards = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  const { installStrictProviderFreeBoundary } = await import("../../support/strict-provider-free-boundary.js");
  return [installProviderFreeBoundary(), installStrictProviderFreeBoundary()] as const;
});
afterAll(() => { expect(guards[0].violations).toEqual([]); expect(guards[1].forbidden).toEqual([]);
  guards[1].restore(); guards[0].restore(); });
import { sourceIndexTarget, type SourceSemanticNominationOccurrence } from "@do-soul/alaya-protocol";
import { SqliteFieldSourceRecordRepo } from "@do-soul/alaya-storage";
import { readFieldDelivery } from "../../../runs/source-access-diagnostic/field-delivery-read.js";
import { sourceContextRoute, FIELD_DELIVERY_LIMITS } from "../../../runs/source-access-diagnostic/field-delivery.js";
import { ConditionalNavigationRunSchema, frozenDeliveryArms, frozenDeliveryPolicy } from "../../../runs/source-access-diagnostic/conditional-navigation-input.js";
import { navigationInventory, solveConditionalNavigation } from "../../../runs/source-access-diagnostic/conditional-navigation.js";
import { navigationReadAccounting, navigationReadLedger } from "../../../runs/source-access-diagnostic/navigation-read-budget.js";
import { bindSourceRecordsObservation } from "../../../runs/snapshot/source-records/observation-projection.js";
import { fixture, publishSource, fieldSha256, WORKSPACE } from "../../../../../../packages/storage/src/__tests__/repos/source-index/source-index-fixture.js";
type Environment = ReturnType<typeof fixture>;
function witness(db: Environment, text: string, id: string, located = true): SourceSemanticNominationOccurrence {
  const record = publishSource(db, text, id, { scope_class: "project" });
  const source = sourceIndexTarget({ kind: "source_evidence", workspace_id: WORKSPACE, root_kind: "source_record", root_id: record.record_id,
    source_version: record.source_version, content_digest: record.content_digest, evidence_object_id: null }, id, Buffer.byteLength(text));
  return { reference: id, attempt: 1, view: "original", source, route: located
    ? { kind: "vector", native_rank: 1, cosine: 1, window: { status: "available", window: {
      window_id: `sha256:${fieldSha256(id)}`, start_byte: 7, end_byte: 14, content_digest: `sha256:${fieldSha256(Buffer.from(text).subarray(7, 14).toString("utf8"))}` } } }
    : { kind: "lexical", native_rank: 1, lane: "unicode61", lane_rank: 1, bm25: -1 } };
}
function context(db: Environment, hit: SourceSemanticNominationOccurrence) {
  const row = { workspace: WORKSPACE, question_id: "authored", authorized_scopes: ["project"], interpretation_clock: "2026-09-22T00:00:00.000Z",
    original: "original", conditions: [{ id: "original", object: "query", hypothesis: "authored", query: "authored", status: "ready" as const,
      residual: null, provenance: "authored" }], branches: [], delivery_policy: { contract: "benchmark-field-delivery.v1" as const,
      selection: "field-order" as const, windows: "source-context" as const, byte_budget: 8192 } };
  const inventory = navigationInventory([{ condition: row.original, witness: [hit] }]);
  return { row, database: db.database, solved: solveConditionalNavigation({ ...row, ...inventory }), targets: inventory.targets,
    witnesses: [hit], projectSourceTime: bindSourceRecordsObservation(row), ledger: navigationReadLedger(10), cached: new Map(),
    delivery: { ordinal: 1, question_id: row.question_id, arm: "authored", accounting: navigationReadAccounting(), reused_delivery_reads: 0 } };
}
it("chooses whole short-source context independently of generic chunk location, and reports global clipping", () => {
  const db = fixture(), text = "assistant generic acknowledgement.\nuser: I volunteered on the spring holiday. 京都🙂";
  try {
    const hit = witness(db, text, "short");
    const ctx = context(db, hit), result = readFieldDelivery(ctx);
    expect(sourceContextRoute(hit.source, [hit])).toBe("whole-source");
    expect(result.windows).toMatchObject([{ context_route: "whole-source", start: 0, end: Buffer.byteLength(text), text }]);
    expect(ctx.delivery.accounting.source_reads).toBe(1); expect(ctx.ledger.located_accounting.attempts).toBe(0);
    ctx.row.delivery_policy.byte_budget = Buffer.byteLength(text) - 1;
    const clipped = readFieldDelivery(ctx);
    expect(clipped.windows[0]!.text).toBe(text.slice(0, -2));
    expect(clipped.fieldDelivery!.packing).toMatchObject({ source_context_packing: [{ status: "partial", read_end: Buffer.byteLength(text),
      delivered_end: Buffer.byteLength(text) - 4 }] });
    expect(ctx.delivery.accounting.source_reads).toBe(2);
  } finally { db.database.close({ optimize: false }); }
});
it("keeps the threshold at the existing cap and long native/prefix routes distinct", () => {
  const db = fixture();
  try {
    const hit = witness(db, "a".repeat(FIELD_DELIVERY_LIMITS.window_bytes), "at-cap", false);
    expect(sourceContextRoute(hit.source, [hit])).toBe("whole-source");
    const long = witness(db, "0123456789".repeat(600), "long");
    expect(readFieldDelivery(context(db, long)).windows).toMatchObject([{ start: 7, end: 14, text: "7890123", context_route: "native-anchor" }]);
    const lexical = { ...long, route: { kind: "lexical" as const, native_rank: 1, lane: "unicode61" as const, lane_rank: 1, bm25: -1 } };
    const ctx = context(db, lexical), result = readFieldDelivery(ctx);
    expect(result.windows).toMatchObject([{ start: 0, end: 4096, context_route: "lexical-prefix" }]);
    expect(result.windows[0]!.text).toBe("0123456789".repeat(410).slice(0, 4096));
    expect(ctx.ledger.located_accounting.attempts).toBe(0); expect(ctx.delivery.accounting.source_reads).toBe(1);
    for (const route of [{ kind: "vector" as const, native_rank: 1, cosine: 1 },
      { kind: "vector" as const, native_rank: 1, cosine: 1, window: { status: "unavailable" as const, reason: "unknown" } },
      { ...lexical.route, hit: { status: "unavailable" as const, reason: "unknown" } }]) {
      const unknown = { ...long, route }, unavailable = context(db, unknown);
      expect(sourceContextRoute(long.source, [lexical, unknown])).toBe("unavailable");
      expect(readFieldDelivery(unavailable).fieldDelivery!.status).toBe("unavailable");
      expect(unavailable.ledger.reserved.logical_requests).toBe(0);
    }
  } finally { db.database.close({ optimize: false }); }
});
it("does not retry on failed native hydration, exhaustion, or a known lexical current-read rejection", () => {
  const db = fixture();
  try {
    const long = witness(db, "0123456789".repeat(600), "long-failure");
    if (long.route.kind !== "vector" || long.route.window?.status !== "available") throw new Error("authored location missing");
    const bad = { ...long, route: { ...long.route, window: { ...long.route.window,
      window: { ...long.route.window.window, content_digest: `sha256:${"0".repeat(64)}` } } } };
    const ctx = context(db, bad);
    expect(() => readFieldDelivery(ctx)).toThrow(/digest/);
    expect(ctx.delivery.accounting.source_reads).toBe(0); expect(ctx.ledger.located_accounting).toMatchObject({ attempts: 1, completed: 0, status: "partial" });
    expect(ctx.ledger.located_accounting.native_bytes_including_metadata).toBeGreaterThan(0);
    const exhausted = context(db, long); exhausted.ledger = navigationReadLedger(0);
    expect(readFieldDelivery(exhausted).fieldDelivery!.status).toBe("unavailable");
    expect(exhausted.delivery.accounting.source_reads).toBe(0);
    const lexical = { ...long, route: { kind: "lexical" as const, native_rank: 1, lane: "unicode61" as const, lane_rank: 1, bm25: -1 } };
    const denied = context(db, lexical); denied.row.authorized_scopes = [];
    expect(() => readFieldDelivery(denied)).toThrow(/authorized scopes/);
    expect(denied.delivery.accounting.source_reads).toBe(1); expect(denied.delivery.accounting.native_bytes).toBeGreaterThan(0);
  } finally { db.database.close({ optimize: false }); }
});
it("rejects forged short extent and stale identity using an actual current read, without native fallback or seed reuse", () => {
  const db = fixture();
  try {
    const hit = witness(db, "0123456789".repeat(600), "forged", false);
    const forged = { ...hit, source: { ...hit.source, body_bytes: 30 } }, ctx = context(db, forged);
    expect(() => readFieldDelivery(ctx)).toThrow(/extent\/identity/);
    expect(ctx.delivery.accounting.source_reads).toBe(1); expect(ctx.ledger.located_accounting.attempts).toBe(0);
    publishSource(db, "new version", "forged", { scope_class: "project", source_version: "new", recorded_at: "2026-10-01T00:00:00.000Z" });
    const stale = context(db, hit);
    expect(() => readFieldDelivery(stale)).toThrow(/identity changed/);
    expect(stale.delivery.accounting.source_reads).toBe(1);
    const byId = vi.spyOn(SqliteFieldSourceRecordRepo.prototype, "findByIdBounded");
    try { expect(() => readFieldDelivery(context(db, forged))).toThrow(); expect(byId).not.toHaveBeenCalled(); }
    finally { byId.mockRestore(); }
  } finally { db.database.close({ optimize: false }); }
});
it("derives opt-in frozen arm names and policies from the same private comparison authority", () => {
  const config = ConditionalNavigationRunSchema.parse({ contract: "benchmark-conditional-navigation.v1", source_revision: "authored", cache_root: "/unused",
    frozen_nominations: { family: "conditional-navigation-pilot.v1", receipt: { path: "/unused", sha256: "a".repeat(64) }, byte_budget: 8192 }, rows: [{
      ordinal: 1, question_id: "authored", snapshot: "/unused", snapshot_sha256: "b".repeat(64), workspace: WORKSPACE,
      interpretation_clock: "2026-09-22T00:00:00.000Z", authorized_scopes: null, expected_index: null, original: "original",
      conditions: [{ id: "original", object: "query", hypothesis: "authored", query: "authored", status: "ready", residual: null, provenance: "authored" }], branches: [] }] });
  expect(frozenDeliveryArms(config).map(([arm]) => arm)).toEqual(["window-prefix", "window-native-anchor"]);
  config.frozen_nominations!.comparison = "source-context";
  expect(frozenDeliveryArms(config).map(([arm]) => arm)).toEqual(["window-prefix", "window-source-context"]);
  expect(frozenDeliveryPolicy(config, "window-source-context")).toMatchObject({ selection: "field-order", windows: "source-context", byte_budget: 8192 });
  expect(() => frozenDeliveryPolicy(config, "window-native-anchor")).toThrow();
});
it("runs authored compiled CLI, isolated SQLite and frozen evaluation with no query/model/acquisition/index effects", () => {
  const proof = fileURLToPath(new URL("../../support/source-context-proof.mjs", import.meta.url));
  const evidence = process.env.ALAYA_AUTHORED_SOURCE_CONTEXT_EVIDENCE;
  const result = execFileSync(process.execPath, [proof, ...(evidence ? [evidence] : [])], { encoding: "utf8", timeout: 240_000, maxBuffer: 8 * 1024 ** 2 });
  expect(JSON.parse(result)).toMatchObject({ status: "complete" });
}, 250_000);
