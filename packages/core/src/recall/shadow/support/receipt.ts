import { digestRecallFieldIdentity, type RecallFieldDigest } from
  "../../field/field-identity.js";
import { freezeShadow } from "../envelope.js";
import { SUPPORT_HYPERGRAPH_OPERATOR_ID } from "./types.js";
import type {
  SupportAliasRecordV1,
  SupportCorrelationRecordV1,
  SupportEdgeV1,
  SupportNodeV1
} from "./types.js";

export type SupportHypergraphReceiptV1 = Readonly<{
  readonly schema_version: 1;
  readonly operator_id: typeof SUPPORT_HYPERGRAPH_OPERATOR_ID;
  readonly query_id: string;
  readonly snapshot_digest: string;
  readonly nodes: readonly SupportNodeV1[];
  readonly edges: readonly SupportEdgeV1[];
  readonly aliases: readonly SupportAliasRecordV1[];
  readonly correlations: readonly SupportCorrelationRecordV1[];
  readonly digest: RecallFieldDigest;
}>;

export type SupportHypergraphBodyV1 = Omit<SupportHypergraphReceiptV1, "digest">;

export function digestSupportHypergraph(
  body: Omit<SupportHypergraphBodyV1, "schema_version" | "operator_id">
): SupportHypergraphReceiptV1 {
  const receiptBody = freezeShadow({
    schema_version: 1 as const,
    operator_id: SUPPORT_HYPERGRAPH_OPERATOR_ID,
    query_id: body.query_id,
    snapshot_digest: body.snapshot_digest,
    nodes: Object.freeze([...body.nodes]),
    edges: Object.freeze([...body.edges]),
    aliases: Object.freeze([...body.aliases]),
    correlations: Object.freeze([...body.correlations])
  });
  return freezeShadow({
    ...receiptBody,
    digest: digestRecallFieldIdentity(canonicalBody(receiptBody))
  });
}

function canonicalBody(body: SupportHypergraphBodyV1): unknown {
  return {
    schema_version: body.schema_version,
    operator_id: body.operator_id,
    query_id: body.query_id,
    snapshot_digest: body.snapshot_digest,
    nodes: body.nodes.map((node) => ({ kind: node.kind, id: node.id })),
    edges: body.edges.map((edge) => ({
      kind: edge.kind,
      from: { kind: edge.from.kind, id: edge.from.id },
      to: { kind: edge.to.kind, id: edge.to.id }
    })),
    aliases: body.aliases.map((alias) => ({
      left_id: alias.left_id,
      right_id: alias.right_id,
      state: alias.state,
      ...(alias.relation_evidence_receipt === undefined ? {} : {
        relation_evidence_receipt: alias.relation_evidence_receipt
      })
    })),
    correlations: body.correlations.map((row) => ({
      left_id: row.left_id,
      right_id: row.right_id,
      state: row.state
    }))
  };
}
