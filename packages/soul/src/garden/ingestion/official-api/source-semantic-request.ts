import { createHash } from "node:crypto";
import { z } from "zod";
import {
  AlayaError, BoundedIdSchema, SourceAssertionIdSchema, SourceSemanticAssertionLocationSchema, SourceSemanticInterpretationSchema, sourceSemanticInterpretationIdentity,
  SourceSemanticQuerySchema, SourceSemanticRequestEnvelopeSchema, SourceSemanticResponseEnvelopeSchema,
  SourceSemanticProposalSchema, SOURCE_SEMANTIC_PROPOSAL_CONTRACT, SOURCE_SEMANTIC_LEGACY_NORMALIZER_VERSION,
  SourceSemanticContentProposalSchema, SOURCE_SEMANTIC_CONTENT_PROPOSAL_CONTRACT,
  SOURCE_SEMANTIC_ENVELOPE_SCHEMA_VERSION, SOURCE_SEMANTIC_K_VERSION,
  SOURCE_SEMANTIC_NORMALIZER_VERSION, SOURCE_SEMANTIC_PACKET_CONTRACT,
  buildSourceReferenceCatalog, canonicalJson,
  type SourceInterpretationProfile, type SourceReferenceCatalog, type SourceSemanticQuery
} from "@do-soul/alaya-protocol";
import { SOURCE_SEMANTIC_SOURCE_UNIT_CONTRACT, selectSourceSemanticUnits } from "./source-semantic-units.js";
import { SOURCE_SEMANTIC_SYSTEM_PROMPT } from "./source-semantic-content-guidance.js";
import { CANONICAL_SOURCE_SEMANTIC_SYSTEM_PROMPT } from "./source-semantic-canonical-prompt.js";
export { SOURCE_SEMANTIC_SYSTEM_PROMPT } from "./source-semantic-content-guidance.js";

export const SOURCE_SEMANTIC_QUERY_REQUEST_CONTRACT = "source-semantic-query-request-v2" as const;
export const SOURCE_SEMANTIC_QUERY_RESPONSE_CONTRACT = "source-semantic-query-response-v2" as const;
export const SOURCE_SEMANTIC_ALIGNMENT_REQUEST_CONTRACT = "source-semantic-alignment-request-v2" as const;
export const SOURCE_SEMANTIC_ALIGNMENT_RESPONSE_CONTRACT = "source-semantic-alignment-response-v2" as const;

const FORBIDDEN_PROPOSAL_KEYS = [
  "answers", "answer", "ranking", "seeds", "seed", "programs", "program",
  "verdicts", "verdict", "QueryProgram", "query_program", "answer_ids", "answerIds"
] as const;

const SourceSemanticResourceLimitsSchema = z.object({
  output_byte_limit: z.number().int().min(1024).max(1024 * 1024),
  work_units: z.number().int().nonnegative().optional(),
  memory_bytes: z.number().int().nonnegative().optional()
}).strict().readonly();

const ProducerCapability = z.object({
  producer_id: BoundedIdSchema,
  producer_version: z.string().min(1).max(1024),
  proposes: z.literal("draft_semantics")
}).strict().readonly();

