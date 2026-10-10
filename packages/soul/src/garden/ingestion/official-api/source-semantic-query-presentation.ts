import { z } from "zod";
import {
  AlayaError, sourceSemanticProducerEnvelopeJsonSchema, sourceSemanticProducerGenerationOutcomeSchema,
  SourceSemanticQueryCarrierBodySchema, SourceSemanticQueryMeaningBodySchema,
  SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT, SOURCE_SEMANTIC_QUERY_MEANING_MAX_DEPTH,
  type SourceSemanticQueryPresentation
} from "@do-soul/alaya-protocol";
import { producerResponseJsonSchema } from "./source-semantic-response-schema.js";
import { sourceSemanticQueryPresentation, type SourceSemanticQueryRequest } from "./source-semantic-request.js";
import {
  sourceSemanticQueryExamples, sourceSemanticQueryNestedExamples,
  SOURCE_SEMANTIC_QUERY_MEANING_RESPONSE_CONTRACT, SOURCE_SEMANTIC_QUERY_NESTED_RESPONSE_CONTRACT
} from "./source-semantic-query-examples.js";
export { SOURCE_SEMANTIC_QUERY_MEANING_RESPONSE_CONTRACT, SOURCE_SEMANTIC_QUERY_NESTED_RESPONSE_CONTRACT }
  from "./source-semantic-query-examples.js";

function isJsonSchemaObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function derefJsonSchema(root: Record<string, unknown>, node: Record<string, unknown>): Record<string, unknown> {
  if (typeof node.$ref !== "string") return node;
  const pointer = node.$ref;
  if (!pointer.startsWith("#/")) throw new AlayaError("VALIDATION", `unresolved generation schema pointer ${pointer}`);
  let current: unknown = root;
  for (const part of pointer.slice(2).split("/")) {
    current = isJsonSchemaObject(current) ? current[part.replace(/~1/gu, "/").replace(/~0/gu, "~")] : undefined;
    if (!isJsonSchemaObject(current)) throw new AlayaError("VALIDATION", `unresolved generation schema pointer ${pointer}`);
  }
  if (!isJsonSchemaObject(current)) throw new AlayaError("VALIDATION", `unresolved generation schema pointer ${pointer}`);
  return derefJsonSchema(root, current);
}

function queryReferenceSchema(schema: Record<string, unknown>, target: Record<string, unknown>): object {
  const resolved = derefJsonSchema(schema, target);
  const variants = Array.isArray(resolved.oneOf) ? resolved.oneOf : Array.isArray(resolved.anyOf) ? resolved.anyOf : [];
  for (const variant of variants) {
    if (!isJsonSchemaObject(variant)) continue;
    const shape = derefJsonSchema(schema, variant);
    const properties = isJsonSchemaObject(shape.properties) ? shape.properties : undefined;
    const kind = isJsonSchemaObject(properties?.kind) ? derefJsonSchema(schema, properties.kind) : undefined;
    if (Array.isArray(kind?.enum) && kind.enum.length === 1 && kind.enum[0] === "reference") return structuredClone(shape);
  }
  throw new AlayaError("VALIDATION", "query target schema is missing a local reference variant");
}

/** Use one producer declaration location; historical receive syntax remains unchanged. */
function constrainQueryGenerationNodes(schema: Record<string, unknown>, body: Record<string, unknown>,
  presentation: SourceSemanticQueryPresentation): void {
  const properties = isJsonSchemaObject(body.properties) ? body.properties : undefined;
  let expressions = isJsonSchemaObject(properties?.nodes) ? properties.nodes : undefined;
  if (presentation === "nested-meaning-v1") {
    const alternatives = isJsonSchemaObject(properties?.alternatives) ? properties.alternatives : undefined;
    if (!isJsonSchemaObject(alternatives?.items)) throw new AlayaError("VALIDATION", "query meaning schema is missing alternatives.items");
    const alternative = derefJsonSchema(schema, alternatives.items);
    const fields = isJsonSchemaObject(alternative.properties) ? alternative.properties : undefined;
    expressions = isJsonSchemaObject(fields?.conditions) ? fields.conditions : undefined;
  }
  if (!isJsonSchemaObject(expressions?.items)) throw new AlayaError("VALIDATION", "query schema is missing expression items");
  const node = derefJsonSchema(schema, expressions.items);
  const variants = Array.isArray(node.oneOf) ? node.oneOf : Array.isArray(node.anyOf) ? node.anyOf : [];
  let found = false;
  for (const variant of variants) {
    if (!isJsonSchemaObject(variant)) continue;
    const shape = derefJsonSchema(schema, variant);
    const fields = isJsonSchemaObject(shape.properties) ? shape.properties : undefined;
    if (isJsonSchemaObject(fields?.reporter)) fields.reporter = queryReferenceSchema(schema, fields.reporter);
    if (!isJsonSchemaObject(fields?.arguments)) continue;
    if (!isJsonSchemaObject(fields.arguments.items)) throw new AlayaError("VALIDATION", "query role schema is missing items");
    const argument = derefJsonSchema(schema, fields.arguments.items);
    if (!isJsonSchemaObject(argument.properties) || !isJsonSchemaObject(argument.properties.excerpt)
      || !isJsonSchemaObject(argument.properties.target)) {
      throw new AlayaError("VALIDATION", "query role schema is missing excerpt or target");
    }
    argument.properties.target = queryReferenceSchema(schema, argument.properties.target);
    argument.required = [...new Set([...(Array.isArray(argument.required) ? argument.required : []), "excerpt"])];
    found = true;
  }
  if (!found) throw new AlayaError("VALIDATION", "query schema is missing statement arguments");
}

