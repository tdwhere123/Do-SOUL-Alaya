import { emptyBytesSha256, emptyJsonArraySha256 } from "@do-soul/alaya-protocol";

export type ProjectionIdentity = Readonly<{
  readonly projection_count: number;
  readonly projection_digest: string;
  readonly assertion_schema_generation: string;
  readonly assertion_event_contract_generation: string;
  readonly projection_schema_generation: string;
  readonly projection_policy_id: string;
  readonly projection_policy_sha256: string;
}>;

export function isCompatibleProjectionIdentity(
  left: ProjectionIdentity,
  right: ProjectionIdentity
): boolean {
  if (left.projection_count !== right.projection_count) return false;
  if (!hasMatchingProjectionMetadata(left, right)) return false;
  if (left.projection_digest === right.projection_digest) return true;
  return left.projection_count === 0 &&
    isEmptyProjectionDigest(left.projection_digest) &&
    isEmptyProjectionDigest(right.projection_digest);
}

function hasMatchingProjectionMetadata(
  left: ProjectionIdentity,
  right: ProjectionIdentity
): boolean {
  return left.assertion_schema_generation === right.assertion_schema_generation &&
    left.assertion_event_contract_generation === right.assertion_event_contract_generation &&
    left.projection_schema_generation === right.projection_schema_generation &&
    left.projection_policy_id === right.projection_policy_id &&
    left.projection_policy_sha256 === right.projection_policy_sha256;
}

function isEmptyProjectionDigest(digest: string): boolean {
  return digest === emptyBytesSha256() || digest === emptyJsonArraySha256();
}
