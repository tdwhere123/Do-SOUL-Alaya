import {
  BoundedIdSchema, SOURCE_INDEX_MAX_BODY_BYTES, SourceIndexConfigurationSchema, SourceIndexOperationError,
  sourceIndexConfigurationId, sourceIndexProfileId,
  type SourceIndexBackfillBudget, type SourceIndexBackfillResult, type SourceIndexBudget,
  type SourceIndexResources, type SourceIndexSelection, type SourceIndexWindow
} from "@do-soul/alaya-protocol";
import {
  captureSourceEmbeddingInputs, captureSourceEmbeddingProfile, sourceEmbeddingSha256, validateSourceEmbeddingResults,
  type SourceEmbeddingBinding, type SourceEmbeddingBindingResult, type SourceEmbeddingResult
} from "../embedding-recall/source-embedding-runtime.js";
import { CoreError } from "../shared/errors.js";
import type { SourceIndexLifecycle } from "./source-index-lifecycle.js";

/** Runtime capability and execution limits, not a provider selector or a scheduling policy. */
export interface SourceIndexBackfillInput {
  readonly selection: SourceIndexSelection;
  readonly generation_id: string;
  readonly root_key: string;
  readonly binding: SourceEmbeddingBindingResult;
  readonly budget: SourceIndexBackfillBudget;
  /** Absolute wall-clock deadline, within the native timer range (at most 2^31-1 ms away). */
  readonly deadline_ms: number;
  readonly signal: AbortSignal;
}

type CapturedInput = Omit<SourceIndexBackfillInput, "binding"> & {
  binding: Readonly<{ status: "unsupported"; reason: string }> | Readonly<{
    status: "ready"; profile: SourceEmbeddingBinding["profile"]; profile_id: string;
    embed: SourceEmbeddingBinding["embedInputs"];
  }>;
};

/** Captured-root producer for the forthcoming daemon background Source backfill caller.
 * select/begin/capture remain caller-owned lifecycle operations. Each call restores the exact
 * manifest and resumes its first unaccepted window from SQLite, including after reopen.
 * Refusals/failures leave committed vectors in place; retry the same captured root with a fresh
 * allowance/binding. An explicitly failed lifecycle generation still requires begin to resume;
 * stale/superseded targets require the caller to select/begin/capture the current generation.
 * It never publishes: root_complete (even an empty root) is not generation readiness.
 * Do not invoke inside a caller-owned SQLite transaction/snapshot. All lifecycle calls return
 * synchronously before inference. Deadline interruption of synchronous native SQL needs daemon
 * integration; SQLite internal CPU and actual model execution work are explicitly unknown.
 */
export class SourceIndexBackfill {
  public constructor(private readonly lifecycle: SourceIndexLifecycle) {}

  public async step(input: SourceIndexBackfillInput): Promise<SourceIndexBackfillResult> {
    const captured = captureInput(input);
    return new CapturedRootStep(this.lifecycle, captured).run();
  }
}

class CapturedRootStep {
  private accepted = 0;
  private readonly resources: { -readonly [K in keyof SourceIndexBackfillResult["resources"]]: SourceIndexBackfillResult["resources"][K] } = {
    work: 0, native_bytes: 0, native_accounting: "complete", sql_internal_work: "unknown",
    model_inputs_submitted: 0, model_input_bytes_submitted: 0,
    token_count_observed: 0, inputs_without_token_count: 0, model_execution_work: "not_run"
  };

  public constructor(private readonly lifecycle: SourceIndexLifecycle, private readonly input: CapturedInput) {}