/** Derive either presentation's producer constraints from the shared meaning body owner. */
function constrainQueryGenerationSchema(envelope: object, presentation: SourceSemanticQueryPresentation): object {
  const schema = structuredClone(envelope) as Record<string, unknown>;
  const properties = isJsonSchemaObject(schema.properties) ? schema.properties : undefined;
  if (!isJsonSchemaObject(properties?.query)) {
    throw new AlayaError("VALIDATION", "query generation schema is missing properties.query");
  }
  const body = structuredClone(derefJsonSchema(schema, properties.query));
  constrainQueryGenerationNodes(schema, body, presentation);
  const bodyProperties = isJsonSchemaObject(body.properties) ? body.properties : undefined;
  if (body.anyOf !== undefined || body.oneOf !== undefined || bodyProperties?.requested_operation === undefined
    || !isJsonSchemaObject(bodyProperties.entities) || !isJsonSchemaObject(bodyProperties.alternatives)
    || bodyProperties.alternatives.items === undefined) {
    throw new AlayaError("VALIDATION", "query carrier body cannot encode the operation/input generation union");
  }
  if (!isJsonSchemaObject(bodyProperties.entities.items)) throw new AlayaError("VALIDATION", "query entity schema is missing items");
  const entity = derefJsonSchema(schema, bodyProperties.entities.items);
  const declarations = Array.isArray(entity.oneOf) ? entity.oneOf : Array.isArray(entity.anyOf) ? entity.anyOf : [];
  if (declarations.length === 0) throw new AlayaError("VALIDATION", "query entity schema is missing declaration variants");
  for (const declaration of declarations) {
    if (!isJsonSchemaObject(declaration)) throw new AlayaError("VALIDATION", "invalid query entity declaration schema");
    const shape = derefJsonSchema(schema, declaration);
    if (!isJsonSchemaObject(shape.properties) || !isJsonSchemaObject(shape.properties.excerpt)) {
      throw new AlayaError("VALIDATION", "query entity declaration schema is missing excerpt");
    }
    shape.required = [...new Set([...(Array.isArray(shape.required) ? shape.required : []), "excerpt"])];
  }
  body.required = [...new Set([...(Array.isArray(body.required) ? body.required : []), "entities"])];
  const { contract, entities, nodes, ...remaining } = bodyProperties;
  body.properties = { contract, entities, ...(nodes === undefined ? {} : { nodes }), ...remaining };
  const itemNode = isJsonSchemaObject(bodyProperties.alternatives.items)
    ? bodyProperties.alternatives.items : { $ref: bodyProperties.alternatives.items };
  const items = structuredClone(derefJsonSchema(schema, itemNode));
  if (!isJsonSchemaObject(items.properties) || items.properties.evidence_inputs === undefined) {
    throw new AlayaError("VALIDATION", "query alternative schema is missing evidence_inputs");
  }
  const withOperation = structuredClone(body);
  const required = Array.isArray(withOperation.required) ? [...withOperation.required as string[]] : [];
  if (!required.includes("requested_operation")) required.push("requested_operation");
  withOperation.required = required;
  const withoutInputs = structuredClone(body);
  const residualItems = structuredClone(items);
  delete (residualItems.properties as Record<string, unknown>).evidence_inputs;
  if (Array.isArray(residualItems.required)) {
    residualItems.required = (residualItems.required as string[]).filter((key) => key !== "evidence_inputs");
  }
  (withoutInputs.properties as Record<string, unknown>).alternatives = {
    ...structuredClone(bodyProperties.alternatives), items: residualItems
  };
  const defsKey = schema.$defs !== undefined ? "$defs" : schema.definitions !== undefined ? "definitions" : "$defs";
  const defs = isJsonSchemaObject(schema[defsKey]) ? schema[defsKey] as Record<string, unknown> : {};
  for (const name of ["queryRequiresRequestedOperation", "queryOmitsEvidenceInputs"]) {
    if (defs[name] !== undefined) throw new AlayaError("VALIDATION", `generation schema already defines ${defsKey}.${name}`);
  }
  schema[defsKey] = {
    ...defs,
    queryRequiresRequestedOperation: withOperation,
    queryOmitsEvidenceInputs: withoutInputs
  };
  properties.query = {
    ...(properties.query.readOnly === undefined ? {} : { readOnly: properties.query.readOnly }),
    anyOf: [{ $ref: `#/${defsKey}/queryRequiresRequestedOperation` }, { $ref: `#/${defsKey}/queryOmitsEvidenceInputs` }]
  };
  return schema;
}