const SourceSemanticOpenRequestBodySchema = z.object({
  k_version: z.literal(SOURCE_SEMANTIC_K_VERSION),
  normalizer_version: z.enum([SOURCE_SEMANTIC_LEGACY_NORMALIZER_VERSION, SOURCE_SEMANTIC_NORMALIZER_VERSION]),
  proposal_contract: z.enum([SOURCE_SEMANTIC_PROPOSAL_CONTRACT, SOURCE_SEMANTIC_CONTENT_PROPOSAL_CONTRACT]).optional(),
  source_unit_contract: z.literal(SOURCE_SEMANTIC_SOURCE_UNIT_CONTRACT).optional(),
  producer_capability: ProducerCapability,
  resource_limits: SourceSemanticResourceLimitsSchema,
  assertion_locations: z.array(SourceSemanticAssertionLocationSchema).max(8).readonly().optional(),
  source_assertions: z.array(z.object({
    assertion_id: SourceAssertionIdSchema, text: z.string().trim().min(1), source_role: z.enum(["user", "assistant"]).optional()
  }).strict().readonly()).max(8).readonly()
}).strict().superRefine((request, context) => {
  const current = request.proposal_contract !== undefined;
  if (current !== (request.normalizer_version === SOURCE_SEMANTIC_NORMALIZER_VERSION)) {
    context.addIssue({ code: "custom", message: "proposal contract and normalizer version must agree" });
  }
  if (request.source_unit_contract === undefined && request.source_assertions.some((row) => row.source_role !== undefined)) {
    context.addIssue({ code: "custom", message: "source roles require the source unit contract" });
  }
  if (request.source_unit_contract !== undefined && (!current || request.source_assertions.some((row) => row.source_role === undefined))) {
    context.addIssue({ code: "custom", message: "source units require the current proposal contract and explicit source roles" });
  }
  if (request.proposal_contract === SOURCE_SEMANTIC_CONTENT_PROPOSAL_CONTRACT && request.source_unit_contract === undefined) {
    context.addIssue({ code: "custom", message: "content proposals require complete source units" });
  }
}).readonly();

const ApprovedContextSchema = z.object({
  context_id: BoundedIdSchema, notes: z.string().min(1).max(1024).optional()
}).strict().readonly();

const SourceSemanticHDescriptorSchema = z.object({
  h_id: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  interpretation: SourceSemanticInterpretationSchema
}).strict().superRefine((descriptor, context) => {
  if (sourceSemanticInterpretationIdentity(descriptor.interpretation, semanticSha256) !== descriptor.h_id) {
    context.addIssue({ code: "custom", message: "alignment descriptor identity differs from its interpretation" });
  }
}).readonly();

type SourceSemanticResourceLimits = z.infer<typeof SourceSemanticResourceLimitsSchema>;
type SourceSemanticOpenRequestBody = z.infer<typeof SourceSemanticOpenRequestBodySchema>;
type SourceSemanticApprovedContext = z.infer<typeof ApprovedContextSchema>;
export type SourceSemanticHDescriptor = z.infer<typeof SourceSemanticHDescriptorSchema>;

export type SourceSemanticRequest = Readonly<{
  schema_version: typeof SOURCE_SEMANTIC_ENVELOPE_SCHEMA_VERSION;
  interpretation_contract: typeof SOURCE_SEMANTIC_PACKET_CONTRACT;
  source_request: SourceSemanticOpenRequestBody;
  source_catalog: SourceReferenceCatalog;
  profile?: SourceInterpretationProfile;
}>;

export type SourceSemanticProposalInput = Readonly<{
  sourceCorpus: string;
  assertionIds: readonly number[];
  source_id: string;
  source_version: string;
  producer_id: string;
  producer_version: string;
  resource_limits?: Partial<SourceSemanticResourceLimits>;
  profile?: SourceInterpretationProfile;
}>;

export type SourceSemanticQueryProposalInput = Readonly<{
  original_query: string;
  approved_fixed_context?: SourceSemanticApprovedContext;
  producer_id: string;
  producer_version: string;
  resource_limits?: Partial<SourceSemanticResourceLimits>;
}>;

export type SourceSemanticAlignmentProposalInput = Readonly<{
  admitted_q: SourceSemanticQuery;
  h_descriptors: readonly SourceSemanticHDescriptor[];
  producer_id: string;
  producer_version: string;
  resource_limits?: Partial<SourceSemanticResourceLimits>;
}>;

export type SourceSemanticQueryRequest = Readonly<{
  contract: typeof SOURCE_SEMANTIC_QUERY_REQUEST_CONTRACT;
  k_version: typeof SOURCE_SEMANTIC_K_VERSION;
  original_query: string;
  original_query_digest: string;
  approved_fixed_context?: SourceSemanticApprovedContext;
  producer_capability: z.infer<typeof ProducerCapability>;
  resource_limits: SourceSemanticResourceLimits;
}>;

export type SourceSemanticAlignmentRequest = Readonly<{
  contract: typeof SOURCE_SEMANTIC_ALIGNMENT_REQUEST_CONTRACT;
  k_version: typeof SOURCE_SEMANTIC_K_VERSION;
  admitted_q: SourceSemanticQuery;
  h_descriptors: readonly SourceSemanticHDescriptor[];
  producer_capability: z.infer<typeof ProducerCapability>;
  resource_limits: SourceSemanticResourceLimits;
}>;

