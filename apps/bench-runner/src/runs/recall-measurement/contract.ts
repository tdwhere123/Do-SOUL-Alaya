import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { AlayaError, canonicalJson, RequestBudgetSchema, AuthorizedScopesAdmissionSchema,
  SourceSemanticQuerySchema, SourceSemanticHandleDescriptorSchema, SourceSemanticAccessPolicySchema,
  SourceSemanticExecutionSchema, SourceSemanticAccessReceiptSchema, SourceSemanticPreviewExtentsSchema, SourceSemanticCoverageSchema, SourceSemanticWorkerWorkSchema,
  SourceSemanticQueryStatusSchema, SourceSemanticQueryUnavailableReasonSchema,
  SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP, SourceSemanticCorrespondencePreparationOptionsSchema,
  SourceSemanticCorrespondenceGenerationPolicySchema } from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "@do-soul/alaya-core";
import { SemanticProposalWorksetSchema } from "../semantic-cache/workset.js";
import { readBoundedCanonicalUtf8Artifact } from "../extraction/cache-audit/bounded-artifact-reader.js";
import { publishBytesExclusiveDurable } from "../extraction/fill/manifest/durable-exclusive-publication.js";
import { hashRegularFileNoFollow } from "../snapshot/bound-file.js";
import { BENCH_DAEMON_DB_FILENAME, restoreSnapshotToDataDir } from "../snapshot/materialize.js";
import { startBenchDaemon, type BenchDaemonHandle } from "../../harness/daemon.js";
import { currentBenchScope, removeDataDirWhenBenchDaemonCancelled, runBenchDaemonOperation,
  trackBenchBody } from "../../harness/daemon-task.js";
import { readCurrentExtractionAuthorityRevision } from "../extraction/authority/inspection.js";
import { isAuthorityRevision } from "../extraction/authority/receipt.js";
import { SemanticChainSourceIndexBindingSchema } from "./source-index-binding-schema.js";
import { assertSemanticChainSourceIndex } from "./source-index-binding.js";
import { SemanticChainSourceFailureSchema } from "./source-index-observation.js";
import { MemoryEmbeddingProfileSchema, captureMemoryEmbeddingProfile, matchesMemoryEmbeddingProfile, memorySelection } from "./memory-embedding-profile.js";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const SemanticChainConfigSchema = z.object({
  snapshot_path: z.string().min(1), snapshot_sha256: Digest,
  source_index: SemanticChainSourceIndexBindingSchema.optional(),
  implementation_revision: z.string().refine(isAuthorityRevision), interpretation_clock: z.string().datetime(),
  workspace_id: z.string().min(1), run_id: z.string().min(1),
  query_workset: SemanticProposalWorksetSchema.refine((value) => value.kind === "query", "query workset required"),
  query_cache_root: z.string().min(1), correspondence_cache_root: z.string().min(1),
  correspondence_cache_owners: z.array(z.object({ key: Digest, cache_root: z.string().min(1) }).strict())
    .max(SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP).optional(),
  max_output_tokens: z.number().int().min(1).max(65536),
  correspondence_generation: z.object({ model: z.string().min(1), request_profile: z.string().min(1),
    provider_url: z.string().min(1), max_output_tokens: z.number().int().min(1).max(65536) }).strict().optional(),
  discovery_page_cap: z.number().int().min(1).max(64),
  source_preview_extents: SourceSemanticPreviewExtentsSchema.optional(),
  // Retained candidate opportunity per query, not provider execution authority.
  correspondence_pair_cap: z.number().int().min(0).max(SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP),
  // Protocol owns the paired demand selection and total request cap, distinct from the H cap.
  ...SourceSemanticCorrespondencePreparationOptionsSchema.unwrap().shape,
  access_policy: SourceSemanticAccessPolicySchema,
  budget: RequestBudgetSchema, authorized_scopes: AuthorizedScopesAdmissionSchema,
  output_byte_limit: z.number().int().min(1024).max(1_000_000)
}).strict().superRefine((config, context) => {
  const preparation = SourceSemanticCorrespondencePreparationOptionsSchema.safeParse({
    correspondence_demand: config.correspondence_demand, correspondence_cap: config.correspondence_cap
  });
  if (!preparation.success) for (const issue of preparation.error.issues) {
    context.addIssue({ code: "custom", path: issue.path, message: issue.message });
  }
});
export type SemanticChainConfig = z.infer<typeof SemanticChainConfigSchema>;

