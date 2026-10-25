import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { AlayaError, SoulMemorySearchResponseSchema, sourceIndexEntry, sourceRecallTarget, encodeSourceDisclosure, sourceDisclosureProofUse,
  type SoulMemorySearchResponse } from "@do-soul/alaya-protocol";
import { initDatabase, SqliteFieldSourceRecordRepo } from "@do-soul/alaya-storage";
import { fieldContractSha256 } from "@do-soul/alaya-core";
import { seedWorkspaces, hashedOriginalRecord } from "../../../../../../packages/storage/src/__tests__/repos/field/field-contract-fixture.js";
import { SemanticChainConfigSchema, chainIdentity, readChainArtifact, writeChainArtifact } from "../../../runs/recall-measurement/contract.js";
import { executeOrdinaryRecallEntry } from "../../../runs/recall-measurement/ordinary/ordinary-entry-execution.js";
import { admitOrdinaryFrozenExecution } from "../../../runs/recall-measurement/ordinary/ordinary-frozen-replay.js";
import { OrdinaryRecallExecutionSchema } from "../../../runs/recall-measurement/ordinary/ordinary-entry-contract.js";
import { ordinaryEntryStopCause } from "../../../runs/recall-measurement/ordinary/ordinary-entry-policy.js";
import { scoreConsumerMessageVisibility } from "../../../runs/longmemeval-semantic/message-visibility.js";
import { sourceGoldUnitFromPublishedRoot } from "../../../runs/measurement/source-gold-join.js";
import { hashRegularFileNoFollow } from "../../../runs/snapshot/bound-file.js";
import { readCurrentExtractionAuthorityRevision } from "../../../runs/extraction/authority/inspection.js";

