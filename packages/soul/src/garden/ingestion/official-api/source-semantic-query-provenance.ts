import { z } from "zod";
import { producerResponseJsonSchema } from "./source-semantic-response-schema.js";
import {
  sourceSemanticProducerEnvelopeJsonSchema, sourceSemanticProducerGenerationOutcomeSchema,
  AlayaError, SOURCE_SEMANTIC_MAX_BYTES, SourceSemanticCorrespondenceAssessmentSchema,
  countSourceSemanticCorrespondenceJsonBytes,
  type SourceSemanticCorrespondenceDemand,
  type SourceSemanticCorrespondenceEndpointCatalog, type SourceSemanticQuery,
  type SourceSemanticQueryCatalogEntry, type SourceSemanticResourceLedger
} from "@do-soul/alaya-protocol";

export const SOURCE_SEMANTIC_CORRESPONDENCE_GENERATION_RESPONSE_CONTRACT =
  "source-semantic-correspondence-response-v5" as const;
export const SOURCE_SEMANTIC_CORRESPONDENCE_SCOPED_GENERATION_RESPONSE_CONTRACT =
  "source-semantic-correspondence-response-v6" as const;

type SourceSemanticQueryProvenanceQuote = Readonly<{
  handle: string;
  excerpt: string;
}>;

export type SourceSemanticQueryProvenanceResolution = Readonly<{
  eligible: readonly SourceSemanticQueryProvenanceQuote[];
  ineligible: readonly string[];
}>;


/** Exact unique stored original-query excerpt for one catalog handle. Predicates never resolve. */
export function resolveSourceSemanticQueryProvenance(
  query: SourceSemanticQuery,
  catalog: SourceSemanticCorrespondenceEndpointCatalog,
  original_query: string
): SourceSemanticQueryProvenanceResolution {
  const eligible: SourceSemanticQueryProvenanceQuote[] = [];
  const ineligible: string[] = [];
  for (const endpoint of catalog.query_endpoints) {
    const excerpt = storedCatalogExcerpt(endpoint, query);
    if (excerpt !== undefined && original_query.includes(excerpt)) {
      eligible.push({ handle: endpoint.handle, excerpt });
    } else {
      ineligible.push(endpoint.handle);
    }
  }
  return { eligible, ineligible };
}

export function completeSourceSemanticCorrespondenceGenerationAssessment(
  body: unknown,
  resolution: SourceSemanticQueryProvenanceResolution,
  maximumBytes = SOURCE_SEMANTIC_MAX_BYTES,
  meter?: SourceSemanticResourceLedger
): unknown {
  if (!isRecord(body) || !Array.isArray(body.assessments)) return body;
  const quotes = new Map(resolution.eligible.map((row) => [row.handle, row.excerpt]));
  const omitted = collectOmittedQuotes(body.assessments, quotes);
  if (omitted.length === 0) return body;
  premeterOmittedQuotes(body, omitted, maximumBytes);
  meter?.retain(body, "correspondence excerpt expansion copy");
  meter?.charge(omitted.length,
    omitted.reduce((bytes, row) => bytes + 128 + 4 * row.excerpt.length, 0), "correspondence excerpt allocation");
  return { ...body, assessments: body.assessments.map((row) => completeAssessmentRow(row, quotes)) };
}

export function sourceSemanticCorrespondenceGenerationResponseJsonSchema(
  request: Readonly<{
    original_query: string;
    admitted_query_semantics: SourceSemanticQuery;
    catalog: SourceSemanticCorrespondenceEndpointCatalog;
    demand?: SourceSemanticCorrespondenceDemand;
    response_contract?: typeof SOURCE_SEMANTIC_CORRESPONDENCE_GENERATION_RESPONSE_CONTRACT
      | typeof SOURCE_SEMANTIC_CORRESPONDENCE_SCOPED_GENERATION_RESPONSE_CONTRACT;
  }>
): object {
  const demanded = request.demand?.demanded_handles;
  const catalog = demanded === undefined ? request.catalog : {
    query_endpoints: request.catalog.query_endpoints.filter((row) => demanded.includes(row.handle)),
    source_endpoints: request.catalog.source_endpoints
  };
  const resolution = resolveSourceSemanticQueryProvenance(
    request.admitted_query_semantics, catalog, request.original_query
  );
  const envelope = producerResponseJsonSchema(z.object({
    contract: z.literal(request.response_contract ?? SOURCE_SEMANTIC_CORRESPONDENCE_GENERATION_RESPONSE_CONTRACT),
    outcome: sourceSemanticProducerGenerationOutcomeSchema("correspondence"),
    semantic_correspondence: SourceSemanticCorrespondenceAssessmentSchema.optional()
  }).strict().readonly());
  return sourceSemanticProducerEnvelopeJsonSchema(constrainSourceSemanticCorrespondenceGenerationSchema(envelope, resolution), "correspondence");
}

