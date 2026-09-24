import { z } from "zod";
import {
  SOURCE_SEMANTIC_MAX_BYTES, SourceSemanticHandleSchema, SourceSemanticSupportSchema
} from "../../garden/source-semantic-draft.js";
import type { SourceSemanticInterpretation } from "../../garden/source-semantic-interpretation.js";
import {
  SOURCE_SEMANTIC_CORRESPONDENCE_CONTRACT, SOURCE_SEMANTIC_CORRESPONDENCE_DESCRIPTOR_HANDLE,
  SOURCE_SEMANTIC_CORRESPONDENCE_RELATION, SourceSemanticCorrespondenceSchema,
  type SourceSemanticCorrespondence, type SourceSemanticEndpointCorrespondence, type SourceSemanticQueryEndpoint,
  type SourceSemanticSourceEndpoint
} from "./semantic-correspondence.js";
import type { SourceSemanticQuery } from "./semantic-query.js";

export const SOURCE_SEMANTIC_CORRESPONDENCE_SELECTION_CONTRACT = "source-semantic-correspondence-selection-v2" as const;
export const SOURCE_SEMANTIC_CORRESPONDENCE_ENDPOINT_EVIDENCE_CONTRACT = "source-semantic-correspondence-endpoint-evidence-v1" as const;
export const SOURCE_SEMANTIC_QUERY_ENDPOINT_HANDLE = /^qe([1-9][0-9]{0,2})$/u;
export const SOURCE_SEMANTIC_SOURCE_ENDPOINT_HANDLE = /^se([1-9][0-9]{0,2})$/u;

const QueryHandle = z.string().regex(SOURCE_SEMANTIC_QUERY_ENDPOINT_HANDLE);
const SourceHandle = z.string().regex(SOURCE_SEMANTIC_SOURCE_ENDPOINT_HANDLE);
const DescriptorHandle = z.string().regex(SOURCE_SEMANTIC_CORRESPONDENCE_DESCRIPTOR_HANDLE);

export const SourceSemanticQueryCatalogEntrySchema = z.object({
  handle: QueryHandle,
  kind: z.enum(["referent", "predicate", "slot"]),
  alternative: z.number().int().nonnegative().optional(),
  frame: SourceSemanticHandleSchema.optional(),
  slot: SourceSemanticHandleSchema.optional(),
  variable: SourceSemanticHandleSchema.optional(),
  sort: z.enum(["entity", "proposition", "context"]).optional(),
  reading: z.string().min(1).max(256).optional(),
  named: z.boolean().optional()
}).strict().readonly();

export const SourceSemanticSourceCatalogEntrySchema = z.object({
  handle: SourceHandle,
  source_interpretation_handle: DescriptorHandle,
  kind: z.enum(["referent", "frame", "slot"]),
  referent: SourceSemanticHandleSchema.optional(),
  frame: SourceSemanticHandleSchema.optional(),
  slot: SourceSemanticHandleSchema.optional(),
  reading: z.string().min(1).max(256).optional()
}).strict().readonly();

export const SourceSemanticCorrespondenceEndpointCatalogSchema = z.object({
  query_endpoints: z.array(SourceSemanticQueryCatalogEntrySchema).max(256).readonly(),
  source_endpoints: z.array(SourceSemanticSourceCatalogEntrySchema).max(256).readonly()
}).strict().readonly();

export const SourceSemanticCorrespondenceSelectionSchema = z.object({
  contract: z.literal(SOURCE_SEMANTIC_CORRESPONDENCE_SELECTION_CONTRACT),
  source_interpretation_handle: DescriptorHandle.optional(),
  selections: z.array(z.object({
    query: QueryHandle,
    source: SourceHandle,
    query_excerpt: z.string().min(1).max(1024),
    source_semantic_support: z.array(SourceSemanticSupportSchema).max(8).readonly(),
    applicable_context: SourceSemanticHandleSchema.optional()
  }).strict().readonly()).max(256).readonly(),
  domains: z.array(z.object({
    query_domain: SourceSemanticHandleSchema, source_domain: SourceSemanticHandleSchema,
    query_support: z.object({ kind: z.literal("query_text"), excerpt: z.string().min(1).max(1024) }).strict().readonly(),
    source_semantic_support: z.array(SourceSemanticSupportSchema).max(8).readonly()
  }).strict().readonly()).max(64).readonly().optional(),
  membership_assumptions: z.array(z.object({
    query_variable: SourceSemanticHandleSchema, source_domain: SourceSemanticHandleSchema,
    restrictions: z.array(SourceSemanticHandleSchema).max(16).readonly(),
    status: z.enum(["member", "excluded"]),
    query_support: z.object({ kind: z.literal("query_text"), excerpt: z.string().min(1).max(1024) }).strict().readonly(),
    description: z.string().min(1).max(1024)
  }).strict().readonly()).max(64).readonly().optional()
}).strict().readonly();