const QueryBase = { query_key: Digest, original_query: z.string(), raw_digest: Digest.nullable() };
/** One native discovery step. Shared by the query variants and the recorded replay row. */
export const SemanticChainDiscoveryTraceSchema = z.array(z.object({ coverage: SourceSemanticCoverageSchema, work: SourceSemanticWorkerWorkSchema,
  execution: SourceSemanticExecutionSchema,
  access: SourceSemanticAccessReceiptSchema, query_semantics_status: SourceSemanticQueryStatusSchema,
  continuation_handle: z.string().nullable(), candidate_ids: z.array(z.string()) }).strict());
const Discovery = {
  descriptors: z.array(SourceSemanticHandleDescriptorSchema),
  discovery_trace: SemanticChainDiscoveryTraceSchema,
  discovery_pages: z.number().int().nonnegative(), discovery_open: z.boolean(),
  initial_discovery_elapsed_ms: z.number().nonnegative().optional(),
  unvisited_source_interpretation_count: z.number().int().nonnegative().nullable(), discovery_truncated: z.boolean()
};
export const SemanticChainQuerySchema = z.discriminatedUnion("status", [
  z.object({ ...QueryBase, status: z.literal("blocked"), reason: z.string(),
    discovery_failure: SemanticChainSourceFailureSchema.optional() }).strict(),
  z.object({ ...QueryBase, status: z.literal("raw_ready"), reason: z.string(),
    query_semantics_unavailable: SourceSemanticQueryUnavailableReasonSchema,
    ...Discovery }).strict(),
  z.object({ ...QueryBase, status: z.literal("ready"), query_semantics: SourceSemanticQuerySchema,
    ...Discovery, selected_source_interpretation_ids: z.array(z.string()),
    correspondence_opportunities: z.array(z.object({ source_interpretation_id: z.string(),
      decision: z.enum(["selected", "zero_budget", "missing_interpretation", "not_selected"])
    }).strict()),
    correspondence_demand_opportunities: z.array(z.object({ source_interpretation_id: z.string(),
      generation_policy: SourceSemanticCorrespondenceGenerationPolicySchema,
      decision: z.enum(["selected", "zero_budget", "not_selected"])
    }).strict()).optional(),
  }).strict()
]);
// Retained v6/v1-access plans are deliberately unsupported, not upgraded.
export const SEMANTIC_CHAIN_PLAN_CONTRACT = "source-semantic-chain-plan-v7" as const;
export const SemanticChainPlanSchema = z.object({
  contract: z.literal(SEMANTIC_CHAIN_PLAN_CONTRACT), input_identity: Digest,
  config: SemanticChainConfigSchema, queries: z.array(SemanticChainQuerySchema),
  correspondence_workset: SemanticProposalWorksetSchema.nullable(),
  settled_input: z.object({ selection: z.literal("observed_subset"),
    full_workset_identity: Digest.nullable() }).strict().optional()
}).strict();
export type SemanticChainPlan = z.infer<typeof SemanticChainPlanSchema>;
export const chainIdentity = (value: unknown): string => fieldContractSha256(canonicalJson(value));

export function readChainArtifact(path: string): unknown | undefined {
  if (!existsSync(path)) return undefined;
  const envelope = z.object({ identity: Digest, payload: z.unknown() }).strict().parse(JSON.parse(
    readBoundedCanonicalUtf8Artifact({ path, maxBytes: 32 * 1024 * 1024, label: "semantic chain artifact" })
  ));
  if (chainIdentity(envelope.payload) !== envelope.identity) throw new AlayaError("CONFLICT", "semantic chain artifact identity mismatch");
  return envelope.payload;
}

