import type { LongMemEvalMatrixPromotionAuthorization } from "./schema/authorization.js";
import type { PromotionValidatorIdentity } from "./schema/authorization.js";

export {
  LongMemEvalMatrixPromotionAuthorizationSchema,
  LongMemEvalMatrixPromotionRejectionSchema,
  renderLongMemEvalMatrixPromotionAuthorization,
  renderLongMemEvalMatrixPromotionRejection,
  type LongMemEvalMatrixPromotionAuthorization,
  type LongMemEvalMatrixPromotionRejection,
  type PromotionValidatorIdentity
} from "./schema/authorization.js";
export {
  LongMemEvalMatrixPromotionContractSchema,
  parseLongMemEvalMatrixPromotionContract,
  type LongMemEvalMatrixPromotionContract
} from "./schema/contract.js";

export interface PromotionCodeIdentityInput {
  readonly checkoutRoot: string;
  readonly contractPath: string;
}

export interface PromotionCodeIdentityDependencies {
  readonly measureValidatorGitState?: (checkoutRoot: string) => Promise<unknown>;
  readonly readContractSha256?: (contractPath: string) => Promise<string>;
  readonly computeExecutedDistIdentity?: () => Promise<unknown>;
}

export type LongMemEvalMatrixPromotionAuthorizeDependencies =
  PromotionCodeIdentityDependencies;

export interface LongMemEvalMatrixPromotionAuthorizeInput
  extends PromotionCodeIdentityInput {
  readonly contractRoot: string;
  readonly contractContents: string | Uint8Array;
}

export async function authorizeLongMemEvalMatrixPromotion(
  _input: LongMemEvalMatrixPromotionAuthorizeInput,
  _dependencies?: LongMemEvalMatrixPromotionAuthorizeDependencies
): Promise<LongMemEvalMatrixPromotionAuthorization> {
  throw new Error("longmemeval matrix promotion is not supported");
}

export async function resolveCurrentPromotionValidatorIdentity(
  _input: PromotionCodeIdentityInput,
  _parsed: { readonly sha256: string },
  _dependencies?: PromotionCodeIdentityDependencies
): Promise<PromotionValidatorIdentity> {
  throw new Error("longmemeval matrix promotion is not supported");
}
