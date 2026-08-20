import { createHash } from "node:crypto";
import {
  buildVerifiedUserAssertionReceiptPreimage,
  buildVerifiedUserAssertionReceiptV2Preimage,
  formatVerifiedUserAssertionSourceHash,
  formatVerifiedUserAssertionV2SourceHash,
  parseVerifiedUserAssertionSourceHash,
  verifyLegacyVerifiedUserAssertionV1SourceHash,
  verifyVerifiedUserAssertionSourceHash
} from "@do-soul/alaya-protocol";
import {
  buildOfficialApiSourceCorpus,
  buildOfficialApiVerifiedUserAssertionSource,
  filterSourceAssertionEntities,
  parseOfficialApiSourceLocator,
  preferenceProfileGroundingRemovalReason,
  rebindOfficialApiSourceLocatorQuote,
  resolvePreferenceAwareSourceGrounding
} from "@do-soul/alaya-soul";
import type { BenchSignalSeedInput } from "../daemon/daemon-types.js";
import { omitGoldPrefixedFields } from "./compile-gold-fields.js";
import {
  compileSourceBoundSemanticFactorFields,
  omitCompileSemanticFactorFields
} from "./compile-semantic-factor.js";

export interface CompileSourceGroundingIdentity {
  readonly workspaceId: string;
  readonly runId: string;
  readonly signalId?: string;
}

export function attachCompileSourceGrounding(
  rawPayload: Readonly<Record<string, unknown>>,
  signalInput: BenchSignalSeedInput,
  identity?: Readonly<CompileSourceGroundingIdentity>
): Record<string, unknown> {
  return omitGoldPrefixedFields(compileAttachedSourceGrounding(
    rawPayload,
    signalInput,
    identity
  )) as Record<string, unknown>;
}

function compileAttachedSourceGrounding(
  rawPayload: Readonly<Record<string, unknown>>,
  signalInput: BenchSignalSeedInput,
  identity?: Readonly<CompileSourceGroundingIdentity>
): Record<string, unknown> {
  const replay = prepareCompileGroundingReplay(rawPayload, signalInput, identity);
  const rejectionReason = compileGroundingReplayRejectionReason(rawPayload, replay);
  if (rejectionReason !== null) {
    return rejectedPayload(
      replay.safePayload,
      replay.sourceCorpus,
      replay.proposal,
      rejectionReason
    );
  }
  const replayBinding = rebindVerifiedSourcePayload({
    safePayload: replay.safePayload,
    signalInput,
    proposal: replay.proposal,
    sourceCorpus: replay.sourceCorpus,
    cachedSourceCorpus: replay.cachedSourceCorpus,
    verifiedAssertion: replay.verifiedAssertion
  });
  if (replayBinding === null) {
    return rejectedPayload(
      replay.safePayload,
      replay.sourceCorpus,
      replay.proposal,
      "verified_source_assertion_mismatch"
    );
  }
  return groundCompileSourcePayload({
    safePayload: replayBinding.safePayload,
    signalInput,
    identity,
    proposal: replay.proposal,
    proposedMatch: replay.proposedMatch,
    sourceCorpus: replay.sourceCorpus,
    verifiedAssertion: replay.verifiedAssertion,
    persistedSourceCorpus: replayBinding.persistedSourceCorpus,
    persistedSourceLocator: replayBinding.persistedSourceLocator
  });
}

interface CompileGroundingPreparation {
  readonly proposal: ReturnType<typeof readProposal>;
  readonly safePayload: Readonly<Record<string, unknown>>;
  readonly proposedMatch: string;
  readonly sourceCorpus: string;
  readonly cachedSourceCorpus: string | null;
  readonly verifiedAssertion: string | null;
}

function prepareCompileGroundingReplay(
  rawPayload: Readonly<Record<string, unknown>>,
  signalInput: BenchSignalSeedInput,
  identity: Readonly<CompileSourceGroundingIdentity> | undefined
): CompileGroundingPreparation {
  const proposal = readProposal(rawPayload, signalInput);
  const sourceCorpus = signalInput.turnMessages === undefined
    ? signalInput.turnContent
    : buildOfficialApiSourceCorpus(signalInput.turnContent, signalInput.turnMessages);
  const cachedSourceCorpus = readCachedSourceCorpus(rawPayload.full_turn_content);
  return {
    proposal,
    safePayload: stripDerivedGrounding(rawPayload),
    proposedMatch: proposal.proposed_matched_text,
    sourceCorpus,
    cachedSourceCorpus,
    verifiedAssertion: readVerifiedCachedAssertion(
      rawPayload,
      signalInput,
      sourceCorpus,
      cachedSourceCorpus,
      identity
    )
  };
}

