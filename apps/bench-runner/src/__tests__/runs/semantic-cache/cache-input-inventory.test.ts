import { mkdirSync, mkdtempSync, opendirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { canonicalPath } from "../../../runs/fs/opened-contained-path.js";
import { admitEvaluatorOutputRoot } from "../../../runs/measurement/evaluator-output.js";
import { retainedSourceRequestInputKeys, sourceCacheInputPaths } from "../../../runs/extraction/cache/source-cache-inputs.js";
import { cacheFilePath } from "../../../runs/compile-seed/cache/cache-shard.js";
import { ledgerPath } from "../../../runs/extraction/authority/attempt-ledger.js";
import { semanticProposalCacheInputPaths, semanticProposalLookup } from "../../../runs/semantic-cache/attempt.js";
import { semanticProposalShardPath } from "../../../runs/semantic-cache/artifact.js";
import { readSemanticProposalResults } from "../../../runs/semantic-cache/results.js";
import { materializeSemanticProposalLines, parseSemanticProposalWorkset } from "../../../runs/semantic-cache/workset.js";
import { providerRawAttemptInputPaths, readSingleSourceRawAttempt } from
  "../../../runs/extraction/fill/provider-raw-attempt.js";

vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, opendirSync: vi.fn(fs.opendirSync) };
});

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(opendirSync).mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("protects consumed shard, raw attempt, and ledger aliases despite invalid cache evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "proposal-cache-inputs-"));
  roots.push(root);
  const cacheRoot = join(root, "cache");
  const workset = parseSemanticProposalWorkset({ contract: "source-semantic-proposal-workset-v3",
    kind: "query", model: "gemini-2.5-flash-lite", request_profile: "gemini-2.5-nonthinking-v1",
    provider_url: "http://127.0.0.1:9", items: [{ original_query: "Where is the telescope?" }] });
  const line = materializeSemanticProposalLines(workset, 128)[0]!;
  const physicalShard = join(root, "physical-shard");
  const shard = semanticProposalShardPath(cacheRoot, line.key);
  mkdirSync(physicalShard);
  mkdirSync(cacheRoot);
  symlinkSync(physicalShard, dirname(shard), "dir");
  writeFileSync(shard, "{invalid");
  expect(() => readSemanticProposalResults(workset, cacheRoot, 128)).toThrow(/malformed/u);
  expect(() => admitEvaluatorOutputRoot(physicalShard, semanticProposalCacheInputPaths(workset, cacheRoot, 128)))
    .toThrow(/separate from producer and input roots/u);

  const physicalRaw = join(root, "physical-raw");
  const rawDirectory = join(cacheRoot, "provider-raw", line.key.slice(0, 2));
  mkdirSync(physicalRaw);
  mkdirSync(dirname(rawDirectory));
  symlinkSync(physicalRaw, rawDirectory, "dir");
  writeFileSync(join(rawDirectory, `${line.key}.1.json`), "{invalid");
  const paths = semanticProposalCacheInputPaths(workset, cacheRoot, 128);
  expect(() => admitEvaluatorOutputRoot(physicalRaw, paths)).toThrow(/separate from producer and input roots/u);
  expect(paths).toContain(join(rawDirectory, `${line.key}.1.json`));

  const physicalLedger = join(root, "physical-ledger");
  mkdirSync(physicalLedger);
  const lineage = semanticProposalLookup(workset, line, 128).attempt_lineage_digest!;
  const ledger = ledgerPath(cacheRoot, lineage);
  writeFileSync(join(physicalLedger, "ledger.json"), "{invalid");
  symlinkSync(join(physicalLedger, "ledger.json"), ledger);
  expect(() => admitEvaluatorOutputRoot(physicalLedger, paths)).toThrow(/separate from producer and input roots/u);
  expect(readFileSync(ledger, "utf8")).toBe("{invalid");
  expect(readdirSync(physicalShard)).toEqual([`${line.key}.json`]);
});

it("keeps valid request paths when another retained item cannot materialize", () => {
  const root = mkdtempSync(join(tmpdir(), "proposal-cache-siblings-"));
  roots.push(root);
  const workset = parseSemanticProposalWorkset({ contract: "source-semantic-proposal-workset-v3",
    kind: "query", model: "gemini-2.5-flash-lite", request_profile: "gemini-2.5-nonthinking-v1",
    provider_url: "http://127.0.0.1:9", items: [{ original_query: "Where is the telescope?" }, { unrelated: true }] });
  const line = materializeSemanticProposalLines({ ...workset, items: [workset.items[0]] }, 128)[0]!;
  const paths = semanticProposalCacheInputPaths(workset, join(root, "cache"), 128);
  expect(paths).toContain(semanticProposalShardPath(join(root, "cache"), line.key));
});

