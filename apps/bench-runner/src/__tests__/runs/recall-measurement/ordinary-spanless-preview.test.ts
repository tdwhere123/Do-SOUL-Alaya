import { afterAll, afterEach, expect, it, vi } from "vitest";
const boundary = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  const { installStrictProviderFreeBoundary } = await import("../../support/strict-provider-free-boundary.js");
  return { safe: installProviderFreeBoundary(), strict: installStrictProviderFreeBoundary() };
});
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDatabase, openReadOnlyDatabase, SqliteFieldSourceRecordRepo } from "@do-soul/alaya-storage";
import { fieldContractSha256 } from "@do-soul/alaya-core";
import { SoulMemorySearchResponseSchema, sourceRecallTarget, sourceIndexEntry, encodeSourceDisclosure, sourceDisclosureProofUse,
  type SourceEvidenceTarget, type MemorySearchResult, type SoulMemorySearchResponse } from "@do-soul/alaya-protocol";
import { seedWorkspaces, hashedOriginalRecord } from "../../../../../../packages/storage/src/__tests__/repos/field/field-contract-fixture.js";
import { SemanticChainConfigSchema, chainIdentity, writeChainArtifact } from "../../../runs/recall-measurement/contract.js";
import { OrdinaryRecallArchiveSchema, buildOrdinaryRecallRequest, UNOBSERVED_ORDINARY_COUNTERS }
  from "../../../runs/recall-measurement/ordinary/ordinary-entry-contract.js";
import { admitOrdinaryFrozenExecution } from "../../../runs/recall-measurement/ordinary/ordinary-frozen-replay.js";
import { admitOrdinarySourceDelivery } from "../../../runs/recall-measurement/ordinary/ordinary-source-admission.js";
import { admitEmittedSourcePreview } from "../../../runs/recall-measurement/library-admission.js";
import { scoreOrdinaryByteVisibility } from "../../../runs/recall-measurement/ordinary/ordinary-byte-visibility.js";
import { readOrdinaryLineFacts, scoreOrdinaryLineCounterfactual } from "../../../runs/recall-measurement/ordinary/ordinary-line-counterfactual.js";
import { scoreConsumerMessageVisibility } from "../../../runs/longmemeval-semantic/message-visibility.js";
import { sourceGoldUnitFromPublishedRoot } from "../../../runs/measurement/source-gold-join.js";
import { FirstExposureSession } from "../../../runs/measurement/first-exposure-session.js";
import { admittedSourceDeliveryTail } from "../../../runs/measurement/source-delivery-visibility.js";
import { hashRegularFileNoFollow } from "../../../runs/snapshot/bound-file.js";
import type { AnswerTurnGold } from "../../../runs/longmemeval-semantic/answer-spans.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
afterAll(() => {
  expect(boundary.safe.violations).toEqual([]); expect(boundary.strict.forbidden).toEqual([]);
  boundary.strict.restore(); boundary.safe.restore();
});
const clock = "2026-10-01T00:00:00.000Z", query = { query_key: "a".repeat(64), original_query: "Authored source query" };
const decorated = "a".repeat(157) + "...", bodies = ["a".repeat(2048), "b".repeat(2000)];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ordinary-spanless-")); roots.push(root);
  const snapshot = join(root, "source.sqlite"), database = initDatabase({ filename: snapshot });
  seedWorkspaces(database, ["workspace"]);
  const targets: SourceEvidenceTarget[] = bodies.map((body, index) => {
    const record = { ...hashedOriginalRecord("workspace", body, `authored-${index}`), scope_class: "project" as const };
    new SqliteFieldSourceRecordRepo(database, fieldContractSha256).insert(record);
    return sourceRecallTarget({ workspace_id: record.workspace_id, root_kind: "source_record", root_id: record.record_id,
      source_version: record.source_version, content_digest: record.content_digest, evidence_object_id: record.evidence_object_id });
  });
  database.connection.pragma("wal_checkpoint(TRUNCATE)"); database.connection.pragma("journal_mode = DELETE"); database.close();
  const config = SemanticChainConfigSchema.parse({ snapshot_path: snapshot, snapshot_sha256: hashRegularFileNoFollow(snapshot),
    implementation_revision: `git-worktree-v1:${"a".repeat(40)}:${"b".repeat(64)}`, interpretation_clock: clock,
    workspace_id: "workspace", run_id: "authored-run", query_workset: { contract: "source-semantic-proposal-workset-v3", kind: "query",
      model: "not-executed", provider_url: "https://example.invalid", request_profile: "gemini-3.1-minimal-v1",
      items: [{ original_query: query.original_query }] }, query_cache_root: join(root, "unused-q"), correspondence_cache_root: join(root, "unused-c"),
    max_output_tokens: 1024, discovery_page_cap: 1, correspondence_pair_cap: 0, access_policy: "query-conditioned-v1",
    budget: { schema_version: 1, work_units: 1000000, memory_bytes: 1000000, page_budget: 10000, finalization_reserve: 1000, min_envelope: 10 },
    authorized_scopes: { mode: "named", scopes: ["project"] }, output_byte_limit: 100000 });
  return { root, snapshot, targets, config };
}
function result(target: SourceEvidenceTarget, text: string): MemorySearchResult & { target: SourceEvidenceTarget } {
  return { object_kind: "source_evidence", target, relevance_score: 0, content_preview: text, evidence_pointers: [],
    hypothesis_id: "authored-hypothesis", output_binding: "authored-binding", program_state: "accepting", time_state: "as_of",
    selection_reason: "authored fixture", source_channels: [], score_factors: { activation: 0, relevance: 0 },
    budget_state: { token_estimate: 1, max_entries: 5, max_total_tokens: 100, remaining_entries: 4, remaining_tokens: 99, within_budget: true },
    source_disclosure: encodeSourceDisclosure({ material_kind: "unknown", source_binding: "checked_record", evaluated_as_of: clock,
      validity: { kind: "unknown", reason: "not_recorded" }, temporal_state: "unknown", proof_use: sourceDisclosureProofUse("source_only") }) };
}
const bounded = (target: SourceEvidenceTarget, size: number) => ({ ...target, span: { content_start: 0, content_end: size,
  retained_extent: "body" as const, content_complete: true, original_complete: true } });
