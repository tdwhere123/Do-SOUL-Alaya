import { z } from "zod";

export const OPEN_SEMANTIC_FACTOR_GRAPH_SCHEMA_VERSION = 1 as const;
export const OPEN_SEMANTIC_FACTOR_FORMATION_OPERATOR_ID =
  "open_semantic_factor_formation_v1";
export const OPEN_SEMANTIC_FACTOR_LIMIT = 32;
export const OPEN_SEMANTIC_VARIABLE_LIMIT = 8;
export const OPEN_SEMANTIC_PROPOSITION_LIMIT = 8;
export const OPEN_SEMANTIC_ARGUMENT_LIMIT = 8;

const CanonicalIdSchema = z.string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9._:-]*$/u);
const SourceSpanSchema = z.tuple([
  z.number().int().nonnegative(),
  z.number().int().positive()
]).superRefine(([start, end], context) => {
  if (end <= start) {
    context.addIssue({ code: "custom", message: "source span must be non-empty" });
  }
}).readonly();
const GroundedSurfaceSchema = z.object({
  surface: z.string().min(1).max(512),
  source_span: SourceSpanSchema
}).strict();
const ProposedSurfaceSchema = z.object({
  surface: z.string().min(1).max(512),
  source_occurrence: z.number().int().nonnegative().lt(128).default(0)
}).strict();
const SemanticIdentitySchema = z.string().min(1).max(512).superRefine(
  (value, context) => {
    if (value !== normalizeSemanticIdentity(value)) {
      context.addIssue({
        code: "custom",
        message: "semantic identity must be canonical NFKC lowercase text"
      });
    }
  }
);

export const OpenSemanticFactorSchema = GroundedSurfaceSchema.extend({
  factor_id: CanonicalIdSchema,
  semantic_identity: SemanticIdentitySchema
}).readonly();

export const OpenSemanticFactorProposalSchema = ProposedSurfaceSchema.extend({
  factor_id: CanonicalIdSchema,
  semantic_identity: SemanticIdentitySchema
}).readonly();

export const OpenSemanticVariableSchema = GroundedSurfaceSchema.extend({
  variable_id: CanonicalIdSchema
}).readonly();

export const OpenSemanticVariableProposalSchema = ProposedSurfaceSchema.extend({
  variable_id: CanonicalIdSchema
}).readonly();

export const OpenSemanticArgumentSchema = z.object({
  position: z.number().int().nonnegative().lt(OPEN_SEMANTIC_ARGUMENT_LIMIT),
  binding_identity: SemanticIdentitySchema,
  reference_kind: z.enum(["factor", "variable"]),
  reference_id: CanonicalIdSchema
}).strict().readonly();

export const OpenSemanticPropositionSchema = z.object({
  proposition_id: CanonicalIdSchema,
  predicate_factor_id: CanonicalIdSchema,
  arguments: z.array(OpenSemanticArgumentSchema)
    .min(1)
    .max(OPEN_SEMANTIC_ARGUMENT_LIMIT)
    .readonly()
}).strict().readonly();

const OpenSemanticFactorGraphStructureSchema = z.object({
  schema_version: z.literal(OPEN_SEMANTIC_FACTOR_GRAPH_SCHEMA_VERSION),
  source_kind: z.enum(["evidence", "query"]),
  result_variable_ids: z.array(CanonicalIdSchema)
    .max(OPEN_SEMANTIC_VARIABLE_LIMIT)
    .readonly(),
  propositions: z.array(OpenSemanticPropositionSchema)
    .min(1)
    .max(OPEN_SEMANTIC_PROPOSITION_LIMIT)
    .readonly()
}).strict();

export const OpenSemanticFactorGraphProposalSchema =
  OpenSemanticFactorGraphStructureSchema.extend({
  factors: z.array(OpenSemanticFactorProposalSchema)
    .min(1)
    .max(OPEN_SEMANTIC_FACTOR_LIMIT)
    .readonly(),
  variables: z.array(OpenSemanticVariableProposalSchema)
    .max(OPEN_SEMANTIC_VARIABLE_LIMIT)
    .readonly()
}).strict().superRefine(validateGraphStructure).readonly();

export const OpenSemanticFactorGraphSchema = OpenSemanticFactorGraphStructureSchema.extend({
  factors: z.array(OpenSemanticFactorSchema)
    .min(1)
    .max(OPEN_SEMANTIC_FACTOR_LIMIT)
    .readonly(),
  variables: z.array(OpenSemanticVariableSchema)
    .max(OPEN_SEMANTIC_VARIABLE_LIMIT)
    .readonly()
}).strict().superRefine(validateGraphStructure).readonly();

export type OpenSemanticFactorProposal =
  z.infer<typeof OpenSemanticFactorProposalSchema>;
export type OpenSemanticVariableProposal =
  z.infer<typeof OpenSemanticVariableProposalSchema>;
export type OpenSemanticFactorGraphProposal =
  z.infer<typeof OpenSemanticFactorGraphProposalSchema>;
