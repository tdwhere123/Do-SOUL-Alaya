import { appendFileSync } from "node:fs";

export function writeRecallEvalPoolDump(
  questionId: string,
  goldMemoryIds: readonly string[],
  results: readonly { readonly object_id: string }[]
): void {
  const dumpPath = process.env.ALAYA_RECALL_EVAL_POOL_DUMP;
  if (dumpPath === undefined) return;
  const goldSet = new Set(goldMemoryIds);
  appendFileSync(dumpPath, JSON.stringify({
    questionId,
    goldIds: [...goldMemoryIds],
    pool: results.map((result, index) => ({
      rank: index + 1,
      objectId: result.object_id,
      isGold: goldSet.has(result.object_id)
    }))
  }) + "\n");
}
