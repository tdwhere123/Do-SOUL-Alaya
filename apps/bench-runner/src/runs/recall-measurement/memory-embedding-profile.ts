import { z } from "zod";
import { SourceIndexProfileSchema, sourceIndexProfileId } from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "@do-soul/alaya-core";
import type { BenchDaemonHandle } from "../../harness/daemon.js";

export const MemoryEmbeddingProfileSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ready"), profile_id: z.string(), profile: SourceIndexProfileSchema }).strict(),
  z.object({ status: z.literal("unsupported"), reason: z.string() }).strict(),
  z.object({ status: z.literal("failed"), reason: z.string() }).strict()
]);
export type MemoryEmbeddingProfile = z.infer<typeof MemoryEmbeddingProfileSchema>;

export function memorySelection(execution: { source_scope?: "separate"; memory?: { model_id: string; artifact_digest: string };
  model_id: string; artifact_digest?: string }): { model_id: string; artifact_digest: string } | undefined {
  if (execution.source_scope === "separate") return execution.memory;
  return execution.artifact_digest === undefined ? undefined : { model_id: execution.model_id, artifact_digest: execution.artifact_digest };
}

/** This captures the loaded Memory provider's profile, not a Source index generation. */
export async function captureMemoryEmbeddingProfile(daemon: BenchDaemonHandle): Promise<MemoryEmbeddingProfile> {
  try {
    return MemoryEmbeddingProfileSchema.parse(await daemon.runtime.services.bindMemoryEmbeddingProfile());
  } catch {
    return { status: "failed", reason: "memory_profile_binding_failed" };
  }
}

export function matchesMemoryEmbeddingProfile(evidence: MemoryEmbeddingProfile,
  selection: { model_id: string; artifact_digest: string }, dimensions: number | null): boolean {
  return evidence.status === "ready" && evidence.profile.provider_kind === "local_onnx" &&
    evidence.profile.model_id === selection.model_id && evidence.profile.artifact_digest === selection.artifact_digest &&
    (dimensions === null || evidence.profile.dimensions === dimensions) &&
    sourceIndexProfileId(evidence.profile, fieldContractSha256) === evidence.profile_id;
}
