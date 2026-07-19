import process from "node:process";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  authorizeLongMemEvalMatrixPromotion,
  LongMemEvalMatrixPromotionAuthorizationSchema,
  parseLongMemEvalMatrixPromotionContract,
  renderLongMemEvalMatrixPromotionAuthorization,
  renderLongMemEvalMatrixPromotionRejection,
  resolveCurrentPromotionValidatorIdentity,
  type LongMemEvalMatrixPromotionRejection,
  type PromotionValidatorIdentity
} from "../../longmemeval/promotion/index.js";
import { publishExclusiveAuthorization } from "./atomic-output.js";
import { readLongMemEvalMatrixPromotionContract } from "./contract-input.js";
import { parseLongMemEvalMatrixPromotionCommandOptions } from "./options.js";

export interface LongMemEvalMatrixPromotionCommandDependencies {
  readonly authorize: typeof authorizeLongMemEvalMatrixPromotion;
  readonly resolveValidatorIdentity: typeof resolveCurrentPromotionValidatorIdentity;
  readonly checkoutRoot: string;
  readonly stdout: (message: string) => unknown;
  readonly stderr: (message: string) => unknown;
}

const DEFAULT_DEPENDENCIES: LongMemEvalMatrixPromotionCommandDependencies = {
  authorize: authorizeLongMemEvalMatrixPromotion,
  resolveValidatorIdentity: resolveCurrentPromotionValidatorIdentity,
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
  let outputPath: string | undefined;
  let contractPath: string | undefined;
  let contractSha256: string | null = null;
  let validator: PromotionValidatorIdentity | null = null;
  let validatorResolveError: string | null = null;
  try {
    const options = parseLongMemEvalMatrixPromotionCommandOptions(args);
    outputPath = path.resolve(options.outputPath);
    contractPath = path.resolve(options.contractPath);
    const input = await readLongMemEvalMatrixPromotionContract(options.contractPath);
    try {
      const parsed = parseLongMemEvalMatrixPromotionContract(input.contractContents);
      contractSha256 = parsed.sha256;
      try {
        validator = await dependencies.resolveValidatorIdentity({
          checkoutRoot: dependencies.checkoutRoot,
          contractPath
        }, parsed);
      } catch (resolveError) {
        validator = null;
        validatorResolveError = resolveError instanceof Error
          ? resolveError.message
          : String(resolveError);
      }
    } catch (parseError) {
      contractSha256 = null;
      validator = null;
      validatorResolveError = parseError instanceof Error
        ? parseError.message
        : String(parseError);
    }
    const authorization = LongMemEvalMatrixPromotionAuthorizationSchema.parse(
      await dependencies.authorize({
        checkoutRoot: dependencies.checkoutRoot,
        contractPath,
        ...input
      })
    );
    const output = await publishExclusiveAuthorization(
      outputPath,
      renderLongMemEvalMatrixPromotionAuthorization(authorization)
    );
    dependencies.stdout(`LongMemEval matrix promotion authorized\nAuthorization: ${output}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dependencies.stderr(`alaya-bench-runner authorize-longmemeval-matrix: ${message}\n`);
    if (outputPath !== undefined) {
      const rejection: LongMemEvalMatrixPromotionRejection = {
        schema_version: 1,
        kind: "longmemeval_matrix_promotion_rejection",
        status: "rejected",
        error: { message },
        contract_path: contractPath ?? null,
        contract_sha256: contractSha256,
        validator,
        validator_resolve_error: validatorResolveError
      };
      // Overwrite so operator retries stay unblocked.
      await writeFile(
        `${outputPath}.rejected.json`,
        renderLongMemEvalMatrixPromotionRejection(rejection),
        { encoding: "utf8", mode: 0o600 }
      );
    }
    return 2;
  }
}
