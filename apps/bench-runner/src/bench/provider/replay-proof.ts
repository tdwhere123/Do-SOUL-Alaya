import { assertSourceBoundF3SealCurrent, sourceBoundF3Seal } from "@do-soul/alaya-soul";
import { proveCacheOnlyExtraction } from "../diagnostic-loop/cache-only.js";
import type { DiagnosticLoopRequest } from "../diagnostic-loop/types.js";
import {
  EXTRACTION_REQUEST_PROFILES,
  type ExtractionRequestProfile
} from "../extraction/request-profile.js";
import {
  findProviderBinding,
  isObsoleteRequestProfile,
  resolveVendorModel
} from "./catalog.js";

export function proveProviderZeroCallReplay(input: {
  readonly request: DiagnosticLoopRequest;
}): {
  readonly physical_calls: 0;
  readonly profile: ExtractionRequestProfile;
  readonly evidence_prompt_sha256: string;
  readonly query_prompt_sha256: string;
} {
  assertSourceBoundF3SealCurrent();
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
  const seal = sourceBoundF3Seal();
  return {
    physical_calls: 0,
    profile: requireKnownRequestProfile(input.request.requestProfile),
    evidence_prompt_sha256: seal.evidence_prompt_sha256,
    query_prompt_sha256: seal.query_prompt_sha256
  };
}

function requireKnownRequestProfile(value: string): ExtractionRequestProfile {
  if ((EXTRACTION_REQUEST_PROFILES as readonly string[]).includes(value)) {
    return value as ExtractionRequestProfile;
  }
  throw new Error(`unsupported request profile '${value}'`);
}
