import { createHash } from "node:crypto";
import {
  OFFICIAL_API_SYSTEM_PROMPT,
  assertSourceBoundF3SealCurrent,
  sourceBoundF3Seal
} from "@do-soul/alaya-soul";
import type { DiagnosticLoopRequest } from
  "../../bench/diagnostic-loop/types.js";
import { prepareExtractionFillWindow } from
  "../../bench/extraction/fill/fill-window.js";
import { requiredExtractionCacheKeys } from
  "../../bench/compile-seed/preflight/cache-window-key-binding.js";
import { isExtractionRequestProfile } from
  "../../bench/extraction/request-profile.js";

export function canonicalReplayContractDigests(): {
  readonly schemaDigest: string;
  readonly operatorDigest: string;
} {
  assertSourceBoundF3SealCurrent();
  const seal = sourceBoundF3Seal();
  return {
    schemaDigest: digest({
      schema_version: seal.schema_version,
      graph_schema_version: seal.graph_schema_version,
      forbidden_writes: seal.forbidden_writes
    }),
    operatorDigest: digest({
      selected_capability: seal.selected_capability,
      membership_capability: seal.membership_capability,
      prompt_asks: seal.prompt_asks,
      evidence_operator_id: seal.evidence_operator_id,
      query_operator_id: seal.query_operator_id,
      evidence_prompt_sha256: seal.evidence_prompt_sha256,
      query_prompt_sha256: seal.query_prompt_sha256,
      evidence_request_template_sha256: seal.evidence_request_template_sha256,
      query_request_template_sha256: seal.query_request_template_sha256
    })
  };
}

export async function rebuildCanonicalReplayKeys(input: {
  readonly request: DiagnosticLoopRequest;
  readonly dataDir?: string;
  readonly pinnedMetaRoot?: string;
}): Promise<readonly string[]> {
  if (input.request.limit === undefined || input.request.offset === undefined) {
    throw new Error("canonical replay request requires limit and offset");
  }
  const window = await prepareExtractionFillWindow({
    variant: input.request.variant,
    limit: input.request.limit,
    offset: input.request.offset,
    ...(input.dataDir === undefined ? {} : { dataDir: input.dataDir }),
    ...(input.pinnedMetaRoot === undefined ? {} : { pinnedMetaRoot: input.pinnedMetaRoot })
  }, undefined);
  if (window.datasetRevision !== input.request.datasetRevision ||
      window.questionCount !== input.request.limit) {
    throw new Error("canonical replay window does not match dataset authority");
  }
  if (!isExtractionRequestProfile(input.request.requestProfile)) {
    throw new Error("canonical replay request profile is unsupported");
  }
  return Object.freeze([...new Set(requiredExtractionCacheKeys({
    model: input.request.model,
    requestProfile: input.request.requestProfile,
    systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
    requiredTurnContents: window.distinctTurns,
    requiredExtractionTurns: window.distinctExtractionTurns
  }))].sort());
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}
