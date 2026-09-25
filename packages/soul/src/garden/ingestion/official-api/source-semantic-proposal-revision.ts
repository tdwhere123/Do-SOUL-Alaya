import { createHash } from "node:crypto";
import { z } from "zod";
import { AlayaError, canonicalJson } from "@do-soul/alaya-protocol";

const Digest = z.string().regex(/^[0-9a-f]{64}$/u);
const QueryInstruction = "Review the unchanged original question and approved context against the complete retained previous response. The previous proposal may omit a requested restriction. Return one complete new proposal, not a patch. Do not use source facts or an evaluator answer. The host will apply unchanged admission; previous failures remain retained.";
const CorrespondenceInstruction = "Review the unchanged admitted query and published source interpretation against the complete retained previous response and the reported unresolved correspondence. Return one complete new proposal, not a patch. Attention is fallible control information, not evidence. Do not invent a source fact or target answer. The host will apply unchanged admission; previous failures remain retained.";

export const SourceSemanticProposalRevisionSchema = z.object({
  contract: z.literal("source-semantic-proposal-revision-v1"),
  kind: z.enum(["query", "semantic_correspondence"]),
  instruction: z.enum([QueryInstruction, CorrespondenceInstruction]),
  base_request_sha256: Digest,
  parent_request_sha256: Digest,
  parent_request_json: z.string().min(1).max(1_000_000),
  previous_response_sha256: Digest,
  previous_response: z.string().min(1).max(524288),
  previous_response_completion: z.literal("complete"),
  revision_number: z.literal(1),
  attention_request_sha256: Digest.optional(),
  review_comments: z.array(z.string().min(1).max(2048)).max(32).readonly()
}).strict().superRefine((revision, context) => {
  if (revision.instruction !== (revision.kind === "query" ? QueryInstruction : CorrespondenceInstruction) ||
      sha256(revision.parent_request_json) !== revision.parent_request_sha256 ||
      sha256(revision.previous_response) !== revision.previous_response_sha256) {
    context.addIssue({ code: "custom", message: "proposal revision identity or instruction differs from its parent" });
  }
  if (revision.kind === "query" && (revision.review_comments.length !== 0 || revision.attention_request_sha256 !== undefined)) {
    context.addIssue({ code: "custom", message: "query revision cannot receive source or attention feedback" });
  }
  if (revision.kind === "semantic_correspondence" &&
      (revision.review_comments.length === 0 || revision.attention_request_sha256 !== revision.base_request_sha256)) {
    context.addIssue({ code: "custom", message: "correspondence feedback must bind the unchanged current request" });
  }
}).readonly();
export type SourceSemanticProposalRevision = z.infer<typeof SourceSemanticProposalRevisionSchema>;

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** Construct a child input only from complete physical parent bytes admitted by the caller's transport owner. */
export function prepareSourceSemanticProposalRevision(input: Readonly<{
  kind: SourceSemanticProposalRevision["kind"];
  parent_request: Readonly<Record<string, unknown>>;
  previous_response: string;
  response_completion: "complete" | "truncated" | "unknown";
  review_comments?: readonly string[];
  attention_request_sha256?: string;
}>): SourceSemanticProposalRevision {
  if (input.response_completion !== "complete") {
    throw new AlayaError("VALIDATION", "proposal revision requires observed complete physical response");
  }
  const parent = JSON.stringify(input.parent_request);
  const revision = SourceSemanticProposalRevisionSchema.parse({
    contract: "source-semantic-proposal-revision-v1", kind: input.kind,
    instruction: input.kind === "query" ? QueryInstruction : CorrespondenceInstruction,
    base_request_sha256: sha256(canonicalJson(withoutRevision(input.parent_request))),
    parent_request_sha256: sha256(parent), parent_request_json: parent,
    previous_response_sha256: sha256(input.previous_response), previous_response: input.previous_response,
    previous_response_completion: "complete", revision_number: 1,
    ...(input.kind === "semantic_correspondence" ? {
      attention_request_sha256: input.attention_request_sha256 ?? sha256(canonicalJson(withoutRevision(input.parent_request)))
    } : input.attention_request_sha256 === undefined ? {} : { attention_request_sha256: input.attention_request_sha256 }),
    review_comments: input.review_comments ?? []
  });
  assertSourceSemanticProposalRevision(input.kind, input.parent_request, revision);
  return revision;
}

/** The current connected cycle permits one child from one unchanged base input. */
export function assertSourceSemanticProposalRevision(kind: SourceSemanticProposalRevision["kind"],
  baseRequest: Readonly<Record<string, unknown>>, value: unknown): SourceSemanticProposalRevision {
  const revision = SourceSemanticProposalRevisionSchema.parse(value);
  if (revision.kind !== kind || "revision" in baseRequest ||
      sha256(canonicalJson(baseRequest)) !== revision.base_request_sha256) {
    throw new AlayaError("CONFLICT", "proposal revision changed its original request or role");
  }
  let parent: unknown;
  try { parent = JSON.parse(revision.parent_request_json); }
  catch { throw new AlayaError("VALIDATION", "proposal revision parent request is not JSON"); }
  if (parent === null || typeof parent !== "object" || Array.isArray(parent) ||
      JSON.stringify(parent) !== revision.parent_request_json ||
      canonicalJson(parent) !== canonicalJson(baseRequest)) {
    throw new AlayaError("CONFLICT", "proposal revision parent differs from unchanged request");
  }
  return revision;
}

function withoutRevision(request: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const { revision: _revision, ...base } = request;
  return base;
}
