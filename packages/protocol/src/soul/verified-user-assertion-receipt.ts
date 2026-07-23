export const VERIFIED_USER_ASSERTION_SOURCE_HASH_PREFIX =
  "sha256:garden-verified-user-assertion-v1:";

export interface VerifiedUserAssertionReceiptInput {
  readonly workspace_id: string;
  readonly run_id: string;
  readonly surface_id: string | null;
  readonly source_assertion: string;
  readonly source_corpus: string;
}

export function buildVerifiedUserAssertionReceiptPreimage(
  input: Readonly<VerifiedUserAssertionReceiptInput>
): string {
  return JSON.stringify({
    version: 1,
    receipt_kind: "garden_verified_user_assertion_v1",
    source_role: "user",
    workspace_id: input.workspace_id,
    run_id: input.run_id,
    surface_id: input.surface_id,
    source_assertion: input.source_assertion,
    source_corpus: input.source_corpus
  });
}

export function formatVerifiedUserAssertionSourceHash(digest: string): string {
  return `${VERIFIED_USER_ASSERTION_SOURCE_HASH_PREFIX}${digest}`;
}

export function readVerifiedUserAssertionSourceHashDigest(
  value: string | null
): string | null {
  if (value?.startsWith(VERIFIED_USER_ASSERTION_SOURCE_HASH_PREFIX) !== true) {
    return null;
  }
  const digest = value.slice(VERIFIED_USER_ASSERTION_SOURCE_HASH_PREFIX.length);
  return /^[a-f0-9]{64}$/u.test(digest) ? digest : null;
}
