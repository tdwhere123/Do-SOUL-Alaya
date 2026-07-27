import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RecallEvalSnapshotBundle } from
  "../../../../longmemeval/snapshot/recall-eval/recall-eval-loader.js";

const reuseRoots: string[] = [];

export async function clearFrozenReuseRoots(): Promise<void> {
  await Promise.all(reuseRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
}

export async function frozenReuseEnvironment(
  bundle: RecallEvalSnapshotBundle
): Promise<Record<string, string>> {
  const root = await mkdtemp(join(tmpdir(), "snapshot-reuse-authority-"));
  reuseRoots.push(root);
  const path = join(root, "consumer-gate.json");
  const raw = `${JSON.stringify({
    schema_version: 1,
    code: {
      commit_sha: "7".repeat(40),
      commit_sha7: "7".repeat(7),
      worktree_state_sha256: "8".repeat(64)
    },
    snapshot_reuse: {
      manifest_sha256: bundle.snapshotManifestSha256,
      producer: bundle.manifest.run_provenance!.code
    }
  })}\n`;
  await writeFile(path, raw, "utf8");
  return {
    ALAYA_RECALL_EVAL_EMBEDDING: "env",
    ALAYA_BENCH_GATE_CONTRACT_PATH: path,
    ALAYA_BENCH_GATE_SHA256: createHash("sha256").update(raw).digest("hex")
  };
}
