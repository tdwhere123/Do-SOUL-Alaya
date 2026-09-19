import {
  SourceSemanticResourceLedger, SourceSemanticResourceExhausted, type RequestBudget, canonicalJson, buildSourceReferenceCatalog, sourceReferenceResolver, assertSourceInterpretationPacketProfile, SourceInterpretationPacketSchema,
  PublishedSourceInterpretationPacketSchema, sourceRecallTarget, sourceEvidenceRootTarget,
  normalizeSourceSemantics, sourceSemanticInterpretationIdentity, sourceSemanticStanceLists,
  SOURCE_SEMANTIC_NORMALIZER_VERSION,
  SourceReferenceCatalogSchema, SourceSemanticInterpretationSchema, SourceSemanticPublishedInterpretationSchema,
  type PublishedSourceInterpretationPacket, type FieldContractSha256,
  type SourceReferenceCatalog, type SourceSemanticInterpretation,
  type SourceSemanticPublishedInterpretation
} from "@do-soul/alaya-protocol";
import { bindSourceSemanticLocations, verifySourceSemanticLocations } from "./source-semantic-location.js";
import { CoreError } from "../../shared/errors.js";
import type { FieldFormationStores } from "./field-stores.js";
import type { EvidenceService } from "../evidence-service.js";
import { resolveCurrentSource } from "./source-observation-currentness.js";
import { sliceUtf8Span, sourceSpanFromCodeUnitOffsets } from "./source-span-views.js";
import { uuidFromHex } from "./source-observation-identity.js";

type PacketInput = Readonly<{
  workspaceId: string; runId: string; artifactKey: string; source: string; packet: unknown;
  assertions: PublishedSourceInterpretationPacket["assertions"];
  profile: PublishedSourceInterpretationPacket["profile"];
  provenance: PublishedSourceInterpretationPacket["provenance"];
}>;
type Owner = Readonly<{ stores: Pick<FieldFormationStores, "listRecords" | "getStoredRecord">; sha256: FieldContractSha256;
  evidenceService: Pick<EvidenceService, "create" | "findByIdScoped">; meter?: SourceSemanticResourceLedger }>;

/** Publishes a source interpretation as evidence, without forming memory or temporal relation truth. */
export function createSourceInterpretationPacketPublication(owner: Owner) {
  return {
    async publish(input: PacketInput) {
      const bound = bindPacket(owner, input);
      const objectId = packetEvidenceId(bound.packet_id, owner.sha256);
      const current = () => verifyPublishedSourceInterpretation(owner, bound, input.workspaceId);
      const existing = await owner.evidenceService.findByIdScoped(objectId, input.workspaceId);
      current();
      if (existing !== null) {
        if (existing.lifecycle_state !== "active" || canonicalJson(JSON.parse(existing.gist)) !== canonicalJson(bound)) {
          throw new CoreError("VALIDATION", "published interpretation packet differs from its source binding");
        }
        return { bound, evidence: existing };
      }
      let evidence;
      try { evidence = await owner.evidenceService.create({ object_id: objectId,
        created_by: input.provenance.producer_id, evidence_kind: "conversation_excerpt",
        semantic_anchor: { topic: "Proposed source interpretation", keywords: [], summary: "Unreviewed interpretation hypothesis" },
        event_anchor: null, physical_anchor: { file_path: null, line_range: null, symbol_name: null, artifact_ref: null },
        evidence_health_state: "questionable", gist: JSON.stringify(bound),
        excerpt: bound.assertions.map((row) => row.text).join("\n"), source_hash: bound.source_target.content_digest,
        run_id: input.runId, workspace_id: input.workspaceId, surface_id: null
      }, [], undefined, undefined, undefined, current);
      } catch (error) {
        const raced = await owner.evidenceService.findByIdScoped(objectId, input.workspaceId);
        if (raced === null || raced.lifecycle_state !== "active" || canonicalJson(JSON.parse(raced.gist)) !== canonicalJson(bound)) throw error;
        current();
        evidence = raced;
      }
      current();
      return { bound, evidence };
    }
  };
}