export function semanticSha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function rejectForbiddenProposalInput(value: object): void {
  for (const key of FORBIDDEN_PROPOSAL_KEYS) {
    if (Object.hasOwn(value, key)) {
      throw new AlayaError("VALIDATION", `semantic proposal input must not include ${key}`);
    }
  }
}

function resourceLimits(value?: Partial<SourceSemanticResourceLimits>): SourceSemanticResourceLimits {
  return SourceSemanticResourceLimitsSchema.parse({
    output_byte_limit: value?.output_byte_limit ?? 1024 * 1024,
    ...(value?.work_units !== undefined ? { work_units: value.work_units } : {}),
    ...(value?.memory_bytes !== undefined ? { memory_bytes: value.memory_bytes } : {})
  });
}

function producerCapability(producer_id: string, producer_version: string) {
  return ProducerCapability.parse({ producer_id, producer_version, proposes: "draft_semantics" });
}

export function parseSourceSemanticRequest(value: unknown): SourceSemanticRequest {
  const parsed = SourceSemanticRequestEnvelopeSchema.parse(value);
  const source_request = SourceSemanticOpenRequestBodySchema.parse(parsed.source_request);
  if (new Set(source_request.source_assertions.map((row) => row.assertion_id)).size !== source_request.source_assertions.length) {
    throw new AlayaError("VALIDATION", "source semantic request has duplicate assertion identities");
  }
  const catalog = buildSourceReferenceCatalog(parsed.source_catalog.source_digest, source_request.source_assertions, semanticSha256);
  if (canonicalJson(catalog) !== canonicalJson(parsed.source_catalog)) {
    throw new AlayaError("CONFLICT", "source semantic request catalog mismatch");
  }
  const request = { ...parsed, source_request } as SourceSemanticRequest;
  if (Buffer.byteLength(JSON.stringify(request), "utf8") > 1_000_000) {
    throw new AlayaError("VALIDATION", "source semantic request exceeds its byte bound");
  }
  return request;
}

export function buildSourceSemanticRequest(input: SourceSemanticProposalInput): SourceSemanticRequest {
  rejectForbiddenProposalInput(input);
  const units = selectSourceSemanticUnits(input.sourceCorpus, input.assertionIds);
  const source_request = SourceSemanticOpenRequestBodySchema.parse({
    k_version: SOURCE_SEMANTIC_K_VERSION,
    normalizer_version: SOURCE_SEMANTIC_NORMALIZER_VERSION,
    proposal_contract: SOURCE_SEMANTIC_CONTENT_PROPOSAL_CONTRACT,
    source_unit_contract: SOURCE_SEMANTIC_SOURCE_UNIT_CONTRACT,
    producer_capability: producerCapability(input.producer_id, input.producer_version),
    resource_limits: resourceLimits(input.resource_limits),
    assertion_locations: units.map((row) => ({
      assertion_id: row.assertion_id, source_utf8_span: [Buffer.byteLength(input.sourceCorpus.slice(0, row.start)), Buffer.byteLength(input.sourceCorpus.slice(0, row.end))]
    })),
    source_assertions: units.map(({ assertion_id, text, source_role }) => ({ assertion_id, text, source_role }))
  });
  return parseSourceSemanticRequest({
    schema_version: SOURCE_SEMANTIC_ENVELOPE_SCHEMA_VERSION,
    interpretation_contract: SOURCE_SEMANTIC_PACKET_CONTRACT,
    source_request,
    source_catalog: buildSourceReferenceCatalog(semanticSha256(input.sourceCorpus), source_request.source_assertions, semanticSha256),
    ...(input.profile !== undefined ? { profile: input.profile } : {})
  });
}

