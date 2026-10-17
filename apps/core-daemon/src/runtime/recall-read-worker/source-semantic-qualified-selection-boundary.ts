import { z } from "zod";
import { canonicalJson, SourceRecordIdentitySchema, SourceSemanticHandleDescriptorSchema, SourceSemanticWorkerWorkSchema,
  SourceSemanticWorkerResultSchema } from "@do-soul/alaya-protocol";
import { PrivateArtifactSchema } from "./source-semantic-research-nominated-library.js";
import { ResearchJointDiagnosticsSchema } from "./source-semantic-joint-boundary.js";

const record = SourceRecordIdentitySchema.unwrap().shape;
export const QualifiedSourceTupleSchema = z.object({ source_id: record.source_id, record_id: record.identity,
  source_version: record.source_version, content_digest: record.content_digest }).strict();
export const QualifiedSourceNomineeSchema = z.object({ nominee: QualifiedSourceTupleSchema,
  current: QualifiedSourceTupleSchema, body_bytes: z.number().int().nonnegative().safe(),
  interpretation: SourceSemanticHandleDescriptorSchema.optional(),
  correspondence_status: z.string().min(1).max(256)
}).strict();
/** Private fixed membership, not a discovery receipt or a complete native snapshot seal. */
export const QualifiedSourceSelectionSchema = z.object({ contract: z.literal("private-qualified-source-selection-v1"),
  query_as_of: z.null(), snapshot_identity: z.string().regex(/^[a-f0-9]{64}$/u),
  snapshot_source_count: z.number().int().positive().max(10000),
  nominees: z.array(QualifiedSourceNomineeSchema).min(1).max(64)
}).strict().superRefine((value, context) => {
  for (const key of ["nominee", "current"] as const) {
    if (new Set(value.nominees.map(row => row[key].source_id)).size !== value.nominees.length ||
        new Set(value.nominees.map(row => row[key].record_id)).size !== value.nominees.length) {
      context.addIssue({ code: "custom", message: "qualified population repeats a source tuple" });
    }
  }
  if (value.snapshot_source_count < value.nominees.length) context.addIssue({ code: "custom", message: "fixed subset exceeds full snapshot membership" });
});
export type QualifiedSourceSelection = z.infer<typeof QualifiedSourceSelectionSchema>;
const Eligibility = z.object({ source: QualifiedSourceNomineeSchema,
  h: z.enum(["missing", "ready", "rejected"]), c: z.string(), reason: z.string().nullable()
}).strict();
const Arm = z.object({ policy: z.enum(["default", "evidence_set_coverage"]),
  artifact: PrivateArtifactSchema, serialized: z.string(), full_envelope_bytes: z.number().int().positive(),
  output_byte_limit: z.number().int().positive(), work: SourceSemanticWorkerWorkSchema
}).strict().superRefine((value, context) => {
  if (value.serialized !== canonicalJson(value.artifact) || value.full_envelope_bytes > value.output_byte_limit) {
    context.addIssue({ code: "custom", message: "qualified page must retain actual fitting encoded bytes" });
  }
});
export const QualifiedSourceSelectionReplySchema = z.object({ kind: z.literal("research_qualified_selection"),
  status: z.enum(["complete", "unavailable", "failed"]), reason: z.string().nullable(),
  population: QualifiedSourceSelectionSchema, eligibility: z.array(Eligibility).max(64),
  query_semantics_status: SourceSemanticWorkerResultSchema.options[4].unwrap().shape.query_semantics_status,
  common_work: SourceSemanticWorkerWorkSchema, fork_start: z.object({ work_units: z.number().int().nonnegative(),
    memory_bytes: z.number().int().nonnegative() }).strict(),
  arms: z.object({ default: Arm.nullable(), evidence_set_coverage: Arm.nullable() }).strict(),
  joint: ResearchJointDiagnosticsSchema.optional(),
  fork_work: z.object({ default: SourceSemanticWorkerWorkSchema.nullable(), evidence_set_coverage: SourceSemanticWorkerWorkSchema.nullable() }).strict(),
  failure: z.object({ phase: z.string(), name: z.string(), message: z.string(), stack: z.string().nullable(), code: z.string().nullable() }).strict().nullable(),
  work: SourceSemanticWorkerWorkSchema, physical_total: z.literal("unknown")
}).strict().superRefine((value, context) => {
  if (value.eligibility.length !== value.population.nominees.length || value.eligibility.some((row, i) =>
    canonicalJson(row.source) !== canonicalJson(value.population.nominees[i]))) {
    context.addIssue({ code: "custom", message: "qualification must preserve every original nominee" });
  }
  if (value.status === "complete" && (value.reason !== null || value.arms.default === null ||
      (value.joint === undefined ? value.arms.evidence_set_coverage === null : value.joint.status !== "complete"))) {
    context.addIssue({ code: "custom", message: "complete selection requires its funded deliveries" });
  }
  if (value.joint !== undefined && (value.arms.evidence_set_coverage !== null || value.fork_work.evidence_set_coverage !== null)) {
    context.addIssue({ code: "custom", message: "joint consumption is exclusive of the coverage comparison" });
  }
});
export type QualifiedSourceSelectionReply = z.infer<typeof QualifiedSourceSelectionReplySchema>;
export type QualifiedSourceSelectionArm = NonNullable<QualifiedSourceSelectionReply["arms"]["default"]>;