export type SourceSemanticQueryCatalogEntry = z.infer<typeof SourceSemanticQueryCatalogEntrySchema>;
export type SourceSemanticSourceCatalogEntry = z.infer<typeof SourceSemanticSourceCatalogEntrySchema>;
export type SourceSemanticCorrespondenceEndpointCatalog = z.infer<typeof SourceSemanticCorrespondenceEndpointCatalogSchema>;
export type SourceSemanticCorrespondenceSelection = z.infer<typeof SourceSemanticCorrespondenceSelectionSchema>;

export type SourceSemanticCorrespondenceDescriptor = Readonly<{
  readonly source_interpretation_handle: string;
  readonly interpretation: SourceSemanticInterpretation;
}>;

export type SourceSemanticCorrespondenceSelectionEnvelope = Readonly<{
  readonly source_interpretation_id: string;
  readonly query_semantics_id: string;
  readonly producer_id: string;
  readonly producer_version: string;
}>;

/** Lawful advertised endpoints only. Does not enumerate pairs or filter by gold. */
export function buildSourceSemanticCorrespondenceEndpointCatalog(
  query: SourceSemanticQuery,
  descriptors: readonly SourceSemanticCorrespondenceDescriptor[]
): SourceSemanticCorrespondenceEndpointCatalog {
  const query_endpoints: SourceSemanticQueryCatalogEntry[] = [];
  const source_endpoints: SourceSemanticSourceCatalogEntry[] = [];
  for (const variable of query.variables) {
    if (variable.sort !== "entity" || variable.reference === undefined) continue;
    query_endpoints.push({
      handle: nextHandle("qe", query_endpoints.length),
      kind: "referent", variable: variable.id, sort: "entity", named: true,
      reading: variable.reference.excerpt
    });
  }
  for (const [alternative, row] of query.alternatives.entries()) {
    for (const frame of row.frames) {
      if (frame.operator !== undefined) continue;
      query_endpoints.push({
        handle: nextHandle("qe", query_endpoints.length),
        kind: "predicate", alternative, frame: frame.id, sort: "proposition",
        reading: frame.predicate_reading
      });
      for (const role of frame.role_requirements) {
        query_endpoints.push({
          handle: nextHandle("qe", query_endpoints.length),
          kind: "slot", alternative, frame: frame.id, slot: role.id,
          reading: role.role_reading
        });
      }
    }
  }
  for (const descriptor of descriptors) {
    for (const referent of descriptor.interpretation.referents) {
      if (referent.referent_kind !== "grouped") continue;
      source_endpoints.push({
        handle: nextHandle("se", source_endpoints.length),
        source_interpretation_handle: descriptor.source_interpretation_handle, kind: "referent", referent: referent.id
      });
    }
    for (const frame of descriptor.interpretation.frames) {
      source_endpoints.push({
        handle: nextHandle("se", source_endpoints.length),
        source_interpretation_handle: descriptor.source_interpretation_handle, kind: "frame", frame: frame.id,
        reading: frame.predicate_support.reading
      });
      for (const slot of frame.slots) {
        source_endpoints.push({
          handle: nextHandle("se", source_endpoints.length),
          source_interpretation_handle: descriptor.source_interpretation_handle, kind: "slot", frame: frame.id, slot: slot.id,
          reading: slot.role_reading
        });
      }
    }
  }
  return SourceSemanticCorrespondenceEndpointCatalogSchema.parse({ query_endpoints, source_endpoints });
}

