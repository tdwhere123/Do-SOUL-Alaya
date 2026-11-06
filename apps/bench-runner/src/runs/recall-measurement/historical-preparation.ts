import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AlayaError, canonicalJson } from "@do-soul/alaya-protocol";
import { computeExtractionAuthorityWorktreeRevision, readCurrentExtractionAuthorityRevision } from "../extraction/authority/inspection.js";
import { canonicalPath, canonicalPathsOverlap } from "../fs/opened-contained-path.js";
import { captureRegularFileSha256, readRegularFileNoFollow } from "../snapshot/bound-file.js";
import { cloneCachedSealedSnapshot } from "../snapshot/freeze/db-copy.js";
import { SemanticChainConfigSchema, assertChainSnapshot, readChainArtifact, writeChainArtifact, type SemanticChainConfig } from "./contract.js";

export const HISTORICAL_RECALL_PREPARATION = "pre-statement-map.v1";
// Named consumers: archived Original100 and Dev2 candidate preparations. Retire this adapter
// only after their baseline comparisons and retention obligations end; never expand by inference.
const PRODUCERS = ["9dce76ae7dabc8103baf277c6ad93863c5c16bbd", "a937dc0718a0a412a2a4bd9122c0e70744066c77"];
const checkout = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");

export function assertHistoricalRecallProducer(version: string, revision: string): void {
  const head = revision.split(":")[1];
  if (version !== HISTORICAL_RECALL_PREPARATION || head === undefined || !PRODUCERS.includes(head)
      || computeExtractionAuthorityWorktreeRevision({ head, trackedDiff: new Uint8Array(), untrackedFiles: [] }) !== revision) {
    throw new AlayaError("UNAVAILABLE", "unsupported historical recall preparation producer");
  }
  // The named immutable source object must actually be retained locally; no fetch/reconstruction.
  execFileSync("git", ["-c", "core.fsmonitor=false", "cat-file", "-e", `${head}^{commit}`], { cwd: checkout, stdio: "pipe" });
}

function captureFiles(paths: readonly string[]) {
  return paths.map(path => {
    try { return { path, identity: captureRegularFileSha256(path) }; }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return { path, identity: null };
      throw error;
    }
  });
}

/** Artifact-bound admission, not an assertion that today's preparation implementation is equal.
 * No original SQLite connection is opened. A byte-identical read copy is qualified with the same
 * generation/receipt validators; the ordinary daemon independently migrates its own restored copy. */
export function admitHistoricalRecallPreparation(input: {
  version: string; producerRevision: string; configPath: string; root: string;
}): { config: SemanticChainConfig; identity: string; finish: () => void } {
  assertHistoricalRecallProducer(input.version, input.producerRevision);
  const configPath = resolve(input.configPath);
  if (!existsSync(configPath)) throw new AlayaError("UNAVAILABLE", "historical sealed preparation is missing");
  const original = SemanticChainConfigSchema.parse(JSON.parse(readRegularFileNoFollow(configPath, 4 * 1024 * 1024).toString("utf8")));
  const binding = original.source_index;
  if (original.implementation_revision !== input.producerRevision || original.consumer_revision !== undefined
      || original.consumer_snapshot_path !== undefined || binding === undefined) {
    throw new AlayaError("CONFLICT", "historical config does not bind the named producer");
  }
  const directory = canonicalPath(dirname(configPath)), root = canonicalPath(resolve(input.root));
  if (canonicalPath(original.snapshot_path) !== join(directory, "source-index.sqlite")
      || canonicalPath(binding.preparation_path) !== join(directory, "preparation.json")
      || canonicalPathsOverlap(directory, root) || canonicalPathsOverlap(canonicalPath(binding.cache_root), root)) {
    throw new AlayaError("CONFLICT", "historical preparation paths escape their retained owner or overlap output");
  }
  const paths = [configPath, original.snapshot_path, `${original.snapshot_path}-wal`, `${original.snapshot_path}-shm`,
    binding.preparation_path, join(dirname(directory), "d1-statements.json")];
  const before = captureFiles(paths);
  if (before[1]!.identity?.sha256 !== original.snapshot_sha256 || !before[4]!.identity) {
    throw new AlayaError("CONFLICT", "historical preparation snapshot hash or receipt is missing or changed");
  }
  if (before[2]!.identity !== null && before[2]!.identity!.size !== 0) {
    throw new AlayaError("CONFLICT", "historical preparation has uncheckpointed WAL bytes");
  }
  const receipt = readChainArtifact(binding.preparation_path);
  if (typeof receipt !== "object" || receipt === null || !("implementation_revision" in receipt)
      || receipt.implementation_revision !== input.producerRevision) {
    throw new AlayaError("CONFLICT", "historical preparation receipt does not bind the named producer");
  }
  if (existsSync(root)) throw new AlayaError("CONFLICT", "historical consumer requires a fresh private root");
  mkdirSync(root, { recursive: true });
  const copy = join(root, "source-index.sqlite");
  cloneCachedSealedSnapshot({ sourcePath: original.snapshot_path, targetPath: copy, expectedSha256: original.snapshot_sha256 });
  const config = SemanticChainConfigSchema.parse({ ...original, consumer_revision: readCurrentExtractionAuthorityRevision(), consumer_snapshot_path: copy });
  assertChainSnapshot(config);
  const identity = before[0]!.identity!.sha256;
  writeChainArtifact(join(root, "admission.json"), { contract: input.version, producer_revision: input.producerRevision,
    consumer_revision: config.consumer_revision, original_files: before, snapshot_copy_path: copy,
    config_sha256: identity, preparation_identity: binding.preparation_identity, index: binding.index,
    formation_binding: "captured_statement_report_only_not_raw_model_output" });
  return { config, identity, finish: () => {
    const after = captureFiles(paths);
    if (canonicalJson(before) !== canonicalJson(after)) throw new AlayaError("CONFLICT", "historical preparation originals changed during recall");
    writeChainArtifact(join(root, "originals-after.json"), { unchanged: true, original_files: after });
  } };
}
