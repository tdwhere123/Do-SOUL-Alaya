import { z } from "zod";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RequestBudgetSchema, SoulMemorySearchRequestSchema, SourceEvidenceTargetSchema } from "@do-soul/alaya-protocol";
import { isAuthorityRevision } from "../../extraction/authority/receipt.js";

/** Offline support for the reviewed local capture protocol, not an authorization to execute Recall. */
export const ORDINARY_RECALL_CAPTURE_CONTRACT = "ordinary-recall-local-capture-v1";
export const ORDINARY_RECALL_PUBLIC_SEMANTICS = "conditional-field-source-only-v1";
export const OrdinaryRecallProtocolVersionSchema = z.enum(["14.1.0", "15.0.0"]);

/** Version 15 changes semantic-library capacity; this source-only public contract is unchanged. */
export function ordinaryRecallReaderProtocolVersion() {
  const entry = fileURLToPath(import.meta.resolve("@do-soul/alaya-protocol"));
  const manifest = JSON.parse(readFileSync(resolve(dirname(entry), "../package.json"), "utf8")) as { version?: unknown };
  return OrdinaryRecallProtocolVersionSchema.parse(manifest.version);
}
const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Commit = z.string().regex(/^[a-f0-9]{40}$/u);
const Time = z.string().datetime();
const Count = z.number().int().nonnegative();

export const OrdinaryRecallCaptureConfigSchema = z.object({
  capture_contract: z.literal(ORDINARY_RECALL_CAPTURE_CONTRACT),
  public_semantics: z.literal(ORDINARY_RECALL_PUBLIC_SEMANTICS),
  protocol_package_version: OrdinaryRecallProtocolVersionSchema,
  candidate: Commit, tree: Commit, implementation_revision: z.string().refine(isAuthorityRevision),
  snapshot_path: z.string().min(1), snapshot_sha256: Digest,
  workspace_id: z.string().min(1), run_id: z.string().min(1),
  first_request: SoulMemorySearchRequestSchema,
  expected_target: SourceEvidenceTargetSchema, expected_source_bytes: Count,
  bounds: z.object({
    membership_calls: Count.min(1).max(64), payload_expansion_calls: Count.max(64),
    total_recall_calls: Count.min(1).max(64), payload_byte_budget: Count.min(1).max(1048576),
    public_envelope_observation_bytes: Count.min(1).max(1048576),
    default_native_request: RequestBudgetSchema
  }).passthrough(),
  provider_calls: z.literal(0), consumer_calls: z.literal(0)
}).passthrough().superRefine((config, context) => {
  const request = config.first_request;
  if (request.result_kind_view !== "source_only" || request.enumeration_policy !== "canonical" ||
      request.protocol_version !== 1 || request.supports_source_evidence !== true ||
      request.continuation != null || request.payload_continuation != null ||
      request.scope_class !== "project" || !Time.safeParse(request.source_observed_at).success ||
      config.expected_target.workspace_id !== config.workspace_id || config.expected_target.root_kind !== "source_record" ||
      config.expected_target.span !== undefined ||
      config.implementation_revision !== config.candidate &&
        !config.implementation_revision.startsWith(`git-worktree-v1:${config.candidate}:`)) {
    context.addIssue({ code: "custom", message: "unsupported ordinary Recall producer or initial public contract" });
  }
});
export type OrdinaryRecallCaptureConfig = z.infer<typeof OrdinaryRecallCaptureConfigSchema>;

export const OrdinaryRecallPreparationSchema = z.object({
  status: z.literal("prepared_not_executed"), prepared_at: Time,
  candidate: Commit, tree: Commit, native_implementation_revision: z.string().refine(isAuthorityRevision),
  config_identity: Digest, operator_sha256: Digest
}).passthrough();
export const OrdinaryRecallReservationSchema = z.object({
  candidate: Commit, tree: Commit, lane: z.string().min(1), reserved_at: Time,
  config_identity: Digest, operator_sha256: Digest, retry: z.literal(false)
}).passthrough();
export const OrdinaryRecallRequestRecordSchema = z.object({
  ordinal: Count.min(1), phase: z.enum(["membership", "payload"]), tool: z.literal("soul.recall"),
  arguments: SoulMemorySearchRequestSchema, reserved_at: Time, retry: z.literal(false)
}).strict();
export type OrdinaryRecallRequestRecord = z.infer<typeof OrdinaryRecallRequestRecordSchema>;
export const OrdinaryRecallContextSchema = z.object({
  workspaceId: z.string().min(1), runId: z.string().min(1), agentTarget: z.literal("bench-runner"),
  sessionId: z.string().min(1), surfaceId: z.string().nullable()
}).strict();
export type OrdinaryRecallContext = z.infer<typeof OrdinaryRecallContextSchema>;
export const OrdinaryRecallEnvelopeSchema = z.object({
  content: z.array(z.record(z.string(), z.unknown())), structuredContent: z.unknown().optional(),
  isError: z.boolean().optional()
}).passthrough();
export type OrdinaryRecallEnvelope = z.infer<typeof OrdinaryRecallEnvelopeSchema>;
export const OrdinaryRecallWireRecordSchema = z.object({
  ordinal: Count.min(1), at: Time, direction: z.enum(["client_to_server", "server_to_client"]),
  message: z.object({ jsonrpc: z.literal("2.0"), id: z.union([z.string(), z.number().int()]).optional(),
    method: z.string().optional(), params: z.unknown().optional(), result: z.unknown().optional(),
    error: z.unknown().optional() }).passthrough()
}).strict();
export type OrdinaryRecallWireRecord = z.infer<typeof OrdinaryRecallWireRecordSchema>;
export const OrdinaryRecallObservationSchema = z.object({
  membership_calls: Count, payload_expansion_calls: Count, calls: Count,
  contiguous_delivered_bytes: Count, source_complete: z.boolean(), stop_reason: z.string().min(1),
  first_source_exposure: z.unknown().nullable(), pages: z.array(z.unknown()),
  trusted_principal: OrdinaryRecallContextSchema.nullable(), query_identity: z.array(z.unknown()).nullable(),
  remaining_tail_bytes: Count
}).strict();
export const OrdinaryRecallProcessResultSchema = z.object({
  status: z.enum(["closed", "failed_or_interrupted"]),
  close: z.object({ code: z.number().int().nullable(), signal: z.string().nullable() }).strict(),
  forced: z.boolean(), child_error: z.unknown().nullable(), process_in_flight: z.literal(false), no_retry: z.literal(true)
}).passthrough().superRefine((result, context) => {
  const successfulExit = result.close.code === 0 && !result.forced && result.child_error === null;
  if ((result.status === "closed") !== successfulExit) {
    context.addIssue({ code: "custom", path: ["status"], message: "process status contradicts the producer exit record" });
  }
});
export const OrdinaryRecallShutdownSchema = z.object({
  at: Time, shutdown_awaited: z.literal(true), daemon_started: z.boolean(),
  frozen_source_file_unchanged: z.literal(true), snapshot_sha256: Digest,
  failure: z.unknown().nullable(), provider_calls: z.literal(0), consumer_calls: z.literal(0)
}).passthrough();