function storedCatalogExcerpt(
  endpoint: SourceSemanticQueryCatalogEntry, query: SourceSemanticQuery
): string | undefined {
  if (endpoint.kind === "referent") {
    const variable = query.variables.find((row) => row.id === endpoint.variable);
    return uniqueQueryText(variable?.reference);
  }
  if (endpoint.kind !== "slot") return undefined;
  const alternative = query.alternatives[endpoint.alternative ?? -1];
  const frame = alternative?.frames.find((row) => row.id === endpoint.frame);
  const role = frame?.role_requirements.find((row) => row.id === endpoint.slot);
  return uniqueQueryText(role?.support);
}

function uniqueQueryText(support: unknown): string | undefined {
  const excerpts: string[] = [];
  if (support == null) return undefined;
  const rows = Array.isArray(support) ? support : [support];
  for (const row of rows) {
    if (!isRecord(row) || row.kind !== "query_text" || typeof row.excerpt !== "string") return undefined;
    if (row.excerpt.length < 1 || row.excerpt.length > 1024) return undefined;
    excerpts.push(row.excerpt);
  }
  if (excerpts.length === 0) return undefined;
  return new Set(excerpts).size === 1 ? excerpts[0] : undefined;
}

const EXPANSION_MESSAGE = "source semantic semantic_correspondence exceeds its byte bound";

function omittedExcerpt(record: Record<string, unknown>, excerpt: string | undefined): string | undefined {
  if (excerpt === undefined || Object.hasOwn(record, "query_excerpt")) return undefined;
  return excerpt;
}

function jsonObjectHasFields(record: Record<string, unknown>): boolean {
  for (const value of Object.values(record)) {
    if (value !== undefined) return true;
  }
  return false;
}

type OmittedQuote = Readonly<{ excerpt: string; comma: boolean }>;

function collectOmittedQuotes(
  assessments: readonly unknown[], quotes: ReadonlyMap<string, string>
): OmittedQuote[] {
  const omitted: OmittedQuote[] = [];
  for (const row of assessments) {
    if (!isRecord(row) || typeof row.query !== "string") continue;
    const excerpt = quotes.get(row.query);
    if (row.status === "unresolved") {
      const fill = omittedExcerpt(row, excerpt);
      if (fill !== undefined) omitted.push({ excerpt: fill, comma: jsonObjectHasFields(row) });
      continue;
    }
    if (row.status !== "supported" || !Array.isArray(row.equivalents)) continue;
    for (const entry of row.equivalents) {
      if (!isRecord(entry)) continue;
      const fill = omittedExcerpt(entry, excerpt);
      if (fill !== undefined) omitted.push({ excerpt: fill, comma: jsonObjectHasFields(entry) });
    }
  }
  return omitted;
}

function premeterOmittedQuotes(
  body: unknown, omitted: readonly OmittedQuote[], maximumBytes: number
): void {
  let used = countSourceSemanticCorrespondenceJsonBytes(body, maximumBytes, EXPANSION_MESSAGE);
  for (const omission of omitted) {
    const propertyBytes = countSourceSemanticCorrespondenceJsonBytes(
      { query_excerpt: omission.excerpt }, maximumBytes, EXPANSION_MESSAGE
    );
    const extra = propertyBytes - 2 + Number(omission.comma);
    if (extra > maximumBytes - used) throw new AlayaError("VALIDATION", EXPANSION_MESSAGE);
    used += extra;
  }
}

function completeAssessmentRow(row: unknown, quotes: ReadonlyMap<string, string>): unknown {
  if (!isRecord(row) || typeof row.query !== "string") return row;
  const excerpt = quotes.get(row.query);
  if (row.status === "unresolved") {
    const fill = omittedExcerpt(row, excerpt);
    return fill === undefined ? row : { ...row, query_excerpt: fill };
  }
  if (row.status !== "supported" || !Array.isArray(row.equivalents)) return row;
  let filled = false;
  const equivalents = row.equivalents.map((entry) => {
    if (!isRecord(entry)) return entry;
    const fill = omittedExcerpt(entry, excerpt);
    if (fill === undefined) return entry;
    filled = true;
    return { ...entry, query_excerpt: fill };
  });
  return filled ? { ...row, equivalents } : row;
}

