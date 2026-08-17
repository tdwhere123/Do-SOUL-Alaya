import { assertSourceBoundF3SealCurrent, sourceBoundF3Seal } from "@do-soul/alaya-soul";
import { proveCacheOnlyExtraction } from "../diagnostic-loop/cache-only.js";
import type { DiagnosticLoopRequest } from "../diagnostic-loop/types.js";
import {
  MIMO_MODEL_ID,
  MIMO_REQUEST_PROFILE,
  OBSOLETE_DEEPSEEK_REQUEST_PROFILE,
  resolveMimoVendorModel
} from "./profile.js";

export function proveMimoZeroCallReplay(input: {
  readonly request: DiagnosticLoopRequest;
}): {
  readonly physical_calls: 0;
  readonly profile: typeof MIMO_REQUEST_PROFILE;
  readonly evidence_prompt_sha256: string;
  readonly query_prompt_sha256: string;
} {
  assertSourceBoundF3SealCurrent();
  if (input.request.requestProfile === OBSOLETE_DEEPSEEK_REQUEST_PROFILE) {
    throw new Error("MiMo replay refuses obsolete DeepSeek cache authority");
  }
  if (input.request.requestProfile !== MIMO_REQUEST_PROFILE) {
    throw new Error(`MiMo replay requires request profile ${MIMO_REQUEST_PROFILE}`);
  }
  if (resolveMimoVendorModel(input.request.model) !== MIMO_MODEL_ID) {
    throw new Error(`MiMo replay requires model ${MIMO_MODEL_ID}`);
  }
  const proof = proveCacheOnlyExtraction(input.request);
  if (proof.physicalCalls !== 0) {
    throw new Error("MiMo replay is not cache-only");
  }
  const seal = sourceBoundF3Seal();
  return {
    physical_calls: 0,
    profile: MIMO_REQUEST_PROFILE,
    evidence_prompt_sha256: seal.evidence_prompt_sha256,
    query_prompt_sha256: seal.query_prompt_sha256
  };
}