function bindPacket(owner: Pick<Owner, "stores" | "sha256">, input: PacketInput): PublishedSourceInterpretationPacket {
  const packet = SourceInterpretationPacketSchema.parse(input.packet);
  assertSourceInterpretationPacketProfile(packet, input.profile, owner.sha256);
  const stored = resolveCurrentSource(owner.stores, input.workspaceId,
    { artifact_key: input.artifactKey, source_corpus_digest: owner.sha256(input.source) }, owner.sha256);
  const source = stored.content_bytes;
  const assertions = input.assertions.map((row) => {
    if (source.slice(...row.source_span) !== row.text) throw new CoreError("VALIDATION", "packet assertion is not exact source text");
    return { ...row, source_span: durableSpan(source, row.source_span) };
  });
  if (new Set(assertions.map((row) => row.assertion_id)).size !== assertions.length) {
    throw new CoreError("VALIDATION", "packet assertion identities are duplicated");
  }
  const selected = new Set(assertions.map((row) => row.assertion_id));
  if ([...packet.propositions, ...packet.operators].some((row) => row.assertion_ids.some((id) => !selected.has(id)))) {
    throw new CoreError("VALIDATION", "packet refers to an unselected source assertion");
  }
  const catalog = buildSourceReferenceCatalog(owner.sha256(source), input.assertions, owner.sha256);
  if (packet.source_catalog_id !== catalog.catalog_id) throw new CoreError("VALIDATION", "packet source catalog does not bind this source");
  const references = sourceReferenceResolver(catalog, owner.sha256);
  const mention_spans = packet.mentions.map((mention) => {
    const assertion = input.assertions.find((row) => row.assertion_id === mention.assertion_id);
    if (assertion === undefined) throw new CoreError("VALIDATION", "mention assertion is missing");
    const { span, text } = references.resolve(packet.source_catalog_id, mention.assertion_id, mention.source_ref);
    return { id: mention.id, text, utf8_span: durableSpan(source,
      [assertion.source_span[0] + span[0], assertion.source_span[0] + span[1]]) };
  });
  const body = { contract: "published-source-interpretation-v2" as const, semantic_status: "unreviewed" as const,
    source_target: sourceRecallTarget({ workspace_id: input.workspaceId, root_kind: "source_record",
      root_id: stored.record.identity, source_version: stored.record.source_version,
      content_digest: stored.record.content_digest, evidence_object_id: stored.record.evidence_object_id }),
    artifact_key: input.artifactKey, provenance: input.provenance, assertions, mention_spans, packet, profile: input.profile };
  const packet_id = packetIdentity(body, owner.sha256);
  return PublishedSourceInterpretationPacketSchema.parse({ ...body, packet_id, hypothesis_id: packet_id });
}

function durableSpan(source: string, span: readonly [number, number]): readonly [number, number] {
  const derived = sourceSpanFromCodeUnitOffsets(source, { start_offset: span[0], end_offset: span[1], purpose: "native_structure" });
  return [derived.start_offset, derived.end_offset];
}

function packetIdentity(body: Omit<PublishedSourceInterpretationPacket, "packet_id" | "hypothesis_id">,
  sha256: FieldContractSha256): string { return `sha256:${sha256(canonicalJson(body))}`; }

export function packetEvidenceId(packetId: string, sha256: FieldContractSha256): string {
  return uuidFromHex(sha256(`source-interpretation-packet:${packetId}`));
}

export function verifyPublishedSourceInterpretation(owner: Pick<Owner, "stores" | "sha256">,
  value: unknown, workspaceId: string) {
  const bound = PublishedSourceInterpretationPacketSchema.parse(value);
  const { packet_id, hypothesis_id, ...body } = bound;
  if (packetIdentity(body, owner.sha256) !== packet_id || hypothesis_id !== packet_id) {
    throw new CoreError("VALIDATION", "interpretation packet identity mismatch");
  }
  const stored = resolveCurrentSource(owner.stores, workspaceId, { artifact_key: bound.artifact_key,
    source_corpus_digest: bound.source_target.content_digest.replace(/^sha256:/u, "") }, owner.sha256);
  const target = sourceRecallTarget({ workspace_id: workspaceId, root_kind: "source_record",
    root_id: stored.record.identity, source_version: stored.record.source_version,
    content_digest: stored.record.content_digest, evidence_object_id: stored.record.evidence_object_id });
  if (canonicalJson(target) !== canonicalJson(sourceEvidenceRootTarget(bound.source_target))) {
    throw new CoreError("VALIDATION", "interpretation packet source is no longer current");
  }
  const source = stored.content_bytes;
  const assertions = bound.assertions.map((row) => {
    const [start, end] = row.source_span;
    const text = sliceUtf8Span(source, { start_offset: start, end_offset: end, purpose: "native_structure" });
    if (text !== row.text) throw new CoreError("VALIDATION", "stored packet assertion differs from source text");
    const prefix = Buffer.from(source, "utf8").subarray(0, start).toString("utf8");
    return { ...row, source_span: [prefix.length, prefix.length + text.length] as const };
  });
  const rebound = bindPacket(owner, { workspaceId, runId: "verification", artifactKey: bound.artifact_key,
    source, assertions, packet: bound.packet, profile: bound.profile, provenance: bound.provenance });
  if (canonicalJson(rebound) !== canonicalJson(bound)) throw new CoreError("VALIDATION", "stored packet location binding differs from source");
  return { bound, stored };
}

