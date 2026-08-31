import { createHash } from "node:crypto";
import {
  parseVerifiedUserAssertionCatalogLocator,
  parseVerifiedUserAssertionSourceHash,
  verifyVerifiedUserAssertionSourceHash,
  type CandidateMemorySignal,
  type EvidenceCapsule
} from "@do-soul/alaya-protocol";
import type { VerifiedAssertionLocatorResolver } from "../../evidence-recall-types.js";

export function matchesVerifiedAssertionReceipt(input: Readonly<{
  readonly capsule: Readonly<EvidenceCapsule>;
  readonly signalId: string | null;
  readonly signal: Readonly<CandidateMemorySignal>;
  readonly resolveAssertionLocator: VerifiedAssertionLocatorResolver | undefined;
}>): boolean {
  const raw = input.signal.raw_payload;
  const assertion = readString(raw.source_assertion);
  const corpus = readString(raw.full_turn_content);
  const sourceHash = readString(raw.verified_user_assertion_source_hash);
  if (!matchesStoredIdentity(input, assertion, corpus, sourceHash)) return false;
  const receiptInput = {
    workspace_id: input.signal.workspace_id,
    run_id: input.signal.run_id,
    surface_id: input.signal.surface_id,
    source_assertion: assertion!,
    source_corpus: corpus!
  };
  if (parseVerifiedUserAssertionSourceHash(sourceHash)?.version === 1) {
    return verifyVerifiedUserAssertionSourceHash(sourceHash, receiptInput, sha256);
  }
  const locator = parseVerifiedUserAssertionCatalogLocator(raw.source_locator);
  return locator !== null && input.resolveAssertionLocator?.({
    sourceCorpus: corpus!,
    sourceAssertion: assertion!,
    sourceLocator: locator
  }) === true && verifyVerifiedUserAssertionSourceHash(
    sourceHash,
    { ...receiptInput, signal_id: input.signal.signal_id, source_locator: locator },
    sha256
  );
}

function matchesStoredIdentity(
  input: Readonly<{
    readonly capsule: Readonly<EvidenceCapsule>;
    readonly signalId: string | null;
    readonly signal: Readonly<CandidateMemorySignal>;
  }>,
  assertion: string | null,
  corpus: string | null,
  sourceHash: string | null
): boolean {
  return input.signalId !== null && assertion !== null && corpus !== null &&
    sourceHash !== null && sourceHash === input.capsule.source_hash &&
    input.signal.signal_id === input.signalId &&
    input.signal.workspace_id === input.capsule.workspace_id &&
    input.signal.run_id === input.capsule.run_id &&
    input.signal.surface_id === input.capsule.surface_id &&
    assertion === input.capsule.excerpt && corpus === input.capsule.gist;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
