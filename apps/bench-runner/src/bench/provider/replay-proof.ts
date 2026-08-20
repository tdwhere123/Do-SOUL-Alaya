import { assertSourceBoundF3SealCurrent, sourceBoundF3Seal } from "@do-soul/alaya-soul";
import { proveCacheOnlyExtraction } from "../diagnostic-loop/cache-only.js";
import type { DiagnosticLoopRequest } from "../diagnostic-loop/types.js";
import {
  assertQuerySemanticFactorCacheMatchesRequest
} from "../query-factors/query-semantic-factor-cache-identity.js";
import {
  assertBoundQuerySemanticFactorCacheFileDigest,
  bindQuerySemanticFactorCacheFileToRequest
} from "../query-factors/query-semantic-factor-cache.js";
import {
  EXTRACTION_REQUEST_PROFILES,
  type ExtractionRequestProfile
} from "../extraction/request-profile.js";
import {
  findProviderBinding,
  isObsoleteRequestProfile,
  resolveVendorModel
} from "./catalog.js";

export async function proveProviderZeroCallReplay(input: {
  readonly request: DiagnosticLoopRequest;
  readonly expectedFileSha256?: string;
}): Promise<{
  readonly physical_calls: 0;
  readonly profile: ExtractionRequestProfile;
  readonly evidence_prompt_sha256: string;
  readonly query_prompt_sha256: string;
  readonly evidence_request_template_sha256: string;
  readonly query_request_template_sha256: string;
}> {
  assertSourceBoundF3SealCurrent();
  if (input.request.requestedKeys.length === 0) {
    throw new Error("provider replay requires a non-empty request key set");
  }
  if (isObsoleteRequestProfile(input.request.requestProfile)) {
    throw new Error(
      `provider replay refuses obsolete request profile ${input.request.requestProfile}`
    );
  }
  const binding = findProviderBinding(input.request.model);
  if (binding !== undefined) {
    if (input.request.requestProfile !== binding.requestProfile) {
      throw new Error(
        `provider replay requires request profile ${binding.requestProfile} for ${binding.id}`
      );
    }
    if (resolveVendorModel(input.request.model) !== binding.id) {
      throw new Error(`provider replay requires model ${binding.id}`);
    }
  }
  const proof = proveCacheOnlyExtraction(input.request);
  if (proof.physicalCalls !== 0) {
    throw new Error("provider replay is not cache-only");
  }
  await assertReplayQueryCacheAuthority(input.request, input.expectedFileSha256);
  const seal = sourceBoundF3Seal();
  return {
    physical_calls: 0,
    profile: requireKnownRequestProfile(input.request.requestProfile),
    evidence_prompt_sha256: seal.evidence_prompt_sha256,
    query_prompt_sha256: seal.query_prompt_sha256,
    evidence_request_template_sha256: seal.evidence_request_template_sha256,
    query_request_template_sha256: seal.query_request_template_sha256
  };
}

function requireKnownRequestProfile(value: string): ExtractionRequestProfile {
  if ((EXTRACTION_REQUEST_PROFILES as readonly string[]).includes(value)) {
    return value as ExtractionRequestProfile;
  }
  throw new Error(`unsupported request profile '${value}'`);
}

async function assertReplayQueryCacheAuthority(
  request: DiagnosticLoopRequest,
  expectedFileSha256: string | undefined
): Promise<void> {
  if (request.treatmentFactorCachePath === undefined) return;
  const bound = await bindQuerySemanticFactorCacheFileToRequest(
    request.treatmentFactorCachePath,
    request
  );
  assertQuerySemanticFactorCacheMatchesRequest(bound.binding, request);
  if (expectedFileSha256 !== undefined) {
    assertBoundQuerySemanticFactorCacheFileDigest(
      request.treatmentFactorCachePath, expectedFileSha256
    );
  }
}