/** Path inventories can retain readable references from an unavailable artifact; this never admits its payload. */
export function readChainArtifactPayloadForInventory(path: string): unknown | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const envelope = z.object({ payload: z.unknown() }).passthrough().safeParse(JSON.parse(
      readBoundedCanonicalUtf8Artifact({ path, maxBytes: 32 * 1024 * 1024, label: "semantic chain path inventory" })
    ));
    return envelope.success ? envelope.data.payload : undefined;
  } catch { return undefined; }
}

/** A readable path reference protects output even when unrelated retained fields fail admission. */
export function retainedArtifactField(value: unknown, ...keys: readonly string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
    current = Reflect.get(current, key);
  }
  return current;
}

export function retainedArtifactPathField(value: unknown, ...keys: readonly string[]): string | undefined {
  const current = retainedArtifactField(value, ...keys);
  return typeof current === "string" && current.length > 0 ? current : undefined;
}

export function writeChainArtifact(path: string, payload: unknown): void {
  const identity = chainIdentity(payload);
  const existing = readChainArtifact(path);
  if (existing !== undefined) {
    if (chainIdentity(existing) !== identity) throw new AlayaError("CONFLICT", "immutable semantic chain stage conflict");
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  publishBytesExclusiveDurable({ destination: path, bytes: Buffer.from(JSON.stringify({ identity, payload })),
    ownerIdentity: identity, temporaryDirectory: dirname(path), allowExistingExact: true });
}

export function writeChainJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  publishBytesExclusiveDurable({ destination: path, bytes: Buffer.from(JSON.stringify(value)),
    ownerIdentity: chainIdentity(value), temporaryDirectory: dirname(path), allowExistingExact: true });
}

export function assertChainSnapshot(config: SemanticChainConfig): void {
  if (hashRegularFileNoFollow(config.snapshot_path) !== config.snapshot_sha256) throw new AlayaError("CONFLICT", "semantic chain snapshot changed");
  if (readCurrentExtractionAuthorityRevision() !== config.implementation_revision) throw new AlayaError("CONFLICT", "semantic chain implementation changed");
  assertSemanticChainSourceIndex(config);
}

type SemanticChainDaemonOptions = Readonly<{ signal?: AbortSignal; embeddingStartupProbe?: "omit";
  sourceSemanticObservations?: boolean }>;
type DaemonRestoration = Readonly<{ snapshotSha256: string; workspaceId: string; databasePath: string }>;
const daemonRestorations = new WeakMap<BenchDaemonHandle, Readonly<{
  binding: DaemonRestoration; scope: NonNullable<ReturnType<typeof currentBenchScope>>;
}>>();

/** Internal capture seam: only the restore/start owner can establish this association. */
export function readSemanticChainDaemonRestoration(daemon: BenchDaemonHandle): DaemonRestoration {
  const owned = daemonRestorations.get(daemon);
  if (owned === undefined || owned.scope.cancelled || owned.scope.signal.aborted) {
    throw new AlayaError("CONFLICT", "semantic chain daemon restoration is not live or owned");
  }
  return owned.binding;
}
export async function withSemanticChainDaemon<T>(config: SemanticChainConfig, root: string,
  body: (daemon: BenchDaemonHandle) => Promise<T>, options: SemanticChainDaemonOptions = {}): Promise<T> {
  const captured = { ...options };
  captured.signal?.throwIfAborted();
  assertChainSnapshot(config);
  return runBenchDaemonOperation(() => runBoundSemanticChainDaemon(config, root, body, captured));
}

