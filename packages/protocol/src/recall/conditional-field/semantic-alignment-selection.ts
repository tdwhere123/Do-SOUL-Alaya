import { z } from "zod";
import {
  SOURCE_SEMANTIC_MAX_BYTES, SourceSemanticHandleSchema, SourceSemanticSupportSchema
} from "../../garden/source-semantic-draft.js";
import type { SourceSemanticInterpretation } from "../../garden/source-semantic-interpretation.js";
import {
  SOURCE_SEMANTIC_ALIGNMENT_CONTRACT, SOURCE_SEMANTIC_ALIGNMENT_DESCRIPTOR_HANDLE,
  SOURCE_SEMANTIC_ALIGNMENT_RELATION, SourceSemanticAlignmentSchema,
  type SourceSemanticAlignment, type SourceSemanticCorrespondence, type SourceSemanticQueryEndpoint,
  type SourceSemanticSourceEndpoint
} from "./semantic-alignment.js";
import type { SourceSemanticQuery } from "./semantic-query.js";

export const SOURCE_SEMANTIC_ALIGNMENT_SELECTION_CONTRACT = "source-semantic-alignment-selection-v1" as const;
export const SOURCE_SEMANTIC_QUERY_ENDPOINT_HANDLE = /^qe([1-9][0-9]{0,2})$/u;
export const SOURCE_SEMANTIC_SOURCE_ENDPOINT_HANDLE = /^se([1-9][0-9]{0,2})$/u;

const QueryHandle = z.string().regex(SOURCE_SEMANTIC_QUERY_ENDPOINT_HANDLE);
const SourceHandle = z.string().regex(SOURCE_SEMANTIC_SOURCE_ENDPOINT_HANDLE);
const DescriptorHandle = z.string().regex(SOURCE_SEMANTIC_ALIGNMENT_DESCRIPTOR_HANDLE);

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
  h: DescriptorHandle,
  kind: z.enum(["referent", "frame", "slot"]),
  referent: SourceSemanticHandleSchema.optional(),
  frame: SourceSemanticHandleSchema.optional(),
  slot: SourceSemanticHandleSchema.optional(),
  reading: z.string().min(1).max(256).optional()
}).strict().readonly();

export const SourceSemanticAlignmentEndpointCatalogSchema = z.object({
  query_endpoints: z.array(SourceSemanticQueryCatalogEntrySchema).max(256).readonly(),
  source_endpoints: z.array(SourceSemanticSourceCatalogEntrySchema).max(256).readonly()
}).strict().readonly();

export const SourceSemanticAlignmentSelectionSchema = z.object({
  contract: z.literal(SOURCE_SEMANTIC_ALIGNMENT_SELECTION_CONTRACT),
  h: DescriptorHandle.optional(),
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
export type SourceSemanticAlignmentEndpointCatalog = z.infer<typeof SourceSemanticAlignmentEndpointCatalogSchema>;
export type SourceSemanticAlignmentSelection = z.infer<typeof SourceSemanticAlignmentSelectionSchema>;

export type SourceSemanticAlignmentDescriptor = Readonly<{
  readonly h: string;
  readonly interpretation: SourceSemanticInterpretation;
}>;

export type SourceSemanticAlignmentSelectionEnvelope = Readonly<{
  readonly h_id: string;
  readonly q_id: string;
  readonly producer_id: string;
  readonly producer_version: string;
}>;

/** Lawful advertised endpoints only. Does not enumerate pairs or filter by gold. */
export function buildSourceSemanticAlignmentEndpointCatalog(
  query: SourceSemanticQuery,
  descriptors: readonly SourceSemanticAlignmentDescriptor[]
): SourceSemanticAlignmentEndpointCatalog {
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
        h: descriptor.h, kind: "referent", referent: referent.id
      });
    }
    for (const frame of descriptor.interpretation.frames) {
      source_endpoints.push({
        handle: nextHandle("se", source_endpoints.length),
        h: descriptor.h, kind: "frame", frame: frame.id,
        reading: frame.predicate_support.reading
      });
      for (const slot of frame.slots) {
        source_endpoints.push({
          handle: nextHandle("se", source_endpoints.length),
          h: descriptor.h, kind: "slot", frame: frame.id, slot: slot.id,
          reading: slot.role_reading
        });
      }
    }
  }
  return SourceSemanticAlignmentEndpointCatalogSchema.parse({ query_endpoints, source_endpoints });
}

export function materializeSourceSemanticAlignmentSelection(
  body: unknown,
  catalog: SourceSemanticAlignmentEndpointCatalog,
  envelope: SourceSemanticAlignmentSelectionEnvelope
): SourceSemanticAlignment {
  if (new TextEncoder().encode(JSON.stringify(body)).length > SOURCE_SEMANTIC_MAX_BYTES) {
    throw new z.ZodError([{ code: "custom", path: [], message: "source semantic alignment exceeds its byte bound" }]);
  }
  const parsed = SourceSemanticAlignmentSelectionSchema.parse(body);
  const queryByHandle = new Map(catalog.query_endpoints.map((row) => [row.handle, row]));
  const sourceByHandle = new Map(catalog.source_endpoints.map((row) => [row.handle, row]));
  const correspondences: SourceSemanticCorrespondence[] = parsed.selections.map((selection, index) => {
    const query = queryByHandle.get(selection.query);
    const source = sourceByHandle.get(selection.source);
    if (query === undefined) {
      throw new z.ZodError([{ code: "custom", path: ["selections", index, "query"], message: "undeclared local reference" }]);
    }
    if (source === undefined) {
      throw new z.ZodError([{ code: "custom", path: ["selections", index, "source"], message: "undeclared local reference" }]);
    }
    if (source.h !== (parsed.h ?? "h1")) {
      throw new z.ZodError([{ code: "custom", path: ["selections", index, "source"],
        message: "source endpoint is not on the bound interpretation" }]);
    }
    return {
      relation: SOURCE_SEMANTIC_ALIGNMENT_RELATION,
      query_endpoint: queryEndpoint(query),
      source_endpoint: sourceEndpoint(source),
      query_support: { kind: "query_text", excerpt: selection.query_excerpt },
      source_semantic_support: selection.source_semantic_support,
      ...(selection.applicable_context === undefined ? {} : { applicable_context: selection.applicable_context })
    };
  });
  return SourceSemanticAlignmentSchema.parse({
    contract: SOURCE_SEMANTIC_ALIGNMENT_CONTRACT,
    h_id: envelope.h_id,
    q_id: envelope.q_id,
    producer_id: envelope.producer_id,
    producer_version: envelope.producer_version,
    contract_version: SOURCE_SEMANTIC_ALIGNMENT_CONTRACT,
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
    throw new z.ZodError([{ code: "custom", path: [], message: "alignment endpoint catalog exceeds its bound" }]);
  }
  return handle;
}