export type OpenSemanticFactor = z.infer<typeof OpenSemanticFactorSchema>;
export type OpenSemanticVariable = z.infer<typeof OpenSemanticVariableSchema>;
export type OpenSemanticArgument = z.infer<typeof OpenSemanticArgumentSchema>;
export type OpenSemanticProposition = z.infer<typeof OpenSemanticPropositionSchema>;
export type OpenSemanticFactorGraph = z.infer<typeof OpenSemanticFactorGraphSchema>;

export const OpenSemanticFactorFormationProposalSchema = z.object({
  schema_version: z.literal(1),
  producer_operator_id: CanonicalIdSchema,
  source_text: z.string().min(1).max(16_384),
  graph: OpenSemanticFactorGraphProposalSchema
}).strict().readonly();
export type OpenSemanticFactorFormationProposal =
  z.infer<typeof OpenSemanticFactorFormationProposalSchema>;

export const OpenSemanticFactorFormationStatusSchema = z.enum([
  "formed",
  "ineligible",
  "unavailable",
  "rejected"
]);
export const OpenSemanticFactorFormationCaptureSchema = z.object({
  schema_version: z.literal(1),
  operator_id: z.literal(OPEN_SEMANTIC_FACTOR_FORMATION_OPERATOR_ID),
  status: OpenSemanticFactorFormationStatusSchema,
  producer_operator_id: CanonicalIdSchema.nullable(),
  source_sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/u).nullable(),
  graph: OpenSemanticFactorGraphSchema.nullable(),
  capture_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/u)
}).strict().superRefine((capture, context) => {
  const formed = capture.status === "formed";
  if (formed !== (capture.producer_operator_id !== null &&
      capture.source_sha256 !== null && capture.graph !== null)) {
    context.addIssue({
      code: "custom",
      message: "formed open semantic factor capture requires producer, source, and graph"
    });
  }
  if (!formed && capture.graph !== null) {
    context.addIssue({
      code: "custom",
      message: "non-formed open semantic factor capture cannot contain a graph"
    });
  }
}).readonly();

export type OpenSemanticFactorFormationStatus =
  z.infer<typeof OpenSemanticFactorFormationStatusSchema>;
export type OpenSemanticFactorFormationCapture =
  z.infer<typeof OpenSemanticFactorFormationCaptureSchema>;
export type OpenSemanticFactorFormationCaptureBody = Omit<
  OpenSemanticFactorFormationCapture,
  "capture_digest"
>;

export function groundOpenSemanticFactorGraph(
  proposal: unknown,
  sourceText: string
): Readonly<OpenSemanticFactorGraph> | null {
  const parsed = OpenSemanticFactorGraphProposalSchema.safeParse(proposal);
  if (!parsed.success || sourceText.length === 0) return null;
  const groundedFactors = groundProposedSurfaces(parsed.data.factors, sourceText);
  const groundedVariables = groundProposedSurfaces(parsed.data.variables, sourceText);
  if (groundedFactors === null || groundedVariables === null ||
      hasDuplicateSourceSpans([...groundedFactors, ...groundedVariables])) {
    return null;
  }
  const grounded = OpenSemanticFactorGraphSchema.safeParse({
    ...parsed.data,
    factors: groundedFactors,
    variables: groundedVariables
  });
  return grounded.success ? canonicalGraph(grounded.data) : null;
}

function hasDuplicateSourceSpans(
  nodes: readonly Readonly<{ readonly source_span: readonly [number, number] }>[]
): boolean {
  const spans = nodes.map(({ source_span: [start, end] }) => `${start}:${end}`);
  return new Set(spans).size !== spans.length;
}

export function openSemanticFactorFormationCapturePreimage(
  capture: Readonly<OpenSemanticFactorFormationCaptureBody>
): string {
  return JSON.stringify([
    capture.schema_version,
    capture.operator_id,
    capture.status,
    capture.producer_operator_id,
    capture.source_sha256,
    capture.graph
  ]);
}

export function verifyOpenSemanticFactorFormationCapture(
  value: unknown,
  sha256: (preimage: string) => string
): OpenSemanticFactorFormationCapture {
  const capture = OpenSemanticFactorFormationCaptureSchema.parse(value);
  const { capture_digest: _digest, ...body } = capture;
  const expected = `sha256:${sha256(
    openSemanticFactorFormationCapturePreimage(body)
  )}`;
  if (capture.capture_digest !== expected) {
    throw new Error("open semantic factor formation capture digest mismatch");
  }
  return capture;
}