function compileGroundingReplayRejectionReason(
  rawPayload: Readonly<Record<string, unknown>>,
  replay: CompileGroundingPreparation
): string | null {
  if (replay.cachedSourceCorpus !== null &&
      replay.cachedSourceCorpus !== replay.sourceCorpus &&
      replay.verifiedAssertion === null) {
    return "cached_source_corpus_mismatch";
  }
  return Object.hasOwn(rawPayload, "verified_user_assertion_source_hash") &&
    replay.verifiedAssertion === null
    ? "verified_source_assertion_mismatch"
    : null;
}

function rebindVerifiedSourcePayload(input: Readonly<{
  readonly safePayload: Readonly<Record<string, unknown>>;
  readonly signalInput: BenchSignalSeedInput;
  readonly proposal: ReturnType<typeof readProposal>;
  readonly sourceCorpus: string;
  readonly cachedSourceCorpus: string | null;
  readonly verifiedAssertion: string | null;
}>): Readonly<{
  readonly safePayload: Readonly<Record<string, unknown>>;
  readonly persistedSourceCorpus: string | null;
  readonly persistedSourceLocator: unknown;
}> | null {
  if (input.verifiedAssertion === null) return {
    safePayload: input.safePayload,
    persistedSourceCorpus: null,
    persistedSourceLocator: null
  };
  if (input.safePayload.source_locator === undefined) return null;
  const cachedGrounding = resolvePreferenceAwareSourceGrounding({
    proposal: input.proposal.proposed_preference_profile,
    sourceCorpus: input.cachedSourceCorpus ?? input.sourceCorpus,
    proposedMatch: input.verifiedAssertion,
    sourceLocator: input.safePayload.source_locator
  });
  if (cachedGrounding.resolution.status !== "grounded" ||
      cachedGrounding.resolution.assertion !== input.verifiedAssertion) return null;
  const sourceLocator = rebindOfficialApiSourceLocatorQuote(
    input.sourceCorpus,
    input.verifiedAssertion
  );
  if (sourceLocator === null) return null;
  const persisted = buildOfficialApiVerifiedUserAssertionSource(
    input.signalInput.turnContent,
    input.signalInput.turnMessages ?? [],
    sourceLocator,
    input.verifiedAssertion
  );
  return persisted === null ? null : {
    safePayload: { ...input.safePayload, source_locator: sourceLocator },
    persistedSourceCorpus: persisted.source_corpus,
    persistedSourceLocator: persisted.source_locator
  };
}

interface CompileGroundingReplayInput {
  readonly safePayload: Readonly<Record<string, unknown>>;
  readonly signalInput: BenchSignalSeedInput;
  readonly identity: Readonly<CompileSourceGroundingIdentity> | undefined;
  readonly proposal: ReturnType<typeof readProposal>;
  readonly proposedMatch: string;
  readonly sourceCorpus: string;
  readonly verifiedAssertion: string | null;
  readonly persistedSourceCorpus: string | null;
  readonly persistedSourceLocator: unknown;
}

function groundCompileSourcePayload(input: CompileGroundingReplayInput): Record<string, unknown> {
  const grounding = resolvePreferenceAwareSourceGrounding({
    proposal: input.proposal.proposed_preference_profile,
    sourceCorpus: input.sourceCorpus,
    proposedMatch: input.verifiedAssertion ?? input.proposedMatch,
    ...(input.safePayload.source_locator === undefined
      ? {}
      : { sourceLocator: input.safePayload.source_locator })
  });
  const resolution = grounding.resolution;
  if (resolution.status === "rejected") {
    return rejectedPayload(
      input.safePayload,
      input.sourceCorpus,
      input.proposal,
      resolution.reason
    );
  }
  if (input.verifiedAssertion !== null && resolution.assertion !== input.verifiedAssertion) {
    return rejectedPayload(
      input.safePayload,
      input.sourceCorpus,
      input.proposal,
      "verified_source_assertion_mismatch"
    );
  }
  return buildGroundedCompilePayload(input, resolution.assertion, grounding.preferenceProfile);
}

