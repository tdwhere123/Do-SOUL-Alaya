import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { fieldContractSha256 } from "@do-soul/alaya-core";
import { sourceIndexProfileId } from "@do-soul/alaya-protocol";
import { assertMemoryEmbeddingReceipts, assertMemoryEmbeddingRecovery, SemanticChainConfigSchema, writeChainArtifact } from "../../../runs/recall-measurement/contract.js";
import { semanticChainCacheInputPaths } from "../../../runs/recall-measurement/inputs.js";
import { admitEvaluatorOutputRoot } from "../../../runs/measurement/evaluator-output.js";

it("admits only complete Memory receipts bound to the selected preparation", () => {
  const root = mkdtempSync(join(tmpdir(), "memory-profile-receipt-"));
  try {
    const digest = `sha256:${"a".repeat(64)}`;
    const profile = { provider_kind: "local_onnx", model_id: "fixture-memory", model_revision: "fixture", artifact_digest: digest,
      tokenizer_revision: "fixture", dimensions: 384, preprocessing: "raw", normalization: "mean", max_input_tokens: 512,
      windowing: "recorded-message-windows.v1" as const, window_bytes: 4 };
    const observed = { status: "ready" as const, profile, profile_id: sourceIndexProfileId(profile, fieldContractSha256) };
    const preparation = join(root, "preparation.json");
    writeChainArtifact(preparation, { memory_profile: observed, memory_readiness: { status: "ready", dimensions: 384 } });
    const config = SemanticChainConfigSchema.parse({ snapshot_path: join(root, "snapshot.sqlite"), snapshot_sha256: "a".repeat(64),
      implementation_revision: "b".repeat(40), interpretation_clock: "2026-09-22T00:00:00.000Z", workspace_id: "fixture", run_id: "fixture",
      query_workset: { contract: "source-semantic-proposal-workset-v3", kind: "query", model: "fixture", request_profile: "gemini-2.5-nonthinking-v1",
        provider_url: "http://127.0.0.1:9", items: [{ original_query: "fixture" }] },
      query_cache_root: join(root, "query"), correspondence_cache_root: join(root, "correspondence"), max_output_tokens: 4096,
      discovery_page_cap: 1, correspondence_pair_cap: 0, access_policy: "query-conditioned-v1", authorized_scopes: { mode: "unrestricted" },
      budget: { schema_version: 1, work_units: 1000, memory_bytes: 10000, page_budget: 10, finalization_reserve: 100, min_envelope: 10 },
      output_byte_limit: 1024, source_index: { kind: "cached_local", cache_root: join(root, "source"), model_id: "fixture-source",
        source_scope: "separate", artifact_digest: digest,
        memory: { cache_root: join(root, "memory"), model_id: profile.model_id, artifact_digest: digest }, memory_warmup: "eager",
        preparation_path: preparation, preparation_identity: "c".repeat(64), index: { configuration: { revision: "fixture", profile },
          config_id: "fixture", profile_id: "fixture", selection_revision: 1, generation_id: "fixture", source_epoch: 0,
          status: "ready", enumeration_complete: true, target_count: 1, completed_count: 1 } } });
    const inputs = semanticChainCacheInputPaths({ config });
    expect(inputs).toContain(join(root, "memory"));
    expect(() => admitEvaluatorOutputRoot(join(root, "memory", "output"), inputs)).toThrow(/separate/u);
    const stage = join(root, "stage");
    expect(() => assertMemoryEmbeddingReceipts(config, stage, "prior")).not.toThrow();
    expect(() => assertMemoryEmbeddingReceipts(config, stage, "complete")).toThrow(/unresolved/u);
    writeChainArtifact(join(stage, "memory-embedding-readiness.json"), { status: "ready", dimensions: 384, profile: observed });
    expect(() => assertMemoryEmbeddingReceipts(config, stage, "started")).not.toThrow();
    expect(() => assertMemoryEmbeddingReceipts(config, stage, "prior")).toThrow(/unresolved/u);
    expect(() => assertMemoryEmbeddingReceipts(config, stage, "complete")).toThrow(/unresolved/u);
    writeChainArtifact(join(stage, "memory-embedding-profile-final.json"), observed);
    expect(() => assertMemoryEmbeddingReceipts(config, stage, "complete")).not.toThrow();
    const row = join(stage, "fixture-row.json");
    expect(() => assertMemoryEmbeddingRecovery(config, stage, [row])).toThrow(/incomplete durable rows/u);
    writeFileSync(row, "fixture");
    writeFileSync(`${row}.reserved`, "fixture");
    expect(() => assertMemoryEmbeddingRecovery(config, stage, [row])).not.toThrow();
    const wrong = { ...config, source_index: { ...config.source_index!, memory: {
      ...config.source_index!.memory!, artifact_digest: `sha256:${"b".repeat(64)}` } } };
    expect(() => assertMemoryEmbeddingReceipts(wrong, stage, "complete")).toThrow(/Memory embedding profile/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
