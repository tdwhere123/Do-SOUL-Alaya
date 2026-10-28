import { describe, expect, it } from "vitest";
import { CachedLocalSourceExecutionSchema } from "../../../runs/recall-measurement/source-index-binding-schema.js";
import { matchesMemoryEmbeddingProfile } from "../../../runs/recall-measurement/memory-embedding-profile.js";
import { fieldContractSha256 } from "@do-soul/alaya-core";
import { sourceIndexProfileId } from "@do-soul/alaya-protocol";

describe("Source embedding execution identity", () => {
  const source = { cache_root: "/tmp/source-models", model_id: "Xenova/bge-m3", source_scope: "separate" as const };
  const memory = { cache_root: "/tmp/memory-models", model_id: "Xenova/paraphrase-multilingual-MiniLM-L12-v2" };
  const artifact_digest = `sha256:${"a".repeat(64)}`;
  const selectedMemory = { ...memory, artifact_digest: `sha256:${"b".repeat(64)}` };

  it("retains historical shared-provider selections when the separate scope is absent", () => {
    expect(CachedLocalSourceExecutionSchema.parse(memory)).toEqual(memory);
  });

  it("requires both explicit Memory selection and the selected Source artifact identity", () => {
    expect(CachedLocalSourceExecutionSchema.safeParse(source).success).toBe(false);
    expect(CachedLocalSourceExecutionSchema.safeParse({ ...source, memory }).success).toBe(false);
    expect(CachedLocalSourceExecutionSchema.safeParse({ ...source, artifact_digest }).success).toBe(false);
    expect(CachedLocalSourceExecutionSchema.safeParse({ ...source, artifact_digest, memory }).success).toBe(false);
    expect(CachedLocalSourceExecutionSchema.parse({ ...source, artifact_digest, memory: selectedMemory, memory_warmup: "eager" }))
      .toMatchObject({ ...source, artifact_digest, memory: selectedMemory, memory_warmup: "eager" });
  });

  it("requires the loaded Memory profile, artifact, dimension, and profile identity to agree", () => {
    const profile = { provider_kind: "local_onnx", model_id: selectedMemory.model_id, model_revision: "fixture",
      artifact_digest: selectedMemory.artifact_digest, tokenizer_revision: "fixture", dimensions: 384,
      preprocessing: "raw", normalization: "attention-mask-mean.l2.q8.v1", max_input_tokens: 512,
      windowing: "recorded-message-windows.v1" as const, window_bytes: 4 };
    const evidence = { status: "ready" as const, profile, profile_id: sourceIndexProfileId(profile, fieldContractSha256) };
    expect(matchesMemoryEmbeddingProfile(evidence, selectedMemory, 384)).toBe(true);
    expect(matchesMemoryEmbeddingProfile(evidence, { ...selectedMemory, artifact_digest }, 384)).toBe(false);
    expect(matchesMemoryEmbeddingProfile(evidence, selectedMemory, 1024)).toBe(false);
    expect(matchesMemoryEmbeddingProfile({ ...evidence, profile_id: "not-the-profile" }, selectedMemory, 384)).toBe(false);
    expect(matchesMemoryEmbeddingProfile({ status: "unsupported", reason: "unavailable" }, selectedMemory, null)).toBe(false);
  });
});
