import {
  AlayaError, SOURCE_SEMANTIC_CACHE_CONTRACT, SOURCE_SEMANTIC_ENVELOPE_SCHEMA_VERSION,
  SOURCE_SEMANTIC_K_VERSION, SOURCE_SEMANTIC_NORMALIZER_VERSION, SOURCE_SEMANTIC_PACKET_CONTRACT,
  SOURCE_SEMANTIC_RESPONSE_CONTRACT, canonicalJson, type SourceInterpretationProfile,
  type UtteranceAttribution
} from "@do-soul/alaya-protocol";
import type { ExtractionSourcePacking } from "@do-soul/alaya-protocol";
import {
  OFFICIAL_API_SYSTEM_PROMPT, OFFICIAL_API_SOURCE_PACKET_SYSTEM_PROMPT, SOURCE_SEMANTIC_SYSTEM_PROMPT,
  buildOfficialApiSourceCorpus, collectOfficialApiExtractionCoverage, buildOfficialApiSourcePacketRequest,
  prepareSourceSemanticRequest, collectSourceSemanticUnitPacks, stringifyOfficialApiExtractionRequest, type OfficialApiExtractionRequest,
  type OfficialApiSourcePacketRequest, type SourceSemanticRequest, type SourceSemanticHostPreparation,
  SourceSemanticRevisionSchema, sourceSemanticBaseRequestDigest, type SourceSemanticRevision,
  parseRetainedSourceSemanticRequest, retainedSourceSemanticSystemPrompt
} from "@do-soul/alaya-soul";
import type { LongMemEvalExtractionTurn } from "./turn-contents.js";
import { createHash } from "node:crypto";
import { computeCacheKey, computeRetainedCacheKey } from "../compile-seed/cache/cache-key.js";
import { z } from "zod";
import { parseSourceSemanticRequest, sourceSemanticSystemPrompt } from "@do-soul/alaya-soul";
import type { CompileSeedExtractionConfig } from "../compile-seed/compile-seed-types.js";

export const SOURCE_SEMANTIC_BATCH_PRODUCER_ID = "official-api-source-semantic";
export const SOURCE_SEMANTIC_BATCH_PRODUCER_VERSION = "1";

/** Logical source request identity shared by interactive and Batch transports. */
export interface SourceRequestLine {
  readonly key: string;
  readonly unitKeys: readonly string[];
  readonly requestSha256: string;
  readonly systemPrompt: string;
  readonly userPrompt: string;
}

export const SourceRequestLineSchema = z.object({
  key: z.string().regex(/^[a-f0-9]{64}$/u),
  unitKeys: z.array(z.string().min(1)).readonly(),
  requestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  systemPrompt: z.string().min(1),
  userPrompt: z.string().min(1)
}).strict().readonly();

/** Persisted logical descriptors rederive their identity from the owning request. */
export function parseSourceSemanticRequestLine(
  value: unknown, config: Pick<CompileSeedExtractionConfig, "model" | "requestProfile">
): SourceRequestLine {
  const line = SourceRequestLineSchema.parse(value);
  let request: SourceSemanticRequest;
  try { request = parseSourceSemanticRequest(JSON.parse(line.userPrompt)); }
  catch (cause) { throw new AlayaError("VALIDATION", "source semantic request line is malformed", { cause }); }
  const expected = prepareSourceSemanticRequestLine(request, line.unitKeys, config);
  if (canonicalJson(line) !== canonicalJson(expected)) {
    throw new AlayaError("CONFLICT", "source semantic request line identity mismatch");
  }
  return line;
}

/** Verifies a recorded logical identity without making that line dispatchable. */
export function verifyRetainedSourceSemanticRequestLine(
  value: unknown, config: Pick<CompileSeedExtractionConfig, "model" | "requestProfile">
) {
  const line = SourceRequestLineSchema.parse(value);
  const request = parseRetainedSourceSemanticRequest(JSON.parse(line.userPrompt));
  const userPrompt = JSON.stringify(request);
  const systemPrompt = retainedSourceSemanticSystemPrompt(request);
  const expected = { key: computeRetainedCacheKey(config.model, config.requestProfile, systemPrompt, userPrompt),
    unitKeys: line.unitKeys, requestSha256: createHash("sha256").update(userPrompt).digest("hex"), systemPrompt, userPrompt };
  if (canonicalJson(line) !== canonicalJson(expected)) {
    throw new AlayaError("CONFLICT", "retained source semantic request line identity mismatch");
  }
  return { eligibility: "retained_only" as const, line, request };
}

