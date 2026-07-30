import { writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  LongMemEvalMatrixPromotionAuthorization,
  LongMemEvalMatrixPromotionRejection,
  PromotionValidatorIdentity
} from "../../longmemeval/promotion/schema/authorization.js";
import type {
  authorizeLongMemEvalMatrixPromotion,
  resolveCurrentPromotionValidatorIdentity
} from "../../longmemeval/promotion/index.js";
import { readLongMemEvalMatrixPromotionContract } from "./contract-input.js";
import { parseLongMemEvalMatrixPromotionCommandOptions } from "./options.js";

export interface ResolvedLongMemEvalMatrixPromotionCommandDependencies {
  readonly authorize: typeof authorizeLongMemEvalMatrixPromotion;
  readonly resolveValidatorIdentity: typeof resolveCurrentPromotionValidatorIdentity;
  readonly parseContract: (contents: Uint8Array) => { readonly sha256: string };
  readonly parseAuthorization: (value: unknown) => LongMemEvalMatrixPromotionAuthorization;
  readonly renderAuthorization: (value: LongMemEvalMatrixPromotionAuthorization) => string;
  readonly renderRejection: (value: LongMemEvalMatrixPromotionRejection) => string;
  readonly publishAuthorization: (outputPath: string, contents: string) => Promise<string>;
  readonly checkoutRoot: string;
  readonly stdout: (message: string) => unknown;
  readonly stderr: (message: string) => unknown;
}

export async function runAuthorizeLongMemEvalMatrixCommand(
  args: ReadonlyArray<string>,
  dependencies: ResolvedLongMemEvalMatrixPromotionCommandDependencies
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
      const parsed = dependencies.parseContract(input.contractContents);
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
    const authorization = dependencies.parseAuthorization(
      await dependencies.authorize({
        checkoutRoot: dependencies.checkoutRoot,
        contractPath,
        ...input
      })
    );
    const output = await dependencies.publishAuthorization(
      outputPath,
      dependencies.renderAuthorization(authorization)
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
      await writeFile(
        `${outputPath}.rejected.json`,
        dependencies.renderRejection(rejection),
        { encoding: "utf8", mode: 0o600 }
      );
    }
    return 2;
  }
}
