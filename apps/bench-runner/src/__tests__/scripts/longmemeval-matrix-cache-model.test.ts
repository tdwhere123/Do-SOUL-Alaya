import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { resolveMatrixExtractionModel } from
  "../../../scripts/longmemeval-matrix-cache-model.mjs";
import { execFileWithFileCapture } from "./script-capture.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../.."
);

it("uses the extraction model declared by the cache manifest", () => {
  expect(resolveMatrixExtractionModel({ extraction_model: "deepseek-v4-flash" }))
    .toBe("deepseek-v4-flash");
});

it("uses the extraction model bound into a frozen snapshot manifest", () => {
  expect(resolveMatrixExtractionModel({
    extraction_provenance: { extraction_model: "DeepSeek-V4-Flash" }
  })).toBe("DeepSeek-V4-Flash");
});

it("accepts an explicit model only when it exactly matches the cache manifest", () => {
  expect(resolveMatrixExtractionModel(
    { extraction_model: "deepseek-v4-flash" },
    "deepseek-v4-flash"
  )).toBe("deepseek-v4-flash");
  expect(() => resolveMatrixExtractionModel(
    { extraction_model: "deepseek-v4-flash" },
    "DeepSeek-V4-Flash"
  )).toThrow(/does not match extraction cache manifest/u);
});

it("fails closed when the manifest model identity is absent", () => {
  expect(() => resolveMatrixExtractionModel({})).toThrow(
    /extraction cache manifest has no extraction_model/u
  );
});

it("stops the matrix cell before benchmark execution on an explicit model mismatch", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "matrix-model-"));
  try {
    const cacheRoot = path.join(root, "cache");
    const snapshot = path.join(root, "snapshot", "source-100.db");
    await mkdir(cacheRoot, { recursive: true });
    await mkdir(path.dirname(snapshot), { recursive: true });
    await writeFile(
      path.join(cacheRoot, "manifest.json"),
      JSON.stringify({ extraction_model: "deepseek-v4-flash" }),
      "utf8"
    );
    await writeFile(snapshot, "fixture", "utf8");
    await writeFile(
      path.join(root, "matrix-promotion-contract.json"),
      "{}\n",
      "utf8"
    );

    await expect(execFileWithFileCapture(
      "bash",
      [path.join(repoRoot, "apps/bench-runner/scripts/longmemeval-matrix-cell.sh"), "A"],
      {
        env: {
          ...process.env,
          MATRIX_RUN_ROOT: root,
          MATRIX_CACHE_ROOT: cacheRoot,
          MATRIX_SNAPSHOT: snapshot,
          MATRIX_EXTRACTION_MODEL: "DeepSeek-V4-Flash"
        }
      }
    )).rejects.toMatchObject({
      code: 65,
      stderr: expect.stringContaining("does not match extraction cache manifest")
    });
    await expect(access(path.join(root, "matrix-data")))
      .rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("starts experiment validation without a promotion contract or external cache", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "matrix-experiment-model-"));
  try {
    const datasetDir = path.join(root, "dataset");
    const snapshot = path.join(root, "snapshot", "source-100.db");
    await Promise.all([
      mkdir(datasetDir, { recursive: true }),
      mkdir(path.dirname(snapshot), { recursive: true })
    ]);
    await Promise.all([
      writeFile(path.join(datasetDir, "longmemeval_s.json"), "[]\n", "utf8"),
      writeFile(snapshot, "fixture", "utf8"),
      writeFile(`${snapshot}.sidecar.json`, "{}\n", "utf8"),
      writeFile(`${snapshot}.extraction-authority.json`, "{}\n", "utf8"),
      writeFile(`${snapshot}.manifest.json`, JSON.stringify({
        extraction_provenance: { extraction_model: "deepseek-v4-flash" }
      }), "utf8")
    ]);

    await expect(execFileWithFileCapture(
      "bash",
      [path.join(repoRoot, "apps/bench-runner/scripts/longmemeval-matrix-cell.sh"), "A"],
      {
        env: {
          ...process.env,
          MATRIX_EXPERIMENT: "1",
          MATRIX_RUN_ROOT: root,
          MATRIX_DATASET_DIR: datasetDir,
          MATRIX_SNAPSHOT: snapshot,
          MATRIX_EXTRACTION_MODEL: "DeepSeek-V4-Flash"
        }
      }
    )).rejects.toMatchObject({
      code: 65,
      stderr: expect.stringContaining("does not match extraction cache manifest")
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
