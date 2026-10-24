import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDatabase, SqliteFieldSourceRecordRepo } from "@do-soul/alaya-storage";
import { fieldContractSha256 } from "@do-soul/alaya-core";
import { hashContentDigest, hashSourceRecordId, SOURCE_SPAN_IDENTITY_OPERATOR_ID, UNKNOWN_UTTERANCE_ATTRIBUTION,
  stableCanonicalStringify } from "@do-soul/alaya-protocol";
import { SemanticChainConfigSchema, readChainArtifact } from "../../../runs/recall-measurement/contract.js";
import { OrdinaryRecallExecutionSchema } from "../../../runs/recall-measurement/ordinary/ordinary-entry-contract.js";
import { executeOrdinaryRecallEntry } from "../../../runs/recall-measurement/ordinary/ordinary-entry-execution.js";
import { hashRegularFileNoFollow } from "../../../runs/snapshot/bound-file.js";
import { readCurrentExtractionAuthorityRevision } from "../../../runs/extraction/authority/inspection.js";
import { publishIndexedGeneration } from "../../../../../core-daemon/src/__tests__/runtime/recall/recall-storage.test-support.js";
import { simulateIndexedQueryPreparation } from "./ordinary-indexed-snapshot.test-support.js";
import { exposureSlots, firstExposureMismatch } from "../../../runs/measurement/first-exposure-session.js";

const roots: string[] = [];
afterEach(() => vi.restoreAllMocks());
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true });
  isolation.restore(); expect(isolation.violations).toEqual([]); });
async function fixture(count: number) {
  const root = mkdtempSync(join(tmpdir(), "ordinary-exposure-archive-")); roots.push(root);
  const snapshot = join(root, "source.sqlite"), clock = "2026-10-01T00:00:00.000Z";
  const database = initDatabase({ filename: snapshot });
  const body = "Synthetic π preview. Synthetic source body.";
  const content_digest = hashContentDigest(body, fieldContractSha256);
  try {
    database.connection.prepare(`INSERT INTO workspaces (workspace_id, name, root_path, workspace_kind,
      default_engine_binding, workspace_state, created_at, archived_at, default_engine_class)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run("synthetic-workspace", "Synthetic", root, "local_repo", null, "active", clock, null, null);
    const records = new SqliteFieldSourceRecordRepo(database, fieldContractSha256);
    for (let n = 0; n < count; n++) {
      const source_id = `synthetic-source-${n}`;
      records.insert({ record_id: hashSourceRecordId({ source_id, source_version: "v1", content_digest }, fieldContractSha256),
        workspace_id: "synthetic-workspace", source_id, source_version: "v1", content_digest,
        evidence_object_id: null, recorded_at: clock, event_time: null, valid_from: null, valid_to: null,
        operator_id: SOURCE_SPAN_IDENTITY_OPERATOR_ID, speaker: null, scope_class: "project",
        attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION, source_body: body });
    }
    // Native Recall enumerates the admitted source-index generation, not all
    // stored records. Authored numerical vectors exercise indexing, not a model.
    expect(await publishIndexedGeneration(database, [{ text: body }], undefined, "synthetic-workspace")).toBe(count);
    database.connection.pragma("wal_checkpoint(TRUNCATE)"); database.connection.pragma("journal_mode = DELETE");
  } finally { database.close({ optimize: false }); }
  const query = { query_key: "a".repeat(64), original_query: "Synthetic" };
  const config = SemanticChainConfigSchema.parse({ snapshot_path: snapshot, snapshot_sha256: hashRegularFileNoFollow(snapshot),
    implementation_revision: readCurrentExtractionAuthorityRevision(), interpretation_clock: clock,
    workspace_id: "synthetic-workspace", run_id: "synthetic-run",
    query_workset: { contract: "source-semantic-proposal-workset-v3", kind: "query", model: "gemini-3.1-flash-lite",
      provider_url: "http://127.0.0.1:9", request_profile: "gemini-3.1-minimal-v1", items: [{ original_query: query.original_query }] },
    query_cache_root: join(root, "query-cache"), correspondence_cache_root: join(root, "correspondence-cache"),
    max_output_tokens: 1024, discovery_page_cap: 1, correspondence_pair_cap: 0, access_policy: "query-conditioned-v1",
    budget: { schema_version: 1, work_units: 10000000, memory_bytes: 60000000, page_budget: 10000, finalization_reserve: 50000, min_envelope: 10 },
    authorized_scopes: { mode: "named", scopes: ["project"] }, output_byte_limit: 1000000 });
  const outputRoot = join(root, "execution"); mkdirSync(outputRoot);
  return { root: outputRoot, config, queries: [query] };
}

it.each([8, 10])("retains authenticated first exposure across a fresh %i-root SQLite/built-worker/MCP archive", async count => {
  const input = await fixture(count);
  // The published generation uses authored axes. Prepare the query with that same
  // explicit simulation at the binding seam; all capture, SQLite reads, worker
  // execution, MCP delivery and archive admission remain real.
  const preparation = simulateIndexedQueryPreparation();
  const execution = await executeOrdinaryRecallEntry(input);
  expect(preparation).toHaveBeenCalled();
  const archived = OrdinaryRecallExecutionSchema.parse(readChainArtifact(join(input.root, "ordinary-entry.json")));
  expect(archived).toEqual(OrdinaryRecallExecutionSchema.parse(JSON.parse(JSON.stringify(execution))));
  const row = archived.rows[0]!;
  expect(row.first_exposure, JSON.stringify(row)).not.toBeNull();
  const initial = row.first_exposure!.initial!;
  expect(row.pages.map(page => page.occupied_slots), JSON.stringify(row)).toEqual(count === 8 ? [5, 3, 0] : [5, 5]);
  expect(row.status).toBe("complete");
  expect(row.stop_cause).toBe(count === 8 ? "occupancy_tail_exhausted" : "observed_ten_slot_prefix");
  for (const [position, page] of row.pages.entries()) {
    const index = page.output!.index!, receipt = page.first_exposure!;
    const { commitment, ...material } = receipt;
    expect(page.observation).toBe("observed"); expect(page.response_state).toBe("success");
    expect(commitment).toBe(createHash("sha256").update(stableCanonicalStringify(material)).digest("hex"));
    expect(receipt.initial).toEqual(initial);
    expect(receipt.request_continuation).toEqual(page.request.continuation ?? null);
    if (position > 0) expect(page.request.continuation).toEqual(row.pages[position - 1]!.output!.index!.continuation);
    expect(firstExposureMismatch(receipt, { query_id: index.query_id, snapshot_id: index.snapshot_id,
      interpretation_id: index.interpretation_id!, as_of: index.as_of! }, exposureSlots(page.output!), page.output!.delivery_id)).toBe(false);
  }
  expect(row.costs.latency_ms).toMatchObject({ status: "available", source: "client_mcp_elapsed" });
  expect(row.costs.latency_ms.status === "available" && row.costs.latency_ms.value > 0).toBe(true);
  expect(hashRegularFileNoFollow(input.config.snapshot_path)).toBe(input.config.snapshot_sha256);
  expect(await executeOrdinaryRecallEntry(input)).toEqual(execution);
}, 120000);
