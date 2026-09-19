import {
  SourceSemanticQuerySchema,
  sourceSemanticQueryIdentity,
  type SourceSemanticQuery
} from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "../../../shared/field-hash.js";
import { digestOriginalQuery } from "./compile-query-identity.js";
import {
  defaultSourceSemanticQueryProducerRegistry,
  type SourceSemanticQueryProducerRecord,
  type SourceSemanticQueryProducerRegistry
} from "./source-semantic-query-producer-registry.js";

export type SourceSemanticQueryAdmission =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid" }
  | { readonly kind: "unsupported" }
  | {
      readonly kind: "admitted";
      readonly query: SourceSemanticQuery;
      readonly query_id: string;
      readonly original_query_digest: string;
      readonly producer: SourceSemanticQueryProducerRecord;
    };

export function admitSourceSemanticQuery(
  query: unknown,
  originalQuery: string,
  registry: SourceSemanticQueryProducerRegistry = defaultSourceSemanticQueryProducerRegistry
): SourceSemanticQueryAdmission {
  if (query === undefined) return { kind: "absent" };
  const parsed = SourceSemanticQuerySchema.safeParse(query);
  if (!parsed.success) return { kind: "invalid" };
  if (parsed.data.original_query_digest !== digestOriginalQuery(originalQuery)) {
    return { kind: "invalid" };
  }
  const excerpts = [
    ...(parsed.data.domains ?? []).map((row) => row.support.excerpt),
    ...parsed.data.variables.flatMap((row) => row.reference === undefined ? [] : [row.reference.excerpt]),
    ...parsed.data.alternatives.flatMap((row) => row.frames.flatMap((frame) => frame.role_requirements.map((role) => role.support.excerpt)))
  ];
  if (excerpts.some((excerpt) => !originalQuery.includes(excerpt))) return { kind: "invalid" };
  const producer = registry.lookup(parsed.data.producer_id, parsed.data.producer_version);
  if (producer === undefined || !producer.capabilities.includes("semantic_query")) {
    return { kind: "unsupported" };
  }
  return {
    kind: "admitted",
    query: parsed.data,
    query_id: sourceSemanticQueryIdentity(parsed.data, fieldContractSha256),
    original_query_digest: parsed.data.original_query_digest,
    producer
  };
}
