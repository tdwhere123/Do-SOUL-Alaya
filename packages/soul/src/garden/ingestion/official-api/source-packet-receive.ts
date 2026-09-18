import { z } from "zod";
import { AlayaError, PublishedSourceInterpretationPacketSchema, assertSourceInterpretationPacketProfile, sourceReferenceResolver, SourceInterpretationPacketSchema,
  type PublishedSourceInterpretationPacket } from "@do-soul/alaya-protocol";
import { buildOfficialApiSourceAssertions, indexOfficialApiSourceAssertions } from "../../triage/grounding/source-locator.js";
import { computeOfficialApiSourceCorpusIdentity } from "./extraction-request.js";
import { packetSha256, parseOfficialApiSourcePacketRequest, sourcePacketRequestIdentity,
  type OfficialApiSourcePacketRequest } from "./source-packet-request.js";

export const MAX_OFFICIAL_API_SOURCE_PACKET_RESPONSE_BYTES = 1024 * 1024;

export const OfficialApiSourcePacketResponseSchema = z.object({
  contract: z.literal("source-interpretation-response-v2"), packet: SourceInterpretationPacketSchema.nullable()
}).strict().readonly();

/** Only an actually empty eligible source catalog can complete without a provider attempt. */
export function completeEmptyOfficialApiSourcePacket(requestValue: OfficialApiSourcePacketRequest,
  input: Readonly<{ sourceCorpus: string; artifactKey: string; producerId: string }>) {
  const request = parseOfficialApiSourcePacketRequest(requestValue);
  if (request.source_request.source_assertions.length !== 0 || buildOfficialApiSourceAssertions(input.sourceCorpus).length !== 0) {
    throw new AlayaError("CONFLICT", "deterministic packet empty requires a complete empty source assertion catalog");
  }
  const rawJson = JSON.stringify(OfficialApiSourcePacketResponseSchema.parse({ contract: "source-interpretation-response-v2", packet: null }));
  const received = receiveOfficialApiSourcePacket(rawJson, request, input);
  if (received.status !== "empty") throw new AlayaError("CONFLICT", "deterministic empty packet cannot contain a proposal");
  return { rawJson, received };
}

/** Ordinary and Batch responses enter this same all-or-nothing request-bound admission. */
export function receiveOfficialApiSourcePacket(rawJson: string, requestValue: OfficialApiSourcePacketRequest,
  input: Readonly<{ sourceCorpus: string; artifactKey: string; producerId: string;
    transport?: PublishedSourceInterpretationPacket["provenance"]["transport"] }>) {
  if (Buffer.byteLength(rawJson, "utf8") > MAX_OFFICIAL_API_SOURCE_PACKET_RESPONSE_BYTES) {
    throw new AlayaError("VALIDATION", "source packet response exceeds byte bound");
  }
  const request = parseOfficialApiSourcePacketRequest(requestValue);
  if (computeOfficialApiSourceCorpusIdentity(input.sourceCorpus) !== request.source_request.source_corpus_identity) {
    throw new AlayaError("CONFLICT", "source packet source generation mismatch");
  }
  if (packetSha256(input.sourceCorpus) !== request.source_catalog.source_digest) {
    throw new AlayaError("CONFLICT", "source reference source generation mismatch");
  }
  const catalog = new Map(indexOfficialApiSourceAssertions(input.sourceCorpus).map((row) => [row.assertion_id, row]));
  const assertions = request.source_request.source_assertions.map((row) => {
    const current = catalog.get(row.assertion_id);
    if (current === undefined || current.text !== row.text) throw new AlayaError("CONFLICT", "source packet assertion catalog mismatch");
    return { assertion_id: row.assertion_id, text: row.text, source_span: [current.start, current.end] as const };
  });
  const { packet } = OfficialApiSourcePacketResponseSchema.parse(JSON.parse(rawJson));
  const provenance = PublishedSourceInterpretationPacketSchema.unwrap().shape.provenance.parse({
    request_key: sourcePacketRequestIdentity(request), raw_response_id: `sha256:${packetSha256(rawJson)}`,
    producer_id: input.producerId, transport: input.transport ?? { kind: "unavailable" as const } });
  if (packet === null) return { status: "empty" as const, provenance };
  assertSourceInterpretationPacketProfile(packet, request.profile, packetSha256);
  const references = sourceReferenceResolver(request.source_catalog, packetSha256);
  if (packet.source_catalog_id !== request.source_catalog.catalog_id) {
    throw new AlayaError("CONFLICT", "source packet has a foreign source catalog");
  }
  const selected = new Map(assertions.map((row) => [row.assertion_id, row]));
  for (const node of [...packet.propositions, ...packet.operators]) {
    if (node.assertion_ids.some((id) => !selected.has(id))) {
      throw new AlayaError("CONFLICT", "source packet node cites an unselected assertion");
    }
  }
  for (const mention of packet.mentions) {
    const assertion = selected.get(mention.assertion_id);
    if (assertion === undefined) throw new AlayaError("CONFLICT", "source packet mention cites an unselected assertion");
    references.resolve(packet.source_catalog_id, mention.assertion_id, mention.source_ref);
  }
  return { status: "received" as const, draft: { artifactKey: input.artifactKey, source: input.sourceCorpus,
    assertions, packet, profile: request.profile, provenance } };
}
