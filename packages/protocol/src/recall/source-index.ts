import { z } from "zod";
import { AlayaError } from "../shared/alaya-error.js";
import { SourceEvidenceTargetSchema, sourceGoldRootIdentity, type SourceEvidenceTarget } from "./conditional-field/product-identity.js";
import { canonicalJson } from "./selection/capture/canonical-json.js";
import { FieldContractDigestSchema, hashContentDigest, type FieldContractSha256 } from "./field-contract/canonical-identity.js";

const Revision = z.string().min(1).max(256);
export const SOURCE_INDEX_MAX_BODY_BYTES = 4 * 1024 * 1024;
export const SOURCE_INDEX_MAX_WINDOWS = 4096;

/** Exact model and input semantics, not a display name or a Memory/Capsule embedding key. */
export const SourceIndexProfileSchema = z.object({
  provider_kind: Revision, model_id: Revision, model_revision: Revision,
  artifact_digest: FieldContractDigestSchema, tokenizer_revision: Revision,
  dimensions: z.number().int().min(1).max(65536),
  preprocessing: Revision, normalization: Revision,
  max_input_tokens: z.number().int().min(1).max(1048576),
  windowing: z.literal("utf8-byte-windows.v1"),
  window_bytes: z.number().int().min(4).max(65536)
}).strict().readonly();
export const SourceIndexConfigurationSchema = z.object({
  revision: Revision, profile: SourceIndexProfileSchema
}).strict().readonly();
export type SourceIndexProfile = z.infer<typeof SourceIndexProfileSchema>;
export type SourceIndexConfiguration = z.infer<typeof SourceIndexConfigurationSchema>;
export const SourceIndexTargetSchema = z.object({
  root_key: z.string().min(1).max(2048), source_id: z.string().min(1).max(256),
  target: SourceEvidenceTargetSchema.refine(target => target.root_kind === "source_record" && target.span === undefined),
  body_bytes: z.number().int().min(0)
}).strict().readonly();
export type SourceIndexTarget = z.infer<typeof SourceIndexTargetSchema>;
export type SourceIndexSelection = Readonly<{
  workspace_id: string; selection_revision: number; config_id: string; profile_id: string;
  configuration: SourceIndexConfiguration;
}>;
export const SourceIndexGenerationStatusSchema = z.enum(["building", "partial", "ready", "valid_empty", "failed", "retired"]);
export type SourceIndexGenerationStatus = z.infer<typeof SourceIndexGenerationStatusSchema>;
/** Generation eligibility only; callers must also verify the active pointer, selection and source guards. */
export function sourceIndexGenerationCanServeQueries(status: string): status is "ready" | "partial" | "valid_empty" {
  return status === "ready" || status === "partial" || status === "valid_empty";
}
export type SourceIndexGeneration = Readonly<{
  selection: SourceIndexSelection; generation_id: string; source_epoch: number;
  status: SourceIndexGenerationStatus; enumeration_complete: boolean; after_source_id: string | null;
  target_count: number; completed_count: number; reason: string | null;
}>;
export type SourceIndexState = Readonly<{ status: "unknown" }> | Readonly<{
  status: SourceIndexGenerationStatus | "unbound"; selection: SourceIndexSelection;
  active_generation_id: string | null;
}>;
/** Instrumented native source/dependency/pending-row reads, not SQLite-internal CPU or SQL write work.
 * Preparation also has fixed body/window safety caps; model input limits are separate.
 */
export type SourceIndexResources = Readonly<{ work: number; native_bytes: number }>;
export type SourceIndexCaptureResult = Readonly<{
  generation: SourceIndexGeneration; added: number; resources: SourceIndexResources;
}>;
/** Unbound identifies missing generation/target membership, not a native-source currentness change. */
export type SourceIndexReadResult = Readonly<{
  status: "ready"; source: SourceIndexTarget; body: string; resources: SourceIndexResources;
}> | Readonly<{ status: "partial" | "stale" | "superseded" | "unbound"; reason: string; resources: SourceIndexResources }>;
export type SourceIndexWriteResult = Readonly<{ status: "accepted" }> |
  Readonly<{ status: "rejected"; reason: "stale" | "superseded" | "missing_generation" | "missing_target" | "incomplete" }>;