/** Copies admitted premises onto the existing endpoints; the catalog alone decides eligibility and handles. */
export function buildSourceSemanticCorrespondenceEndpointEvidence(
  query: SourceSemanticQuery,
  descriptors: readonly SourceSemanticCorrespondenceDescriptor[],
  catalog: SourceSemanticCorrespondenceEndpointCatalog
) {
  const variables = new Map(query.variables.map((row) => [row.id, row]));
  const sources = new Map(descriptors.map((row) => [row.source_interpretation_handle, row.interpretation]));
  const query_endpoints = catalog.query_endpoints.map((endpoint) => {
    if (endpoint.kind === "referent") {
      const variable = variables.get(endpoint.variable!);
      if (variable?.reference === undefined) throw new Error("catalog referent has no declared query reference");
      const uses = query.alternatives.flatMap((alternative, index) => alternative.frames.flatMap((frame) =>
        frame.role_requirements.filter((role) => role.target_variable === variable.id).map((role) => ({
          alternative: index, frame: frame.id, predicate_reading: frame.predicate_reading,
          operator: frame.operator ?? null, source_act: frame.source_act ?? null,
          role: role.id, role_reading: role.role_reading, role_support: role.support,
          context_obligations: alternative.context_obligations.filter((obligation) => obligation.frame === frame.id),
          alternative_context: { purpose: alternative.purpose ?? null,
            context_obligations: alternative.context_obligations,
            answer_frames: alternative.answer_frames ?? null,
            evidence_inputs: alternative.evidence_inputs ?? null }
        }))));
      return { handle: endpoint.handle, kind: endpoint.kind, reference: variable.reference,
        attribution_context: query.attribution_context, uses };
    }
    const alternative = query.alternatives[endpoint.alternative!];
    const frame = alternative?.frames.find((row) => row.id === endpoint.frame);
    if (alternative === undefined || frame === undefined) throw new Error("catalog frame has no declared query frame");
    const frame_context = { frame: frame.id, predicate_reading: frame.predicate_reading,
      operator: frame.operator ?? null, source_act: frame.source_act ?? null,
      context_obligations: alternative.context_obligations.filter((row) => row.frame === frame.id),
      alternative_context: { purpose: alternative.purpose ?? null,
        context_obligations: alternative.context_obligations,
        answer_frames: alternative.answer_frames ?? null,
        evidence_inputs: alternative.evidence_inputs ?? null } };
    if (endpoint.kind === "predicate") {
      return { handle: endpoint.handle, kind: endpoint.kind, frame_context,
        roles: frame.role_requirements };
    }
    const role = frame.role_requirements.find((row) => row.id === endpoint.slot);
    if (role === undefined) throw new Error("catalog slot has no declared query role");
    return { handle: endpoint.handle, kind: endpoint.kind, frame_context, role };
  });
  const source_endpoints = catalog.source_endpoints.map((endpoint) => {
    const interpretation = sources.get(endpoint.source_interpretation_handle);
    if (interpretation === undefined) throw new Error("catalog source endpoint has no declared interpretation");
    const source_context = { attribution_context: interpretation.source.attribution_context,
      assertion_locations: interpretation.source.assertion_locations ?? null };
    if (endpoint.kind === "referent") {
      const referent = interpretation.referents.find((row) => row.id === endpoint.referent);
      if (referent === undefined) throw new Error("catalog referent has no declared source referent");
      const mentions = referent.mentions.map((id) => {
        const mention = interpretation.mentions.find((row) => row.id === id);
        if (mention === undefined) throw new Error("source referent has no declared mention");
        return { id: mention.id, text: mention.text, assertion_id: mention.assertion_id,
          source_ref: mention.source_ref, utf8_span: mention.utf8_span,
          span_space: mention.span_space ?? null };
      });
      const uses = interpretation.frames.flatMap((frame) => frame.bindings.filter((binding) =>
        binding.target.kind === "node" && binding.target.id === referent.id).map((binding) => {
          const slot = frame.slots.find((row) => row.id === binding.slot_id);
          if (slot === undefined) throw new Error("source binding has no declared slot");
          return { frame: frame.id, assertion_ids: frame.assertion_ids, context_owner: frame.context_owner,
            slot: slot.id, role_reading: slot.role_reading, slot_support: slot.support,
            target: binding.target, binding_support: binding.support };
        }));
      return { handle: endpoint.handle, kind: endpoint.kind, source_context, mentions, uses };
    }
    const frame = interpretation.frames.find((row) => row.id === endpoint.frame);
    if (frame === undefined) throw new Error("catalog frame has no declared source frame");
    const frame_context = { frame: frame.id, assertion_ids: frame.assertion_ids,
      context_owner: frame.context_owner, predicate_support: frame.predicate_support,
      additional_support: frame.additional_support };
    if (endpoint.kind === "frame") {
      return { handle: endpoint.handle, kind: endpoint.kind, source_context, frame_context,
        slots: frame.slots.map((slot) => ({ ...slot,
          bindings: frame.bindings.filter((binding) => binding.slot_id === slot.id) })) };
    }
    const slot = frame.slots.find((row) => row.id === endpoint.slot);
    if (slot === undefined) throw new Error("catalog slot has no declared source slot");
    return { handle: endpoint.handle, kind: endpoint.kind, source_context, frame_context,
      slot, bindings: frame.bindings.filter((binding) => binding.slot_id === slot.id) };
  });
  return { contract: SOURCE_SEMANTIC_CORRESPONDENCE_ENDPOINT_EVIDENCE_CONTRACT,
    query_endpoints, source_endpoints };
}

