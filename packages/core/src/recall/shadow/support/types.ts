export const SUPPORT_HYPERGRAPH_OPERATOR_ID = "recall_support_hypergraph_v1" as const;

export const SUPPORT_NODE_KINDS = [
  "candidate_projection",
  "answer_binding",
  "proposition",
  "evidence_unit",
  "source_lineage"
] as const;

export type SupportNodeKind = (typeof SUPPORT_NODE_KINDS)[number];

export const SUPPORT_EDGE_KINDS = [
  "expresses",
  "yields",
  "grounds",
  "supports",
  "refutes",
  "supersedes",
  "sourced_from",
  "correlated"
] as const;

export type SupportEdgeKind = (typeof SUPPORT_EDGE_KINDS)[number];

export type SupportEndpointV1 = Readonly<{
  readonly kind: SupportNodeKind;
  readonly id: string;
}>;

export type SupportNodeV1 = Readonly<{
  readonly kind: SupportNodeKind;
  readonly id: string;
}>;

export type SupportEdgeV1 = Readonly<{
  readonly kind: SupportEdgeKind;
  readonly from: SupportEndpointV1;
  readonly to: SupportEndpointV1;
}>;

export type SupportAliasRecordV1 = Readonly<{
  readonly left_id: string;
  readonly right_id: string;
  readonly state: "equal" | "may_equal" | "distinct" | "unknown" | "conflict";
}>;

export type SupportCorrelationRecordV1 = Readonly<{
  readonly left_id: string;
  readonly right_id: string;
  readonly state:
    | "same_evidence_unit"
    | "same_source_lineage"
    | "possibly_correlated"
    | "certified_independent";
}>;
