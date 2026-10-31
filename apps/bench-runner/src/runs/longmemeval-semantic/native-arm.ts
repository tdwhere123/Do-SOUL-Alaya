import { z } from "zod";
import { SOURCE_SEMANTIC_LIBRARY_ORDER } from "@do-soul/alaya-core";
import {
  SOURCE_SEMANTIC_CACHE_CONTRACT, SOURCE_SEMANTIC_PACKET_CONTRACT, SOURCE_SEMANTIC_QUERY_CONTRACT,
  SOURCE_SEMANTIC_CORRESPONDENCE_CONTRACT, SOURCE_SEMANTIC_LIBRARY_RESULT_VERSION,
  SOURCE_SEMANTIC_LIBRARY_PROTOCOL_VERSION, SourceSemanticAccessPolicySchema
} from "@do-soul/alaya-protocol";
import { chainIdentity } from "../recall-measurement/contract.js";

/** Bench pins the public owner, never selects candidates or supplies a proof policy. */
export const NATIVE_SEMANTIC_ROUTE = {
  surface: "soul.interpretation", operation: "recall", protocol_version: SOURCE_SEMANTIC_LIBRARY_PROTOCOL_VERSION,
  result_version: SOURCE_SEMANTIC_LIBRARY_RESULT_VERSION, order: SOURCE_SEMANTIC_LIBRARY_ORDER,
  source_interpretation: SOURCE_SEMANTIC_PACKET_CONTRACT, source_cache: SOURCE_SEMANTIC_CACHE_CONTRACT,
  query_semantics: SOURCE_SEMANTIC_QUERY_CONTRACT, semantic_correspondence: SOURCE_SEMANTIC_CORRESPONDENCE_CONTRACT,
  access_policy: SourceSemanticAccessPolicySchema.enum["query-conditioned-v1"],
  pair_allocation: "per_query_native_prefix", global_spend: "semantic_proposal_authority_attempt_ledger",
  payload: "native_bounded_encoding"
} as const;
export const NativeSemanticRouteSchema = z.custom<typeof NATIVE_SEMANTIC_ROUTE>((value) =>
  value !== undefined && chainIdentity(value) === chainIdentity(NATIVE_SEMANTIC_ROUTE), "native route contract changed");
