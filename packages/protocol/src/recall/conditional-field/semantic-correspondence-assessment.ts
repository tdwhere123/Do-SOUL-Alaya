import { z } from "zod";
import { AlayaError } from "../../shared/alaya-error.js";
import type { SourceSemanticResourceLedger } from "../../garden/source-semantic-resources.js";
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

export const SOURCE_SEMANTIC_CORRESPONDENCE_ASSESSMENT_CONTRACT = "source-semantic-correspondence-assessment-v1" as const;
export const SOURCE_SEMANTIC_CORRESPONDENCE_ENDPOINT_EVIDENCE_CONTRACT = "source-semantic-correspondence-endpoint-evidence-v1" as const;
export const SOURCE_SEMANTIC_CORRESPONDENCE_REQUEST_MAX_BYTES = 1_000_000;
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

const ProposedEquivalentSchema = z.object({
    source: SourceHandle,
    query_excerpt: z.string().min(1).max(1024),
    source_semantic_support: z.array(SourceSemanticSupportSchema).max(8).readonly(),
    applicable_context: SourceSemanticHandleSchema.optional(),
    grounding: z.string().min(1).max(1024)
}).strict().readonly();

const EndpointAssessmentSchema = z.discriminatedUnion("status", [
  z.object({ query: QueryHandle, status: z.literal("supported"),
    equivalents: z.array(ProposedEquivalentSchema).min(1).max(256).readonly() }).strict().readonly(),
  z.object({ query: QueryHandle, status: z.literal("unresolved"),
    query_excerpt: z.string().min(1).max(1024),
    explanation: z.string().min(1).max(1024) }).strict().readonly()
]);