  public async run(): Promise<SourceIndexBackfillResult> {
    const stopped = this.stop();
    if (stopped !== null) return stopped;
    const binding = this.input.binding;
    if (binding.status !== "ready") return this.result("unsupported", binding.reason);
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), Math.max(1, this.input.deadline_ms - Date.now()));
    const signal = AbortSignal.any([this.input.signal, deadline.signal]);
    try {
      return await this.embedRoot(binding, signal);
    } catch (error) {
      return this.stop() ?? this.result("failed", error instanceof Error ? error.message : "backfill_failed");
    } finally {
      clearTimeout(timer);
    }
  }

  private async embedRoot(binding: Extract<CapturedInput["binding"], { status: "ready" }>,
    signal: AbortSignal): Promise<SourceIndexBackfillResult> {
    const { selection, generation_id: generationId, root_key: rootKey, budget } = this.input;
    const workspace = selection.workspace_id;
    const prepared = this.native(() => this.lifecycle.prepare(workspace, generationId, rootKey,
      this.remaining(), budget.max_body_bytes, selection));
    if (prepared.status !== "ready") return this.refusal(prepared.status, prepared.reason);
    if (prepared.document.profile_id !== binding.profile_id) return this.result("unsupported", "profile_binding_mismatch");
    for (;;) {
      const stopped = this.stop();
      if (stopped !== null) return stopped;
      const pending = this.native(() => this.lifecycle.pendingWindows(workspace, generationId, rootKey, 1, this.remaining()));
      if (pending.status !== "ready") return this.refusal(pending.status, pending.reason);
      const afterPending = this.stop();
      if (afterPending !== null) return afterPending;
      const ordinal = pending.ordinals[0];
      if (ordinal === undefined) return this.result("root_complete", "no_pending_windows");
      const window = prepared.document.windows[ordinal];
      if (window === undefined || window.ordinal !== ordinal) throw new CoreError("OBLIGATION_VIOLATION", "Pending Source window is outside prepared manifest");
      if (this.resources.model_inputs_submitted >= budget.model_inputs) return this.result("resource_exhausted", "model_input_budget");
      const bytes = Buffer.byteLength(window.text, "utf8");
      if (bytes > budget.input_bytes - this.resources.model_input_bytes_submitted) return this.result("resource_exhausted", "model_input_bytes");
      const afterRead = this.stop();
      if (afterRead !== null) return afterRead;
      const observed = await this.infer(binding, window, bytes, signal);
      const afterModel = this.stop();
      if (afterModel !== null) return afterModel;
      if (observed.status !== "embedded") return this.modelRefusal(observed.reason);
      const written = this.native(() => this.lifecycle.acceptVector(workspace, generationId, {
        window_id: observed.input_id, input_digest: observed.input_digest, embedding: observed.vector,
        token_count: observed.token_count, truncated: observed.truncated
      }, this.remaining()));
      if (written.status !== "accepted") return this.refusal("partial", written.reason);
      this.accepted++;
      // Cancellation/deadline observed after this synchronous write cannot undo an accepted vector.
    }
  }

  private async infer(binding: Extract<CapturedInput["binding"], { status: "ready" }>, window: SourceIndexWindow,
    bytes: number, signal: AbortSignal): Promise<SourceEmbeddingResult> {
    const inputs = captureSourceEmbeddingInputs([{ input_id: window.window_id, text: window.text }]);
    // Submitted costs are retained even on synchronous throw, invalid evidence, timeout or lost transport.
    // Tokenization/inference may already have happened; lack of runtime evidence is never zero work.
    const results = await interruptible(() => {
      this.resources.model_execution_work = "unknown";
      this.resources.model_inputs_submitted++;
      this.resources.model_input_bytes_submitted += bytes;
      this.resources.inputs_without_token_count++;
      return binding.embed(inputs, {
        profile_id: binding.profile_id, signal, timeoutMs: Math.max(1, this.input.deadline_ms - Date.now())
      });
    }, signal);
    const observed = validateSourceEmbeddingResults(inputs, results, binding.profile)[0]!;
    if (observed.token_count !== null) {
      this.resources.token_count_observed += observed.token_count;
      this.resources.inputs_without_token_count--;
    }
    return observed;
  }

  private modelRefusal(reason: string): SourceIndexBackfillResult {
    if (reason === "input_token_limit") return this.result("token_limit", reason);
    if (reason === "cancelled") return this.result("cancelled", reason);
    if (["runtime_closed", "stale_child", "child_source_evidence_unavailable", "profile_mismatch"].includes(reason)) {
      return this.result("unsupported", reason);
    }
    return this.result("failed", reason);
  }

  private refusal(status: string, reason: string): SourceIndexBackfillResult {
    if (reason === "stale" || reason === "superseded") return this.result(reason, reason);
    if (reason === "missing_generation" || reason === "missing_target") return this.result("unbound", reason);
    if (reason === "incomplete" || reason === "generation_failed") return this.result("failed", reason);
    if (["read_budget", "body_capacity", "window_capacity"].includes(reason)) return this.result("resource_exhausted", reason);
    if (status === "stale" || status === "superseded" || status === "unbound") return this.result(status, reason);
    return this.result("partial", reason);
  }

  private native<T extends { resources: SourceIndexResources }>(operation: () => T): T {
    try {
      const result = operation();
      this.resources.work += result.resources.work;
      this.resources.native_bytes += result.resources.native_bytes;
      return result;
    } catch (error) {
      if (error instanceof SourceIndexOperationError) {
        this.resources.work += error.resources.work;
        this.resources.native_bytes += error.resources.native_bytes;
      }
      this.resources.native_accounting = "partial";
      throw error;
    }
  }

  private remaining(): SourceIndexBudget {
    return { work: this.input.budget.work - this.resources.work,
      native_bytes: this.input.budget.native_bytes - this.resources.native_bytes };
  }

  private stop(): SourceIndexBackfillResult | null {
    if (this.input.signal.aborted) return this.result("cancelled", "caller_cancelled");
    if (Date.now() >= this.input.deadline_ms) return this.result("deadline", "deadline_exceeded");
    return null;
  }

  private result(status: SourceIndexBackfillResult["status"], reason: string): SourceIndexBackfillResult {
    return { status, reason, accepted_vectors: this.accepted, resources: { ...this.resources } };
  }
}

