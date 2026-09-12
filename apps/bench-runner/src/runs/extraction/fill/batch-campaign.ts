import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { runExtractionFill, type ExtractionFillOptions, type ExtractionFillResult } from "../extraction-fill.js";
import { readBoundedCanonicalUtf8Artifact } from "../cache-audit/bounded-artifact-reader.js";
import { acquireExtractionCacheWriteLease, withExtractionCacheWriteLease } from "./manifest/fill-root-guard.js";
import { replaceBytesDurable } from "./manifest/durable-exclusive-publication.js";
import { batchDigest, canonicalBatchPlan } from "./batch/plan.js";
import type { GeminiBatchLimits } from "./batch/contract.js";
import { readExtractionAuthorityReceipt } from "../authority/receipt.js";
import { isGeminiGenerateContentProfile } from "./batch/native-codec.js";

const absolutePath = z.string().refine(isAbsolute, "campaign paths must be absolute");
const Manifest = z.object({
  version: z.literal(1), name: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/u),
  limitsPath: absolutePath, requestLimit: z.number().int().min(1).max(400),
  pollIntervalMs: z.number().int().min(1_000).max(86_400_000),
  fill: z.object({
    variant: z.enum(["longmemeval_oracle", "longmemeval_s", "longmemeval_m"]), cacheRoot: absolutePath,
    authorityReceiptPath: absolutePath, targetSelectionReceiptPath: absolutePath.optional(),
    predecessorAuthorityReceiptPath: absolutePath.optional(), dataDir: absolutePath.optional(),
    pinnedMetaRoot: absolutePath.optional(), offset: z.number().int().nonnegative(),
    limit: z.number().int().positive()
  }).strict()
}).strict();
const State = z.object({
  version: z.literal(1), manifestPath: z.string(), manifestDigest: z.string(), referencesDigest: z.string(),
  window: z.number().int().nonnegative(), phase: z.enum(["prepare", "submit", "resume"]),
  nextCheckAt: z.number().int().nonnegative(), status: z.enum(["running", "stopped", "complete"]),
  stopReason: z.string().optional()
}).strict();
export type BatchCampaignState = z.infer<typeof State>;

/** Scheduling only. The fill owner retains all request, admission and spend authority. */
export async function runBatchCampaign(manifestPath: string, options: {
  readonly signal?: AbortSignal;
  readonly log?: (state: BatchCampaignState) => void;
} = {}): Promise<BatchCampaignState> {
  const path = resolve(manifestPath);
  const manifestText = readArtifact(path);
  const manifest = Manifest.parse(JSON.parse(manifestText));
  const limitsText = readArtifact(manifest.limitsPath);
  const limits = JSON.parse(limitsText) as GeminiBatchLimits;
  const references = [manifest.fill.authorityReceiptPath, manifest.fill.targetSelectionReceiptPath,
    manifest.fill.predecessorAuthorityReceiptPath].filter((value): value is string => value !== undefined);
  const referencesDigest = batchDigest(JSON.stringify([limitsText, ...references.map(readArtifact)]));
  const manifestDigest = batchDigest(manifestText);
  // Reuse the mechanical root lease for the scheduler; each fill invocation owns
  // the actual cache root lease. Two controllers for this root cannot interleave.
  const lease = acquireExtractionCacheWriteLease(join(manifest.fill.cacheRoot, ".batch-campaign"));
  return withExtractionCacheWriteLease(lease, async () => {
    const statePath = join(lease.stableRootPath, "state.json");
    const state: BatchCampaignState = existsSync(statePath) ? State.parse(JSON.parse(readArtifact(statePath))) : {
      version: 1, manifestPath: path, manifestDigest, referencesDigest,
      window: 0, phase: "prepare", nextCheckAt: 0, status: "running"
    };
    if (state.manifestPath !== path || state.manifestDigest !== manifestDigest || state.referencesDigest !== referencesDigest) {
      throw new Error("Batch campaign manifest or authority references changed");
    }
    assertCampaignLimits(limits, manifest.requestLimit, manifest.fill.authorityReceiptPath);
    if (state.status === "complete") {
      state.status = "running"; state.phase = "resume"; state.nextCheckAt = 0;
    }
    const save = () => {
      lease.assertOwned();
      replaceBytesDurable({ destination: statePath, bytes: Buffer.from(JSON.stringify(state)),
        ownerIdentity: manifestDigest, temporaryDirectory: lease.stableRootPath });
      options.log?.(structuredClone(state));
    };
    save();
    while (state.status === "running") {
      options.signal?.throwIfAborted();
      if (state.nextCheckAt > Date.now()) await delay(state.nextCheckAt - Date.now(), undefined,
        options.signal === undefined ? {} : { signal: options.signal });
      options.signal?.throwIfAborted();
      // Intent is durable before prepare, upload/create, poll or import. A crash
      // repeats the same owner operation on the same admitted window/job.
      save();
      try {
        if (readArtifact(path) !== manifestText || readArtifact(manifest.limitsPath) !== limitsText ||
            batchDigest(JSON.stringify([limitsText, ...references.map(readArtifact)])) !== referencesDigest) {
          throw new Error("Batch campaign manifest or authority references changed");
        }
        const fill: ExtractionFillOptions = { ...manifest.fill, concurrency: 1,
          batch: { operation: state.phase, window: `${manifest.name}-${state.window}`,
            requestLimit: manifest.requestLimit, requireSuccessfulPredecessors: true, limits },
          ...(options.signal === undefined ? {} : { signal: options.signal }) };
        const result = await runExtractionFill(fill);
        advanceCampaign(state, result, manifest.pollIntervalMs);
      } catch (cause) {
        if (options.signal?.aborted) throw cause;
        state.status = "stopped";
        // Provider diagnostics may carry request content. Keep them in the owned
        // job artifacts; scheduler output exposes only a bounded stop category.
        state.stopReason = "fill_operation_failed_inspect_current_window";
      }
      save();
    }
    return structuredClone(state);
  });
}

