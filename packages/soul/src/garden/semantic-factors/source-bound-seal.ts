import { createHash } from "node:crypto";
import {
  OPEN_SEMANTIC_FACTOR_GRAPH_SCHEMA_VERSION
} from "@do-soul/alaya-protocol";
import { OFFICIAL_API_SYSTEM_PROMPT } from "../official-api/system-prompt.js";
import { GARDEN_OPEN_SEMANTIC_FACTOR_PRODUCER_OPERATOR_ID } from
  "../grounding/semantic-factors/formation-proposal.js";
import {
  OPEN_SEMANTIC_FACTOR_QUERY_OPERATOR_ID,
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
  "2f99ca087c6ec0644fb3c737e4da4ed05e801ae778e5bca93e5f7bf79b7a293b";
export const SOURCE_BOUND_F3_QUERY_PROMPT_SHA256 =
  "63cc29f6ba1465d34f919b3d25bdf9d373cbae797bbe3e2ba124c5888dfa68e4";

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
}

export function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