it("protects source raw, shard, and ledger aliases despite unavailable sibling evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "source-cache-inputs-")); roots.push(root);
  const cacheRoot = join(root, "cache"), key = "a".repeat(64), shardKey = "b".repeat(64);
  const preflight = join(root, "source-preflight.json");
  writeFileSync(preflight, JSON.stringify({ selected_keys: [key, null],
    ready_requests: [{ key }, { key: "malformed" }], planned_requests: [{ key: shardKey }] }));
  expect(retainedSourceRequestInputKeys(preflight)).toEqual([key, shardKey]);
  const rawRoot = join(cacheRoot, "provider-raw");
  mkdirSync(rawRoot, { recursive: true });
  const rawTarget = join(root, "physical-raw");
  mkdirSync(rawTarget);
  const rawBucket = join(rawRoot, key.slice(0, 2));
  symlinkSync(rawTarget, rawBucket, "dir");
  const paths = sourceCacheInputPaths(cacheRoot, retainedSourceRequestInputKeys(preflight));
  expect(paths).toContain(rawBucket);
  expect(paths).toContain(cacheFilePath(cacheRoot, shardKey));
  expect(() => admitEvaluatorOutputRoot(rawTarget, paths)).toThrow(/separate from producer and input roots/u);
  const safeRoot = join(root, "separate-evaluator");
  expect(admitEvaluatorOutputRoot(safeRoot, paths)).toBe(canonicalPath(safeRoot));

  const shardTarget = join(root, "physical-shard");
  mkdirSync(shardTarget);
  symlinkSync(shardTarget, dirname(cacheFilePath(cacheRoot, shardKey)), "dir");
  expect(() => admitEvaluatorOutputRoot(shardTarget, sourceCacheInputPaths(cacheRoot, [shardKey])))
    .toThrow(/separate from producer and input roots/u);
  const ledgerTarget = join(root, "physical-ledger");
  mkdirSync(ledgerTarget);
  writeFileSync(join(ledgerTarget, "ledger.json"), "{invalid");
  const ledger = ledgerPath(cacheRoot, "c".repeat(64));
  symlinkSync(join(ledgerTarget, "ledger.json"), ledger);
  const ledgerPaths = sourceCacheInputPaths(cacheRoot);
  expect(ledgerPaths).toContain(ledger);
  expect(() => admitEvaluatorOutputRoot(ledgerTarget, ledgerPaths)).toThrow(/separate from producer and input roots/u);

  const fileCache = join(root, "file-cache"), fileBucket = join(fileCache, "provider-raw", "aa");
  const fileTarget = join(root, "physical-raw-file");
  mkdirSync(fileBucket, { recursive: true });
  mkdirSync(fileTarget);
  const rawFile = join(fileBucket, `${key}.malformed.json`);
  writeFileSync(join(fileTarget, "attempt.json"), "{invalid");
  symlinkSync(join(fileTarget, "attempt.json"), rawFile);
  const filePaths = sourceCacheInputPaths(fileCache);
  expect(filePaths).toContain(rawFile);
  expect(() => admitEvaluatorOutputRoot(fileTarget, filePaths))
    .toThrow(/separate from producer and input roots/u);
});

it("bounds raw directory enumeration and propagates overflow through Q and source reads and inventories", async () => {
  const root = mkdtempSync(join(tmpdir(), "proposal-raw-inventory-")); roots.push(root);
  const workset = parseSemanticProposalWorkset({ contract: "source-semantic-proposal-workset-v3",
    kind: "query", model: "gemini-3.1-flash-lite", request_profile: "gemini-3.1-minimal-v1",
    provider_url: "https://generativelanguage.googleapis.com",
    items: [{ original_query: "Which file format did Mira use for the Atlas export?" }] });
  const key = materializeSemanticProposalLines(workset, 16_384)[0]!.key;
  const cacheRoot = join(root, "cache");
  const directory = join(cacheRoot, "provider-raw", key.slice(0, 2));
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "other.txt"), "");
  const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
  let entryCount = 32_768;
  const enumerations: { read: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }[] = [];
  vi.mocked(opendirSync).mockImplementation((path, options) => {
    const handle = fs.opendirSync(path, options);
    if (path !== directory) return handle;
    const entry = handle.readSync();
    if (entry === null) throw new Error("real raw directory fixture must contain an entry");
    let visited = 0;
    const read = vi.spyOn(handle, "readSync").mockImplementation(() => {
      if (visited === entryCount) return null;
      entry.name = `other-${visited++}.txt`;
      return entry;
    });
    const close = vi.spyOn(handle, "closeSync");
    enumerations.push({ read, close });
    return handle;
  });
  expect(providerRawAttemptInputPaths(cacheRoot, key)).toEqual([directory]);
  expect(enumerations).toHaveLength(1);
  expect(enumerations[0]!.read).toHaveBeenCalledTimes(32_769);
  expect(enumerations[0]!.close).toHaveBeenCalledTimes(1);

  entryCount = 32_769;
  for (const consume of [
    () => readSemanticProposalResults(workset, cacheRoot, 16_384),
    () => semanticProposalCacheInputPaths(workset, cacheRoot, 16_384),
    () => providerRawAttemptInputPaths(cacheRoot, key),
    () => readSingleSourceRawAttempt(cacheRoot, key)
  ]) {
    enumerations.length = 0;
    expect(consume).toThrow(/bounded inventory/u);
    expect(enumerations).toHaveLength(1);
    expect(enumerations[0]!.read).toHaveBeenCalledTimes(32_769);
    expect(enumerations[0]!.close).toHaveBeenCalledTimes(1);
  }
});
