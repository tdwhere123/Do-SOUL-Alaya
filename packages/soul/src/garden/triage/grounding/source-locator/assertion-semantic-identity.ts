import { createHash } from "node:crypto";
import {
  hasUnresolvedReference,
  isLocallyClosedAtomicAssertion
} from "../source-assertion/reference-closure.js";
import { OFFICIAL_API_SOURCE_LOCATOR_CONTRACT_VERSION } from "./assertion-catalog.js";
import type { SourceConversationRole } from "../source-role/marker.js";

export const ASSERTION_SEMANTIC_IDENTITY_CONTRACT_ID =
  "alaya.assertion_semantic_identity.v1";
export const ASSERTION_SEMANTIC_IDENTITY_CONTRACT_VERSION = 1;

export type AssertionTrustedRole = SourceConversationRole;

export interface AssertionSemanticIdentityInput {
  readonly formationContractVersion: number;
  readonly exactText: string;
  readonly trustedRole: AssertionTrustedRole;
  readonly semanticContext: string;
}

export interface AssertionCatalogLocatorBinding {
  readonly contract_version: number;
  readonly kind: "assertion_catalog";
  readonly assertion_id: number;
  readonly start: number;
  readonly end: number;
}

export interface AssertionSourceBinding {
  readonly semanticKey: string;
  readonly sourceCorpusIdentity: string;
  readonly sourceTextDigest: string;
  readonly locator: AssertionCatalogLocatorBinding;
  readonly datasetRevision?: string;
}

export function resolveAssertionSemanticContext(
  exactText: string,
  enclosingSentence: string
): string {
  if (exactText.length === 0) {
    throw new TypeError("assertion semantic identity requires exact text");
  }
  if (!enclosingSentence.includes(exactText)) {
    throw new TypeError(
      "semantic context sentence must contain the exact assertion text"
    );
  }
  if (isLocallyClosedAtomicAssertion(exactText) && !hasUnresolvedReference(exactText)) {
    return "";
  }
  return enclosingSentence;
}

export function computeAssertionSemanticKey(
  input: AssertionSemanticIdentityInput
): string {
  if (input.exactText.length === 0) {
    throw new TypeError("assertion semantic identity requires exact text");
  }
  if (!Number.isInteger(input.formationContractVersion) ||
      input.formationContractVersion < 1) {
    throw new TypeError("formation contract version must be a positive integer");
  }
  if (input.trustedRole !== "user" && input.trustedRole !== "assistant") {
    throw new TypeError("trusted role must be user or assistant");
  }
  return createHash("sha256")
    .update(ASSERTION_SEMANTIC_IDENTITY_CONTRACT_ID, "utf8")
    .update("\u0000", "utf8")
    .update(String(ASSERTION_SEMANTIC_IDENTITY_CONTRACT_VERSION), "utf8")
    .update("\u0000", "utf8")
    .update(String(input.formationContractVersion), "utf8")
    .update("\u0000", "utf8")
    .update(input.exactText, "utf8")
    .update("\u0000", "utf8")
    .update(input.trustedRole, "utf8")
    .update("\u0000", "utf8")
    .update(input.semanticContext, "utf8")
    .digest("hex");
}

export function bindAssertionSource(input: {
  readonly semanticKey: string;
  readonly sourceCorpusIdentity: string;
  readonly sourceTextDigest: string;
  readonly locator: Omit<AssertionCatalogLocatorBinding, "kind" | "contract_version"> &
    Partial<Pick<AssertionCatalogLocatorBinding, "kind" | "contract_version">>;
  readonly datasetRevision?: string;
}): AssertionSourceBinding {
  if (!/^[a-f0-9]{64}$/u.test(input.semanticKey) ||
      !/^[a-f0-9]{64}$/u.test(input.sourceCorpusIdentity) ||
      !/^[a-f0-9]{64}$/u.test(input.sourceTextDigest)) {
    throw new TypeError("assertion source binding digests must be sha256 hex");
  }
  if (!Number.isInteger(input.locator.assertion_id) || input.locator.assertion_id < 1) {
    throw new TypeError("assertion_id must be a positive integer");
  }
  if (!Number.isInteger(input.locator.start) || !Number.isInteger(input.locator.end) ||
      input.locator.start < 0 || input.locator.end <= input.locator.start) {
    throw new TypeError("assertion span must be a half-open [start, end) range");
  }
  const binding: AssertionSourceBinding = {
    semanticKey: input.semanticKey,
    sourceCorpusIdentity: input.sourceCorpusIdentity,
    sourceTextDigest: input.sourceTextDigest,
    locator: {
      contract_version: input.locator.contract_version ??
        OFFICIAL_API_SOURCE_LOCATOR_CONTRACT_VERSION,
      kind: "assertion_catalog",
      assertion_id: input.locator.assertion_id,
      start: input.locator.start,
      end: input.locator.end
    },
    ...(input.datasetRevision === undefined ? {} : { datasetRevision: input.datasetRevision })
  };
  return Object.freeze(binding);
}

export function digestSourceText(sourceText: string): string {
  return createHash("sha256").update(sourceText, "utf8").digest("hex");
}