function captureInput(input: SourceIndexBackfillInput): CapturedInput {
  const { selection, generation_id, root_key, budget, deadline_ms } = structuredClone({
    selection: input.selection, generation_id: input.generation_id, root_key: input.root_key,
    budget: input.budget, deadline_ms: input.deadline_ms
  });
  BoundedIdSchema.parse(selection.workspace_id);
  const configuration = SourceIndexConfigurationSchema.parse(selection.configuration);
  if ([generation_id, root_key].some(value => typeof value !== "string" || value.length < 1 || value.length > 2048) ||
      [budget.work, budget.native_bytes, budget.model_inputs, budget.input_bytes, budget.max_body_bytes]
        .some(value => !Number.isSafeInteger(value) || value < 0) ||
      budget.max_body_bytes > SOURCE_INDEX_MAX_BODY_BYTES || !Number.isSafeInteger(deadline_ms) ||
      deadline_ms - Date.now() > 2147483647 || !(input.signal instanceof AbortSignal)) {
    throw new CoreError("VALIDATION", "Invalid Source backfill target or execution limits");
  }
  const supplied = input.binding;
  if (supplied.status === "unsupported") return { selection, generation_id, root_key, budget, deadline_ms,
    signal: input.signal, binding: Object.freeze({ ...supplied }) };
  const profileId = supplied.profile_id;
  const profile = captureSourceEmbeddingProfile(supplied.profile, profileId);
  if (sourceIndexProfileId(configuration.profile, sourceEmbeddingSha256) !== profileId || selection.profile_id !== profileId ||
      sourceIndexConfigurationId(configuration, sourceEmbeddingSha256) !== selection.config_id) {
    throw new CoreError("VALIDATION", "Source backfill selection and runtime profile differ");
  }
  return { selection, generation_id, root_key, budget, deadline_ms, signal: input.signal,
    binding: Object.freeze({ status: "ready", profile, profile_id: profileId, embed: supplied.embedInputs.bind(supplied) }) };
}

/** Stop waiting on a non-cooperative runtime without ever persisting its late result.
 * Actual work may continue there; submitted inputs and unknown execution accounting remain visible.
 */
async function interruptible(operation: () => Promise<readonly SourceEmbeddingResult[]>, signal: AbortSignal) {
  let rejectAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(signal.reason);
    signal.addEventListener("abort", rejectAbort, { once: true });
  });
  try {
    if (signal.aborted) throw signal.reason;
    // Preserve existing promise/race ordering; convert only synchronous throws so
    // cancellation cannot leave a rejected promise outside the race.
    let running: Promise<readonly SourceEmbeddingResult[]>;
    try { running = operation(); }
    catch (error) { running = Promise.reject(error); }
    return await Promise.race([running, aborted]);
  } finally {
    if (rejectAbort !== undefined) signal.removeEventListener("abort", rejectAbort);
  }
}