function archive(f: ReturnType<typeof fixture>, results: ReturnType<typeof result>[], open = false,
  corrupt?: (value: SoulMemorySearchResponse) => SoulMemorySearchResponse) {
  const output = SoulMemorySearchResponseSchema.parse({ delivery_id: "authored-delivery", results, total_count: results.length,
    index: { schema_version: 1, query_id: "authored-query", snapshot_id: `sha256:${f.config.snapshot_sha256}`,
      result_version: "authored-version", interpretation_id: "authored-interpretation", as_of: clock,
      entries: results.map(row => ({ ...sourceIndexEntry({ ...row.target, association_milligrades: 0,
        hypothesis_id: row.hypothesis_id!, output_binding: row.output_binding!, program_state: "accepting", time_state: "as_of" }), target: row.target })),
      completeness: { schema_version: 1, logical_index: open ? "partial" : "complete", observed_coverage: open ? "partial" : "complete",
        transport: "complete", payload: "partial", representation: "complete" },
      continuation: open ? { schema_version: 1, continuation_id: "authored-next", query_id: "authored-query",
        snapshot_id: `sha256:${f.config.snapshot_sha256}`, result_version: "authored-version", expires_at: "2026-10-02T00:00:00.000Z", cursor: "next" } : null,
      representation: { schema_version: 1, policy: "construct_index_then_page_then_payload", page_budget: 5, identity_tie_break: "serialization" },
      order_status: "partial", page_purpose: "membership" } });
  const request = buildOrdinaryRecallRequest({ query: query.original_query, scope_class: "project", source_observed_at: clock });
  const envelope = { content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: { ok: true, output: structuredClone(output) } };
  const first = new FirstExposureSession().record(output), index = output.index!;
  const intervals = results.flatMap((row, slot_index) => row.target.kind === "source_evidence" && row.target.span !== undefined
    ? [{ slot_index, target: row.target, span: row.target.span }] : []);
  const recorded = corrupt?.(output) ?? output;
  const cost = { status: "unavailable", reason: "authored fixture has no public query" };
  const execution = OrdinaryRecallArchiveSchema.parse({ contract: "ordinary-recall-public-entry-v2", input_identity: "c".repeat(64),
    config_identity: chainIdentity(f.config), mapping: { status: "mapped", scope_class: "project", max_results: 5,
      observed_slot_target: 10, unmapped_dimensions: [] }, consumer_model_calls: 0,
    rows: [{ ...query, status: "partial", snapshot_identity: { query_id: index.query_id, snapshot_id: index.snapshot_id,
      result_version: index.result_version, interpretation_id: index.interpretation_id, as_of: index.as_of },
      pages: [{ ordinal: 1, phase: "membership", request, public_call: { request: { name: "soul.recall", arguments: request }, response: envelope },
        envelope, output: recorded, first_exposure: first, response_state: "success", observation: "observed", occupied_slots: results.length,
        source_intervals: intervals, complete: true, continuation: open ? "present" : "none", terminal_tail: admittedSourceDeliveryTail(index), reason: null }],
      page_count: 1, stop_cause: "no_issued_continuation", first_exposure: first, source_intervals: intervals,
      unobserved_counters: [...UNOBSERVED_ORDINARY_COUNTERS], costs: { work_units: cost, read_bytes: cost, latency_ms: cost } }] });
  writeChainArtifact(join(f.root, "ordinary/ordinary-entry.json"), execution);
  return () => admitOrdinaryFrozenExecution({ executionRoot: f.root, config: f.config, query });
}
function gold(targets: readonly SourceEvidenceTarget[]): AnswerTurnGold {
  return { unit: "published_body_utf8_bytes", annotated_turns: targets.length, complete: true,
    spans: targets.map((target, i) => ({ session_index: i, message_index: 0, source_id: target.root_id,
      target: sourceGoldUnitFromPublishedRoot(target), start: 0, end: target.root_id === targets[0]?.root_id ? 157 : 2000 })) };
}
it("replays decorated spanless output through SQLite without inventing body bytes or closing a partial tail", () => {
  const f = fixture(), before = readFileSync(f.snapshot);
  const replay = archive(f, [result(f.targets[0]!, decorated)], true)();
  expect(replay.pages[0]).toMatchObject({ occupied_slots: 1, continuation: "present", intervals: [],
    unmapped_sources: [{ rank: 1 }], terminal_tail: { status: "open" } });
  expect(replay.previews[0]).toMatchObject({ rank: 1, text: decorated, source: { status: "unmapped", reason: "source_span_unavailable" } });
  expect(replay.windows).toEqual([]);
  const bytes = scoreOrdinaryByteVisibility({ ...replay, gold: gold([f.targets[0]!]) });
  expect(bytes.observed_display_utf8_bytes).toBe(160);
  expect(bytes.captured_source_utf8_bytes).toBeNull(); expect(bytes.admitted_source_utf8_bytes).toBe(0);
  expect(bytes.first_hit_byte).toMatchObject({ status: "unknown", bytes: null });
  expect(bytes.budgets.every(row => row.any_at_budget.status === "unknown" && row.source_utf8_bytes === null)).toBe(true);
  expect(readFileSync(f.snapshot)).toEqual(before);
});
it("retains mixed ranks and independent slot hits while body budgets and line packing remain unavailable", () => {
  const f = fixture(), second = bounded(f.targets[1]!, 2000);
  const replay = archive(f, [result(f.targets[0]!, decorated), result(second, bodies[1]!)])();
  expect(replay.windows.map(window => [window.rank, window.start, window.end])).toEqual([[2, 0, 2000]]);
  const labels = { ...gold([second]), spans: [{ ...gold([second]).spans[0]!, end: 2000 }] };
  expect(scoreConsumerMessageVisibility({ ...replay, gold: labels }).any_at_5.status).toBe("hit");
  expect(scoreConsumerMessageVisibility({ ...replay, gold: gold([f.targets[0]!]) }).any_at_5.status).toBe("unknown");
  const mixed = scoreConsumerMessageVisibility({ ...replay, gold: gold([f.targets[0]!, second]) });
  expect(mixed.any_at_5.status).toBe("hit"); expect(mixed.all_at_5.status).toBe("unknown");
  expect(mixed.messages.map(message => message.at_5.status)).toEqual(["unknown", "hit"]);
  const bytes = scoreOrdinaryByteVisibility({ ...replay, gold: labels });
  expect(bytes.observed_display_utf8_bytes).toBe(2160); expect(bytes.admitted_source_utf8_bytes).toBe(2000);
  expect(bytes.captured_source_utf8_bytes).toBeNull(); expect(bytes.last_hit_byte.status).toBe("unknown");
  const database = openReadOnlyDatabase(f.snapshot);
  try {
    const contrast = scoreOrdinaryLineCounterfactual({ ...replay, gold: labels,
      line_facts: readOrdinaryLineFacts(database, replay.previews.map(preview => preview.target)) });
    expect(contrast.status).toBe("unavailable");
    expect(contrast.budgets.every(row => row.aligned.any_at_budget.status === "unknown" && row.aligned.source_utf8_bytes === null)).toBe(true);
  } finally { database.close(); }
});
it("keeps known omitted markers out of the source-body budget without charging their decoration to B", () => {
  const f = fixture(), omitted = { ...result(bounded(f.targets[0]!, 2048), "[payload omitted]"),
    budget_state: { ...result(f.targets[0]!, "").budget_state, within_budget: false } };
  const second = bounded(f.targets[1]!, 2000), replay = archive(f, [omitted, result(second, bodies[1]!)])();
  expect(replay.previews[0]!.source.status).toBe("not_delivered");
  const labels = { ...gold([second]), spans: [{ ...gold([second]).spans[0]!, end: 2000 }] };
  const bytes = scoreOrdinaryByteVisibility({ ...replay, gold: labels });
  expect(bytes.first_hit_byte.bytes).toBe(2000); expect(bytes.budgets[0]!.any_at_budget.status).toBe("hit");
  expect(bytes.observed_display_utf8_bytes).toBe(2017); expect(bytes.captured_source_utf8_bytes).toBe(2000);
});
it.each(["span", "root", "missing-root", "scope", "target"])("rejects forged %s despite otherwise valid spanless observation", kind => {
  const f = fixture(), database = openReadOnlyDatabase(f.snapshot), target = f.targets[0]!;
  try {
    if (kind === "span") {
      const claimed = bounded(target, 160);
      expect(() => admitOrdinarySourceDelivery(database, "workspace", ["project"], claimed, result(claimed, decorated)))
        .toThrow(/preview differs from sealed source span/u);
      expect(() => admitEmittedSourcePreview(undefined, result(target, decorated), undefined, target, bodies[0]!, false))
        .toThrow(/no bound body span/u);
    } else if (kind === "root") {
      const changed = { ...target, content_digest: `sha256:${"0".repeat(64)}` };
      expect(() => admitOrdinarySourceDelivery(database, "workspace", ["project"], changed, result(changed, decorated))).toThrow();
    } else if (kind === "missing-root") {
      const changed = { ...target, root_id: "missing-authored-root" };
      expect(() => admitOrdinarySourceDelivery(database, "workspace", ["project"], changed, result(changed, decorated)))
        .toThrow(/source unbound/u);
    } else if (kind === "scope") {
      expect(() => admitOrdinarySourceDelivery(database, "workspace", ["global_core"], target, result(target, decorated)))
        .toThrow(/outside authorized scopes/u);
    } else expect(() => admitOrdinarySourceDelivery(database, "workspace", ["project"], target, result(f.targets[1]!, decorated)))
      .toThrow(/result target changed/u);
  } finally { database.close(); }
});
it("rejects recorded/raw output disagreement instead of classifying it as unmapped display", () => {
  const f = fixture();
  const replay = archive(f, [result(f.targets[0]!, decorated)], false, output => ({ ...output,
    results: output.results.map((row, i) => i === 0 ? { ...row, content_preview: "forged" } : row) }));
  expect(replay).toThrow(/decoded output differs from raw MCP output/u);
});
