export type ProjectionIdentity = Readonly<{
  readonly projection_count: number;
  readonly projection_digest: string;
  readonly assertion_schema_generation: string;
  readonly assertion_event_contract_generation: string;
  readonly projection_schema_generation: string;
  readonly projection_policy_id: string;
  readonly projection_policy_sha256: string;
}>;

const BOOTSTRAP_EMPTY_PROJECTION_DIGEST =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const CORE_EMPTY_PROJECTION_DIGEST =
  "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";

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
  return digest === BOOTSTRAP_EMPTY_PROJECTION_DIGEST ||
    digest === CORE_EMPTY_PROJECTION_DIGEST;
}