export function buildSourceSemanticQueryRequest(input: SourceSemanticQueryProposalInput): SourceSemanticQueryRequest {
  rejectForbiddenProposalInput(input);
  if (input.original_query.trim().length === 0) {
    throw new AlayaError("VALIDATION", "query proposal requires the original query");
  }
  const original_query = input.original_query;
  if (original_query.length > 8192) throw new AlayaError("VALIDATION", "original query exceeds its bound");
  return {
    contract: SOURCE_SEMANTIC_QUERY_REQUEST_CONTRACT,
    k_version: SOURCE_SEMANTIC_K_VERSION,
    original_query,
    original_query_digest: `sha256:${semanticSha256(original_query)}`,
    ...(input.approved_fixed_context !== undefined
      ? { approved_fixed_context: ApprovedContextSchema.parse(input.approved_fixed_context) } : {}),
    producer_capability: producerCapability(input.producer_id, input.producer_version),
    resource_limits: resourceLimits(input.resource_limits)
  };
}

export function buildSourceSemanticAlignmentRequest(
  input: SourceSemanticAlignmentProposalInput
): SourceSemanticAlignmentRequest {
  rejectForbiddenProposalInput(input);
  const admitted_q = SourceSemanticQuerySchema.parse(input.admitted_q);
  const h_descriptors = z.array(SourceSemanticHDescriptorSchema).min(1).max(64).parse(input.h_descriptors);
  if (Buffer.byteLength(JSON.stringify(h_descriptors)) > 1_000_000) throw new AlayaError("VALIDATION", "alignment descriptors exceed input budget");
  return {
    contract: SOURCE_SEMANTIC_ALIGNMENT_REQUEST_CONTRACT,
    k_version: SOURCE_SEMANTIC_K_VERSION,
    admitted_q,
    h_descriptors,
    producer_capability: producerCapability(input.producer_id, input.producer_version),
    resource_limits: resourceLimits(input.resource_limits)
  };
}

/** Producer JSON Schema selected by the recorded request contract, without profile enums. */
export function sourceSemanticResponseJsonSchema(request?: SourceSemanticRequest): object {
  const contract = request?.source_request.proposal_contract;
  const schema = request !== undefined && contract === undefined ? SourceSemanticResponseEnvelopeSchema
    : contract === SOURCE_SEMANTIC_PROPOSAL_CONTRACT ? SourceSemanticProposalSchema : SourceSemanticContentProposalSchema;
  return z.toJSONSchema(schema, {
    io: "input",
    override: ({ jsonSchema }) => {
      if (jsonSchema.const !== undefined) { jsonSchema.enum = [jsonSchema.const]; delete jsonSchema.const; }
    }
  });
}

const exampleGaps = [{ kind: "unresolved_referent", affected_ids: ["rItem"],
  support: [{ kind: "lexical", mentions: ["mItem"] }], description: "The thing shelved is not identified." },
  { kind: "uninterpreted_clause", affected_ids: ["mClause"],
    support: [{ kind: "lexical", mentions: ["mClause"] }], description: "This clause is left uninterpreted without inventing a frame." }];
const sourceSemanticResponseExample = {
  contract: SOURCE_SEMANTIC_PROPOSAL_CONTRACT,
  outcome: { status: "interpreted" },
  draft: {
    contract: "source-interpretation-v4",
    mentions: [
      { id: "mActor", assertion_id: 1, source_ref: { first: "a1s0", last: "a1s0" } },
      { id: "mShelved", assertion_id: 1, source_ref: { first: "a1s2", last: "a1s2" } },
      { id: "mItem", assertion_id: 1, source_ref: { first: "a1s4", last: "a1s4" } },
      { id: "mClause", assertion_id: 2, source_ref: { first: "a2s0", last: "a2s11" } }
    ],
    referents: [
      { id: "rActor", referent_kind: "grouped", mentions: ["mActor"] },
      { id: "rItem", referent_kind: "unresolved", mentions: ["mItem"] }
    ],
    frames: [{
      id: "fShelve", assertion_ids: [1], context_owner: { kind: "source_act", source_act: "assertion" },
      additional_support: [], predicate_support: { kind: "explicit", reading: "shelve", mentions: ["mShelved"] },
      slots: [
        { id: "agent", role_reading: "person doing the shelving", support: [{ kind: "lexical", mentions: ["mActor"] }] },
        { id: "theme", role_reading: "thing placed on a shelf", support: [{ kind: "lexical", mentions: ["mItem"] }] }
      ],
      bindings: [
        { slot_id: "agent", target: { kind: "node", id: "rActor" }, support: [] },
        { slot_id: "theme", target: { kind: "node", id: "rItem" }, support: [] }
      ]
    }],
    operators: [], gaps: exampleGaps
  }
};

