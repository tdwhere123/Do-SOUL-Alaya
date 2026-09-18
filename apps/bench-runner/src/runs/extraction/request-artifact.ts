import {
  AlayaError, SOURCE_SEMANTIC_CACHE_CONTRACT, SOURCE_SEMANTIC_ENVELOPE_SCHEMA_VERSION,
  SOURCE_SEMANTIC_K_VERSION, SOURCE_SEMANTIC_NORMALIZER_VERSION, SOURCE_SEMANTIC_PACKET_CONTRACT,
  SOURCE_SEMANTIC_RESPONSE_CONTRACT, type SourceInterpretationProfile
} from "@do-soul/alaya-protocol";
import type { ExtractionSourcePacking } from "@do-soul/alaya-protocol";
import {
  OFFICIAL_API_SYSTEM_PROMPT, OFFICIAL_API_SOURCE_PACKET_SYSTEM_PROMPT, SOURCE_SEMANTIC_SYSTEM_PROMPT,
  buildOfficialApiSourceCorpus, collectOfficialApiExtractionCoverage, buildOfficialApiSourcePacketRequest,
  buildSourceSemanticRequest, stringifyOfficialApiExtractionRequest, type OfficialApiExtractionRequest,
  type OfficialApiSourcePacketRequest, type SourceSemanticRequest
} from "@do-soul/alaya-soul";
import type { LongMemEvalExtractionTurn } from "./turn-contents.js";

export const SOURCE_SEMANTIC_BATCH_PRODUCER_ID = "official-api-source-semantic";
export const SOURCE_SEMANTIC_BATCH_PRODUCER_VERSION = "1";

export type ExtractionOpenSemanticsGeneration = Readonly<{
  contract: typeof SOURCE_SEMANTIC_PACKET_CONTRACT;
  k_version: typeof SOURCE_SEMANTIC_K_VERSION;
  normalizer_version: typeof SOURCE_SEMANTIC_NORMALIZER_VERSION;
  envelope_schema_version: typeof SOURCE_SEMANTIC_ENVELOPE_SCHEMA_VERSION;
  response_contract: typeof SOURCE_SEMANTIC_RESPONSE_CONTRACT;
  cache_contract: typeof SOURCE_SEMANTIC_CACHE_CONTRACT;
}>;

export const EXTRACTION_OPEN_SEMANTICS_GENERATION: ExtractionOpenSemanticsGeneration = Object.freeze({
  contract: SOURCE_SEMANTIC_PACKET_CONTRACT,
  k_version: SOURCE_SEMANTIC_K_VERSION,
  normalizer_version: SOURCE_SEMANTIC_NORMALIZER_VERSION,
  envelope_schema_version: SOURCE_SEMANTIC_ENVELOPE_SCHEMA_VERSION,
  response_contract: SOURCE_SEMANTIC_RESPONSE_CONTRACT,
  cache_contract: SOURCE_SEMANTIC_CACHE_CONTRACT
});

export type ExtractionTypedArtifactMode = "source_packet" | "open_semantics";

export type ExtractionGenerationInput = Readonly<{
  sourceInterpretationProfile?: SourceInterpretationProfile;
  openSemantics?: ExtractionOpenSemanticsGeneration;
}>;

export function assertExclusiveExtractionGeneration(input: ExtractionGenerationInput): void {
  if (input.sourceInterpretationProfile !== undefined && input.openSemantics !== undefined) {
    throw new AlayaError("VALIDATION", "open semantics and packet profile are mutually exclusive");
  }
}

export function extractionTypedArtifactMode(input: ExtractionGenerationInput): ExtractionTypedArtifactMode | undefined {
  assertExclusiveExtractionGeneration(input);
  if (input.openSemantics !== undefined) return "open_semantics";
  if (input.sourceInterpretationProfile !== undefined) return "source_packet";
  return undefined;
}

export function extractionArtifactPrompt(
  profile?: SourceInterpretationProfile,
  openSemantics?: ExtractionOpenSemanticsGeneration
): string {
  assertExclusiveExtractionGeneration({ sourceInterpretationProfile: profile, openSemantics });
  if (openSemantics !== undefined) return SOURCE_SEMANTIC_SYSTEM_PROMPT;
  return profile === undefined ? OFFICIAL_API_SYSTEM_PROMPT : OFFICIAL_API_SOURCE_PACKET_SYSTEM_PROMPT;
}

/** Packing and source membership remain owned by the existing source request catalog. */
export function extractionArtifactRequests(turn: Pick<LongMemEvalExtractionTurn, "turnContent"> &
  Partial<Pick<LongMemEvalExtractionTurn, "turnMessages">>, packing?: ExtractionSourcePacking,
  profile?: SourceInterpretationProfile, openSemantics?: ExtractionOpenSemanticsGeneration): readonly Readonly<{
    source: OfficialApiExtractionRequest; packet?: OfficialApiSourcePacketRequest;
    semantic?: SourceSemanticRequest; userPrompt: string;
  }>[] {
  assertExclusiveExtractionGeneration({ sourceInterpretationProfile: profile, openSemantics });
  return collectOfficialApiExtractionCoverage(turn.turnContent, turn.turnMessages ?? [], packing).requests.map((source) => {
    if (openSemantics !== undefined) {
      const semantic = buildSourceSemanticRequest({
        sourceCorpus: buildOfficialApiSourceCorpus(turn.turnContent, turn.turnMessages ?? []),
        assertionIds: source.source_assertions.map((row) => row.assertion_id),
        source_id: "unbound", source_version: "unbound",
        producer_id: SOURCE_SEMANTIC_BATCH_PRODUCER_ID,
        producer_version: SOURCE_SEMANTIC_BATCH_PRODUCER_VERSION
      });
      return { source, semantic, userPrompt: JSON.stringify(semantic) };
    }
    if (profile === undefined) return { source, userPrompt: stringifyOfficialApiExtractionRequest(source) };
    const packet = buildOfficialApiSourcePacketRequest(buildOfficialApiSourceCorpus(turn.turnContent, turn.turnMessages ?? []),
      source.source_assertions.map((row) => row.assertion_id), profile);
    return { source, packet, userPrompt: JSON.stringify(packet) };
  });
}