/** Actual native guard and persistence-read costs are required on every outcome, including zero-cost preflight. */
export type SourceIndexGuardedWriteResult = Readonly<{ resources: SourceIndexResources }> &
  (SourceIndexWriteResult | Readonly<{ status: "rejected"; reason: "read_budget" | "native_source_unavailable" }>);
export type SourceIndexWindow = Readonly<{
  window_id: string; ordinal: number; start_byte: number; end_byte: number; content_digest: string; text: string;
}>;
export type SourceIndexDocument = Readonly<{
  source: SourceIndexTarget; profile_id: string; body: string; windows: readonly SourceIndexWindow[];
}>;
export type SourceIndexVector = Readonly<{
  window_id: string; input_digest: string; embedding: Float32Array;
  token_count: number; truncated: false;
}>;
export type SourceIndexBudget = Readonly<{ work: number; native_bytes: number }>;
/** Ordinals address the deterministic prepared manifest, never a caller-owned resume cursor. */
export type SourceIndexPendingResult = Readonly<{ status: "ready"; ordinals: readonly number[]; resources: SourceIndexResources }> |
  Exclude<SourceIndexReadResult, { status: "ready" }>;
export type SourceIndexBackfillBudget = SourceIndexBudget & Readonly<{
  model_inputs: number; input_bytes: number; max_body_bytes: number;
}>;
export type SourceIndexBackfillResult = Readonly<{
  status: "root_complete" | "partial" | "resource_exhausted" | "token_limit" | "unsupported" | "stale" | "superseded" |
    "unbound" | "failed" | "cancelled" | "deadline";
  reason: string;
  /** Confirmed accepts in this invocation, not a durable root count. Retry pending access reconciles uncertain commits. */
  accepted_vectors: number;
  resources: SourceIndexResources & Readonly<{
    native_accounting: "complete" | "partial"; sql_internal_work: "unknown";
    model_inputs_submitted: number; model_input_bytes_submitted: number;
    token_count_observed: number; inputs_without_token_count: number; model_execution_work: "not_run" | "unknown";
  }>;
}>;
/** Known native costs survive exceptions; a failing native operation may have additional unknown costs.
 * The cause retains the original failure. Resources are a lower bound when accounting is partial.
 */
export class SourceIndexOperationError extends AlayaError {
  public readonly resources: SourceIndexResources;
  public constructor(cause: unknown, completed: SourceIndexResources) {
    super(cause instanceof AlayaError ? cause.code : "SOURCE_INDEX_FAILED",
      cause instanceof Error ? cause.message : "Source index operation failed",
      { cause, statusCode: cause instanceof AlayaError ? cause.statusCode : undefined });
    this.name = "SourceIndexOperationError";
    const nested = cause instanceof SourceIndexOperationError ? cause.resources : { work: 0, native_bytes: 0 };
    this.resources = Object.freeze({ work: completed.work + nested.work, native_bytes: completed.native_bytes + nested.native_bytes });
  }
}

/** Imminent consumer: Core SourceIndexLifecycle, followed by native acquisition backfill/query preparation. */
export interface SourceIndexRepository {
  select(workspaceId: string, configuration: SourceIndexConfiguration): SourceIndexSelection;
  state(workspaceId: string): SourceIndexState;
  /** Revoke configuration eligibility without declaring a build failure. Retains history and fences old work. */
  unbind(workspaceId: string): void;
  begin(selection: SourceIndexSelection): SourceIndexGeneration;
  capturePage(workspaceId: string, generationId: string, limit: number, budget: SourceIndexBudget): SourceIndexCaptureResult;
  generation(workspaceId: string, generationId: string): SourceIndexGeneration | null;
  /** A bounded captured page; [] is not an enumeration-complete claim. Missing generation throws. */
  listTargets(workspaceId: string, generationId: string, afterRootKey: string | null, limit: number): readonly SourceIndexTarget[];
  readDocument(workspaceId: string, generationId: string, rootKey: string, maxBytes: number, budget: SourceIndexBudget): SourceIndexReadResult;
  /** Omitted guarded-write budgets use a bounded standalone default; lifecycle callers must pass their remainder. */
  writeLexical(source: SourceIndexTarget, body: string, budget?: SourceIndexBudget): SourceIndexGuardedWriteResult;
  writeDocument(workspaceId: string, generationId: string, document: SourceIndexDocument,
    budget?: SourceIndexBudget): SourceIndexGuardedWriteResult;
  /** Transaction-free caller required. Always selects the first unaccepted windows of this captured root;
   * [] says nothing about generation readiness. Row/byte budgets do not bound SQLite-internal anti-join work.
   */
  pendingWindows(workspaceId: string, generationId: string, rootKey: string, limit: number,
    budget: SourceIndexBudget): SourceIndexPendingResult;
  /** Compatibility shape for standalone callers; the same guard uses the standalone allowance. */
  writeVector(workspaceId: string, generationId: string, vector: SourceIndexVector): SourceIndexWriteResult;
  writeVector(workspaceId: string, generationId: string, vector: SourceIndexVector,
    budget: SourceIndexBudget): SourceIndexGuardedWriteResult;
  activate(workspaceId: string, generationId: string): SourceIndexWriteResult;
  fail(workspaceId: string, generationId: string, reason: string): void;
}