// Retained graph proposals select these exact prompt bytes for cache replay.
const LEGACY_SOURCE_SEMANTIC_SYSTEM_PROMPT = [
  "Propose one source-local semantic draft using source-interpretation-v4.",
  'Return strict JSON {"contract":"source-semantic-proposal-v1","outcome":OUTCOME,"draft":DRAFT_IF_INTERPRETED}. Interpreted OUTCOME is exactly {"status":"interpreted"}; draft.gaps is the sole gap list.',
  "Ask only for draft semantics: mention handles with catalog first/last selections, referents, frames with predicate and role readings, slot definitions versus bindings, operators, context owners, lexical/additional/dominating support, and explicit gaps.",
  "Do not emit host hashes, character or UTF-8 offsets, entry_roots, asserted_at_scope, persistent IDs, QueryProgram, seeds, scores, ranking, answers, or verdicts.",
  "A supplied profile is an optional adapter, not an admission prerequisite. Novel predicate and role readings are allowed.",
  "Select inclusive first/last segment IDs shown in source_catalog. Never copy quotation text, invent offsets, or cross assertion boundaries.",
  "Keep catalog segment IDs separate from graph handles: source_catalog segment IDs (for example a1s2) occur ONLY inside source_ref.first/last. Graph mention IDs (for example mShelved) are declared in draft.mentions[].id. Every predicate mentions/supporting_context, referent mentions, lexical/additional support.mentions (including role, binding and gap support) MUST refer to those declared graph mention IDs, never catalog segment IDs.",
  "Declare a mention for every source span used by predicates, roles, bindings and gaps. Mentions locate evidence; they are not argument nodes.",
  'For a binding target {"kind":"node","id":ID}, ID must name a declared draft.referents[].id, draft.frames[].id, or draft.operators[].id. A mention ID, catalog segment ID, frame-local slot ID, or undeclared handle is not a node target.',
  'For a source-supported entity or value, declare a referent (one mention is sufficient for referent_kind="grouped") and bind to that referent, not its mention. For an unresolved role target use {"kind":"unresolved"} without id, or omit its binding and retain a located gap; never fabricate a participant to complete a slot.',
  "A gap affected_ids entry may name a declared mention, referent, frame, or operator. For an uninterpreted clause with no frame, declare a mention for its source span and use that mention in affected_ids and lexical support. Never cite a hypothetical or omitted frame as if it were declared.",
  "Each binding slot_id must name a slot defined by that same frame. Dominating support via_id must name a declared referent, frame, or operator, not a mention. Check each reference against its required kind before returning the draft; prefixes alone do not declare a handle.",
  'An embedded occurrence uses context_owner={"kind":"embedding","parent_frame":PARENT_FRAME_ID}. Do not emit content_argument: the host derives the current occurrence ID. The parent binding identifies its content target; do not assert the embedded action independently.',
  "Cover every selected source assertion with interpreted meaning or an explicit located draft.gaps entry. Locate gap support through declared mentions for that assertion. Do not silently omit clauses that are difficult to interpret.",
  "Explicit predicate support needs valid mention handles; implicit support needs supporting context and a reading. Empty or omitted support is a gap, not implicit.",
  "Unresolved referents are local. Do not mint a global unknown. Record unsupported meaning as gaps.",
  'For source universals use operator="forall" with binder, domain, restriction (a governed occurrence or null), and content. Bind its body with {kind:"bound_variable",quantifier:OPERATOR_ID,binder:BINDER}. Nested universal binders are unsupported: retain a located gap instead of flattening them.',
  'Optional domains contain {id,context:OWNER_ID_OR_NULL,support,members:[{referent,evidence,restrictions:[{restriction,evidence}]}],exclusions:[{referent,evidence}],closure:{kind:"open"}|{kind:"closed",evidence}}. Membership/restriction/closure evidence must be occurrences in the declared context; null requires source assertions. Lists are bounded to64 members. A universal claim does not establish a complete census. Preserve promise/report/negative ownership.',
  'Optional measurements contain {id,subject,owner,population,metric,unit,context,value,support}. value is an exact decimal string (128 digits,64 fractional digits maximum), with source support. Distinct values for the same subject/population/metric/unit/context require an explicit context distinction. Do not turn subjective easiest/best wording into objective values or rankings.',
  "Outcome interpreted requires a draft; abstained, invalid, quarantine, truncated, and transport failures must not carry a draft.",
  "For interpreted output, emit gaps only in draft.gaps. Do not repeat gaps in outcome; the host derives the canonical envelope from the draft.",
  "Do not infer world truth or confidence. Admission of a draft does not certify language fidelity.",
  "Neutral partial example, not the current input: assertion 1 is Mira shelved something. Its catalog segments are a1s0=Mira, a1s1=space, a1s2=shelved, a1s3=space, a1s4=something, a1s5=period. Assertion 2 is The label is hard to interpret. Its segments are a2s0=The, a2s1=space, a2s2=label, a2s3=space, a2s4=is, a2s5=space, a2s6=hard, a2s7=space, a2s8=to, a2s9=space, a2s10=interpret, a2s11=period. This example deliberately leaves assertion 2 as a mention-located gap without a frame. Use the current request's catalog for your response.",
  `Example response:\n${JSON.stringify(sourceSemanticResponseExample)}`
].join("\n");