export function prepareSourceSemanticRequestLine(
  requestValue: SourceSemanticRequest,
  unitKeys: readonly string[],
  config: Pick<CompileSeedExtractionConfig, "model" | "requestProfile">
): SourceRequestLine {
  const request = parseSourceSemanticRequest(requestValue);
  const userPrompt = JSON.stringify(request);
  const systemPrompt = sourceSemanticSystemPrompt(request);
  return { key: computeCacheKey(config.model, config.requestProfile, systemPrompt, userPrompt), unitKeys,
    requestSha256: createHash("sha256").update(userPrompt).digest("hex"), systemPrompt, userPrompt };
}

export type ExtractionOpenSemanticsGeneration = Readonly<{
  contract: typeof SOURCE_SEMANTIC_PACKET_CONTRACT;
  k_version: typeof SOURCE_SEMANTIC_K_VERSION;
  normalizer_version: typeof SOURCE_SEMANTIC_NORMALIZER_VERSION;
  envelope_schema_version: typeof SOURCE_SEMANTIC_ENVELOPE_SCHEMA_VERSION;
  response_contract: typeof SOURCE_SEMANTIC_RESPONSE_CONTRACT;
  cache_contract: typeof SOURCE_SEMANTIC_CACHE_CONTRACT;
  revisions?: readonly SourceSemanticRevision[];
}>;

export const EXTRACTION_OPEN_SEMANTICS_GENERATION: ExtractionOpenSemanticsGeneration = Object.freeze({
  contract: SOURCE_SEMANTIC_PACKET_CONTRACT,
  k_version: SOURCE_SEMANTIC_K_VERSION,
  normalizer_version: SOURCE_SEMANTIC_NORMALIZER_VERSION,
  envelope_schema_version: SOURCE_SEMANTIC_ENVELOPE_SCHEMA_VERSION,
  response_contract: SOURCE_SEMANTIC_RESPONSE_CONTRACT,
  cache_contract: SOURCE_SEMANTIC_CACHE_CONTRACT
});

/** One generation owner for configuration, manifest replay and typed cache admission. */
export function parseExtractionOpenSemanticsGeneration(value: unknown): ExtractionOpenSemanticsGeneration {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new AlayaError("CONFLICT", "invalid open semantics generation");
  const { revisions, ...base } = value as Record<string, unknown>;
  if (canonicalJson(base) !== canonicalJson(EXTRACTION_OPEN_SEMANTICS_GENERATION)) {
    throw new AlayaError("CONFLICT", "open semantics generation differs from live K/normalizer/request/response identity");
  }
  if (revisions === undefined) return EXTRACTION_OPEN_SEMANTICS_GENERATION;
  if (!Array.isArray(revisions) || revisions.length === 0 || revisions.length > 256 ||
      Buffer.byteLength(JSON.stringify(revisions), "utf8") > 1_000_000) {
    throw new AlayaError("VALIDATION", "source revisions exceed their bounded registry");
  }
  const parsed = revisions.map((row) => SourceSemanticRevisionSchema.parse(row));
  if (new Set(parsed.map((row) => row.base_request_sha256)).size !== parsed.length) {
    throw new AlayaError("CONFLICT", "source revision registry repeats an original request");
  }
  return Object.freeze({ ...EXTRACTION_OPEN_SEMANTICS_GENERATION, revisions: Object.freeze(parsed) });
}

export type ExtractionTypedArtifactMode = "source_packet" | "open_semantics";

export type ExtractionGenerationInput = Readonly<{
  sourceInterpretationProfile?: SourceInterpretationProfile;
  openSemantics?: ExtractionOpenSemanticsGeneration;
  sourcePacking?: ExtractionSourcePacking;
}>;