/** Generation envelope for query semantics. Syntax follows the request contract; never inferred from body fields. */
export function sourceSemanticQueryResponseContract(request?: Pick<SourceSemanticQueryRequest, "contract">) {
  return sourceSemanticQueryPresentation(request) === "nested-meaning-v1"
    ? SOURCE_SEMANTIC_QUERY_NESTED_RESPONSE_CONTRACT : SOURCE_SEMANTIC_QUERY_MEANING_RESPONSE_CONTRACT;
}

export function sourceSemanticQueryResponseJsonSchema(request?: Pick<SourceSemanticQueryRequest, "contract">): object {
  const presentation = sourceSemanticQueryPresentation(request);
  return sourceSemanticProducerEnvelopeJsonSchema(constrainQueryGenerationSchema(producerResponseJsonSchema(z.object({
    contract: z.literal(sourceSemanticQueryResponseContract(request)),
    outcome: sourceSemanticProducerGenerationOutcomeSchema("query"),
    query: (presentation === "nested-meaning-v1" ? SourceSemanticQueryMeaningBodySchema : SourceSemanticQueryCarrierBodySchema).optional()
  }).strict().readonly(), "ref"), presentation), "query");
}

const QUERY_MEANING_GUIDANCE = [
  `Propose query meaning for the original query only, using ${SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT}.`,
  "Decide meaning in this order, using only the original query and approved fixed context; the model chooses relations, referents, scope and qualifications. The host derives IDs, sorts, incidence and evidence branches, not omitted meaning.",
  '1. Identify the requested result and task. A property answer needs that property relation: a name is a value of has name, distinct from the named object. Days attended per week counts distinct days, not class sessions per week. For advice, recommendation, comparison or calculation retain requested_operation:{reading,support:{kind:"query_text",excerpt}}. Current advice seeks useful advice or candidates for its stated topic; a historical request event is sought only when the query explicitly asks about that past request. Polite can/could you wording normally requests the task. Preserve the actual target, population, distinctness and qualifications without inventing preferences or useful facts.',
  '2. Choose referents and returns. Declare every named/free entity once in entities, with an exact query excerpt; use [] when none exist. Unknown answers and lawful witnesses are free; speakers, addressees and definite participants are named even before source identity is known. A free excerpt grounds its role, not its value or class. Local keys are arbitrary identifiers, never text evidence or identity. Mark only requested entities, statements or operators return:true on their declarations; Boolean questions and operation inputs have no fabricated returns. Keep an unresolved named referent named and locate an unresolved_referent gap, or abstain if no usable faithful meaning remains. Unknown source correspondence alone requires no gap.',
  '3. Build the direct answer conditions as one conjunction of the requested relation and all its stated restrictions. Each answer branch must carry its own participants, class, time, modality, unit and population restrictions in predicates/roles or located gaps. Named descriptions retain their referent constraint; free values require connected class or property relations. Excerpts and requested_operation do not supply missing predicates. A qualified direct comparison can be asserted without either numeric operand fact: express which metric, owner and operands are compared in the answer relation itself, rather than requiring both values. If no faithful answer relation is expressible, retain conditions:[] with the operation and inputs.',
  '4. Add independently useful evidence_inputs:[{conditions:[...]}] for the requested operation. Qualify each input independently, including its event, participants, classification, time and units. Separate alternative input actions instead of joining all actions into the answer. Inputs do not execute the task or prove its result. A reference to an event shares identity but imports neither its occurrence nor its classifications. Reuse a keyed event with {kind:"occurrence",key} when its full condition is needed, and also include connected qualification conditions needed by this branch.',
  '5. Set scope and evidence act. Use statement:{predicate,arguments,content?} and explicit operators; content preserves what another event says, asks or requires, without separately asserting the embedded event. possible, not, reported and conditional retain their governing scope. Omit required_evidence_act for ordinary factual questions: the current question form does not request source question evidence. Use required_evidence_act:{act,excerpt} only when the query explicitly seeks a source question or directive, on that independently sought root. entailed_at_source requests inference; asserted_at_source requests a literal assertion. Marking an input event as returned or as a source question changes what evidence is sought.',
  '6. Retain qualifications and residuals. Encode tense relative to the approved interpretation clock, completion/aspect, modality and units in meaningful predicates/roles, or query.gaps:[{kind,affected_ids,support:[{kind:"query_text",excerpt}],description?}]. A bare event lemma does not encode past occurrence. Preserve only stated temporal restrictions; invent no dates. affected_ids names declared semantic entity, occurrence/frame or domain keys, or [] for unrepresented meaning; serialization tokens are not gap targets. Omit outcome.gaps so the host echoes this single list. A gap records missing or unsupported meaning, not a substitute for expressible meaning or a complete answer. Do not add a gap solely because a requested operation is unexecuted; the host derives execution status from requested_operation. Execution status neither supplies nor removes a faithful answer relation or its qualified inputs.',
  '7. Use existing evaluation forms when applicable. domains are {key,excerpt}; universal evaluation is {kind:"forall",domain,binder,local_variables}, with a body-bound binder that cannot be returned. Population restrictions are not named entities or invented censuses; unknown members do not imply an unresolved referent. Nested universals remain unsupported. Counterexample alternatives use purpose:"counterexample". Comparison evaluation is {kind:"comparison",domain,operation:"lt"|"le"|"eq"|"ge"|"gt"|"minimum"|"maximum",left,right?,strict,metric,unit,context,scope:"asserted"|"preserve"}; declare operands as entities and return only operand keys. Pairwise strict is true only for lt/gt; extrema omit right and choose strictness explicitly. Evaluation has no nested meaning.',
].join(" ");