export type SourceSemanticCorrespondenceEndpointEvidence = ReturnType<typeof buildSourceSemanticCorrespondenceEndpointEvidence>;

export function materializeSourceSemanticCorrespondenceSelection(
  body: unknown,
  catalog: SourceSemanticCorrespondenceEndpointCatalog,
  envelope: SourceSemanticCorrespondenceSelectionEnvelope
): SourceSemanticCorrespondence {
  if (new TextEncoder().encode(JSON.stringify(body)).length > SOURCE_SEMANTIC_MAX_BYTES) {
    throw new z.ZodError([{ code: "custom", path: [], message: "source semantic semantic_correspondence exceeds its byte bound" }]);
  }
  const parsed = SourceSemanticCorrespondenceSelectionSchema.parse(body);
  const queryByHandle = new Map(catalog.query_endpoints.map((row) => [row.handle, row]));
  const sourceByHandle = new Map(catalog.source_endpoints.map((row) => [row.handle, row]));
  const correspondences: SourceSemanticEndpointCorrespondence[] = parsed.selections.map((selection, index) => {
    const query = queryByHandle.get(selection.query);
    const source = sourceByHandle.get(selection.source);
    if (query === undefined) {
      throw new z.ZodError([{ code: "custom", path: ["selections", index, "query"], message: "undeclared local reference" }]);
    }
    if (source === undefined) {
      throw new z.ZodError([{ code: "custom", path: ["selections", index, "source"], message: "undeclared local reference" }]);
    }
    if (source.source_interpretation_handle !== (parsed.source_interpretation_handle ?? "source1")) {
      throw new z.ZodError([{ code: "custom", path: ["selections", index, "source"],
        message: "source endpoint is not on the bound interpretation" }]);
    }
    return {
      relation: SOURCE_SEMANTIC_CORRESPONDENCE_RELATION,
      query_endpoint: queryEndpoint(query),
      source_endpoint: sourceEndpoint(source),
      query_support: { kind: "query_text", excerpt: selection.query_excerpt },
      source_semantic_support: selection.source_semantic_support,
      ...(selection.applicable_context === undefined ? {} : { applicable_context: selection.applicable_context })
    };
  });
  return SourceSemanticCorrespondenceSchema.parse({
    contract: SOURCE_SEMANTIC_CORRESPONDENCE_CONTRACT,
    source_interpretation_id: envelope.source_interpretation_id,
    query_semantics_id: envelope.query_semantics_id,
    producer_id: envelope.producer_id,
    producer_version: envelope.producer_version,
    contract_version: SOURCE_SEMANTIC_CORRESPONDENCE_CONTRACT,
    correspondences,
    ...(parsed.domains === undefined ? {} : { domains: parsed.domains }),
    ...(parsed.membership_assumptions === undefined ? {} : { membership_assumptions: parsed.membership_assumptions })
  });
}

function queryEndpoint(entry: SourceSemanticQueryCatalogEntry): SourceSemanticQueryEndpoint {
  if (entry.kind === "referent") return { kind: "referent", variable: entry.variable! };
  if (entry.kind === "predicate") return { kind: "predicate", alternative: entry.alternative!, frame: entry.frame! };
  return { kind: "slot", alternative: entry.alternative!, frame: entry.frame!, slot: entry.slot! };
}

function sourceEndpoint(entry: SourceSemanticSourceCatalogEntry): SourceSemanticSourceEndpoint {
  if (entry.kind === "referent") return { kind: "referent", referent: entry.referent! };
  if (entry.kind === "frame") return { kind: "frame", frame: entry.frame! };
  return { kind: "slot", frame: entry.frame!, slot: entry.slot! };
}

function nextHandle(prefix: "qe" | "se", index: number): string {
  const handle = `${prefix}${index + 1}`;
  if (index + 1 > 256) {
    throw new z.ZodError([{ code: "custom", path: [], message: "semantic_correspondence endpoint catalog exceeds its bound" }]);
  }
  return handle;
}