function buildGroundedCompilePayload(
  input: CompileGroundingReplayInput,
  assertion: string,
  groundedPreferenceProfile: unknown
): Record<string, unknown> {
  const canonicalEntities = input.proposal.proposed_canonical_entities;
  const groundedCanonicalEntities = Array.isArray(canonicalEntities)
    ? filterSourceAssertionEntities(
      canonicalEntities.filter((entity): entity is string => typeof entity === "string"),
      assertion
    )
    : [];
  return {
    ...omitCompileSemanticFactorFields(input.safePayload),
    ...(input.verifiedAssertion === null || input.identity === undefined
      ? {}
      : {
        verified_user_assertion_source_hash: verifiedAssertionSourceHash({
          identity: input.identity,
          surfaceId: input.signalInput.surfaceId ?? null,
          assertion,
          sourceCorpus: input.persistedSourceCorpus ?? input.sourceCorpus,
          sourceLocator: input.persistedSourceLocator
        })
      }),
    ...(input.persistedSourceLocator === null
      ? {}
      : { source_locator: input.persistedSourceLocator }),
    matched_text: assertion,
    distilled_fact: assertion,
    full_turn_content: input.persistedSourceCorpus ?? input.sourceCorpus,
    source_assertion: assertion,
    ...(groundedCanonicalEntities.length === 0 ? {} : { canonical_entities: groundedCanonicalEntities }),
    ...(groundedPreferenceProfile === undefined ? {} : { preference_profile: groundedPreferenceProfile }),
    proposed_matched_text: input.proposedMatch,
    source_grounding: {
      ...input.proposal,
      status: "grounded",
      content_basis: "source_assertion",
      source_assertion: assertion,
      reasons: groundingReasons(
        input.proposedMatch,
        assertion,
        input.proposal.proposed_canonical_entities,
        input.proposal.proposed_preference_profile,
        groundedPreferenceProfile
      )
    },
    ...compileSourceBoundSemanticFactorFields(input.safePayload, assertion)
  };
}

function readVerifiedCachedAssertion(
  rawPayload: Readonly<Record<string, unknown>>,
  signalInput: BenchSignalSeedInput,
  sourceCorpus: string,
  cachedSourceCorpus: string | null,
  identity: Readonly<CompileSourceGroundingIdentity> | undefined
): string | null {
  if (identity === undefined) return null;
  const sourceHash = readString(rawPayload.verified_user_assertion_source_hash);
  const parsedReceipt = parseVerifiedUserAssertionSourceHash(sourceHash);
  const priorGrounding = isRecord(rawPayload.source_grounding)
    ? rawPayload.source_grounding
    : {};
  const assertion = readString(rawPayload.source_assertion) ??
    readString(priorGrounding.source_assertion);
  if (parsedReceipt === null || assertion === null || !sourceCorpus.includes(assertion)) {
    return null;
  }
  const receiptCorpora = [sourceCorpus, cachedSourceCorpus]
    .filter((corpus): corpus is string => corpus !== null && corpus.includes(assertion));
  if (parsedReceipt.version === 1) {
    return receiptCorpora.some((corpus) => verifyLegacyVerifiedUserAssertionV1SourceHash(
      sourceHash,
      {
        workspace_id: identity.workspaceId,
        run_id: identity.runId,
        surface_id: signalInput.surfaceId ?? null,
        source_assertion: assertion,
        source_corpus: corpus
      },
      sha256
    )) ? assertion : null;
  }
  const sourceLocator = parseOfficialApiSourceLocator(rawPayload.source_locator);
  if (signalInput.productionSignalId === undefined || sourceLocator === null ||
      cachedSourceCorpus === null) return null;
  return verifyVerifiedUserAssertionSourceHash(sourceHash, {
    signal_id: signalInput.productionSignalId,
    source_locator: sourceLocator,
    workspace_id: identity.workspaceId,
    run_id: identity.runId,
    surface_id: signalInput.surfaceId ?? null,
    source_assertion: assertion,
    source_corpus: cachedSourceCorpus
  }, sha256) ? assertion : null;
}

