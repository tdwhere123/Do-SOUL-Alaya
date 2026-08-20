export const VERIFIED_USER_ASSERTION_SOURCE_HASH_PREFIX =
  "sha256:garden-verified-user-assertion-v1:";
export const VERIFIED_USER_ASSERTION_SOURCE_HASH_V2_PREFIX =
  "sha256:garden-verified-user-assertion-v2:";

const SHA256_DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const FORBIDDEN_CORPUS_SEPARATOR_PATTERN = /[\r\n\u2028\u2029]/u;
const USER_CORPUS_PREFIX = "User: ";

export interface VerifiedUserAssertionReceiptInput {
  readonly workspace_id: string;
  readonly run_id: string;
  readonly surface_id: string | null;
  readonly source_assertion: string;
  readonly source_corpus: string;
}

export interface VerifiedUserAssertionCatalogLocator {
  readonly contract_version: 2;
  readonly kind: "assertion_catalog";
  readonly assertion_id: number;
}

export interface VerifiedUserAssertionReceiptV2Input
  extends VerifiedUserAssertionReceiptInput {
  readonly signal_id: string;
  readonly source_locator: VerifiedUserAssertionCatalogLocator;
}

export interface ParsedVerifiedUserAssertionSourceHash {
  readonly version: 1 | 2;
  readonly digest: string;
}

export type VerifiedUserAssertionSha256 = (preimage: string) => string;

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

export function buildVerifiedUserAssertionReceiptV2Preimage(
  input: Readonly<VerifiedUserAssertionReceiptV2Input>
): string {
  return JSON.stringify({
    version: 2,
    receipt_kind: "garden_verified_user_assertion_v2",
    source_role: "user",
    signal_id: input.signal_id,
    source_locator: {
      contract_version: input.source_locator.contract_version,
      kind: input.source_locator.kind,
      assertion_id: input.source_locator.assertion_id
    },
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

export function formatVerifiedUserAssertionV2SourceHash(digest: string): string {
  return `${VERIFIED_USER_ASSERTION_SOURCE_HASH_V2_PREFIX}${digest}`;
}

export function readVerifiedUserAssertionSourceHashDigest(
  value: string | null
): string | null {
  if (value?.startsWith(VERIFIED_USER_ASSERTION_SOURCE_HASH_PREFIX) !== true) {
    return null;
  }
  const digest = value.slice(VERIFIED_USER_ASSERTION_SOURCE_HASH_PREFIX.length);
  return SHA256_DIGEST_PATTERN.test(digest) ? digest : null;
}

export function readVerifiedUserAssertionV2SourceHashDigest(
  value: string | null
): string | null {
  if (value?.startsWith(VERIFIED_USER_ASSERTION_SOURCE_HASH_V2_PREFIX) !== true) {
    return null;
  }
  const digest = value.slice(VERIFIED_USER_ASSERTION_SOURCE_HASH_V2_PREFIX.length);
  return SHA256_DIGEST_PATTERN.test(digest) ? digest : null;
}

export function parseVerifiedUserAssertionSourceHash(
  value: string | null
): ParsedVerifiedUserAssertionSourceHash | null {
  const v1Digest = readVerifiedUserAssertionSourceHashDigest(value);
  if (v1Digest !== null) return { version: 1, digest: v1Digest };
  const v2Digest = readVerifiedUserAssertionV2SourceHashDigest(value);
  return v2Digest === null ? null : { version: 2, digest: v2Digest };
}

export function parseVerifiedUserAssertionCatalogLocator(
  value: unknown
): VerifiedUserAssertionCatalogLocator | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const locator = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(locator);
  return keys.length === 3 &&
    locator.contract_version === 2 &&
    locator.kind === "assertion_catalog" &&
    Number.isInteger(locator.assertion_id) && Number(locator.assertion_id) > 0
      ? {
          contract_version: 2,
          kind: "assertion_catalog",
          assertion_id: Number(locator.assertion_id)
        }
      : null;
}

export function verifyVerifiedUserAssertionSourceHash(
  value: string | null,
  input: Readonly<VerifiedUserAssertionReceiptInput | VerifiedUserAssertionReceiptV2Input>,
  sha256: VerifiedUserAssertionSha256
): boolean {
  const parsed = parseVerifiedUserAssertionSourceHash(value);
  if (parsed === null || !hasCanonicalUserCorpus(input)) return false;
  const preimage = preimageForVersion(parsed.version, input);
  return preimage !== null && sha256(preimage) === parsed.digest;
}

export function verifyLegacyVerifiedUserAssertionV1SourceHash(
  value: string | null,
  input: Readonly<VerifiedUserAssertionReceiptInput>,
  sha256: VerifiedUserAssertionSha256
): boolean {
  const digest = readVerifiedUserAssertionSourceHashDigest(value);
  return digest !== null &&
    sha256(buildVerifiedUserAssertionReceiptPreimage(input)) === digest;
}

function hasCanonicalUserCorpus(
  input: Readonly<VerifiedUserAssertionReceiptInput>
): boolean {
  if (!input.source_corpus.startsWith(USER_CORPUS_PREFIX) ||
      FORBIDDEN_CORPUS_SEPARATOR_PATTERN.test(input.source_corpus) ||
      input.source_assertion.length === 0) {
    return false;
  }
  const content = input.source_corpus.slice(USER_CORPUS_PREFIX.length);
  const first = content.indexOf(input.source_assertion);
  return first >= 0 && content.indexOf(input.source_assertion, first + 1) < 0;
}

function preimageForVersion(
  version: 1 | 2,
  input: Readonly<VerifiedUserAssertionReceiptInput | VerifiedUserAssertionReceiptV2Input>
): string | null {
  if (version === 1) return buildVerifiedUserAssertionReceiptPreimage(input);
  return isVerifiedUserAssertionReceiptV2Input(input)
    ? buildVerifiedUserAssertionReceiptV2Preimage(input)
    : null;
}

function isVerifiedUserAssertionReceiptV2Input(
  input: Readonly<VerifiedUserAssertionReceiptInput | VerifiedUserAssertionReceiptV2Input>
): input is Readonly<VerifiedUserAssertionReceiptV2Input> {
  if (!("signal_id" in input) || typeof input.signal_id !== "string" ||
      !("source_locator" in input)) {
    return false;
  }
  return parseVerifiedUserAssertionCatalogLocator(input.source_locator) !== null;
}