async function runBoundSemanticChainDaemon<T>(config: SemanticChainConfig, root: string,
  body: (daemon: BenchDaemonHandle) => Promise<T>, options: SemanticChainDaemonOptions): Promise<T> {
  const { signal, embeddingStartupProbe } = options;
  const selectedMemory = config.source_index === undefined ? undefined : memorySelection(config.source_index);
  assertMemoryEmbeddingReceipts(config, root, "prior");
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, "native-session-"));
  const snapshotPath = config.snapshot_path;
  const restoration = Object.freeze({ snapshotSha256: config.snapshot_sha256, workspaceId: config.workspace_id,
    databasePath: join(directory, BENCH_DAEMON_DB_FILENAME) });
  let daemon: BenchDaemonHandle | undefined;
  let complete = false, operationFailed = false;
  let operationFailure: unknown;
  try {
    signal?.throwIfAborted();
    restoreSnapshotToDataDir({ snapshotDbPath: snapshotPath, expectedSha256: restoration.snapshotSha256, dataDirRoot: directory });
    signal?.throwIfAborted();
    const started = await startBenchDaemon({ dataDirRoot: directory, workspaceId: restoration.workspaceId, runId: config.run_id,
      sourceSemanticInterpretationClock: config.interpretation_clock,
      ...(options.sourceSemanticObservations === undefined ? {} : { sourceSemanticObservations: options.sourceSemanticObservations }),
      ...(config.source_index === undefined ? { embeddingMode: "disabled" as const,
        ...(embeddingStartupProbe === undefined ? {} : { embeddingStartupProbe }) } : {
        embeddingMode: "env" as const, embeddingProviderKind: "local_onnx" as const,
        embeddingStartupProbe: config.source_index.memory_warmup ?? "omit" as const,
        cachedLocalEmbedding: config.source_index.source_scope === "separate" ? config.source_index.memory! :
          { cache_root: config.source_index.cache_root, model_id: config.source_index.model_id },
        ...(config.source_index.source_scope === "separate" ? { cachedLocalSourceEmbedding:
          { cache_root: config.source_index.cache_root, model_id: config.source_index.model_id } } : {}) }),
      fieldProjectionAdmissionMode: "explicit_checkpoint" });
    daemon = started;
    if (config.source_index !== undefined) assertSemanticChainSourceIndex(config, restoration.databasePath);
    if (config.source_index !== undefined && (config.source_index.memory_warmup === "eager" || selectedMemory !== undefined)) {
      const status = await started.runtime.services.embeddingProviderWarmup;
      const dimensions = started.runtime.services.getEmbeddingProviderDimensions();
      const profile = selectedMemory === undefined || config.source_index.memory_warmup === "eager" && status !== "ready"
        ? undefined : await captureMemoryEmbeddingProfile(started);
      writeChainArtifact(join(root, "memory-embedding-readiness.json"), { status, dimensions,
        ...(profile === undefined ? {} : { profile }) });
      if (config.source_index.memory_warmup === "eager" && status !== "ready") {
        throw new AlayaError("UNAVAILABLE", "Memory embedding readiness differs from preparation");
      }
      if (selectedMemory !== undefined) assertMemoryEmbeddingReceipts(config, root, "started");
      else if (config.source_index.memory_warmup === "eager") {
        const preparation = z.object({ memory_readiness: z.object({ dimensions: z.number().int().positive() }) }).passthrough()
          .parse(readChainArtifact(config.source_index.preparation_path));
        if (dimensions !== preparation.memory_readiness.dimensions) {
          throw new AlayaError("UNAVAILABLE", "Memory embedding readiness differs from preparation");
        }
      }
    }
    removeDataDirWhenBenchDaemonCancelled(directory);
    const scope = currentBenchScope();
    if (scope === undefined) throw new AlayaError("CANCELLED", "bench work has no owning scope");
    signal?.throwIfAborted();
    daemonRestorations.set(started, { binding: restoration, scope });
    const shutdown = started.shutdown.bind(started);
    started.shutdown = () => { daemonRestorations.delete(started); return shutdown(); };
    const result = await trackBenchBody(scope, () => body(started));
    if (selectedMemory !== undefined) {
      const finalProfile = await captureMemoryEmbeddingProfile(started);
      writeChainArtifact(join(root, "memory-embedding-profile-final.json"), finalProfile);
      assertMemoryEmbeddingReceipts(config, root, "complete");
    }
    complete = true;
    return result;
  } catch (error) {
    operationFailed = true;
    operationFailure = error;
    throw error;
  } finally {
    if (daemon !== undefined) daemonRestorations.delete(daemon);
    try { await daemon?.shutdown(); }
    catch (cleanup) {
      if (!operationFailed) throw cleanup;
      // Cleanup must not erase a rejection/cancellation, including `throw undefined`.
      // Use cause fields understood by the experiment's bounded diagnostic publisher.
      throw new AlayaError(operationFailure instanceof AlayaError ? operationFailure.code : "UNAVAILABLE",
        "semantic chain operation and daemon shutdown failed", { cause: { earlier: operationFailure, cleanup } });
    }
    if (complete) rmSync(directory, { recursive: true, force: true });
  }
}