/** A retained request selects its producer syntax and prompt together. */
export function sourceSemanticSystemPrompt(request: SourceSemanticRequest): string {
  if (request.source_request.proposal_contract === undefined) return CANONICAL_SOURCE_SEMANTIC_SYSTEM_PROMPT;
  return request.source_request.proposal_contract === SOURCE_SEMANTIC_CONTENT_PROPOSAL_CONTRACT
    ? SOURCE_SEMANTIC_SYSTEM_PROMPT : LEGACY_SOURCE_SEMANTIC_SYSTEM_PROMPT;
}

export const SOURCE_SEMANTIC_QUERY_SYSTEM_PROMPT = [
  "Propose query interpretation for the original query only, using source-semantic-query-v2 body fields.",
  "Return variables, frames, role requirements, context obligations, finite alternatives, and located gaps.",
  "Do not emit answers, ranking, seeds, QueryProgram, programs, verdicts, or source answer IDs.",
  "Bind meaning to the original query text. Approved fixed context is given; do not invent H or A.",
  'Optional domains are {id,support:{kind:"query_text",excerpt}}. Universal evaluation is {kind:"forall",domain,binder,local_variables}; binders occur in the body and cannot be returned. entailed_at_source requests inference; asserted_at_source requests a literal assertion. Counterexample alternatives use purpose:"counterexample" and explicit negated-body incidence.',
  'Comparison evaluation is {kind:"comparison",domain,operation:"lt"|"le"|"eq"|"ge"|"gt"|"minimum"|"maximum",left,right?,strict,metric,unit,context,scope:"asserted"|"preserve"}. Comparison alternatives have empty frames/context_obligations. Pairwise strict is true only for lt/gt; extrema omit right and explicitly choose strictness. Return only operand variables.',
  "For interpreted output, outcome.gaps must exactly echo query.gaps. Retain partial meaning and located gaps in the query body."
].join(" ");

export const SOURCE_SEMANTIC_ALIGNMENT_SYSTEM_PROMPT = [
  "Propose alignment correspondences from admitted Q endpoints to the supplied H descriptors.",
  "Use contextual equivalence only. Do not emit answers, ranking, seeds, programs, verdicts, or chosen results.",
  "Do not invent H structure or rewrite Q.",
  'Optional domains map {query_domain,source_domain,query_support,source_semantic_support}. Explicit conditional membership assumptions are {query_variable,source_domain,restrictions:[],status:"member"|"excluded",query_support,description}; use only assumptions stated in the query/context, never infer identity from a matching surface name. Closed source domains cannot acquire novel assumed members.',
  "An interpreted alignment has no gap channel: outcome.gaps must be empty. Use abstained if no supported alignment can be proposed."
].join(" ");
