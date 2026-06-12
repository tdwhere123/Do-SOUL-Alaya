import { createHash } from "node:crypto";

export function buildGardenTaskSignalId(taskId: string, index: number): string {
  const digest = createHash("sha256")
    .update(taskId)
    .update("\0")
    .update(String(index))
    .digest("hex")
    .slice(0, 32);
  return `signal_${digest}`;
}
