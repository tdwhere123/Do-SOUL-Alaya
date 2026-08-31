import type { ExtractionRequestProfile } from "../../../../runs/extraction/request-profile.js";
import type { SnapshotExtractionAuthority } from "../../../../runs/snapshot/extraction-authority.js";
import type { LongMemEvalMatrixPromotionAuthorization } from "../schema/authorization.js";
import type { LongMemEvalMatrixPromotionContract } from "../schema/contract.js";

declare const expansionCapabilityBrand: unique symbol;

export interface LongMemEvalExpansionCapability {
  readonly [expansionCapabilityBrand]: true;
}

export interface LongMemEvalSourceCacheAuthority {
  readonly manifestSha256: string;
  readonly extractionModel: string;
  readonly modelFamily: string;
  readonly requestProfile: ExtractionRequestProfile;
  readonly providerUrl: string;
  readonly systemPromptSha256: string;
  readonly cacheKeyAlgo: string;
  readonly dataset: string;
  readonly datasetRevision: string;
  readonly windowOffset: number;
  readonly windowLimit: number;
  readonly expectedTurns: number;
  readonly expectedKeySetSha256: string;
  readonly contentClosureSha256: string;
  readonly contentClosureIndex: SnapshotExtractionAuthority["content_closure_index"];
  readonly supplementalSourceBindingSha256?: string;
}

export interface LongMemEvalSourceSnapshotAuthority {
  readonly dbPath: string;
  readonly manifestSha256: string;
  readonly dbSha256: string;
  readonly sidecarSha256: string;
  readonly extractionCache: LongMemEvalSourceCacheAuthority;
}

export interface LongMemEvalExpansionCapabilityData {
  readonly contractSha256: string;
  readonly matrixAuthorizationSha256: string;
  readonly policyVersion: LongMemEvalMatrixPromotionContract["policy_version"];
  readonly code: LongMemEvalMatrixPromotionContract["code"];
  readonly sourceSelection: LongMemEvalMatrixPromotionAuthorization["source_selection"];
  readonly nextSelection: LongMemEvalMatrixPromotionAuthorization["next_selection"];
  readonly matrix: LongMemEvalMatrixPromotionAuthorization["matrix"];
  readonly productDefault: LongMemEvalMatrixPromotionAuthorization["product_default"];
  readonly materialEffect: LongMemEvalMatrixPromotionAuthorization["material_effect"];
  readonly validator: LongMemEvalMatrixPromotionAuthorization["validator"];
  readonly sourceSnapshot: LongMemEvalSourceSnapshotAuthority;
}

export interface LongMemEvalExpansionCapabilityInput {
  readonly checkoutRoot: string;
  readonly contractPath: string;
  readonly contractRoot: string;
  readonly contractContents: string | Uint8Array;
}

export async function verifyLongMemEvalExpansionCapability(
  _input: LongMemEvalExpansionCapabilityInput,
  _dependencies?: object
): Promise<LongMemEvalExpansionCapability> {
  throw new Error("expansion/promotion contracts are not supported");
}

export function longMemEvalExpansionCapabilityData(
  _capability: LongMemEvalExpansionCapability
): LongMemEvalExpansionCapabilityData {
  throw new Error("expansion/promotion contracts are not supported");
}

export async function readLongMemEvalSourceSnapshotAuthority(
  _input: object
): Promise<LongMemEvalSourceSnapshotAuthority> {
  throw new Error("expansion/promotion contracts are not supported");
}
