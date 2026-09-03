import { createHash } from "node:crypto";
import {
  hasUnresolvedReference,
  isLocallyClosedAtomicAssertion
} from "../source-assertion/reference-closure.js";
import { OFFICIAL_API_SOURCE_LOCATOR_CONTRACT_VERSION } from "./assertion-catalog.js";
import type { SourceConversationRole } from "../source-role/marker.js";

export const ASSERTION_SEMANTIC_IDENTITY_CONTRACT_ID =
  "alaya.assertion_semantic_identity.v2";
export const ASSERTION_SEMANTIC_IDENTITY_CONTRACT_VERSION = 2;
export const ASSERTION_ANTECEDENT_WINDOW_CODE_UNITS = 512;

export type AssertionTrustedRole = SourceConversationRole;

export interface AssertionSemanticIdentityInput {
  readonly formationContractVersion: number;
  readonly exactText: string;
  readonly trustedRole: AssertionTrustedRole;
  readonly semanticContext: string;
}

export interface AssertionSemanticIdentityWitness extends AssertionSemanticIdentityInput {
  readonly contractId: typeof ASSERTION_SEMANTIC_IDENTITY_CONTRACT_ID;
  readonly contractVersion: typeof ASSERTION_SEMANTIC_IDENTITY_CONTRACT_VERSION;
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
  readonly assertionTextDigest: string;
  readonly occurrenceIdentity: string;
  readonly locator: AssertionCatalogLocatorBinding;
  readonly datasetRevision?: string;
}

export function resolveAssertionSemanticContext(
  exactText: string,
  enclosingSentence: string,
  antecedentWindow = ""
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
  const boundedAntecedent = antecedentWindow.slice(-ASSERTION_ANTECEDENT_WINDOW_CODE_UNITS);
  return JSON.stringify({ version: 1, antecedent: boundedAntecedent, sentence: enclosingSentence });
}

export function createAssertionSemanticIdentityWitness(
  input: AssertionSemanticIdentityInput
): AssertionSemanticIdentityWitness {
  return Object.freeze({
    contractId: ASSERTION_SEMANTIC_IDENTITY_CONTRACT_ID,
    contractVersion: ASSERTION_SEMANTIC_IDENTITY_CONTRACT_VERSION,
    ...input
  });
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
  readonly assertionTextDigest: string;
  readonly occurrenceIdentity: string;
  readonly locator: Omit<AssertionCatalogLocatorBinding, "kind" | "contract_version"> &
    Partial<Pick<AssertionCatalogLocatorBinding, "kind" | "contract_version">>;
  readonly datasetRevision?: string;
}): AssertionSourceBinding {
  if (!/^[a-f0-9]{64}$/u.test(input.semanticKey) ||
      !/^[a-f0-9]{64}$/u.test(input.sourceCorpusIdentity) ||
      !/^[a-f0-9]{64}$/u.test(input.sourceTextDigest) ||
      !/^[a-f0-9]{64}$/u.test(input.assertionTextDigest) ||
      !/^[a-f0-9]{64}$/u.test(input.occurrenceIdentity)) {
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
    assertionTextDigest: input.assertionTextDigest,
    occurrenceIdentity: input.occurrenceIdentity,
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

export function computeAssertionOccurrenceIdentity(input: {
  readonly sourceCorpusIdentity: string;
  readonly assertionId: number;
  readonly start: number;
  readonly end: number;
  readonly messageIds?: readonly (string | null | undefined)[];
}): string {
  if (!/^[a-f0-9]{64}$/u.test(input.sourceCorpusIdentity)) {
    throw new TypeError("assertion source binding digests must be sha256 hex");
  }
  if (!Number.isInteger(input.assertionId) || input.assertionId < 1) {
    throw new TypeError("assertion_id must be a positive integer");
  }
  if (!Number.isInteger(input.start) || !Number.isInteger(input.end) ||
      input.start < 0 || input.end <= input.start) {
    throw new TypeError("assertion span must be a half-open [start, end) range");
  }
  const messageIds = (input.messageIds ?? []).map((id) => typeof id === "string" ? id : "");
  const hash = createHash("sha256")
    .update("alaya.assertion_occurrence.v1", "utf8")
    .update("\u0000", "utf8")
    .update(input.sourceCorpusIdentity, "utf8")
    .update("\u0000", "utf8")
    .update(String(input.assertionId), "utf8")
    .update("\u0000", "utf8")
    .update(String(input.start), "utf8")
    .update("\u0000", "utf8")
    .update(String(input.end), "utf8")
    .update("\u0000", "utf8")
    .update(String(messageIds.length), "utf8");
  for (const id of messageIds) {
    hash.update("\u0000", "utf8").update(id, "utf8");
  }
  return hash.digest("hex");
}

export function digestSourceText(sourceText: string): string {
  return createHash("sha256").update(sourceText, "utf8").digest("hex");
}
