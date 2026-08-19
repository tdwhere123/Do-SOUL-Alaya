import { createHash } from "node:crypto";
import {
  OPEN_SEMANTIC_FACTOR_GRAPH_SCHEMA_VERSION
} from "@do-soul/alaya-protocol";
import { OFFICIAL_API_SYSTEM_PROMPT } from "../official-api/system-prompt.js";
import { officialApiExtractionRequestTemplatePreimage } from
  "../official-api/extraction-request.js";
import { GARDEN_OPEN_SEMANTIC_FACTOR_PRODUCER_OPERATOR_ID } from
  "../grounding/semantic-factors/formation-proposal.js";
import {
  OPEN_SEMANTIC_FACTOR_QUERY_OPERATOR_ID,
  OPEN_SEMANTIC_FACTOR_QUERY_REQUEST_TEMPLATE,
  OPEN_SEMANTIC_FACTOR_QUERY_SYSTEM_PROMPT
} from "./query-compiler.js";

export const SOURCE_BOUND_F3_CAPABILITIES = [
  "f0_f2_only",
  "identities_only",
  "identities_and_topology"
] as const;

export type SourceBoundF3Capability = (typeof SOURCE_BOUND_F3_CAPABILITIES)[number];

export const SELECTED_SOURCE_BOUND_F3_CAPABILITY = "identities_only" as const;
export const SOURCE_BOUND_F3_PROMPT_ASKS = "identities_and_topology" as const;

export const SOURCE_BOUND_F3_FORBIDDEN_WRITES = [
  "RelationAssertion",
  "PathRelation",
  "ClaimForm",
  "projection_state",
  "governance",
  "learning_effect"
] as const;

export const SOURCE_BOUND_F3_EVIDENCE_PROMPT_SHA256 =
  "3ccba91b3cfc4cee74edfee4672b880d870f320fb94124bad9c1ffb8ce60ef3a";
export const SOURCE_BOUND_F3_QUERY_PROMPT_SHA256 =
  "da13495a266e25890113ae8a1f5560c88fd26026d1432217592728482cd88c70";
export const SOURCE_BOUND_F3_EVIDENCE_REQUEST_TEMPLATE_SHA256 =
  "67de86ee33c7315698963950647eef568c1ee864bb2508775009632c6e96d396";
export const SOURCE_BOUND_F3_QUERY_REQUEST_TEMPLATE_SHA256 =
  "92dea9f910b9d06abdc54af40444602bca23041b43eda4aa9a93c92a557e0aa2";

export interface SourceBoundF3Seal {
  readonly schema_version: 1;
  readonly selected_capability: typeof SELECTED_SOURCE_BOUND_F3_CAPABILITY;
  readonly membership_capability: typeof SELECTED_SOURCE_BOUND_F3_CAPABILITY;
  readonly prompt_asks: typeof SOURCE_BOUND_F3_PROMPT_ASKS;
  readonly graph_schema_version: typeof OPEN_SEMANTIC_FACTOR_GRAPH_SCHEMA_VERSION;
  readonly evidence_operator_id: typeof GARDEN_OPEN_SEMANTIC_FACTOR_PRODUCER_OPERATOR_ID;
  readonly query_operator_id: typeof OPEN_SEMANTIC_FACTOR_QUERY_OPERATOR_ID;
  readonly evidence_prompt_sha256: string;
  readonly query_prompt_sha256: string;
  readonly evidence_request_template_sha256: string;
  readonly query_request_template_sha256: string;
  readonly forbidden_writes: typeof SOURCE_BOUND_F3_FORBIDDEN_WRITES;
}

export function sourceBoundF3Seal(): SourceBoundF3Seal {
  return {
    schema_version: 1,
    selected_capability: SELECTED_SOURCE_BOUND_F3_CAPABILITY,
    membership_capability: SELECTED_SOURCE_BOUND_F3_CAPABILITY,
    prompt_asks: SOURCE_BOUND_F3_PROMPT_ASKS,
    graph_schema_version: OPEN_SEMANTIC_FACTOR_GRAPH_SCHEMA_VERSION,
    evidence_operator_id: GARDEN_OPEN_SEMANTIC_FACTOR_PRODUCER_OPERATOR_ID,
    query_operator_id: OPEN_SEMANTIC_FACTOR_QUERY_OPERATOR_ID,
    evidence_prompt_sha256: sha256Utf8(OFFICIAL_API_SYSTEM_PROMPT),
    query_prompt_sha256: sha256Utf8(OPEN_SEMANTIC_FACTOR_QUERY_SYSTEM_PROMPT),
    evidence_request_template_sha256: sha256Utf8(
      officialApiExtractionRequestTemplatePreimage()
    ),
    query_request_template_sha256: sha256Utf8(
      OPEN_SEMANTIC_FACTOR_QUERY_REQUEST_TEMPLATE
    ),
    forbidden_writes: SOURCE_BOUND_F3_FORBIDDEN_WRITES
  };
}

export function assertSourceBoundF3SealCurrent(): void {
  const seal = sourceBoundF3Seal();
  if (seal.evidence_prompt_sha256 !== SOURCE_BOUND_F3_EVIDENCE_PROMPT_SHA256) {
    throw new Error("source-bound F3 evidence prompt drifted from the sealed digest");
  }
  if (seal.query_prompt_sha256 !== SOURCE_BOUND_F3_QUERY_PROMPT_SHA256) {
    throw new Error("source-bound F3 query prompt drifted from the sealed digest");
  }
  if (seal.evidence_request_template_sha256 !==
      SOURCE_BOUND_F3_EVIDENCE_REQUEST_TEMPLATE_SHA256) {
    throw new Error("source-bound F3 evidence request template drifted from the sealed digest");
  }
  if (seal.query_request_template_sha256 !==
      SOURCE_BOUND_F3_QUERY_REQUEST_TEMPLATE_SHA256) {
    throw new Error("source-bound F3 query request template drifted from the sealed digest");
  }
}

export function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
