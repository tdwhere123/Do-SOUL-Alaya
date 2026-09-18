import { SOURCE_INTERPRETATION_SCOPE_OPERATORS, SourceInterpretationProfileSchema, SourceInterpretationSymbolSchema } from "./source-interpretation-profile.js";
import { z } from "zod";
import { BoundedIdSchema, BoundedLabelSchema } from "../shared/schema-primitives.js";
import { SourceAssertionIdSchema } from "../evidence/source-selection.js";
import { SourceReferenceSchema } from "../evidence/source-reference.js";
import { sameSourceEvidenceRoot, SourceEvidenceTargetSchema } from "../recall/conditional-field/product-identity.js";
import { QueryProgramSchema, RequestBudgetSchema } from "../recall/conditional-field/query.js";
import { InformationIndexSchema } from "../recall/conditional-field/index-view.js";
import { Sha256HexSchema, Sha256DigestSchema } from "../recall/conditional-field/common.js";

const LocalId = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/u);
const Mention = z.object({ id: LocalId, assertion_id: SourceAssertionIdSchema,
  source_ref: SourceReferenceSchema }).strict().readonly();
const Argument = z.object({ role: SourceInterpretationSymbolSchema, target: LocalId }).strict().readonly();
const Referent = z.object({ id: LocalId, mentions: z.array(LocalId).min(1).max(64).readonly() }).strict().readonly();
const Proposition = z.object({ id: LocalId, predicate: SourceInterpretationSymbolSchema,
  implicit: z.boolean(), predicate_mentions: z.array(LocalId).max(8).readonly(),
  assertion_ids: z.array(SourceAssertionIdSchema).min(1).max(64).readonly(),
  arguments: z.array(Argument).max(8).readonly() }).strict().readonly();
const Operator = z.object({ id: LocalId,
  operator: z.enum(SOURCE_INTERPRETATION_SCOPE_OPERATORS),
  assertion_ids: z.array(SourceAssertionIdSchema).min(1).max(64).readonly(),
  operands: z.array(Argument).min(1).max(8).readonly() }).strict().readonly();

/** Semantic symbols are nominations. Only mention selections claim literal source text. */
export const SourceInterpretationPacketSchema = z.object({
  contract: z.literal("source-interpretation-v2"),
  profile_id: BoundedIdSchema,
  source_catalog_id: Sha256DigestSchema,
  mentions: z.array(Mention).max(512).readonly(),
  referents: z.array(Referent).max(256).readonly(),
  propositions: z.array(Proposition).min(1).max(256).readonly(),
  operators: z.array(Operator).max(256).readonly(),
  roots: z.array(LocalId).min(1).max(64).readonly()
}).strict().superRefine((packet, context) => {
  const problem = (message: string) => context.addIssue({ code: "custom", message });
  const mentions = new Set(packet.mentions.map((row) => row.id));
  const nodes = [...packet.referents, ...packet.propositions, ...packet.operators];
  const ids = new Set(nodes.map((row) => row.id));
  const statements = new Set([...packet.propositions, ...packet.operators].map((row) => row.id));
  if (mentions.size !== packet.mentions.length || ids.size !== nodes.length ||
      nodes.some((node) => mentions.has(node.id))) problem("packet local identities must be unique");
  if (new Set(packet.roots).size !== packet.roots.length || packet.roots.some((id) => !statements.has(id))) {
    problem("roots must identify unique propositions or scope operators");
  }
  for (const node of packet.referents) if (node.mentions.some((id) => !mentions.has(id))) problem("unknown referent mention");
  for (const node of packet.propositions) {
    if ((!node.implicit && node.predicate_mentions.length === 0) ||
        (node.implicit && node.predicate_mentions.length !== 0) ||
        node.predicate_mentions.some((id) => !mentions.has(id))) problem("predicate literal and implicit evidence disagree");
  }
  const children = new Map([...packet.propositions.map((row) => [row.id, row.arguments] as const),
    ...packet.operators.map((row) => [row.id, row.operands] as const)]);
  for (const args of children.values()) if (args.some((arg) => !ids.has(arg.target))) problem("unknown packet node reference");
  const visited = new Set<string>();
  const walk = (id: string): void => {
    if (visited.has(id)) return;
    visited.add(id);
    for (const arg of children.get(id) ?? []) walk(arg.target);
  };
  for (const root of packet.roots) walk(root);
  if (visited.size !== ids.size) problem("packet has unreachable nodes");
}).readonly();