function advanceCampaign(state: BatchCampaignState, result: ExtractionFillResult, interval: number): void {
  const jobs = result.batchState?.jobs;
  if (jobs === undefined || jobs.length > 1) throw new Error("campaign requires one Batch job per window");
  if (jobs.some((job) => ["submission_unknown", "failed", "cancel_requested", "cancelled", "expired"].includes(job.status) ||
      job.diagnostic !== undefined || Object.values(job.outcomes).some((outcome) => outcome.status !== "admitted"))) {
    state.status = "stopped"; state.stopReason = "batch_unknown_or_failed"; return;
  }
  const settled = jobs.every((job) => job.status === "succeeded" &&
    job.lineKeys.every((key) => job.outcomes[key]?.status === "admitted"));
  if (settled && jobs.some((job) => job.usageUnknown || job.usage === undefined)) {
    state.status = "stopped"; state.stopReason = "batch_usage_unknown"; return;
  }
  if (result.manifest.schema_version === 3 && result.manifest.fill_status === "complete" && result.coverage === 1 && settled) {
    state.status = "complete"; state.nextCheckAt = 0; return;
  }
  if (state.phase === "prepare") state.phase = "submit";
  else if (state.phase === "submit") state.phase = "resume";
  else if (settled && jobs.length > 0) {
    state.window += 1; state.phase = "prepare";
  } else if (jobs.length === 0) {
    state.status = "stopped"; state.stopReason = "incomplete_scope_without_missing_batch_work"; return;
  }
  state.nextCheckAt = state.phase === "resume" && !settled ? Date.now() + interval : 0;
}

function assertCampaignLimits(limits: GeminiBatchLimits, requestLimit: number, authorityPath: string): void {
  // Reuse the Batch schema/settings owner instead of defining a second limits schema.
  const authority = readExtractionAuthorityReceipt(authorityPath);
  const extraction = authority.observation.extraction;
  if (authority.action !== "fill" || !isGeminiGenerateContentProfile(extraction.requestProfile)) {
    throw new Error("campaign requires a Gemini fill authority");
  }
  canonicalBatchPlan({ identity: authority.receipt_digest, model: extraction.model,
    requestProfile: extraction.requestProfile, lines: [], limits });
  if (limits.maxRequestsPerJob > 400 || requestLimit > limits.maxRequestsPerJob ||
      limits.maxInputTokensPerJob > 8_000_000 || limits.maxEnqueuedTokens > 8_000_000) {
    throw new Error("campaign exceeds request or enqueued-token bounds");
  }
}

function readArtifact(path: string): string {
  return readBoundedCanonicalUtf8Artifact({ path, maxBytes: 1_048_576, label: "Batch campaign artifact" });
}
