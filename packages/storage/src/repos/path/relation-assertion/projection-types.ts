import type { PathRelation } from "@do-soul/alaya-protocol";

export type RelationAssertionProjectionGeneration = Readonly<{
  readonly generation: string;
  readonly assertionSchemaGeneration: string;
  readonly assertionEventContractGeneration: string;
  readonly projectionSchemaGeneration: string;
  readonly projectionPolicyId: string;
  readonly projectionPolicySha256: string;
  readonly historyDigest: string;
  readonly asOf: string;
  readonly projectionDigest: string;
  readonly projections: readonly Readonly<PathRelation>[];
  readonly createdAt: string;
}>;