function validateGraphStructure(
  graph: Readonly<{
    source_kind: "evidence" | "query";
    factors: readonly Readonly<{ readonly factor_id: string }>[];
    variables: readonly Readonly<{ readonly variable_id: string }>[];
    result_variable_ids: readonly string[];
    propositions: readonly Readonly<OpenSemanticProposition>[];
  }>,
  context: z.RefinementCtx
): void {
  const factorIds = uniqueIds(graph.factors.map((factor) => factor.factor_id));
  const variableIds = uniqueIds(graph.variables.map((variable) => variable.variable_id));
  const propositionIds = uniqueIds(
    graph.propositions.map((proposition) => proposition.proposition_id)
  );
  if (factorIds === null || variableIds === null || propositionIds === null ||
      intersects(factorIds, variableIds)) {
    context.addIssue({ code: "custom", message: "open semantic identities must be unique" });
    return;
  }
  if (graph.source_kind === "evidence" && graph.variables.length > 0) {
    context.addIssue({ code: "custom", message: "evidence graph cannot contain variables" });
  }
  const resultVariableIds = uniqueIds(graph.result_variable_ids);
  if (resultVariableIds === null ||
      [...(resultVariableIds ?? [])].some((id) => !variableIds.has(id))) {
    context.addIssue({ code: "custom", message: "result variables must reference unique variables" });
  }
  if (graph.source_kind === "evidence" && graph.result_variable_ids.length > 0) {
    context.addIssue({ code: "custom", message: "evidence graph cannot declare result variables" });
  }
  const referencedFactors = new Set<string>();
  const referencedVariables = new Set<string>();
  for (const proposition of graph.propositions) {
    if (!factorIds.has(proposition.predicate_factor_id)) {
      context.addIssue({ code: "custom", message: "predicate factor is missing" });
    }
    referencedFactors.add(proposition.predicate_factor_id);
    validateArguments(
      proposition.arguments,
      factorIds,
      variableIds,
      referencedFactors,
      referencedVariables,
      context
    );
  }
  if ([...factorIds].some((id) => !referencedFactors.has(id)) ||
      [...variableIds].some((id) => !referencedVariables.has(id))) {
    context.addIssue({ code: "custom", message: "semantic factor graph has unbound values" });
  }
}

function validateArguments(
  arguments_: readonly Readonly<OpenSemanticArgument>[],
  factorIds: ReadonlySet<string>,
  variableIds: ReadonlySet<string>,
  referencedFactors: Set<string>,
  referencedVariables: Set<string>,
  context: z.RefinementCtx
): void {
  arguments_.forEach((argument, index) => {
    if (argument.position !== index) {
      context.addIssue({ code: "custom", message: "argument positions must be contiguous" });
    }
    const ids = argument.reference_kind === "factor" ? factorIds : variableIds;
    if (!ids.has(argument.reference_id)) {
      context.addIssue({ code: "custom", message: "argument reference is missing" });
      return;
    }
    const observed = argument.reference_kind === "factor"
      ? referencedFactors
      : referencedVariables;
    observed.add(argument.reference_id);
  });
}

function groundProposedSurfaces<T extends Readonly<{
  readonly surface: string;
  readonly source_occurrence: number;
}>>(
  items: readonly T[],
  sourceText: string
): readonly Readonly<Omit<T, "source_occurrence"> & {
  readonly source_span: readonly [number, number];
}>[] | null {
  const grounded = items.map((item) => {
    const sourceSpan = findSourceOccurrence(
      sourceText,
      item.surface,
      item.source_occurrence
    );
    if (sourceSpan === null) return null;
    const { source_occurrence: _occurrence, ...rest } = item;
    return Object.freeze({ ...rest, source_span: sourceSpan });
  });
  return grounded.some((item) => item === null)
    ? null
    : grounded as readonly Readonly<Omit<T, "source_occurrence"> & {
      readonly source_span: readonly [number, number];
    }>[];
}

function findSourceOccurrence(
  sourceText: string,
  surface: string,
  occurrence: number
): readonly [number, number] | null {
  let offset = 0;
  for (let index = 0; index <= occurrence; index += 1) {
    const start = sourceText.indexOf(surface, offset);
    if (start < 0) return null;
    if (index === occurrence) return Object.freeze([start, start + surface.length]);
    offset = start + surface.length;
  }
  return null;
}

function canonicalGraph(graph: OpenSemanticFactorGraph): OpenSemanticFactorGraph {
  return OpenSemanticFactorGraphSchema.parse({
    ...graph,
    factors: [...graph.factors].sort(compareGroundedSurfaces),
    variables: [...graph.variables].sort(compareGroundedSurfaces),
    result_variable_ids: [...graph.result_variable_ids].sort(compareText),
    propositions: [...graph.propositions]
      .map((proposition) => ({
        ...proposition,
        arguments: [...proposition.arguments].sort((left, right) =>
          left.position - right.position)
      }))
      .sort((left, right) => compareText(left.proposition_id, right.proposition_id))
  });
}

function compareGroundedSurfaces(
  left: Readonly<{ readonly source_span: readonly [number, number]; readonly surface: string }>,
  right: Readonly<{ readonly source_span: readonly [number, number]; readonly surface: string }>
): number {
  return left.source_span[0] - right.source_span[0] ||
    left.source_span[1] - right.source_span[1] ||
    compareText(left.surface, right.surface);
}

function uniqueIds(ids: readonly string[]): ReadonlySet<string> | null {
  const unique = new Set(ids);
  return unique.size === ids.length ? unique : null;
}

function intersects(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return [...left].some((value) => right.has(value));
}

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function normalizeSemanticIdentity(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}
