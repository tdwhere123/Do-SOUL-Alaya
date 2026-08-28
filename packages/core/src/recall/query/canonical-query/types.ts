export const CANONICAL_QUERY_OPERATOR_ID = "recall_canonical_query_v1" as const;

export const CANONICAL_QUERY_LIMITS = Object.freeze({
  max_variables: 8,
  max_predicates_and_constraints: 16,
  max_extrema: 1,
  max_depth: 3
});

export type CanonicalVariableSortV1 =
  | "entity"
  | "scalar"
  | "time"
  | "answer"
  | "order_key";

export type CanonicalVariableV1 = Readonly<{
  readonly name: string;
  readonly sort: CanonicalVariableSortV1;
}>;

export type CanonicalEvidenceProvenanceV1 = Readonly<{
  readonly source_id: string;
  readonly producer: string;
}>;

export type CanonicalPredicateV1 = Readonly<{
  readonly id: string;
  readonly relation: string;
  readonly arguments: readonly string[];
  readonly provenance?: CanonicalEvidenceProvenanceV1;
}>;

export type CanonicalConstraintV1 = Readonly<{
  readonly id: string;
  readonly constraint: string;
  readonly arguments: readonly string[];
}>;

export type CanonicalCompletionV1 =
  | Readonly<{ readonly kind: "at_most"; readonly n: number }>
  | Readonly<{
      readonly kind: "all_observable";
      readonly scope: string;
      readonly principal: string;
      readonly snapshot_bind: "Sigma_q";
      readonly observer_contract: string;
    }>;

export type CanonicalAnswerProgramV1 =
  | Readonly<{ readonly kind: "scalar"; readonly variable: string }>
  | Readonly<{
      readonly kind: "distinct";
      readonly variable: string;
      readonly completion: CanonicalCompletionV1;
    }>
  | Readonly<{
      readonly kind: "argmax";
      readonly order_key: string;
      readonly inner: CanonicalAnswerProgramV1;
    }>
  | Readonly<{
      readonly kind: "argmin";
      readonly order_key: string;
      readonly inner: CanonicalAnswerProgramV1;
    }>
  | Readonly<{
      readonly kind: "sequence";
      readonly order_key: string;
      readonly variable: string;
      readonly completion: CanonicalCompletionV1;
    }>;

export type CanonicalQueryV1 = Readonly<{
  readonly schema_version: 1;
  readonly operator_id: typeof CANONICAL_QUERY_OPERATOR_ID;
  readonly variables: readonly CanonicalVariableV1[];
  readonly predicates: readonly CanonicalPredicateV1[];
  readonly constraints: readonly CanonicalConstraintV1[];
  readonly answer: CanonicalAnswerProgramV1;
}>;

export type CanonicalQueryUnsupportedCode =
  | "undeclared_variable"
  | "unbound_order_key"
  | "wrong_temporal_domain"
  | "multiple_terminal_programs"
  | "limit_overflow"
  | "latest_without_typed_time_key"
  | "count_sum_unsupported"
  | "unsupported_nesting"
  | "invalid_all_observable"
  | "invalid_sort";

export type CanonicalQueryValidationV1 =
  | Readonly<{ readonly status: "supported"; readonly query: CanonicalQueryV1 }>
  | Readonly<{
      readonly status: "unsupported";
      readonly reason_code: CanonicalQueryUnsupportedCode;
      readonly message: string;
    }>;

export class CanonicalQueryContractError extends Error {
  public readonly code: CanonicalQueryUnsupportedCode;

  public constructor(code: CanonicalQueryUnsupportedCode, message?: string) {
    super(message ?? code);
    this.name = "CanonicalQueryContractError";
    this.code = code;
  }
}