export function constrainSourceSemanticCorrespondenceGenerationSchema(
  envelope: object, resolution: SourceSemanticQueryProvenanceResolution
): object {
  const schema = structuredClone(envelope) as Record<string, unknown>;
  const assessments = assessmentsSchema(schema);
  const eligible = resolution.eligible.map((row) => row.handle);
  if (eligible.length === 0 && resolution.ineligible.length === 0) {
    assessments.maxItems = 0;
    return schema;
  }
  const groups = [
    ...(eligible.length > 0 ? [constrainAssessmentItems(schema, assessments.items, eligible, true)] : []),
    ...(resolution.ineligible.length > 0
      ? [constrainAssessmentItems(schema, assessments.items, resolution.ineligible, false)] : [])
  ];
  assessments.items = groups.length === 1 ? groups[0] : { anyOf: groups };
  return schema;
}

function assessmentsSchema(root: Record<string, unknown>): Record<string, unknown> {
  const properties = isObject(root.properties) ? root.properties : undefined;
  const body = isObject(properties?.assessments) ? root
    : isObject(properties?.semantic_correspondence) ? deref(root, properties.semantic_correspondence) : undefined;
  if (body === undefined) {
    throw new AlayaError("VALIDATION", "correspondence generation schema is missing semantic_correspondence");
  }
  const bodyProperties = isObject(body.properties) ? body.properties : undefined;
  if (!isObject(bodyProperties?.assessments)) {
    throw new AlayaError("VALIDATION", "correspondence generation schema is missing assessments");
  }
  const assessments = deref(root, bodyProperties.assessments);
  if (assessments.items === undefined) {
    throw new AlayaError("VALIDATION", "correspondence generation schema is missing assessment items");
  }
  return assessments;
}

function constrainAssessmentItems(
  root: Record<string, unknown>, items: unknown, handles: readonly string[], optionalExcerpt: boolean
): Record<string, unknown> {
  const resolved = structuredClone(deref(root, isObject(items) ? items : {}));
  delete resolved.$ref;
  const unionKey = Array.isArray(resolved.anyOf) ? "anyOf" : Array.isArray(resolved.oneOf) ? "oneOf" : undefined;
  const branches = unionKey === undefined ? [resolved] : resolved[unionKey] as unknown[];
  const mapped = branches.map((branch) => {
    const node = structuredClone(deref(root, isObject(branch) ? branch : {}));
    delete node.$ref;
    applyQueryEnum(node, handles);
    if (optionalExcerpt) loosenExcerpt(root, node);
    return node;
  });
  if (unionKey === undefined) return mapped[0]!;
  return { ...resolved, [unionKey]: mapped };
}

function applyQueryEnum(branch: Record<string, unknown>, handles: readonly string[]): void {
  const properties = isObject(branch.properties) ? branch.properties : {};
  properties.query = { type: "string", enum: [...handles] };
  branch.properties = properties;
}

function loosenExcerpt(root: Record<string, unknown>, branch: Record<string, unknown>): void {
  if (Array.isArray(branch.required)) {
    branch.required = (branch.required as string[]).filter((key) => key !== "query_excerpt");
  }
  const properties = isObject(branch.properties) ? branch.properties : undefined;
  const equivalents = isObject(properties?.equivalents) ? properties.equivalents : undefined;
  if (!isObject(equivalents?.items) && !(isObject(equivalents) && equivalents.items !== undefined)) return;
  if (!isObject(equivalents)) return;
  const items = structuredClone(deref(root, isObject(equivalents.items) ? equivalents.items : {}));
  delete items.$ref;
  if (Array.isArray(items.required)) {
    items.required = (items.required as string[]).filter((key) => key !== "query_excerpt");
  }
  equivalents.items = items;
}

function deref(root: Record<string, unknown>, node: Record<string, unknown>): Record<string, unknown> {
  if (typeof node.$ref !== "string") return node;
  const pointer = node.$ref;
  if (!pointer.startsWith("#/")) throw new AlayaError("VALIDATION", `unresolved generation schema pointer ${pointer}`);
  let current: Record<string, unknown> = root;
  for (const part of pointer.slice(2).split("/")) {
    const next = current[part.replace(/~1/gu, "/").replace(/~0/gu, "~")];
    if (!isObject(next)) throw new AlayaError("VALIDATION", `unresolved generation schema pointer ${pointer}`);
    current = next;
  }
  return deref(root, current);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return isObject(value);
}