export function assertExclusiveExtractionGeneration(input: ExtractionGenerationInput): void {
  if (input.sourceInterpretationProfile !== undefined && input.openSemantics !== undefined) {
    throw new AlayaError("VALIDATION", "open semantics and packet profile are mutually exclusive");
  }
  if (input.sourcePacking === "complete-source" && input.openSemantics === undefined) {
    throw new AlayaError("VALIDATION", "complete-source packing requires open semantics");
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

export type ExtractionArtifactSource = OfficialApiExtractionRequest | ReturnType<typeof collectSourceSemanticUnitPacks>[number];
export type SourceSemanticArtifactPreparation =
  | Readonly<{ status: "ready"; source: ReturnType<typeof collectSourceSemanticUnitPacks>[number];
      semantic: SourceSemanticRequest; userPrompt: string }>
  | Readonly<{ status: "unsupported_source"; source: ReturnType<typeof collectSourceSemanticUnitPacks>[number];
      disposition: Extract<SourceSemanticHostPreparation, { status: "unsupported_source" }> }>;

/** Each extraction generation owns its source membership and packing. */
export function extractionArtifactRequests(turn: Pick<LongMemEvalExtractionTurn, "turnContent"> &
  Partial<Pick<LongMemEvalExtractionTurn, "turnMessages">>, packing?: ExtractionSourcePacking,
  profile?: SourceInterpretationProfile, openSemantics?: ExtractionOpenSemanticsGeneration): readonly Readonly<{
    source: ExtractionArtifactSource; packet?: OfficialApiSourcePacketRequest;
    semantic?: SourceSemanticRequest; userPrompt: string;
  }>[] {
  assertExclusiveExtractionGeneration({ sourceInterpretationProfile: profile, openSemantics, sourcePacking: packing });
  if (openSemantics !== undefined) {
    return sourceSemanticArtifactRequests(buildOfficialApiSourceCorpus(turn.turnContent, turn.turnMessages ?? []), packing, openSemantics);
  }
  return collectOfficialApiExtractionCoverage(turn.turnContent, turn.turnMessages ?? [], packing).requests.map((source) => {
    if (profile === undefined) return { source, userPrompt: stringifyOfficialApiExtractionRequest(source) };
    const packet = buildOfficialApiSourcePacketRequest(buildOfficialApiSourceCorpus(turn.turnContent, turn.turnMessages ?? []),
      source.source_assertions.map((row) => row.assertion_id), profile);
    return { source, packet, userPrompt: JSON.stringify(packet) };
  });
}

/** Shared request construction for extraction turns and canonical source census records. */
export function sourceSemanticArtifactRequests(sourceCorpus: string, packing: ExtractionSourcePacking | undefined,
  openSemantics: ExtractionOpenSemanticsGeneration, attribution?: UtteranceAttribution): readonly Readonly<{
    source: ReturnType<typeof collectSourceSemanticUnitPacks>[number]; semantic: SourceSemanticRequest; userPrompt: string;
  }>[] {
  return sourceSemanticArtifactPreparations(sourceCorpus, packing, openSemantics, attribution).flatMap((item) =>
    item.status === "ready" ? [{ source: item.source, semantic: item.semantic, userPrompt: item.userPrompt }] : []);
}

/** The source inventory stays whole even when its interpretation has no legal request. */
export function sourceSemanticArtifactPreparations(sourceCorpus: string, packing: ExtractionSourcePacking | undefined,
  openSemantics: ExtractionOpenSemanticsGeneration,
  attribution?: UtteranceAttribution): readonly SourceSemanticArtifactPreparation[] {
  const generation = parseExtractionOpenSemanticsGeneration(openSemantics);
  return collectSourceSemanticUnitPacks(sourceCorpus, packing).map((source): SourceSemanticArtifactPreparation => {
    const proposal = {
      sourceCorpus,
      ...(source.source_scope === undefined ? {} : { sourceScope: source.source_scope }),
      assertionIds: source.source_assertions.map((row) => row.assertion_id),
      source_id: "unbound", source_version: "unbound",
      producer_id: SOURCE_SEMANTIC_BATCH_PRODUCER_ID,
      producer_version: SOURCE_SEMANTIC_BATCH_PRODUCER_VERSION,
      ...(attribution === undefined ? {} : { attribution_context: attribution })
    };
    const base = prepareSourceSemanticRequest(proposal);
    if (base.status === "unsupported_source") return { status: "unsupported_source", source, disposition: base };
    const revision = generation.revisions?.find((row) => row.base_request_sha256 === sourceSemanticBaseRequestDigest(base.request));
    const revised = revision === undefined ? base : prepareSourceSemanticRequest({ ...proposal, revision });
    if (revised.status !== "ready") throw new AlayaError("CONFLICT", "source revision changed host preparation capacity");
    return { status: "ready", source, semantic: revised.request, userPrompt: JSON.stringify(revised.request) };
  });
}
