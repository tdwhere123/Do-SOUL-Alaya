import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture, publishSource, buildReady, configuration, WORKSPACE } from "../../../../../../packages/storage/src/__tests__/repos/source-index/source-index-fixture.js";
import { computeExtractionAuthorityWorktreeRevision } from "../../../runs/extraction/authority/inspection.js";
import { hashRegularFileNoFollow } from "../../../runs/snapshot/bound-file.js";
import { SemanticChainConfigSchema, chainIdentity, assertChainSnapshot, readChainArtifact, writeChainArtifact } from "../../../runs/recall-measurement/contract.js";
import { inspectSemanticChainSourceIndex, prepareSemanticChainSourceIndex } from "../../../runs/recall-measurement/source-index-binding.js";
import { admitHistoricalRecallPreparation, assertHistoricalRecallProducer, HISTORICAL_RECALL_PREPARATION } from "../../../runs/recall-measurement/historical-preparation.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
afterAll(() => { expect(isolation.violations).toEqual([]); isolation.restore(); });
const revision = computeExtractionAuthorityWorktreeRevision({ head: "9dce76ae7dabc8103baf277c6ad93863c5c16bbd",
  trackedDiff: new Uint8Array(), untrackedFiles: [] });
const historicalProducerRetained = (() => {
  try {
    assertHistoricalRecallProducer(HISTORICAL_RECALL_PREPARATION, revision);
    return true;
  } catch {
    return false;
  }
})();
function sealed() {
  const root = mkdtempSync(join(tmpdir(), "historical-recall-")); roots.push(root);
  const dir = join(root, "sealed", "prepare"); mkdirSync(dir, { recursive: true });
  const snapshot = join(dir, "source-index.sqlite"), env = fixture(snapshot);
  publishSource(env, "Blue stone.");
  buildReady(env, configuration({ provider_kind: "local_onnx", model_id: "fixture-local-model" }));
  env.database.close({ optimize: false });
  const index = inspectSemanticChainSourceIndex(snapshot, WORKSPACE, { work_units: 10000000, memory_bytes: 60000000 }).index!;
  const execution = { cache_root: join(root, "models"), model_id: "fixture-local-model" };
  const receiptPath = join(dir, "preparation.json"), sha = hashRegularFileNoFollow(snapshot);
  const receipt = { contract: "semantic-chain-source-preparation-v1", implementation_revision: revision,
    execution, snapshot_path: snapshot, snapshot_sha256: sha, workspace_id: WORKSPACE, index,
    setup: { status: "settled", binding: { status: "ready", profile_id: index.profile_id, profile: index.configuration.profile } } };
  writeChainArtifact(receiptPath, receipt);
  const config = SemanticChainConfigSchema.parse({ snapshot_path: snapshot, snapshot_sha256: sha,
    implementation_revision: revision, interpretation_clock: "2026-09-22T00:00:00.000Z", workspace_id: WORKSPACE, run_id: "fixture",
    source_index: { ...execution, kind: "cached_local", index, preparation_path: receiptPath, preparation_identity: chainIdentity(receipt) },
    query_workset: { contract: "source-semantic-proposal-workset-v3", kind: "query", model: "not-executed",
      provider_url: "https://example.invalid", request_profile: "gemini-3.1-minimal-v1", items: [{ original_query: "Blue stone" }] },
    query_cache_root: join(root, "q"), correspondence_cache_root: join(root, "c"), max_output_tokens: 4096,
    discovery_page_cap: 1, correspondence_pair_cap: 0, access_policy: "query-conditioned-v1", authorized_scopes: { mode: "named", scopes: ["project"] },
    output_byte_limit: 1000000, budget: { schema_version: 1, work_units: 10000000, memory_bytes: 60000000,
      page_budget: 10000, finalization_reserve: 50000, min_envelope: 10 } });
  const configPath = join(dir, "chain-config.json"); writeFileSync(configPath, JSON.stringify(config));
  // Sidecars must remain untouched even though only checkpointed database bytes are consumed.
  writeFileSync(`${snapshot}-wal`, ""); writeFileSync(`${snapshot}-shm`, "synthetic retained sidecar");
  return { root, snapshot, receiptPath, configPath, config, execution,
    input: { version: HISTORICAL_RECALL_PREPARATION, producerRevision: revision, configPath, root: join(root, "private") } };
}

