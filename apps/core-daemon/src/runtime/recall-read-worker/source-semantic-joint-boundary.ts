import { z } from "zod";
import { SourceEvidenceTargetSchema, SourceSemanticConsumedLeafSchema, SourceSemanticWorkerResultSchema,
  SoulInterpretationResponseSchema, canonicalJson } from "@do-soul/alaya-protocol";
import type { SourceSemanticJointSelection, SourceSemanticJointAssessment } from "@do-soul/alaya-core/dist/recall/conditional-field/query/source-semantic-joint-witness.js";

const Id = z.string().min(1).max(1024), Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const Role = z.object({ variable: Id, query_slot: Id, source_slot: Id }).strict();
const Frame = z.object({ query_frame: Id, source_frame: Id }).strict();
const Key = z.object({ kind: Role, issuer: Role, project: Role, normalization: Role, value: Role }).strict();
const Time = Role.extend({ basis: z.literal("source_event_explicit_offset") }).strict();
const Local = z.object({ interpretation_id: Digest, semantic_correspondence_id: Digest, source_target: SourceEvidenceTargetSchema,
  alternative: z.number().int().nonnegative(), input: z.number().int().nonnegative() }).strict();
const SelectionOwner = z.object({ contract: z.literal("private-two-h-chronology-v1"), query_semantics_id: Digest,
  seed: Local.extend({ bridge: Frame, review: Frame, module: Role, review_module: Role, ticket: Key, time: Time }).strict(),
  approval: Local.extend({ frame: Frame, ticket: Key, time: Time }).strict() }).strict();
/** Adapter schema for Core's private premise contract; no MCP/protocol schema is widened. */
export const SourceSemanticJointSelectionSchema: z.ZodType<SourceSemanticJointSelection> = SelectionOwner;
const Span = z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]).readonly();
const Operand = z.object({ value: z.string(), node: Id,
  mentions: z.array(z.object({ id: Id, span: Span, text: z.string() }).strict()).min(1).max(512) }).strict();
const AssessmentOwner = z.object({ contract: z.literal("private-two-h-chronology-assessment-v1"),
  semantic_status: z.literal("unreviewed"), world_claim: z.literal("unknown"),
  status: z.enum(["witnessed", "unresolved", "not_lowered", "invalid", "resource_exhausted"]), reason: Id,
  witness: z.object({ witness_id: Digest, selection: SelectionOwner, snapshot_id: Digest, as_of: z.string().datetime(),
    source_targets: z.array(SourceEvidenceTargetSchema).length(2),
    locals: z.array(z.object({ proof_identity: Digest, binding_id: Id, explanation_ids: z.array(Id).max(1000),
      observations: z.array(z.object({ observation_id: Id, leaf: SourceSemanticConsumedLeafSchema }).strict()).max(4096) }).strict()).length(2),
    module: Id, ticket: z.object({ kind: Id, issuer: Id, project: Id, normalization: z.literal("exact"), value: Id }).strict(),
    approval_times: z.array(Operand).min(1).max(512), review_times: z.array(Operand).min(1).max(512)
  }).strict().nullable()
}).strict().superRefine((v, ctx) => {
  if ((v.status === "witnessed") !== (v.witness !== null)) ctx.addIssue({ code: "custom", message: "only witnessed assessments carry a witness" });
});
const Assessment: z.ZodType<SourceSemanticJointAssessment> = AssessmentOwner;
const Recall = SourceSemanticWorkerResultSchema.options[4];
const PublicRecall = SoulInterpretationResponseSchema.options[4].unwrap();
const { operation: _operation, order: _order, delivery_id: _delivery, request_identity: _request,
  protocol_version: _protocol, index: _index, ...privateShape } = PublicRecall.shape;
const { continuation: _continuation, ...privateIndexShape } = PublicRecall.shape.index.unwrap().unwrap().shape;
const PrivateArtifact = z.object({ ...privateShape,
  index: z.object(privateIndexShape).strict(), frozen_plan_has_more: z.boolean()
}).strict();
const Delivery = z.object({ artifact: PrivateArtifact, serialized: z.string(), full_envelope_bytes: z.number().int().positive(),
  output_byte_limit: z.number().int().positive() }).strict().superRefine((v, ctx) => {
  if (v.full_envelope_bytes > v.output_byte_limit || v.serialized !== canonicalJson(v.artifact)) {
    ctx.addIssue({ code: "custom", message: "private delivery must retain the actual fitting encoded artifact" });
  }
});
const DiagnosticsOwner = z.object({ contract: z.literal("private-joint-delivery-v1"),
  status: z.enum(["complete", "unavailable", "failed"]), reason: Id.nullable(), request_identity: Digest,
  assessment: Assessment.nullable(), witness_delivered: z.boolean(), candidate: Delivery.nullable(),
  withdrawal: z.object({ leaf_id: Id, leaf: SourceSemanticConsumedLeafSchema, assessment: Assessment,
    independent_approval_preserved: z.boolean(), delivery: Delivery }).strict().nullable(),
  work: Recall.unwrap().shape.work
}).strict().superRefine((v, ctx) => {
  if (v.status === "complete" && (!v.witness_delivered || v.assessment?.status !== "witnessed"
    || v.withdrawal?.assessment.status !== "unresolved" || !v.withdrawal.independent_approval_preserved)) {
    ctx.addIssue({ code: "custom", message: "complete private joint delivery requires actual delivery and causal withdrawal" });
  }
});
export type ResearchJointDiagnostics = z.output<typeof DiagnosticsOwner>;
export const ResearchJointReplySchema = z.object({ kind: z.literal("research_joint"), result: Recall,
  private_joint: DiagnosticsOwner }).strict();
export type ResearchJointReply = z.output<typeof ResearchJointReplySchema>;
export type ResearchJointDelivery = z.output<typeof Delivery>;
