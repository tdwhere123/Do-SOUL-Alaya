import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveLocalArtifactTreeSha256 } from "../../../longmemeval/provenance/embedding/local-onnx.js";
import { buildLongMemEvalRunProvenance } from "../../../longmemeval/provenance/run.js";
import {
  fakeExecutedDistIdentity,
  registerRunProvenanceRootCleanup
} from "./run-provenance-fixture.js";

const roots = registerRunProvenanceRootCleanup();

describe("LongMemEval run provenance", () => {

  it("rejects symbolic links in the local ONNX artifact tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "lme-onnx-symlink-"));
    roots.push(root);
    const modelRoot = join(root, "models", "Xenova", "test");
    await mkdir(modelRoot, { recursive: true });
    await writeFile(join(root, "outside"), "secret", "utf8");
    await symlink(join(root, "outside"), join(modelRoot, "model.onnx"));

    await expect(resolveLocalArtifactTreeSha256(
      join(root, "models"), "Xenova/test"
    )).rejects.toThrow(/artifact tree/u);
  });

  it("rejects an environment identity that does not match the fresh closure", async () => {
    await expect(buildLongMemEvalRunProvenance({
      opts: {
        variant: "longmemeval_s",
        historyRoot: "/tmp",
        embeddingMode: "disabled"
      },
      evaluatedCount: 0,
      commitSha7: "05d98df",
      embeddingProviderLabel: "disabled",
      env: {
        ALAYA_BENCH_EXECUTED_DIST_CLOSURE_SHA256: "f".repeat(64),
        ALAYA_BENCH_EXECUTED_DIST_FILE_COUNT: "1"
      },
      computeExecutedDistIdentity: fakeExecutedDistIdentity
    })).rejects.toThrow(/does not match fresh closure/u);
  });

  it("rejects an ONNX thread count above the runtime maximum", async () => {
    await expect(buildLongMemEvalRunProvenance({
      opts: {
        variant: "longmemeval_s",
        historyRoot: "/tmp",
        embeddingMode: "disabled"
      },
      evaluatedCount: 0,
      commitSha7: "05d98df",
      embeddingProviderLabel: "disabled",
      env: { ALAYA_LOCAL_ONNX_THREADS: "128" },
      computeExecutedDistIdentity: fakeExecutedDistIdentity
    })).rejects.toThrow(/ALAYA_LOCAL_ONNX_THREADS/u);
  });

  it("rejects model traversal and a symlinked model root", async () => {
    const root = await mkdtemp(join(tmpdir(), "lme-onnx-root-symlink-"));
    roots.push(root);
    const cacheRoot = join(root, "models");
    const outside = join(root, "outside");
    await mkdir(cacheRoot, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "model.onnx"), "model", "utf8");
    await symlink(outside, join(cacheRoot, "linked"), "dir");

    await expect(resolveLocalArtifactTreeSha256(cacheRoot, "../outside"))
      .rejects.toThrow(/cache root/u);
    await expect(resolveLocalArtifactTreeSha256(cacheRoot, "linked"))
      .rejects.toThrow(/artifact tree/u);
  });

});