export const PublishedSourceInterpretationPacketSchema = z.object({
  contract: z.literal("published-source-interpretation-v2"),
  packet_id: BoundedIdSchema,
  hypothesis_id: BoundedIdSchema,
  semantic_status: z.literal("unreviewed"),
  source_target: SourceEvidenceTargetSchema,
  artifact_key: BoundedIdSchema,
  provenance: z.object({ request_key: BoundedIdSchema, raw_response_id: BoundedIdSchema,
    producer_id: BoundedIdSchema,
    cache_admission: z.object({ generation_sha256: Sha256HexSchema, request_key: Sha256HexSchema,
      raw_json_sha256: Sha256HexSchema }).strict().readonly().optional(),
    // Absence is an authored/legacy local draft without retained transport evidence.
    transport: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("unavailable") }).strict(),
      z.object({ kind: z.literal("gemini_batch"), plan_identity: Sha256HexSchema,
        model: BoundedLabelSchema, request_profile: BoundedLabelSchema, max_output_tokens: z.number().int().positive(),
        request_sha256: Sha256HexSchema, job: BoundedIdSchema, input_file: BoundedIdSchema,
        input_sha256: Sha256HexSchema, output_sha256: Sha256HexSchema, response_sha256: Sha256HexSchema,
        finish_reason: z.literal("STOP"), attempt_ordinal: z.number().int().positive()
      }).strict()
    ]).optional()
  }).strict().readonly(),
  assertions: z.array(z.object({ assertion_id: SourceAssertionIdSchema, text: z.string().min(1),
    source_span: z.tuple([z.number().int().nonnegative(), z.number().int().positive()]).readonly()
  }).strict().readonly()).min(1).max(64).readonly(),
  mention_spans: z.array(z.object({ id: LocalId, text: z.string().min(1).max(65536),
    utf8_span: z.tuple([z.number().int().nonnegative(), z.number().int().positive()]).readonly()
  }).strict().readonly()).max(512).readonly(),
  packet: SourceInterpretationPacketSchema,
  profile: SourceInterpretationProfileSchema
}).strict().readonly();

export type SourceInterpretationPacket = z.infer<typeof SourceInterpretationPacketSchema>;
export type PublishedSourceInterpretationPacket = z.infer<typeof PublishedSourceInterpretationPacketSchema>;

export const SourceInterpretationReasoningRequestSchema = z.object({
  contract: z.literal("source-interpretation-reasoning-v1"),
  accepts_unreviewed_conditional_results: z.literal(true),
  packet_id: BoundedIdSchema,
  profile_id: BoundedIdSchema,
  original_query: z.string().min(1).max(8192),
  program: QueryProgramSchema,
  seed_nodes: z.array(LocalId).min(1).max(64).readonly(),
  budget: RequestBudgetSchema,
  output_byte_limit: z.number().int().min(1024).max(1_000_000)
}).strict().readonly();

export const SourceInterpretationReasoningResultSchema = z.object({
  contract: z.literal("source-interpretation-reasoning-v1"),
  status: z.enum(["complete", "incomplete", "output_limited"]),
  computation_status: z.enum(["complete", "incomplete"]),
  interpretation: z.object({ packet_id: BoundedIdSchema, hypothesis_id: BoundedIdSchema,
    semantic_status: z.literal("unreviewed"), conclusion_scope: z.literal("conditional_on_interpretation"),
    world_claim: z.literal("unknown"), source_target: SourceEvidenceTargetSchema }).strict().readonly(),
  index: InformationIndexSchema.nullable(),
  interpretation_packet: PublishedSourceInterpretationPacketSchema.nullable(),
  premises: z.array(z.object({ premise_id: BoundedIdSchema, relation_kind: BoundedLabelSchema,
    statement_id: LocalId, from_node: LocalId, to_node: LocalId,
    source_assertions: z.array(z.object({ assertion_id: SourceAssertionIdSchema, text: z.string(),
      source_span: z.tuple([z.number().int().nonnegative(), z.number().int().positive()]).readonly()
    }).strict().readonly()).min(1).max(64).readonly()
  }).strict().readonly()).max(4096).readonly(),
  work: z.object({ packet_bytes: z.number().int().nonnegative(), premise_count: z.number().int().nonnegative(),
    engine_work: z.number().int().nonnegative(), preparation_work: z.number().int().nonnegative(),
    projection_work: z.number().int().nonnegative(), native_work: z.number().int().nonnegative(), native_bytes: z.number().int().nonnegative() }).strict().readonly()
}).strict().superRefine((result, context) => {
  const packet = result.interpretation_packet;
  if (packet !== null && (packet.packet_id !== result.interpretation.packet_id ||
      packet.hypothesis_id !== result.interpretation.hypothesis_id ||
      !sameSourceEvidenceRoot(result.interpretation.source_target, packet.source_target))) {
    context.addIssue({ code: "custom", message: "interpretation definition differs from its result qualifier" });
  }
  if (result.index !== null && (packet === null ||
      result.index.entries.some((entry) => entry.interpretation_node?.packet_id !== packet.packet_id || entry.hypothesis_id !== packet.hypothesis_id ||
        entry.target.kind !== "source_evidence" || !sameSourceEvidenceRoot(entry.target, packet.source_target)))) {
    context.addIssue({ code: "custom", message: "conditional conclusions require their complete interpretation definition" });
  }
}).readonly();

export type SourceInterpretationReasoningRequest = z.infer<typeof SourceInterpretationReasoningRequestSchema>;
export type SourceInterpretationReasoningResult = z.infer<typeof SourceInterpretationReasoningResultSchema>;
