import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  verifyLongMemEvalExpansionCapability,
  type LongMemEvalExpansionCapability
} from "../../longmemeval/promotion/expansion-capability.js";
import { readLongMemEvalMatrixPromotionContract } from "./contract-input.js";

export interface LongMemEvalExpansionContractInputDependencies {
  readonly checkoutRoot: string;
  readonly verify: typeof verifyLongMemEvalExpansionCapability;
}

const DEFAULT_DEPENDENCIES: LongMemEvalExpansionContractInputDependencies = {
  checkoutRoot: path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../../.."
  ),
  verify: verifyLongMemEvalExpansionCapability
};

export async function verifyLongMemEvalExpansionContractInput(
  contractPath: string,
  dependencies: LongMemEvalExpansionContractInputDependencies = DEFAULT_DEPENDENCIES
): Promise<LongMemEvalExpansionCapability> {
  const input = await readLongMemEvalMatrixPromotionContract(contractPath);
  return dependencies.verify({
    checkoutRoot: dependencies.checkoutRoot,
    contractPath: path.resolve(contractPath),
    ...input
  });
}
