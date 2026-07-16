import process from "node:process";
import path from "node:path";
import {
  authorizeLongMemEvalMatrixPromotion,
  LongMemEvalMatrixPromotionAuthorizationSchema,
  renderLongMemEvalMatrixPromotionAuthorization
} from "../../longmemeval/promotion/index.js";
import { publishExclusiveAuthorization } from "./atomic-output.js";
import { readLongMemEvalMatrixPromotionContract } from "./contract-input.js";
import { parseLongMemEvalMatrixPromotionCommandOptions } from "./options.js";

export interface LongMemEvalMatrixPromotionCommandDependencies {
  readonly authorize: typeof authorizeLongMemEvalMatrixPromotion;
  readonly stdout: (message: string) => unknown;
  readonly stderr: (message: string) => unknown;
}

const DEFAULT_DEPENDENCIES: LongMemEvalMatrixPromotionCommandDependencies = {
  authorize: authorizeLongMemEvalMatrixPromotion,
  stdout: (message) => process.stdout.write(message),
  stderr: (message) => process.stderr.write(message)
};

export async function runAuthorizeLongMemEvalMatrixCommand(
  args: ReadonlyArray<string>,
  dependencies: LongMemEvalMatrixPromotionCommandDependencies = DEFAULT_DEPENDENCIES
): Promise<number> {
  try {
    const options = parseLongMemEvalMatrixPromotionCommandOptions(args);
    const input = await readLongMemEvalMatrixPromotionContract(options.contractPath);
    const authorization = LongMemEvalMatrixPromotionAuthorizationSchema.parse(
      await dependencies.authorize(input)
    );
    const output = await publishExclusiveAuthorization(
      options.outputPath,
      renderLongMemEvalMatrixPromotionAuthorization(authorization)
    );
    dependencies.stdout(`LongMemEval matrix promotion authorized\nAuthorization: ${output}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dependencies.stderr(`alaya-bench-runner authorize-longmemeval-matrix: ${message}\n`);
    return 2;
  }
}