type SemanticInput = Readonly<{
  workspaceId: string; runId: string; artifactKey: string; source: string;
  catalog: SourceReferenceCatalog;
  provenance: SourceSemanticPublishedInterpretation["provenance"];
  profile?: SourceSemanticPublishedInterpretation["profile"];
  interpretation?: unknown; draft?: unknown;
  assertion_locations?: SourceSemanticInterpretation["source"]["assertion_locations"];
  budget?: RequestBudget; meter?: SourceSemanticResourceLedger;
  producer_version?: string; contract_version?: string;
}>;

/** Publishes an unreviewed source H as evidence. Does not form memory or relation truth. */
export function createSourceSemanticInterpretationPublication(owner: Owner) {
  return {
    async publish(input: SemanticInput) {
      const meter = input.meter ?? new SourceSemanticResourceLedger(input.budget ?? { work_units: 200000, memory_bytes: 20000000 });
      meter.retain(input.draft ?? input.interpretation, "publication input");
      const activeOwner = { ...owner, meter };
      const bound = bindSemanticInterpretation(activeOwner, input);
      const objectId = semanticInterpretationEvidenceId(bound.interpretation_id, owner.sha256);
      const current = () => verifyPublishedSourceSemanticInterpretation(activeOwner, bound, input.workspaceId);
      const existing = await owner.evidenceService.findByIdScoped(objectId, input.workspaceId);
      current();
      if (existing !== null) {
        const stored = SourceSemanticPublishedInterpretationSchema.parse(JSON.parse(existing.gist));
        if (existing.lifecycle_state !== "active" || publicationIdentity(stored) !== publicationIdentity(bound)) {
          throw new CoreError("VALIDATION", "published interpretation differs from its source binding");
        }
        return { bound: stored, evidence: existing, resource_usage: { work_units: meter.spentWork, memory_bytes: meter.spentBytes } };
      }
      let evidence;
      try { evidence = await owner.evidenceService.create({ object_id: objectId,
        created_by: input.provenance.producer_id, evidence_kind: "conversation_excerpt",
        semantic_anchor: { topic: "Proposed source interpretation", keywords: [], summary: "Unreviewed interpretation hypothesis" },
        event_anchor: null, physical_anchor: { file_path: null, line_range: null, symbol_name: null, artifact_ref: null },
        evidence_health_state: "questionable", gist: JSON.stringify(bound),
        excerpt: bound.interpretation.mentions.map((row) => row.text).join("\n"),
        source_hash: bound.source_target.content_digest,
        run_id: input.runId, workspace_id: input.workspaceId, surface_id: null
      }, [], undefined, undefined, undefined, current);
      } catch (error) {
        const raced = await owner.evidenceService.findByIdScoped(objectId, input.workspaceId);
        if (raced === null || raced.lifecycle_state !== "active"
          || publicationIdentity(SourceSemanticPublishedInterpretationSchema.parse(JSON.parse(raced.gist))) !== publicationIdentity(bound)) throw error;
        current();
        evidence = raced;
      }
      current();
      return { bound, evidence, resource_usage: { work_units: meter.spentWork, memory_bytes: meter.spentBytes } };
    }
  };
}

function bindSemanticInterpretation(owner: Pick<Owner, "stores" | "sha256" | "meter">, input: SemanticInput):
  SourceSemanticPublishedInterpretation {
  if (input.interpretation !== undefined && input.draft !== undefined) {
    throw new CoreError("VALIDATION", "source semantic publication accepts a draft or a normalized interpretation, not both");
  }
  const stored = resolveCurrentSource(owner.stores, input.workspaceId,
    { artifact_key: input.artifactKey, source_corpus_digest: owner.sha256(input.source) }, owner.sha256);
  const catalog = SourceReferenceCatalogSchema.parse(input.catalog);
  const interpretation = bindSourceSemanticLocations({ source: stored.content_bytes,
    interpretation: incomingInterpretation(owner, stored, input, catalog), catalog,
    locations: input.assertion_locations, sha256: owner.sha256, meter: owner.meter });
  return assemblePublishedInterpretation(owner.sha256, stored, input.workspaceId, interpretation, input.provenance, input.profile);
}