export const SourceSemanticCorrespondenceAssessmentSchema = z.object({
  contract: z.literal(SOURCE_SEMANTIC_CORRESPONDENCE_ASSESSMENT_CONTRACT),
  source_interpretation_handle: DescriptorHandle,
  assessments: z.array(EndpointAssessmentSchema).max(256).readonly(),
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
export type SourceSemanticCorrespondenceAssessment = z.infer<typeof SourceSemanticCorrespondenceAssessmentSchema>;

export type SourceSemanticCorrespondenceDescriptor = Readonly<{
  readonly source_interpretation_handle: string;
  readonly interpretation: SourceSemanticInterpretation;
}>;

export type SourceSemanticCorrespondenceAssessmentEnvelope = Readonly<{
  readonly original_query: string;
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
  catalog: SourceSemanticCorrespondenceEndpointCatalog,
  availableBytes = SOURCE_SEMANTIC_CORRESPONDENCE_REQUEST_MAX_BYTES
) {
  if (!Number.isSafeInteger(availableBytes) || availableBytes < 0) {
    throw new AlayaError("VALIDATION", "semantic_correspondence endpoint evidence budget is invalid");
  }
  const maximumBytes = Math.min(availableBytes, SOURCE_SEMANTIC_CORRESPONDENCE_REQUEST_MAX_BYTES);
  let evidenceBytes = countSourceSemanticCorrespondenceJsonBytes({ contract: SOURCE_SEMANTIC_CORRESPONDENCE_ENDPOINT_EVIDENCE_CONTRACT,
    query_endpoints: [], source_endpoints: [] }, maximumBytes);
  const charge = (value: unknown, separator = false) => {
    const available = maximumBytes - evidenceBytes - Number(separator);
    evidenceBytes += countSourceSemanticCorrespondenceJsonBytes(value, available) + Number(separator);
  };
  return { contract: SOURCE_SEMANTIC_CORRESPONDENCE_ENDPOINT_EVIDENCE_CONTRACT,
    query_endpoints: queryEndpointEvidence(query, catalog, charge),
    source_endpoints: sourceEndpointEvidence(descriptors, catalog, charge) };
}

type EvidenceCharge = (value: unknown, separator?: boolean) => void;

function queryEndpointEvidence(
  query: SourceSemanticQuery, catalog: SourceSemanticCorrespondenceEndpointCatalog, charge: EvidenceCharge
) {
  const variables = new Map(query.variables.map((row) => [row.id, row]));
  const query_endpoints = catalog.query_endpoints.map((endpoint, endpointIndex) => {
    if (endpoint.kind === "referent") {
      const variable = variables.get(endpoint.variable!);
      if (variable?.reference === undefined) throw new AlayaError("VALIDATION", "catalog referent has no declared query reference");
      charge({ handle: endpoint.handle, kind: endpoint.kind, reference: variable.reference,
        attribution_context: query.attribution_context, uses: [] }, endpointIndex > 0);
      let useCount = 0;
      const uses = query.alternatives.flatMap((alternative, index) => alternative.frames.flatMap((frame) =>
        frame.role_requirements.filter((role) => role.target_variable === variable.id).map((role) => {
          const use = { alternative: index, frame: frame.id, predicate_reading: frame.predicate_reading,
            operator: frame.operator ?? null, source_act: frame.source_act ?? null,
            role: role.id, role_reading: role.role_reading, role_support: role.support,
            context_obligations: alternative.context_obligations.filter((obligation) => obligation.frame === frame.id),
            alternative_context: { purpose: alternative.purpose ?? null,
              context_obligations: alternative.context_obligations,
              answer_frames: alternative.answer_frames ?? null,
              evidence_inputs: alternative.evidence_inputs ?? null } };
          charge(use, useCount++ > 0);
          return use;
        })));
      return { handle: endpoint.handle, kind: endpoint.kind, reference: variable.reference,
        attribution_context: query.attribution_context, uses };
    }
    const alternative = query.alternatives[endpoint.alternative!];
    const frame = alternative?.frames.find((row) => row.id === endpoint.frame);
    if (alternative === undefined || frame === undefined) throw new AlayaError("VALIDATION", "catalog frame has no declared query frame");
    const frame_context = { frame: frame.id, predicate_reading: frame.predicate_reading,
      operator: frame.operator ?? null, source_act: frame.source_act ?? null,
      context_obligations: alternative.context_obligations.filter((row) => row.frame === frame.id),
      alternative_context: { purpose: alternative.purpose ?? null,
        context_obligations: alternative.context_obligations,
        answer_frames: alternative.answer_frames ?? null,
        evidence_inputs: alternative.evidence_inputs ?? null } };
    if (endpoint.kind === "predicate") {
      const row = { handle: endpoint.handle, kind: endpoint.kind, frame_context,
        roles: frame.role_requirements };
      charge(row, endpointIndex > 0);
      return row;
    }
    const role = frame.role_requirements.find((row) => row.id === endpoint.slot);
    if (role === undefined) throw new AlayaError("VALIDATION", "catalog slot has no declared query role");
    const row = { handle: endpoint.handle, kind: endpoint.kind, frame_context, role };
    charge(row, endpointIndex > 0);
    return row;
  });
  return query_endpoints;
}

function sourceEndpointEvidence(
  descriptors: readonly SourceSemanticCorrespondenceDescriptor[],
  catalog: SourceSemanticCorrespondenceEndpointCatalog, charge: EvidenceCharge
) {
  const sources = new Map(descriptors.map((row) => [row.source_interpretation_handle, row.interpretation]));
  const source_endpoints = catalog.source_endpoints.map((endpoint, endpointIndex) => {
    const interpretation = sources.get(endpoint.source_interpretation_handle);
    if (interpretation === undefined) throw new AlayaError("VALIDATION", "catalog source endpoint has no declared interpretation");
    const source_context = { attribution_context: interpretation.source.attribution_context,
      assertion_locations: interpretation.source.assertion_locations ?? null };
    if (endpoint.kind === "referent") {
      const referent = interpretation.referents.find((row) => row.id === endpoint.referent);
      if (referent === undefined) throw new AlayaError("VALIDATION", "catalog referent has no declared source referent");
      charge({ handle: endpoint.handle, kind: endpoint.kind, source_context, mentions: [], uses: [] }, endpointIndex > 0);
      let mentionCount = 0;
      const mentions = referent.mentions.map((id) => {
        const mention = interpretation.mentions.find((row) => row.id === id);
        if (mention === undefined) throw new AlayaError("VALIDATION", "source referent has no declared mention");
        const row = { id: mention.id, text: mention.text, assertion_id: mention.assertion_id,
          source_ref: mention.source_ref, utf8_span: mention.utf8_span,
          span_space: mention.span_space ?? null };
        charge(row, mentionCount++ > 0);
        return row;
      });
      let useCount = 0;
      const uses = interpretation.frames.flatMap((frame) => frame.bindings.filter((binding) =>
        binding.target.kind === "node" && binding.target.id === referent.id).map((binding) => {
          const slot = frame.slots.find((row) => row.id === binding.slot_id);
          if (slot === undefined) throw new AlayaError("VALIDATION", "source binding has no declared slot");
          const use = { frame: frame.id, assertion_ids: frame.assertion_ids, context_owner: frame.context_owner,
            slot: slot.id, role_reading: slot.role_reading, slot_support: slot.support,
            target: binding.target, binding_support: binding.support };
          charge(use, useCount++ > 0);
          return use;
        }));
      return { handle: endpoint.handle, kind: endpoint.kind, source_context, mentions, uses };
    }
    const frame = interpretation.frames.find((row) => row.id === endpoint.frame);
    if (frame === undefined) throw new AlayaError("VALIDATION", "catalog frame has no declared source frame");
    const frame_context = { frame: frame.id, assertion_ids: frame.assertion_ids,
      context_owner: frame.context_owner, predicate_support: frame.predicate_support,
      additional_support: frame.additional_support };
    if (endpoint.kind === "frame") {
      charge({ handle: endpoint.handle, kind: endpoint.kind, source_context, frame_context, slots: [] }, endpointIndex > 0);
      const slots = frame.slots.map((slot, slotIndex) => {
        const row = { ...slot, bindings: frame.bindings.filter((binding) => binding.slot_id === slot.id) };
        charge(row, slotIndex > 0);
        return row;
      });
      return { handle: endpoint.handle, kind: endpoint.kind, source_context, frame_context, slots };
    }
    const slot = frame.slots.find((row) => row.id === endpoint.slot);
    if (slot === undefined) throw new AlayaError("VALIDATION", "catalog slot has no declared source slot");
    const bindings = frame.bindings.filter((binding) => binding.slot_id === slot.id);
    charge({ handle: endpoint.handle, kind: endpoint.kind, source_context, frame_context,
      slot, bindings: [] }, endpointIndex > 0);
    bindings.forEach((binding, index) => charge(binding, index > 0));
    return { handle: endpoint.handle, kind: endpoint.kind, source_context, frame_context, slot, bindings };
  });
  return source_endpoints;
}

/** Counts correspondence JSON without materializing an oversized serialized value. */
export function countSourceSemanticCorrespondenceJsonBytes(
  value: unknown, maximum: number,
  errorMessage = "semantic_correspondence request exceeds input budget"
): number {
  if (!Number.isSafeInteger(maximum) || maximum < 0) throw new AlayaError("VALIDATION", errorMessage);
  let bytes = 0;
  const active = new WeakSet<object>();
  const add = (amount: number) => {
    if (amount > maximum - bytes) {
      throw new AlayaError("VALIDATION", errorMessage);
    }
    bytes += amount;
  };
  const write = (item: unknown): void => {
    if (typeof item === "string") {
      add(2);
      for (let index = 0; index < item.length; index++) {
        const code = item.charCodeAt(index);
        if (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) add(2);
        else if (code < 32) add(6);
        else if (code >= 0xD800 && code <= 0xDBFF) {
          if (index + 1 < item.length && item.charCodeAt(index + 1) >= 0xDC00 && item.charCodeAt(index + 1) <= 0xDFFF) {
            add(4);
            index++;
          } else add(6);
        } else if (code >= 0xDC00 && code <= 0xDFFF) add(6);
        else add(code < 0x80 ? 1 : code < 0x800 ? 2 : 3);
      }
      return;
    }
    if (item === null || item === undefined) { add(4); return; }
    if (typeof item === "boolean") { add(item ? 4 : 5); return; }
    if (typeof item === "number") { add(JSON.stringify(item).length); return; }
    if (Array.isArray(item)) {
      if (active.has(item) || "toJSON" in item) {
        throw new AlayaError("VALIDATION", "semantic_correspondence endpoint evidence requires JSON values");
      }
      active.add(item);
      add(2);
      for (let index = 0; index < item.length; index++) {
        if (index > 0) add(1);
        write(item[index]);
      }
      active.delete(item);
      return;
    }
    if (typeof item !== "object" || "toJSON" in item) {
      throw new AlayaError("VALIDATION", "semantic_correspondence endpoint evidence requires JSON values");
    }
    if (active.has(item)) throw new AlayaError("VALIDATION", "semantic_correspondence endpoint evidence requires JSON values");
    active.add(item);
    add(2);
    let fields = 0;
    for (const [key, entry] of Object.entries(item)) {
      if (entry === undefined) continue;
      if (fields++ > 0) add(1);
      write(key);
      add(1);
      write(entry);
    }
    active.delete(item);
  };
  write(value);
  return bytes;
}

export type SourceSemanticCorrespondenceEndpointEvidence = ReturnType<typeof buildSourceSemanticCorrespondenceEndpointEvidence>;
export type SourceSemanticCorrespondenceAssessmentDemand = Readonly<{
  readonly demanded_handles: readonly string[];
  readonly generation_policy: { readonly kind: string };
}>;

function assessmentIssue(path: readonly (string | number)[], message: string): never {
  throw new z.ZodError([{ code: "custom", path: [...path], message }]);
}

/** Exact demanded (or full-catalog) query handles. Shared by materialization and coverage. */
export function assertSourceSemanticCorrespondenceAssessmentRequirement(
  catalog: SourceSemanticCorrespondenceEndpointCatalog,
  assessments: readonly { readonly query: string }[],
  demand?: SourceSemanticCorrespondenceAssessmentDemand,
  meter?: SourceSemanticResourceLedger
): void {
  const queryByHandle = catalogIndex(catalog.query_endpoints, meter, "assessment query index");
  const requiredCount = demand === undefined || demand.generation_policy.kind === "full_catalog"
    ? catalog.query_endpoints.length : demand.demanded_handles.length;
  // Two sets, their entries, and the full-catalog handle array when needed.
  meter?.charge(2 + requiredCount, 128 + requiredCount * 32 +
    (demand === undefined || demand.generation_policy.kind === "full_catalog" ? 64 + requiredCount * 8 : 0),
    "assessment required handles");
  const required = new Set(demand === undefined || demand.generation_policy.kind === "full_catalog"
    ? catalog.query_endpoints.map((row) => row.handle)
    : demand.demanded_handles);
  const seenQueries = new Set<string>();
  for (const [index, assessment] of assessments.entries()) {
    meter?.charge(1, 32, "assessment seen query entry");
    if (!queryByHandle.has(assessment.query)) {
      assessmentIssue(["assessments", index, "query"], "undeclared local reference");
    }
    if (!required.has(assessment.query)) {
      assessmentIssue(["assessments", index, "query"], "extra query endpoint assessment");
    }
    if (seenQueries.has(assessment.query)) {
      assessmentIssue(["assessments", index, "query"], "duplicate query endpoint assessment");
    }
    seenQueries.add(assessment.query);
  }
  if (seenQueries.size !== required.size) {
    assessmentIssue(["assessments"], "missing query endpoint assessment");
  }
}

export function materializeSourceSemanticCorrespondenceAssessment(
  body: unknown,
  catalog: SourceSemanticCorrespondenceEndpointCatalog,
  envelope: SourceSemanticCorrespondenceAssessmentEnvelope,
  demand?: SourceSemanticCorrespondenceAssessmentDemand,
  meter?: SourceSemanticResourceLedger
): SourceSemanticCorrespondence {
  meter?.retain(body, "canonical assessment validation copy");
  try {
    countSourceSemanticCorrespondenceJsonBytes(body, SOURCE_SEMANTIC_MAX_BYTES);
  } catch (error) {
    throw new z.ZodError([{ code: "custom", path: [], message: "source semantic semantic_correspondence exceeds its byte bound" }]);
  }
  const parsed = SourceSemanticCorrespondenceAssessmentSchema.parse(body);
  assertSourceSemanticCorrespondenceAssessmentRequirement(catalog, parsed.assessments, demand, meter);
  const queryByHandle = catalogIndex(catalog.query_endpoints, meter, "canonical query index");
  const sourceByHandle = catalogIndex(catalog.source_endpoints, meter, "canonical source index");
  meter?.charge(1, 64, "canonical correspondence array");
  const correspondences: SourceSemanticEndpointCorrespondence[] = [];
  for (const [index, assessment] of parsed.assessments.entries()) {
    meter?.charge(1, 0, "canonical assessment traversal");
    const query = queryByHandle.get(assessment.query)!;
    if (assessment.status === "unresolved") {
      if (!envelope.original_query.includes(assessment.query_excerpt)) {
        throw new z.ZodError([{ code: "custom", path: ["assessments", index, "query_excerpt"], message: "query excerpt is not in the original query" }]);
      }
      continue;
    }
    meter?.charge(1, 64, "canonical equivalent set");
    const seenSources = new Set<string>();
    for (const [pairIndex, equivalent] of assessment.equivalents.entries()) {
      // Four result objects, one output slot, the diagnostic path, and one set entry.
      meter?.charge(1, 4 * 64 + 8 + 64 + 4 * 8 + 32, "canonical correspondence row allocation");
      const pairPath = ["assessments", index, "equivalents", pairIndex];
      const source = sourceByHandle.get(equivalent.source);
      if (source === undefined) {
        throw new z.ZodError([{ code: "custom", path: [...pairPath, "source"], message: "undeclared local reference" }]);
      }
      if (source.source_interpretation_handle !== parsed.source_interpretation_handle) {
        throw new z.ZodError([{ code: "custom", path: [...pairPath, "source"], message: "source endpoint is not on the bound interpretation" }]);
      }
      if (seenSources.has(equivalent.source)) {
        throw new z.ZodError([{ code: "custom", path: [...pairPath, "source"], message: "duplicate proposed equivalent" }]);
      }
      if (!envelope.original_query.includes(equivalent.query_excerpt)) {
        throw new z.ZodError([{ code: "custom", path: [...pairPath, "query_excerpt"], message: "query excerpt is not in the original query" }]);
      }
      seenSources.add(equivalent.source);
      if (correspondences.length === 256) {
        throw new z.ZodError([{ code: "custom", path: pairPath, message: "semantic_correspondence exceeds its correspondence bound" }]);
      }
      correspondences.push({
        relation: SOURCE_SEMANTIC_CORRESPONDENCE_RELATION,
        query_endpoint: queryEndpoint(query),
        source_endpoint: sourceEndpoint(source),
        query_support: { kind: "query_text", excerpt: equivalent.query_excerpt },
        source_semantic_support: equivalent.source_semantic_support,
        ...(equivalent.applicable_context === undefined ? {} : { applicable_context: equivalent.applicable_context })
      });
    }
  }
  meter?.charge(1, 64, "canonical correspondence envelope");
  const canonical = {
    contract: SOURCE_SEMANTIC_CORRESPONDENCE_CONTRACT,
    source_interpretation_id: envelope.source_interpretation_id,
    query_semantics_id: envelope.query_semantics_id,
    producer_id: envelope.producer_id,
    producer_version: envelope.producer_version,
    contract_version: SOURCE_SEMANTIC_CORRESPONDENCE_CONTRACT,
    correspondences,
    ...(parsed.domains === undefined ? {} : { domains: parsed.domains }),
    ...(parsed.membership_assumptions === undefined ? {} : { membership_assumptions: parsed.membership_assumptions })
  };
  meter?.retain(canonical, "canonical correspondence validation copy");
  if (meter !== undefined) {
    const bytes = countSourceSemanticCorrespondenceJsonBytes(canonical, SOURCE_SEMANTIC_MAX_BYTES);
    // Schema refinement allocates a UTF-16 JSON string and its UTF-8 encoding.
    meter.charge(bytes, 2 * bytes + bytes, "canonical correspondence byte validation");
  }
  return SourceSemanticCorrespondenceSchema.parse(canonical);
}

function catalogIndex<T extends { readonly handle: string }>(rows: readonly T[],
  meter: SourceSemanticResourceLedger | undefined, phase: string): Map<string, T> {
  meter?.charge(1, 64, phase);
  const index = new Map<string, T>();
  for (const row of rows) {
    meter?.charge(1, 32, phase);
    index.set(row.handle, row);
  }
  return index;
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
