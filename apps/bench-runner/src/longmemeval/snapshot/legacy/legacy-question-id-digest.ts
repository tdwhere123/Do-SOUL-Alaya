import { createHash } from "node:crypto";

export function computeLegacySnapshotQuestionIdDigestV1(
  questionIds: readonly string[]
): string {
  const hash = createHash("sha256");
  for (const questionId of questionIds) {
    const bytes = Buffer.from(questionId, "utf8");
    const size = Buffer.alloc(8);
    size.writeBigUInt64BE(BigInt(bytes.byteLength));
    hash.update(size).update(bytes);
  }
  return hash.digest("hex");
}