function incomingInterpretation(owner: Pick<Owner, "sha256" | "meter">, stored: ReturnType<typeof resolveCurrentSource>,
  input: SemanticInput, catalog: SourceReferenceCatalog): SourceSemanticInterpretation {
  const source = {
    source_id: stored.record.source_id,
    source_version: stored.record.source_version,
    content_digest: stored.record.content_digest
  };
  if (input.interpretation !== undefined) {
    const interpretation = SourceSemanticInterpretationSchema.parse(input.interpretation);
    if (interpretation.normalizer_version !== SOURCE_SEMANTIC_NORMALIZER_VERSION) {
      throw new CoreError("VALIDATION", "new source semantic publication requires the current normalizer");
    }
    return hostStanceInterpretation({ ...interpretation, source: { ...interpretation.source, ...source } });
  }
  if (input.draft === undefined || input.producer_version === undefined || input.contract_version === undefined) {
    throw new CoreError("VALIDATION", "source semantic publication requires a draft or a normalized interpretation");
  }
  const normalized = normalizeSourceSemantics({
    draft: input.draft, catalog, sha256: owner.sha256, source, meter: owner.meter,
    producer_id: input.provenance.producer_id,
    producer_version: input.producer_version, contract_version: input.contract_version
  });
  if (normalized.status === "resource_exhausted") {
    throw new SourceSemanticResourceExhausted("normalization");
  }
  if (normalized.status !== "normalized") throw new CoreError("VALIDATION", normalized.reason);
  return hostStanceInterpretation(normalized.interpretation);
}

function hostStanceInterpretation(interpretation: SourceSemanticInterpretation): SourceSemanticInterpretation {
  const stance = sourceSemanticStanceLists([...interpretation.frames, ...interpretation.operators]);
  if (canonicalJson(interpretation.entry_roots) !== canonicalJson(stance.entry_roots)
    || canonicalJson(interpretation.asserted_at_scope) !== canonicalJson(stance.asserted_at_scope)) {
    throw new CoreError("VALIDATION", "interpretation stance lists are not host-derived");
  }
  return interpretation;
}

function publicationIdentity(bound: SourceSemanticPublishedInterpretation): string {
  return canonicalJson({
    contract: bound.contract,
    interpretation_id: bound.interpretation_id,
    semantic_status: bound.semantic_status,
    source_target: bound.source_target,
    interpretation: bound.interpretation
  });
}

function assemblePublishedInterpretation(sha256: FieldContractSha256, stored: ReturnType<typeof resolveCurrentSource>,
  workspaceId: string, interpretation: SourceSemanticInterpretation,
  provenance: SourceSemanticPublishedInterpretation["provenance"],
  profile: SourceSemanticPublishedInterpretation["profile"]):
  SourceSemanticPublishedInterpretation {
  const source_target = sourceRecallTarget({
    workspace_id: workspaceId, root_kind: "source_record",
    root_id: stored.record.identity, source_version: stored.record.source_version,
    content_digest: stored.record.content_digest, evidence_object_id: stored.record.evidence_object_id
  });
  return SourceSemanticPublishedInterpretationSchema.parse({
    contract: "published-source-interpretation-v4" as const,
    interpretation_id: sourceSemanticInterpretationIdentity(interpretation, sha256),
    semantic_status: "unreviewed" as const, source_target, interpretation, provenance,
    ...(profile === undefined ? {} : { profile })
  });
}

export function semanticInterpretationEvidenceId(interpretationId: string, sha256: FieldContractSha256): string {
  return uuidFromHex(sha256(`source-semantic-interpretation:${interpretationId}`));
}

export function verifyPublishedSourceSemanticInterpretation(owner: Pick<Owner, "stores" | "sha256" | "meter">,
  value: unknown, workspaceId: string) {
  const bound = SourceSemanticPublishedInterpretationSchema.parse(value);
  if (sourceSemanticInterpretationIdentity(bound.interpretation, owner.sha256) !== bound.interpretation_id) {
    throw new CoreError("VALIDATION", "interpretation identity mismatch");
  }
  const stored = resolveCurrentSource(owner.stores, workspaceId, {
    artifact_key: bound.interpretation.source.source_id,
    source_corpus_digest: bound.source_target.content_digest.replace(/^sha256:/u, "")
  }, owner.sha256);
  const target = sourceRecallTarget({
    workspace_id: workspaceId, root_kind: "source_record",
    root_id: stored.record.identity, source_version: stored.record.source_version,
    content_digest: stored.record.content_digest, evidence_object_id: stored.record.evidence_object_id
  });
  if (canonicalJson(target) !== canonicalJson(sourceEvidenceRootTarget(bound.source_target))) {
    throw new CoreError("VALIDATION", "interpretation source is no longer current", { details: { admission: "filtered" } });
  }
  const located = verifySourceSemanticLocations(stored.content_bytes, bound.interpretation, owner.sha256, owner.meter);
  const rebound = assemblePublishedInterpretation(owner.sha256, stored, workspaceId,
    located, bound.provenance, bound.profile);
  if (canonicalJson(rebound) !== canonicalJson(bound)) {
    throw new CoreError("VALIDATION", "stored interpretation location binding differs from source");
  }
  return { bound, stored };
}