/** One receipt authority for daemon recovery and every retained native result consumer. */
export function assertMemoryEmbeddingReceipts(config: SemanticChainConfig, root: string, mode: "prior" | "started" | "complete"): void {
  const binding = config.source_index;
  const selectedMemory = binding === undefined ? undefined : memorySelection(binding);
  if (binding === undefined || selectedMemory === undefined) return;
  const readiness = readChainArtifact(join(root, "memory-embedding-readiness.json"));
  const final = readChainArtifact(join(root, "memory-embedding-profile-final.json"));
  if (mode === "prior" && readiness === undefined && final === undefined) return;
  const observed = z.object({ status: z.enum(["not_requested", "ready", "failed"]),
    dimensions: z.number().int().positive().nullable(), profile: MemoryEmbeddingProfileSchema }).passthrough().safeParse(readiness);
  const preparation = z.object({ memory_profile: MemoryEmbeddingProfileSchema,
    memory_readiness: z.object({ status: z.literal("ready"), dimensions: z.number().int().positive() }).optional() }).passthrough()
    .safeParse(readChainArtifact(binding.preparation_path));
  const message = mode === "prior" ? "prior Memory embedding profile verification is unresolved or changed"
    : mode === "started" ? "Loaded Memory embedding profile differs from preparation"
      : "Loaded Memory embedding profile changed during replay or is unresolved";
  if (!observed.success || !preparation.success ||
      !matchesMemoryEmbeddingProfile(observed.data.profile, selectedMemory, observed.data.dimensions) ||
      canonicalJson(observed.data.profile) !== canonicalJson(preparation.data.memory_profile) ||
      binding.memory_warmup === "eager" && (observed.data.status !== "ready" ||
        observed.data.dimensions !== preparation.data.memory_readiness?.dimensions) ||
      mode !== "started" && final === undefined ||
      final !== undefined && canonicalJson(observed.data.profile) !== canonicalJson(final)) {
    throw new AlayaError("CONFLICT", message);
  }
}

/** A completed prior daemon may be recovered, but its receipt cannot fund new rows. */
export function assertMemoryEmbeddingRecovery(config: SemanticChainConfig, root: string, rowPaths: readonly string[]): void {
  if (config.source_index === undefined || memorySelection(config.source_index) === undefined) return;
  const hasReceipt = existsSync(join(root, "memory-embedding-readiness.json")) ||
    existsSync(join(root, "memory-embedding-profile-final.json"));
  if (!hasReceipt && !rowPaths.some(path => existsSync(path) || existsSync(`${path}.reserved`))) return;
  assertMemoryEmbeddingReceipts(config, root, "complete");
  if (rowPaths.some(path => !existsSync(path) || !existsSync(`${path}.reserved`))) {
    throw new AlayaError("CONFLICT", "completed Memory embedding replay has incomplete durable rows");
  }
}