const SERIALIZATION_BOUND = `8. Serialize the chosen meaning. A nesting path has at most ${SOURCE_SEMANTIC_QUERY_MEANING_MAX_DEPTH + 1} statement/operator nodes; deeper meaning remains a located gap.`;
const ROLE_SUPPORT = 'all argument and reporter targets use {kind:"reference",key}, with reporters entity-only. Every role carries its own exact original-query excerpt, including event references and free input values.';
const SERIALIZATION_OUTPUT = "Semantic event references do not make branch roots. Emit meaning, not answers, graphs, hashes, programs, execution statistics, ranking or verdicts.";
const EXAMPLE_CONTRASTS = "Contrast current advice with a past advice request, object identity with its name, and days per week with session frequency. The bead comparison keeps a qualified direct answer separate from its operand inputs; the elapsed-hours inputs each reuse their own qualified event.";

function renderQuerySystemPrompt(presentation: SourceSemanticQueryPresentation): string {
  const nested = presentation === "nested-meaning-v1";
  const serialization = nested
    ? `${SERIALIZATION_BOUND} Declare entities before alternatives; ${ROLE_SUPPORT} Write expressions directly in conditions and operator content/antecedent/consequent/operands. The host assigns canonical node IDs and branch frame lists; do not emit nodes, node tokens or canonical graphs. Keep semantic keys when references, occurrence reuse, returns, gaps, domains or evaluation require them; preserve separate occurrences instead of deduplicating equal-looking expressions. ${SERIALIZATION_OUTPUT}`
    : `${SERIALIZATION_BOUND} Declare entities before nodes; ${ROLE_SUPPORT} Serialize each expression occurrence once in nodes with a separate node token, then branch roots; conditions and operator content/antecedent/consequent/operands contain tokens, never embedded expressions. Tokens resolve once, with no cycles or unreachable nodes. ${SERIALIZATION_OUTPUT}`;
  const examples = nested ? sourceSemanticQueryNestedExamples : sourceSemanticQueryExamples;
  return `${QUERY_MEANING_GUIDANCE} ${serialization} Complete neutral examples, not the current input: ${JSON.stringify(examples)}. ${EXAMPLE_CONTRASTS}`;
}

export const SOURCE_SEMANTIC_QUERY_SYSTEM_PROMPT = renderQuerySystemPrompt("flat-carrier-v1");
const NESTED_QUERY_SYSTEM_PROMPT = renderQuerySystemPrompt("nested-meaning-v1");

export function sourceSemanticQuerySystemPrompt(request?: Pick<SourceSemanticQueryRequest, "contract">): string {
  return sourceSemanticQueryPresentation(request) === "nested-meaning-v1"
    ? NESTED_QUERY_SYSTEM_PROMPT : SOURCE_SEMANTIC_QUERY_SYSTEM_PROMPT;
}
