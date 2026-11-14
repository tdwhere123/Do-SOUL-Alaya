import { afterAll, afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installProviderFreeBoundary } from "../../../../../../scripts/test-support/provider-free/provider-free-boundary.js";
import { hashRegularFileNoFollow } from "../../../runs/snapshot/bound-file.js";
import { readCurrentExtractionAuthorityRevision } from "../../../runs/extraction/authority/inspection.js";
import { parseSemanticProposalWorkset } from "../../../runs/semantic-cache/workset.js";
import { SemanticChainConfigSchema, assertChainSnapshot } from "../../../runs/recall-measurement/contract.js";
import { prepareSemanticChainSourceIndex } from "../../../runs/recall-measurement/source-index-binding.js";
import { fixture, publishSource, WORKSPACE } from "../../../../../../packages/storage/src/__tests__/repos/source-index/source-index-fixture.js";

const isolation = installProviderFreeBoundary();
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
afterAll(() => isolation.restore());

const PRODUCER = `git-worktree-v1:${"a".repeat(40)}:${"b".repeat(64)}`;

function snapshotConfig() {
  const root = mkdtempSync(join(tmpdir(), "chain-consumer-")); roots.push(root);
  const snapshot = join(root, "input.sqlite");
  const environment = fixture(snapshot);
  publishSource(environment, "Blue stone.");
  environment.database.close();
  const config = SemanticChainConfigSchema.parse({ snapshot_path: snapshot, snapshot_sha256: hashRegularFileNoFollow(snapshot),
    implementation_revision: readCurrentExtractionAuthorityRevision(), interpretation_clock: "2026-09-22T00:00:00.000Z",
    workspace_id: WORKSPACE, run_id: "chain-consumer-run",
    query_workset: parseSemanticProposalWorkset({ contract: "source-semantic-proposal-workset-v3", kind: "query",
      model: "gemini-2.5-flash-lite", request_profile: "gemini-2.5-nonthinking-v1", provider_url: "http://127.0.0.1:9",
      items: [{ original_query: "What color is the stone?" }] }),
    query_cache_root: join(root, "q-cache"), correspondence_cache_root: join(root, "c-cache"),
    max_output_tokens: 4096, discovery_page_cap: 1, correspondence_pair_cap: 0, access_policy: "query-conditioned-v1",
    authorized_scopes: { mode: "named", scopes: ["project"] }, output_byte_limit: 1_000_000,
    budget: { schema_version: 1, work_units: 10_000_000, memory_bytes: 60_000_000,
      page_budget: 10_000, finalization_reserve: 50_000, min_envelope: 10 } });
  return { root, config };
}

it("reads another producer's snapshot only under a declared consumer revision matching this checkout", () => {
  const { config } = snapshotConfig();
  const current = readCurrentExtractionAuthorityRevision();
  expect(() => assertChainSnapshot({ ...config, implementation_revision: PRODUCER })).toThrow(/implementation changed/u);
  expect(() => assertChainSnapshot(SemanticChainConfigSchema.parse({ ...config, implementation_revision: PRODUCER,
    consumer_revision: current }))).not.toThrow();
  expect(() => assertChainSnapshot({ ...config, consumer_revision: PRODUCER })).toThrow(/implementation changed/u);
  expect(isolation.violations).toEqual([]);
});

it("never prepares a Source index as a recall-only consumer", async () => {
  const { root, config } = snapshotConfig();
  await expect(prepareSemanticChainSourceIndex({ ...config, consumer_revision: readCurrentExtractionAuthorityRevision() },
    { cache_root: join(root, "model-cache"), model_id: "fixture-local-model" }, join(root, "consumer")))
    .rejects.toThrow(/recall-only consumer/u);
});
