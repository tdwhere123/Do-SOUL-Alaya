import { appendFileSync } from "node:fs";
import type { LongMemEvalGoldObjectIdentity } from
  "../../diagnostics/gold-object-identities.js";

export function writeRecallEvalPoolDump(
  questionId: string,
  goldObjects: readonly LongMemEvalGoldObjectIdentity[],
  results: readonly {
    readonly object_id: string;
    readonly object_kind?: string | null;
  }[]
): void {
  const dumpPath = process.env.ALAYA_RECALL_EVAL_POOL_DUMP;
  if (dumpPath === undefined) return;
  const goldSet = new Set(goldObjects.map(identityKey));
  appendFileSync(dumpPath, JSON.stringify({
    questionId,
    goldIds: [...new Set(goldObjects.map((gold) => gold.objectId))],
    goldObjects,
    pool: results.map((result, index) => ({
      rank: index + 1,
      objectId: result.object_id,
      objectKind: result.object_kind ?? "memory_entry",
      isGold: isGoldResult(result, goldSet)
    }))
  }) + "\n");
}

function identityKey(identity: LongMemEvalGoldObjectIdentity): string {
  return `${identity.objectKind}:${identity.objectId}`;
}

function isGoldResult(
  result: Readonly<{ object_id: string; object_kind?: string | null }>,
  gold: ReadonlySet<string>
): boolean {
  const objectKind = result.object_kind ?? "memory_entry";
  return (objectKind === "memory_entry" || objectKind === "evidence_capsule") &&
    gold.has(`${objectKind}:${result.object_id}`);
}
