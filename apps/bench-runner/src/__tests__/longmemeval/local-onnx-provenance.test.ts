import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveEmbeddingSupplementRuntimeProvenance,
  resolveLocalArtifactTreeSha256,
  resolveLocalCrossEncoderRuntimeProvenance
} from "../../longmemeval/provenance/local-onnx.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe("local ONNX runtime provenance", () => {
  it("resolves the canonical bi-encoder model, default cache, schema, and D2Q input", async () => {
    const xdgRoot = await mkdtemp(join(tmpdir(), "lme-bi-default-"));
    roots.push(xdgRoot);
    const modelRoot = join(
      xdgRoot,
      "do-soul-alaya/models/Xenova/paraphrase-multilingual-MiniLM-L12-v2"
    );
    await mkdir(modelRoot, { recursive: true });
    await writeFile(join(modelRoot, "model.onnx"), "bi-model", "utf8");

    await expect(resolveEmbeddingSupplementRuntimeProvenance(
      "env",
      "local_onnx",
      { XDG_CACHE_HOME: xdgRoot, ALAYA_RECALL_D2Q: "true" }
    )).resolves.toEqual({
      enabled: true,
      provider_kind: "local_onnx",
      effective_model_id: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
      model_artifact_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      effective_schema_version: 2,
      d2q_input: "content_plus_hq"
    });
  });

  it("fails before recall when an enabled bi encoder has no readable identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "lme-bi-missing-"));
    roots.push(root);

    await expect(resolveEmbeddingSupplementRuntimeProvenance(
      "env",
      "local_onnx",
      {
        ALAYA_LOCAL_EMBEDDING_CACHE_DIR: root,
        ALAYA_LOCAL_EMBEDDING_MODEL: "Xenova/missing"
      }
    )).rejects.toThrow(/missing or unreadable/u);
  });

  it("does not inspect model artifacts for the disabled bi arm", async () => {
    await expect(resolveEmbeddingSupplementRuntimeProvenance(
      "disabled",
      "local_onnx",
      {}
    )).resolves.toEqual({ enabled: false });
  });

  it("binds the digest to artifact contents", async () => {
    const { cacheRoot, modelRoot } = await createModel("fixture-v1");
    const first = await resolveLocalArtifactTreeSha256(cacheRoot, "Xenova/reranker");

    await writeFile(join(modelRoot, "model.onnx"), "fixture-v2", "utf8");
    const second = await resolveLocalArtifactTreeSha256(cacheRoot, "Xenova/reranker");

    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(second).toMatch(/^[a-f0-9]{64}$/u);
    expect(second).not.toBe(first);
  });

  it("fails loud when an enabled cross encoder has no readable artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "lme-cross-onnx-missing-"));
    roots.push(root);

    await expect(resolveLocalCrossEncoderRuntimeProvenance({
      ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK: "true",
      ALAYA_LOCAL_CROSS_ENCODER_CACHE_DIR: root,
      ALAYA_LOCAL_CROSS_ENCODER_MODEL: "Xenova/missing"
    })).rejects.toThrow(/missing or unreadable/u);
  });

  it("records the effective cross-encoder model and artifact digest", async () => {
    const { cacheRoot } = await createModel("fixture-v1");

    await expect(resolveLocalCrossEncoderRuntimeProvenance({
      ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK: "1",
      ALAYA_LOCAL_CROSS_ENCODER_CACHE_DIR: ` ${cacheRoot} `,
      ALAYA_LOCAL_CROSS_ENCODER_MODEL: " Xenova/reranker "
    })).resolves.toEqual({
      enabled: true,
      provider_kind: "local_onnx_cross_encoder",
      effective_model_id: "Xenova/reranker",
      model_artifact_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u)
    });
  });
});

async function createModel(contents: string): Promise<{
  readonly cacheRoot: string;
  readonly modelRoot: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "lme-cross-onnx-"));
  roots.push(root);
  const cacheRoot = join(root, "models");
  const modelRoot = join(cacheRoot, "Xenova", "reranker");
  await mkdir(modelRoot, { recursive: true });
  await writeFile(join(modelRoot, "model.onnx"), contents, "utf8");
  return { cacheRoot, modelRoot };
}
