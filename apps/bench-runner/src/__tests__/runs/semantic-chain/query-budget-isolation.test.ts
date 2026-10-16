import { afterAll, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  await import(/* @vite-ignore */ new URL("../../support/provider-free-cli-bootstrap.mjs", import.meta.url).href);
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  const installed = installProviderFreeBoundary();
  process.env.ALAYA_OFFICIAL_GARDEN_SECRET_REF = "env:E0_TEST_GARDEN_KEY";
  process.env.E0_TEST_GARDEN_KEY = "test-key";
  return installed;
});
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareNativeSourceRecordsSnapshot } from "../../../runs/snapshot/source-records/native.js";
import { readCurrentExtractionAuthorityRevision } from "../../../runs/extraction/authority/inspection.js";
import { parseSemanticProposalWorkset } from "../../../runs/semantic-proposal/workset.js";
import { prepareSemanticChain } from "../../../runs/semantic-chain/prepare.js";
import { replaySemanticChain, measureSemanticChain, ReplaySchema } from "../../../runs/semantic-chain/replay.js";
import { SemanticChainConfigSchema, assertChainSnapshot } from "../../../runs/semantic-chain/contract.js";

afterAll(() => isolation.restore());

const SOURCE_TEXT = "The blue stone is kept in the cedar box.";
const SHORT_QUERY = "What was completed?";
const LONG_QUERY = `${SHORT_QUERY}${" context".repeat(200)}`;
const WORK_BUDGET = 25_000;
// Access owner: 64 * (query.length + 1) feature work before discovery.
const FEATURE_WORK = (query: string): number => 64 * (query.length + 1);
// Scoring owner: (source.length + 1) * (4 + min(32, terms) + min(12, phrases)).
const MAX_SOURCE_SCORE_WORK = (SOURCE_TEXT.length + 1) * (4 + 32 + 12);

it("isolates a blocked long query from a later short raw_ready query under the same work budget", async () => {
  expect(LONG_QUERY).toHaveLength(1619);
  expect(FEATURE_WORK(LONG_QUERY)).toBe(103_680);
  expect(FEATURE_WORK(LONG_QUERY)).toBeGreaterThan(WORK_BUDGET);
  expect(FEATURE_WORK(SHORT_QUERY) + MAX_SOURCE_SCORE_WORK).toBeLessThan(WORK_BUDGET);
  const root = mkdtempSync(join(tmpdir(), "query-budget-isolation-"));
  try {
    const snapshot = await prepareNativeSourceRecordsSnapshot({ snapshotPath: join(root, "input.sqlite"),
      dataDirRoot: join(root, "publication"), workspaceId: "stone-library", runId: "stone-library-run",
      producerCommit: "22650b55c4c0e2814b115918ad979a1c0d0dbad6", sources: [{
        source_id: "stone-note", source_version: "1", title: "Stone note", content_bytes: SOURCE_TEXT,
        source_observed_at: "2026-09-21T00:00:00.000Z", recorded_at: "2026-09-21T00:00:00.000Z"
      }] });
    const config = SemanticChainConfigSchema.parse({ snapshot_path: snapshot.snapshot_path, snapshot_sha256: snapshot.db_sha256,
      implementation_revision: readCurrentExtractionAuthorityRevision(), interpretation_clock: "2026-09-22T00:00:00.000Z",
      workspace_id: snapshot.workspace_id, run_id: snapshot.run_id,
      query_workset: parseSemanticProposalWorkset({ contract: "source-semantic-proposal-workset-v3", kind: "query",
        model: "gemini-2.5-flash-lite", request_profile: "gemini-2.5-nonthinking-v1", provider_url: "http://127.0.0.1:9",
        items: [{ original_query: LONG_QUERY }, { original_query: SHORT_QUERY }] }),
      query_cache_root: join(root, "unattempted-query-cache"), correspondence_cache_root: join(root, "unattempted-correspondence-cache"),
      max_output_tokens: 4096, discovery_page_cap: 4, correspondence_pair_cap: 1,
      access_policy: "canonical-v1", authorized_scopes: { mode: "unrestricted" },
      budget: { schema_version: 1, work_units: WORK_BUDGET, memory_bytes: 60_000_000,
        page_budget: 100_000, finalization_reserve: 1_000, min_envelope: 10 }, output_byte_limit: 100_000 });
    const chainRoot = join(root, "chain");
    const plan = await prepareSemanticChain(config, chainRoot);
    expect(plan.queries).toMatchObject([{ status: "blocked",
      reason: "discovery_unavailable: native discovery resource exhausted" }, { status: "raw_ready", reason: "unattempted" }]);
    const replay = await replaySemanticChain(chainRoot);
    expect(ReplaySchema.parse(replay.result).rows.map(row => row.status)).toEqual(["blocked", "replayed"]);
    const measured = measureSemanticChain(chainRoot, replay.path,
      plan.queries.map(row => ({ query_key: row.query_key, source_units: [] })), join(root, "evaluator"));
    expect(measured.result.rows.map(row => row.status)).toEqual(["blocked", "replayed"]);
    assertChainSnapshot(config);
    expect(isolation.violations).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 120_000);