function verifiedAssertionSourceHash(input: Readonly<{
  readonly identity: CompileSourceGroundingIdentity;
  readonly surfaceId: string | null;
  readonly assertion: string;
  readonly sourceCorpus: string;
  readonly sourceLocator: unknown;
}>): string {
  const sourceLocator = parseOfficialApiSourceLocator(input.sourceLocator);
  if (input.identity.signalId !== undefined && sourceLocator !== null) {
    const digest = sha256(buildVerifiedUserAssertionReceiptV2Preimage({
      signal_id: input.identity.signalId,
      source_locator: sourceLocator,
      workspace_id: input.identity.workspaceId,
      run_id: input.identity.runId,
      surface_id: input.surfaceId,
      source_assertion: input.assertion,
      source_corpus: input.sourceCorpus
    }));
    return formatVerifiedUserAssertionV2SourceHash(digest);
  }
  return formatVerifiedUserAssertionSourceHash(receiptDigestFor(input));
}

function receiptDigestFor(input: Readonly<{
  readonly identity: CompileSourceGroundingIdentity;
  readonly surfaceId: string | null;
  readonly assertion: string;
  readonly sourceCorpus: string;
}>): string {
  return createHash("sha256").update(buildVerifiedUserAssertionReceiptPreimage({
    workspace_id: input.identity.workspaceId,
    run_id: input.identity.runId,
    surface_id: input.surfaceId,
    source_assertion: input.assertion,
    source_corpus: input.sourceCorpus
  }), "utf8").digest("hex");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function readProposal(
  rawPayload: Readonly<Record<string, unknown>>,
  signalInput: BenchSignalSeedInput
): Record<string, unknown> & { readonly proposed_matched_text: string } {
  const prior = isRecord(rawPayload.source_grounding) ? rawPayload.source_grounding : {};
  const proposedMatch = readString(prior.proposed_matched_text) ??
    readString(rawPayload.proposed_matched_text) ?? readString(rawPayload.matched_text) ??
    signalInput.matchedText?.trim() ?? signalInput.distilledFact.trim();
  const distilled = readString(prior.proposed_distilled_fact) ?? readString(rawPayload.distilled_fact);
  return {
    version: 1,
    proposed_matched_text: proposedMatch,
    ...(distilled === null ? {} : { proposed_distilled_fact: distilled }),
    ...proposalField(prior, rawPayload, "proposed_canonical_entities", "canonical_entities"),
    ...proposalField(prior, rawPayload, "proposed_preference_profile", "preference_profile")
  };
}

function proposalField(
  prior: Readonly<Record<string, unknown>>,
  raw: Readonly<Record<string, unknown>>,
  proposedKey: string,
  rawKey: string
): Record<string, unknown> {
  const value = prior[proposedKey] ?? raw[rawKey];
  return value === undefined ? {} : { [proposedKey]: value };
}

function stripDerivedGrounding(raw: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const safe = { ...raw };
  for (const key of [
    "matched_text", "distilled_fact", "canonical_entities", "preference_profile",
    "source_assertion", "source_grounding", "proposed_matched_text", "proposed_distilled_fact",
    "proposed_canonical_entities", "proposed_preference_profile"
  ]) delete safe[key];
  return safe;
}

function rejectedPayload(
  safePayload: Readonly<Record<string, unknown>>,
  sourceCorpus: string,
  proposal: Readonly<Record<string, unknown>>,
  reason: string
): Record<string, unknown> {
  return {
    ...omitCompileSemanticFactorFields(safePayload),
    full_turn_content: sourceCorpus,
    proposed_matched_text: proposal.proposed_matched_text,
    source_grounding: { ...proposal, status: "rejected", content_basis: "none", reasons: [reason] },
    ...compileSourceBoundSemanticFactorFields(safePayload, null)
  };
}

function groundingReasons(
  proposedMatch: string,
  assertion: string,
  canonicalEntities: unknown,
  preferenceProfile: unknown,
  groundedPreferenceProfile: unknown
): readonly string[] {
  const reasons: string[] = [];
  if (proposedMatch !== assertion) reasons.push("matched_text_expanded_to_source_assertion");
  if (canonicalEntities !== undefined) reasons.push("unverified_canonical_entities_removed");
  const profileReason = preferenceProfileGroundingRemovalReason(
    preferenceProfile,
    groundedPreferenceProfile
  );
  if (profileReason !== undefined) reasons.push(profileReason);
  return reasons;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readCachedSourceCorpus(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
