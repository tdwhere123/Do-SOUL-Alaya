import { createHash } from "node:crypto";
import { z } from "zod";
import { AlayaError, canonicalJson, buildSourceReferenceCatalog, SourceReferenceCatalogSchema, SourceInterpretationProfileSchema, sourceInterpretationProfileIdentity,
  type SourceReferenceCatalog, type SourceInterpretationProfile } from "@do-soul/alaya-protocol";
import { buildOfficialApiSourceRequest, parseOfficialApiExtractionRequest,
  type OfficialApiExtractionRequest } from "./extraction-request.js";

const PacketRequestEnvelope = z.object({ schema_version: z.literal(3),
  interpretation_contract: z.literal("source-interpretation-v2"), source_request: z.unknown(),
  profile: SourceInterpretationProfileSchema, profile_id: z.string().min(1).max(256), source_catalog: SourceReferenceCatalogSchema }).strict();

export type OfficialApiSourcePacketRequest = Readonly<{
  schema_version: 3; interpretation_contract: "source-interpretation-v2";
  source_request: OfficialApiExtractionRequest; profile: SourceInterpretationProfile; profile_id: string;
  source_catalog: SourceReferenceCatalog;
}>;

export function parseOfficialApiSourcePacketRequest(value: unknown): OfficialApiSourcePacketRequest {
  const parsed = PacketRequestEnvelope.parse(value);
  const source_request = parseOfficialApiExtractionRequest(parsed.source_request);
  if (parsed.profile_id !== sourceInterpretationProfileIdentity(parsed.profile, packetSha256)) {
    throw new AlayaError("CONFLICT", "source packet request profile does not bind its vocabulary");
  }
  if (new Set(source_request.source_assertions.map((row) => row.assertion_id)).size !== source_request.source_assertions.length) {
    throw new AlayaError("VALIDATION", "source packet request has duplicate assertion identities");
  }
  const catalog = buildSourceReferenceCatalog(parsed.source_catalog.source_digest, source_request.source_assertions, packetSha256);
  if (canonicalJson(catalog) !== canonicalJson(parsed.source_catalog)) {
    throw new AlayaError("CONFLICT", "source packet request catalog mismatch");
  }
  if (Buffer.byteLength(JSON.stringify(parsed)) > 1_000_000) {
    throw new AlayaError("VALIDATION", "source packet request exceeds its byte bound");
  }
  return { ...parsed, source_request };
}

export function buildOfficialApiSourcePacketRequest(sourceCorpus: string, assertionIds: readonly number[],
  profile: SourceInterpretationProfile): OfficialApiSourcePacketRequest {
  const source_request = buildOfficialApiSourceRequest(sourceCorpus, assertionIds);
  return parseOfficialApiSourcePacketRequest({ schema_version: 3, interpretation_contract: "source-interpretation-v2",
    source_request, source_catalog: buildSourceReferenceCatalog(packetSha256(sourceCorpus), source_request.source_assertions, packetSha256), profile,
    profile_id: sourceInterpretationProfileIdentity(profile, packetSha256) });
}

export function sourcePacketRequestIdentity(request: OfficialApiSourcePacketRequest): string {
  return `sha256:${packetSha256(canonicalJson(parseOfficialApiSourcePacketRequest(request)))}`;
}

export function packetSha256(text: string): string { return createHash("sha256").update(text).digest("hex"); }

export const OFFICIAL_API_SOURCE_PACKET_SYSTEM_PROMPT = [
  "Extract one proposed semantic interpretation of the selected source assertions, using source-interpretation-v2.",
  'Return strict JSON {"contract":"source-interpretation-response-v2","packet":PACKET_OR_NULL}.',
  "The packet has contract, profile_id, source_catalog_id, mentions, referents, propositions, operators, roots; copy contract, profile_id and source_catalog.catalog_id from the request.",
  "The supplied profile owns exact predicate and role symbols and their meanings. Never invent a symbol or use a near synonym.",
  "Symbols nominate semantics, not literal quotations. Each mention is {id,assertion_id,source_ref:{first,last}}.",
  "Select inclusive first/last segment IDs shown in source_catalog for the exact desired span. Never copy quotation text, invent offsets, count occurrences or cross assertion boundaries.",
  "ASCII letters/digits/underscore form indivisible runs; every other Unicode scalar including whitespace is a separate segment. Word-internal ASCII substrings cannot be selected; do not silently widen them.",
  "Referents are {id,mentions:[mention ids]}. Group mentions only when this selected context supports that identity; equal text alone is not identity.",
  "Propositions are {id,predicate,implicit,predicate_mentions,assertion_ids,arguments:[{role,target}]}. Targets name referents or other propositions/operators.",
  "Use a proposition node for each event, including events with more than two roles. Reuse explicit referents across related events.",
  "An implicit semantic predicate has implicit=true and no predicate_mentions. Never fabricate a copula or other quotation absent from source.",
  "An explicit predicate has implicit=false and exact predicate mentions. Keep assertion_ids for the complete governing source context.",
  "Operators are {id,operator,assertion_ids,operands:[{role,target}]}; operator is not, possible, reported, conditional or opaque.",
  "Preserve negation, modality, reporting and conditional scope. A promised, desired or possible action is embedded content, not an asserted root.",
  "Each profile predicate declares governing_roles. Only those arguments and all operator operands govern scope: their descendants cannot also be roots. Ordinary event references can connect independently asserted roots.",
  "Roots are independent asserted propositions or their governing operators. All references must resolve; scope cycles and unreachable nodes are forbidden, ordinary reference cycles are allowed. IDs are local proposed identities, never global entities.",
  "Do not infer world truth, confidence, dates or facts beyond these assertions. Missing profile expressivity is not permission to remove scope.",
  "Return null only if there is no representable interpretation; admission of a packet does not certify source coverage or semantic faithfulness."
].join(" ");
