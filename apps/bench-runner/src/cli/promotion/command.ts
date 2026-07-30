import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  authorizeLongMemEvalMatrixPromotion,
  parseLongMemEvalMatrixPromotionContract,
  resolveCurrentPromotionValidatorIdentity
} from "../../longmemeval/promotion/index.js";
import {
  LongMemEvalMatrixPromotionAuthorizationSchema,
  renderLongMemEvalMatrixPromotionAuthorization,
  renderLongMemEvalMatrixPromotionRejection
} from "../../longmemeval/promotion/schema/authorization.js";
import { publishExclusiveAuthorization } from "./atomic-output.js";
import {
  runAuthorizeLongMemEvalMatrixCommand as runCommand,
  type ResolvedLongMemEvalMatrixPromotionCommandDependencies
} from "./command-core.js";

export type LongMemEvalMatrixPromotionCommandDependencies =
  ResolvedLongMemEvalMatrixPromotionCommandDependencies;

const DEFAULT_DEPENDENCIES: ResolvedLongMemEvalMatrixPromotionCommandDependencies = {
  authorize: authorizeLongMemEvalMatrixPromotion,
  resolveValidatorIdentity: resolveCurrentPromotionValidatorIdentity,
  parseContract: parseLongMemEvalMatrixPromotionContract,
  parseAuthorization: (value) => LongMemEvalMatrixPromotionAuthorizationSchema.parse(value),
  renderAuthorization: renderLongMemEvalMatrixPromotionAuthorization,
  renderRejection: renderLongMemEvalMatrixPromotionRejection,
  publishAuthorization: publishExclusiveAuthorization,
  checkoutRoot: path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../../.."
  ),
  stdout: (message) => process.stdout.write(message),
  stderr: (message) => process.stderr.write(message)
};

export async function runAuthorizeLongMemEvalMatrixCommand(
  args: ReadonlyArray<string>,
  dependencies: LongMemEvalMatrixPromotionCommandDependencies = DEFAULT_DEPENDENCIES
): Promise<number> {
  return runCommand(args, dependencies);
}
