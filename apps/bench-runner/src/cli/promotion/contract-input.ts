import { realpath } from "node:fs/promises";
import path from "node:path";
import { openContainedArtifact } from "../merge/contained-artifact-path.js";

const MAX_PROMOTION_CONTRACT_BYTES = 1024 * 1024;

export interface LongMemEvalMatrixPromotionContractInput {
  readonly contractRoot: string;
  readonly contractContents: Buffer;
}

export async function readLongMemEvalMatrixPromotionContract(
  contractPath: string
): Promise<LongMemEvalMatrixPromotionContractInput> {
  const absolutePath = path.resolve(contractPath);
  const contractRoot = await realpath(path.dirname(absolutePath));
  const file = await openContainedArtifact(contractRoot, path.basename(absolutePath));
  if (file === null) throw new Error(`promotion contract not found: ${contractPath}`);
  try {
    return {
      contractRoot,
      contractContents: await file.readBytes(MAX_PROMOTION_CONTRACT_BYTES)
    };
  } finally {
    await file.close();
  }
}