const roots: string[] = [], clock = "2026-10-01T00:00:00.000Z", body = "Authored literal π delivery.";
const query = { query_key: "a".repeat(64), original_query: "Authored query" };
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
afterAll(() => { isolation.restore(); expect(isolation.violations).toEqual([]); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ordinary-progress-")); roots.push(root);
  const snapshot = join(root, "source.sqlite"), database = initDatabase({ filename: snapshot });
  seedWorkspaces(database, ["workspace"]);
  const record = { ...hashedOriginalRecord("workspace", body, "authored-source"), scope_class: "project" as const };
  new SqliteFieldSourceRecordRepo(database, fieldContractSha256).insert(record);
  database.connection.pragma("wal_checkpoint(TRUNCATE)"); database.connection.pragma("journal_mode = DELETE"); database.close();
  const target = { ...sourceRecallTarget({ workspace_id: record.workspace_id, root_kind: "source_record", root_id: record.record_id,
    source_version: record.source_version, content_digest: record.content_digest, evidence_object_id: record.evidence_object_id }),
    span: { content_start: 0, content_end: Buffer.byteLength(body), retained_extent: "body" as const, content_complete: true, original_complete: true } };
  const config = SemanticChainConfigSchema.parse({ snapshot_path: snapshot, snapshot_sha256: hashRegularFileNoFollow(snapshot),
    implementation_revision: readCurrentExtractionAuthorityRevision(), interpretation_clock: clock,
    workspace_id: "workspace", run_id: "authored-run", query_workset: { contract: "source-semantic-proposal-workset-v3", kind: "query",
      model: "not-executed", provider_url: "http://127.0.0.1:9", request_profile: "gemini-3.1-minimal-v1", items: [{ original_query: query.original_query }] },
    query_cache_root: join(root, "unused-q"), correspondence_cache_root: join(root, "unused-c"), max_output_tokens: 1024,
    discovery_page_cap: 1, correspondence_pair_cap: 0, access_policy: "query-conditioned-v1",
    budget: { schema_version: 1, work_units: 1000000, memory_bytes: 1000000, page_budget: 10000, finalization_reserve: 1000, min_envelope: 10 },
    authorized_scopes: { mode: "named", scopes: ["project"] }, output_byte_limit: 100000 });
  function page(ordinal: number, state: "interrupted" | "unavailable" | "invalidated" | "cancelled" | "resource_rejected" | "partial" | "complete",
    issued = true): SoulMemorySearchResponse {
    const entries = state === "complete" ? [sourceIndexEntry({ ...target, association_milligrades: 0,
      hypothesis_id: "authored-hypothesis", output_binding: "authored-binding", program_state: "accepting", time_state: "as_of" })] : [];
    const results = state === "complete" ? [{ object_kind: "source_evidence", target, relevance_score: 0, content_preview: body,
      evidence_pointers: [], hypothesis_id: "authored-hypothesis", output_binding: "authored-binding", program_state: "accepting", time_state: "as_of",
      selection_reason: "authored fixture", source_channels: [], score_factors: { activation: 0, relevance: 0 },
      source_disclosure: encodeSourceDisclosure({ material_kind: "original_body", source_binding: "checked_record", evaluated_as_of: clock,
        validity: { kind: "unknown", reason: "not_recorded" }, temporal_state: "unknown", proof_use: sourceDisclosureProofUse("source_only") }),
      budget_state: { token_estimate: 1, max_entries: 5, max_total_tokens: 100, remaining_entries: 4, remaining_tokens: 99, within_budget: true } }] : [];
    return SoulMemorySearchResponseSchema.parse({ delivery_id: `delivery-${ordinal}`, results, total_count: results.length,
      index: { schema_version: 1, query_id: "authored-query", snapshot_id: `sha256:${config.snapshot_sha256}`, result_version: "authored-version",
        interpretation_id: "authored-interpretation", as_of: clock, entries: entries.map(entry => ({ ...entry, target })),
        completeness: { schema_version: 1, logical_index: state, observed_coverage: state, transport: state, payload: state, representation: state },
        continuation: issued ? { schema_version: 1, continuation_id: `issued-${ordinal}`, query_id: "authored-query", snapshot_id: `sha256:${config.snapshot_sha256}`,
          result_version: "authored-version", expires_at: "2099-10-02T00:00:00.000Z", cursor: `p0g0r${ordinal}`,
          interpretation_id: "authored-interpretation", interpretation_clock: clock, enumeration_policy: "native_query", result_kind_view: "source_only" } : null,
        representation: { schema_version: 1, policy: "construct_index_then_page_then_payload", page_budget: 5, identity_tie_break: "serialization" },
        order_status: "partial", page_purpose: "membership" } });
  }
  return { root, config, target, page, input: { root: join(root, "ordinary"), config, queries: [query] } };
}
function sequence(make: (ordinal: number) => SoulMemorySearchResponse | "error" | "cancel") {
  let calls = 0;
  const requests: unknown[] = [];
  vi.spyOn(Client.prototype, "callTool").mockImplementation(async params => {
    expect(params.name).toBe("soul.recall"); requests.push(structuredClone(params.arguments));
    const output = make(++calls);
    if (output === "cancel") throw new AlayaError("CANCELLED", "authored cancellation");
    if (output === "error") return { content: [{ type: "text", text: "authored public refusal" }], isError: true };
    return { content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: { ok: true, output } };
  });
  return requests;
}

it.each(["interrupted", "unavailable"] as const)("captures issued %s progress then literal bytes; frozen SQLite replay retains old-policy absence", async state => {
  const f = fixture(), control = f.page(1, state), delivered = f.page(2, "complete", false);
  const requests = sequence(ordinal => ordinal === 1 ? control : delivered);
  const execution = await executeOrdinaryRecallEntry(f.input), row = execution.rows[0]!;
  expect(execution.contract).toBe("ordinary-recall-public-entry-v3");
  expect(row.pages.map(page => page.occupied_slots)).toEqual([0, 1]);
  expect(row.stop_cause).toBe("occupancy_tail_exhausted"); expect(row.status).toBe("complete");
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual({ ...requests[0] as object, continuation: control.index!.continuation });
  expect(row.first_exposure!.initial!.slots).toEqual([]);
  expect(row.pages[1]!.first_exposure!.initial).toEqual(row.first_exposure!.initial);
  const replay = admitOrdinaryFrozenExecution({ executionRoot: f.root, config: f.config, query });
  expect(replay.capture_contract).toBe("ordinary-recall-public-entry-v3");
  expect(replay.windows.map(window => [window.rank, window.start, window.end, window.text]))
    .toEqual([[1, 0, Buffer.byteLength(body), body]]);
  const gold = { unit: "published_body_utf8_bytes" as const, annotated_turns: 1, complete: true,
    spans: [{ session_index: 0, message_index: 0, source_id: "authored-source", target: sourceGoldUnitFromPublishedRoot(f.target), start: 0, end: Buffer.byteLength(body) }] };
  expect(scoreConsumerMessageVisibility({ pages: replay.pages, gold }).all_at_10.status).toBe("hit");
  const legacy = { ...execution, contract: "ordinary-recall-public-entry-v2",
    input_identity: chainIdentity({ contract: "ordinary-recall-public-entry-v2", config: f.config, mapping: execution.mapping, queries: [query] }),
    rows: [{ ...row, pages: [row.pages[0]!], page_count: 1,
    status: "partial", stop_cause: "terminal_index", source_intervals: [] }] };
  const oldRoot = join(f.root, "historical"); writeChainArtifact(join(oldRoot, "ordinary/ordinary-entry.json"), legacy);
  const old = admitOrdinaryFrozenExecution({ executionRoot: oldRoot, config: f.config, query });
  expect(old.capture_contract).toBe("ordinary-recall-public-entry-v2"); expect(old.windows).toEqual([]);
  expect(scoreConsumerMessageVisibility({ pages: old.pages, gold }).any_at_5.status).toBe("unknown");
  expect(OrdinaryRecallExecutionSchema.safeParse(legacy).success).toBe(false);
  await expect(executeOrdinaryRecallEntry({ ...f.input, root: join(oldRoot, "ordinary") })).rejects.toThrow();
  expect(requests).toHaveLength(2);
  // The forward replay cannot silently truncate a resumable prefix or relabel it as terminal.
  writeChainArtifact(join(f.root, "relabelled/ordinary/ordinary-entry.json"), { ...legacy, contract: execution.contract });
  expect(() => admitOrdinaryFrozenExecution({ executionRoot: join(f.root, "relabelled"), config: f.config, query }))
    .toThrow(/policy\/config\/query identity mismatch/u);
  writeChainArtifact(join(f.root, "truncated/ordinary/ordinary-entry.json"), { ...legacy, contract: execution.contract,
    input_identity: execution.input_identity });
  expect(() => admitOrdinaryFrozenExecution({ executionRoot: join(f.root, "truncated"), config: f.config, query }))
    .toThrow(/stop differs from bounded-progress policy/u);
  writeChainArtifact(join(f.root, "overrun/ordinary/ordinary-entry.json"), { ...execution, rows: [{ ...row,
    pages: [...row.pages, { ...row.pages[1]!, ordinal: 3 }], page_count: 3 }] });
  expect(() => admitOrdinaryFrozenExecution({ executionRoot: join(f.root, "overrun"), config: f.config, query }))
    .toThrow(/continued after its policy stop/u);
  expect(chainIdentity(readChainArtifact(join(f.input.root, "ordinary-entry.json")))).toBe(chainIdentity(execution));
}, 120000);

it("does not advance retry/payload pages or turn unavailable payload into tail exhaustion", () => {
  const f = fixture(), index = f.page(1, "interrupted").index!;
  for (const page_purpose of ["retry", "payload"] as const) {
    expect(ordinaryEntryStopCause({ ...index, page_purpose }, 0, 1)).toBe("terminal_index");
  }
  expect(ordinaryEntryStopCause({ ...index, continuation: null, completeness: { ...index.completeness,
    logical_index: "complete", observed_coverage: "complete", payload: "unavailable" } }, 0, 1)).toBe("terminal_index");
  expect(ordinaryEntryStopCause(index, 10, 2)).toBe("observed_ten_slot_prefix");
});

it.each([
  { state: "unavailable", issued: false, stop: "terminal_index" },
  { state: "invalidated", issued: true, stop: "terminal_index" },
  { state: "cancelled", issued: true, stop: "terminal_index" },
  { state: "resource_rejected", issued: true, stop: "terminal_index" },
  { state: "partial", issued: false, stop: "no_issued_continuation" }
] as const)("stops $state with issued=$issued without a replacement initial", async ({ state, issued, stop }) => {
  const f = fixture(), requests = sequence(ordinal => f.page(ordinal, state, issued));
  const row = (await executeOrdinaryRecallEntry(f.input)).rows[0]!;
  expect(requests).toHaveLength(1); expect(row.stop_cause).toBe(stop); expect(row.status).toBe("partial");
}, 120000);

it.each(["repeated_cursor", "public_error", "page_ceiling"] as const)("bounds progress at %s and does not manufacture delivery", async failure => {
  const f = fixture();
  const requests = sequence(ordinal => failure === "public_error" && ordinal === 2 ? "error" : {
    ...f.page(ordinal, "interrupted"), ...(failure === "repeated_cursor" && ordinal === 2
      ? { index: { ...f.page(2, "interrupted").index!, continuation: f.page(1, "interrupted").index!.continuation } } : {})
  });
  const row = (await executeOrdinaryRecallEntry(f.input)).rows[0]!;
  expect(requests).toHaveLength(failure === "page_ceiling" ? 64 : 2);
  expect(row.stop_cause).toBe(failure === "page_ceiling" ? "membership_page_bound" : failure === "public_error" ? "failed" : "unavailable");
  expect(row.status).toBe("partial"); expect(row.source_intervals).toEqual([]);
  expect(row.pages.every(page => page.occupied_slots === 0)).toBe(true);
  if (failure === "page_ceiling") {
    const replay = admitOrdinaryFrozenExecution({ executionRoot: f.root, config: f.config, query });
    expect(replay.pages).toHaveLength(64); expect(replay.windows).toEqual([]);
  }
}, 120000);

it("cancellation after progress leaves the reservation unresolved and does not publish or re-expose", async () => {
  const f = fixture(), requests = sequence(ordinal => ordinal === 1 ? f.page(1, "interrupted") : "cancel");
  await expect(executeOrdinaryRecallEntry(f.input)).rejects.toMatchObject({ code: "CANCELLED" });
  expect(readChainArtifact(join(f.input.root, "ordinary-entry.json"))).toBeUndefined();
  await expect(executeOrdinaryRecallEntry(f.input)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(requests).toHaveLength(2);
}, 120000);