it.skipIf(!historicalProducerRetained)("admits an artifact-bound private read copy without opening or changing original SQLite sidecars", async () => {
  const f = sealed();
  const before = [f.configPath, f.receiptPath, f.snapshot, `${f.snapshot}-wal`, `${f.snapshot}-shm`].map(path => readFileSync(path));
  const admitted = admitHistoricalRecallPreparation(f.input);
  expect(admitted.config.snapshot_path).toBe(f.snapshot);
  expect(admitted.config.consumer_snapshot_path).toBe(join(f.input.root, "source-index.sqlite"));
  expect(admitted.config.implementation_revision).toBe(revision);
  assertChainSnapshot(admitted.config);
  expect(readFileSync(admitted.config.consumer_snapshot_path!)).toEqual(before[2]);
  await expect(prepareSemanticChainSourceIndex({ ...admitted.config, source_index: undefined, consumer_snapshot_path: undefined },
    f.execution, join(f.root, "forbidden-prepare"))).rejects.toThrow(/recall-only consumer/u);
  expect(existsSync(join(f.root, "forbidden-prepare"))).toBe(false);
  const copy = admitted.config.consumer_snapshot_path!;
  writeFileSync(copy, "corrupt private copy");
  expect(() => assertChainSnapshot(admitted.config)).toThrow(/private snapshot changed/u);
  admitted.finish();
  expect([f.configPath, f.receiptPath, f.snapshot, `${f.snapshot}-wal`, `${f.snapshot}-shm`].map(path => readFileSync(path))).toEqual(before);
  // The copy does not outlive its question; the originals stay authoritative.
  expect(existsSync(copy)).toBe(false);
  expect(readChainArtifact(join(f.input.root, "originals-after.json"))).toMatchObject({ unchanged: true, private_copy_released: true });
});

it.skipIf(!historicalProducerRetained)("keeps the private copy when the originals changed during recall", () => {
  const f = sealed();
  const admitted = admitHistoricalRecallPreparation(f.input);
  const copy = admitted.config.consumer_snapshot_path!;
  writeFileSync(`${f.snapshot}-shm`, "changed during recall");
  expect(() => admitted.finish()).toThrow(/originals changed/u);
  expect(existsSync(copy)).toBe(true);
});

it.skipIf(!historicalProducerRetained).each(["missing-config", "missing-receipt", "corrupt-receipt", "corrupt-db", "wal", "wrong-producer"])("refuses %s without preparing or accepting an alternate identity", fault => {
  const f = sealed();
  if (fault === "missing-config") rmSync(f.configPath);
  if (fault === "missing-receipt") rmSync(f.receiptPath);
  if (fault === "corrupt-receipt") writeFileSync(f.receiptPath, JSON.stringify({ identity: "0".repeat(64), payload: {} }));
  if (fault === "corrupt-db") writeFileSync(f.snapshot, "corrupted");
  if (fault === "wal") writeFileSync(`${f.snapshot}-wal`, "uncheckpointed");
  if (fault === "wrong-producer") writeFileSync(f.configPath, JSON.stringify({ ...f.config, implementation_revision:
    `git-worktree-v1:${"a".repeat(40)}:${"b".repeat(64)}` }));
  expect(() => admitHistoricalRecallPreparation(f.input)).toThrow();
  expect(existsSync(f.input.root)).toBe(false);
});

it("requires the exact supported clean producer version, not a historical-looking prefix", () => {
  if (historicalProducerRetained) expect(() => assertHistoricalRecallProducer(HISTORICAL_RECALL_PREPARATION, revision)).not.toThrow();
  else expect(() => assertHistoricalRecallProducer(HISTORICAL_RECALL_PREPARATION, revision)).toThrow(/not retained/u);
  expect(() => assertHistoricalRecallProducer("unknown", revision)).toThrow(/unsupported/u);
  expect(() => assertHistoricalRecallProducer(HISTORICAL_RECALL_PREPARATION, revision.replace(/.$/u, "0"))).toThrow(/unsupported/u);
});