export function sourceIndexProfileId(profile: SourceIndexProfile, sha256: FieldContractSha256): string {
  return digest(["source-index-profile.v1", SourceIndexProfileSchema.parse(structuredClone(profile))], sha256);
}
export function sourceIndexConfigurationId(configuration: SourceIndexConfiguration, sha256: FieldContractSha256): string {
  return digest(["source-index-configuration.v1", SourceIndexConfigurationSchema.parse(structuredClone(configuration))], sha256);
}
export function sourceIndexGenerationId(selection: SourceIndexSelection, epoch: number, sha256: FieldContractSha256): string {
  const captured = structuredClone(selection);
  return digest(["source-index-generation.v1", captured.workspace_id, captured.selection_revision, captured.config_id, epoch], sha256);
}
export function sourceIndexTarget(target: SourceEvidenceTarget, sourceId: string, bodyBytes: number): SourceIndexTarget {
  const captured = structuredClone({ target, sourceId, bodyBytes });
  return SourceIndexTargetSchema.parse({ target: captured.target, source_id: captured.sourceId,
    body_bytes: captured.bodyBytes, root_key: sourceGoldRootIdentity(captured.target) });
}

export class SourceIndexCapacityExceeded extends AlayaError {
  public constructor() { super("VALIDATION", "source index window capacity exceeded"); }
}

/** Model-independent, complete retained bytes. This does not assert original-source completeness. */
export function prepareSourceIndexLexical(input: { source: SourceIndexTarget; body: string }, sha256: FieldContractSha256) {
  const captured = structuredClone(input);
  const source = SourceIndexTargetSchema.parse(captured.source);
  const body = captured.body;
  if (typeof body !== "string") throw new AlayaError("VALIDATION", "source index body must be text");
  const bytes = new TextEncoder().encode(body);
  if (bytes.length > SOURCE_INDEX_MAX_BODY_BYTES || bytes.length !== source.body_bytes ||
      /[\uD800-\uDFFF]/u.test(body) || hashContentDigest(body, sha256) !== source.target.content_digest ||
      source.root_key !== sourceGoldRootIdentity(source.target)) throw new AlayaError("VALIDATION", "source index requires complete exact source bytes");
  return { source, body, bytes };
}

/** Captured input only. Complete bytes or an explicit capacity refusal; never a clipped window list. */
export function prepareSourceIndexDocument(input: { source: SourceIndexTarget; body: string; profile: SourceIndexProfile },
  sha256: FieldContractSha256): SourceIndexDocument {
  const captured = structuredClone(input);
  const { source, body, bytes } = prepareSourceIndexLexical(captured, sha256);
  const profile = SourceIndexProfileSchema.parse(captured.profile);
  const profileId = sourceIndexProfileId(profile, sha256);
  const windows: SourceIndexWindow[] = [];
  for (let start = 0; start < bytes.length;) {
    if (windows.length >= SOURCE_INDEX_MAX_WINDOWS) throw new SourceIndexCapacityExceeded();
    let end = Math.min(bytes.length, start + profile.window_bytes);
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(start, end));
    const contentDigest = hashContentDigest(text, sha256);
    windows.push(Object.freeze({ ordinal: windows.length, start_byte: start, end_byte: end, text,
      content_digest: contentDigest,
      window_id: digest(["source-index-window.v1", source.root_key, profileId, start, end, contentDigest], sha256) }));
    start = end;
  }
  return Object.freeze({ source, profile_id: profileId, body, windows: Object.freeze(windows) });
}

function digest(material: unknown, sha256: FieldContractSha256): string { return `sha256:${sha256(canonicalJson(material))}`; }
