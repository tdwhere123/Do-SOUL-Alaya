import { createHash } from "node:crypto";

export function buildGardenTaskSignalId(taskId: string, index: number): string {
  return buildGardenTaskScopedSignalId(taskId, String(index));
}

export function buildGardenTaskEvidenceFallbackSignalId(taskId: string): string {
  return buildGardenTaskScopedSignalId(taskId, "fallback:turn-evidence");
}

function buildGardenTaskScopedSignalId(taskId: string, discriminator: string): string {
  const digest = createHash("sha256")
    .update(taskId)
    .update("\0")
    .update(discriminator)
    .digest("hex")
    .slice(0, 32);
  return `signal_${digest}`;
}
