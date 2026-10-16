import {
  SOURCE_INDEX_MAX_BODY_BYTES,
  type SourceIndexBackfillBudget,
  type SourceIndexConfiguration,
  type SourceIndexGeneration,
  type SourceIndexSelection
} from "@do-soul/alaya-protocol";
import {
  SourceIndexBackfill,
  SourceIndexLifecycle,
  fieldContractSha256,
  type SourceEmbeddingBindingOptions,
  type SourceEmbeddingBindingResult
} from "@do-soul/alaya-core";
import { SqliteSourceIndexRepository, type StorageDatabase } from "@do-soul/alaya-storage";

const SOURCE_INDEX_LOCAL_CONFIGURATION_REVISION = "source-index-local.v1";
const SOURCE_INDEX_PROBE_WINDOW_BYTES = 4;
// Loaded limits include special tokens. Reserve extra margin; never silently truncate.
const SOURCE_INDEX_WINDOW_RESERVED_SPECIAL_TOKENS = 8;
const SOURCE_INDEX_WINDOW_BYTES_MIN = 4;
const SOURCE_INDEX_WINDOW_BYTES_MAX = 65536;

export type SourceIndexProducerBind = (
  options: SourceEmbeddingBindingOptions
) => Promise<SourceEmbeddingBindingResult>;

export type SourceIndexProducerLimits = Readonly<{
  intervalMs: number;
  capturePage: number;
  maxCapturePages: number;
  maxRootsPerPass: number;
  maxWorkspacesPerPass: number;
  work: number;
  nativeBytes: number;
  modelInputs: number;
  inputBytes: number;
  maxBodyBytes: number;
  /** Soft deadline shared by binding, capture and all backfill steps in a pass. */
  stepDeadlineMs: number;
}>;

export interface SourceIndexProducerInput {
  readonly database: StorageDatabase;
  readonly bindSourceEmbedding: SourceIndexProducerBind;
  readonly warn: (message: string, meta: Record<string, unknown>) => void;
  readonly limits?: Partial<SourceIndexProducerLimits>;
}

type ReadyBinding = Extract<SourceEmbeddingBindingResult, { status: "ready" }>;
type Pass = {
  signal: AbortSignal;
  deadline: number;
  spent: { work: number; native_bytes: number; model_inputs: number; input_bytes: number };
  capturePages: number;
  visitedRoots: number;
};

/** Conservative private UTF-8 byte window, not the observation-chunk policy. */
export function sourceIndexWindowBytes(maxInputTokens: number): number {
  return Math.min(SOURCE_INDEX_WINDOW_BYTES_MAX, Math.max(SOURCE_INDEX_WINDOW_BYTES_MIN,
    maxInputTokens - SOURCE_INDEX_WINDOW_RESERVED_SPECIAL_TOKENS));
}

/** Separate from Garden EMBEDDING_BACKFILL. SQLite owns selection, resume and activation CAS.
 * Metered capture/pending/backfill costs share one pass allowance. Administrative reads are
 * separately bounded by workspace/page/root visits; SQLite internal CPU/write work is unknown.
 */
export class SourceIndexProducer {
  private readonly repository: SqliteSourceIndexRepository;
  private readonly lifecycle: SourceIndexLifecycle;
  private readonly backfill: SourceIndexBackfill;
  private readonly limits: SourceIndexProducerLimits;
  private started = false;
  private stopping = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  private signal = new AbortController();
  // A caller timeout is not native settlement. Only the shared provider lifecycle can kill it.
  private readonly nativeWork = new Set<Promise<unknown>>();
  private afterWorkspace = "";
  // Transient scheduling hints only; every pass rechecks the durable generation/pending windows.
  private readonly targetCursors = new Map<string, { generation: string; after: string | null }>();

  public constructor(private readonly input: SourceIndexProducerInput) {
    this.repository = new SqliteSourceIndexRepository(input.database, fieldContractSha256);
    this.lifecycle = new SourceIndexLifecycle(this.repository, fieldContractSha256);
    this.backfill = new SourceIndexBackfill(this.lifecycle);
    this.limits = Object.freeze({
      intervalMs: input.limits?.intervalMs ?? 60_000,
      capturePage: input.limits?.capturePage ?? 32,
      maxCapturePages: input.limits?.maxCapturePages ?? 16,
      maxRootsPerPass: input.limits?.maxRootsPerPass ?? 16,
      maxWorkspacesPerPass: input.limits?.maxWorkspacesPerPass ?? 16,
      work: input.limits?.work ?? 50_000,
      nativeBytes: input.limits?.nativeBytes ?? 4 * 1024 * 1024,
      modelInputs: input.limits?.modelInputs ?? 8,
      inputBytes: input.limits?.inputBytes ?? 256 * 1024,
      maxBodyBytes: input.limits?.maxBodyBytes ?? SOURCE_INDEX_MAX_BODY_BYTES,
      stepDeadlineMs: input.limits?.stepDeadlineMs ?? 30_000
    });
  }

  public start(): void {
    if (this.started) return;
    this.started = true;
    this.timer = setInterval(() => { void this.runPass(); }, this.limits.intervalMs);
    void this.runPass();
  }

  /** Stop waiting promptly, but retain native occupancy until actual settlement/closeProvider. */
  public async stop(): Promise<void> {
    this.stopping = true;
    this.started = false;
    if (this.timer !== null) { clearInterval(this.timer); this.timer = null; }
    this.signal.abort();
    if (this.inFlight !== null) await this.inFlight;
  }

  public async runPass(): Promise<void> {
    if (this.inFlight !== null || this.nativeWork.size > 0 || this.stopping && !this.started) return;
    if (this.stopping) { this.stopping = false; this.signal = new AbortController(); }
    // Defer entry until the occupancy slot is installed (including synchronous bind failures).
    const work = Promise.resolve().then(() => this.executePass());
    this.inFlight = work;
    try { await work; }
    finally { if (this.inFlight === work) this.inFlight = null; }
  }

  private trackNative<T>(operation: () => Promise<T>): Promise<T> {
    const work = operation();
    this.nativeWork.add(work);
    void work.then(() => this.nativeWork.delete(work), () => this.nativeWork.delete(work));
    return work;
  }

  private async executePass(): Promise<void> {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), this.limits.stepDeadlineMs);
    const pass: Pass = { signal: AbortSignal.any([this.signal.signal, deadline.signal]),
      deadline: Date.now() + this.limits.stepDeadlineMs,
      spent: { work: 0, native_bytes: 0, model_inputs: 0, input_bytes: 0 }, capturePages: 0, visitedRoots: 0 };
    try {
      if (pass.signal.aborted) return;
      const binding = await waitLocally(this.trackNative(() => bindIndexProfile(this.input.bindSourceEmbedding,
        () => !pass.signal.aborted)), pass.signal);
      if (pass.signal.aborted) return;
      const tracked = binding.status === "ready" ? this.trackBinding(binding) : binding;
      for (let count = 0; count < this.limits.maxWorkspacesPerPass && !pass.signal.aborted; count++) {
        const workspace = this.nextWorkspace() ?? (count === 0 ? this.nextWorkspace() : null);
        if (workspace === null) return;
        // Advance even when this workspace consumes the remaining allowance; later ones cannot starve.
        this.afterWorkspace = workspace;
        if (tracked.status !== "ready") {
          this.lifecycle.unbind(workspace);
          this.targetCursors.delete(workspace);
        } else {
          await this.reconcileWorkspace(workspace, tracked, pass);
          if (!this.hasBudget(pass)) return;
        }
      }
    } catch (error) {
      if (!pass.signal.aborted) this.input.warn("source index producer pass failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    } finally { clearTimeout(timer); }
  }

  private trackBinding(binding: ReadyBinding): ReadyBinding {
    return { ...binding, embedInputs: (inputs, options) => this.trackNative(() =>
      // Producer deadlines stop local waiting, not the shared runtime. Its close owner retains
      // termination authority. Ordinary query/memory IPC timeout semantics are unchanged.
      binding.embedInputs(inputs, { profile_id: options.profile_id, timeoutMs: 0 })) };
  }

  private async reconcileWorkspace(workspaceId: string, binding: ReadyBinding, pass: Pass): Promise<void> {
    const configuration: SourceIndexConfiguration = {
      revision: SOURCE_INDEX_LOCAL_CONFIGURATION_REVISION, profile: binding.profile
    };
    const selection = this.lifecycle.select(workspaceId, configuration);
    const generation = this.lifecycle.begin(selection);
    if (generation.status === "ready" || generation.status === "valid_empty") {
      this.targetCursors.delete(workspaceId);
      return;
    }
    const captured = this.captureUntilComplete(workspaceId, generation, pass);
    if (pass.signal.aborted) return;
    await this.backfillTargets(selection, captured.generation_id, binding, pass);
    if (!pass.signal.aborted) this.publishIfReady(workspaceId, captured.generation_id);
  }

  private captureUntilComplete(workspaceId: string, initial: SourceIndexGeneration, pass: Pass): SourceIndexGeneration {
    let generation = initial;
    while (!generation.enumeration_complete && !pass.signal.aborted &&
        pass.capturePages < this.limits.maxCapturePages && this.hasBudget(pass)) {
      pass.capturePages++;
      const result = this.lifecycle.capture(workspaceId, generation.generation_id, this.limits.capturePage,
        remainingBudget(this.limits, pass.spent));
      pass.spent.work += result.resources.work;
      pass.spent.native_bytes += result.resources.native_bytes;
      generation = result.generation;
      if (result.resources.work === 0 && result.resources.native_bytes === 0) break;
    }
    return generation;
  }

  private async backfillTargets(selection: SourceIndexSelection, generationId: string,
    binding: ReadyBinding, pass: Pass): Promise<void> {
    const workspace = selection.workspace_id;
    let cursor = this.targetCursors.get(workspace);
    if (cursor?.generation !== generationId) {
      cursor = { generation: generationId, after: null };
      this.targetCursors.set(workspace, cursor);
    }
    while (!pass.signal.aborted && this.hasBudget(pass) && pass.visitedRoots < this.limits.maxRootsPerPass) {
      // One metadata row per visit, including already-complete targets. Never scan/skip an unbounded prefix.
      const target = this.repository.listTargets(workspace, generationId, cursor.after, 1)[0];
      if (target === undefined) { this.targetCursors.delete(workspace); return; }
      pass.visitedRoots++;
      const previousRoot = cursor.after;
      cursor.after = target.root_key;
      const pending = this.lifecycle.pendingWindows(workspace, generationId, target.root_key, 1,
        remainingBudget(this.limits, pass.spent));
      pass.spent.work += pending.resources.work;
      pass.spent.native_bytes += pending.resources.native_bytes;
      if (pending.status === "stale" || pending.status === "superseded") return;
      if (pending.status === "ready" && pending.ordinals.length === 0) continue;
      const result = await this.backfill.step({ selection, generation_id: generationId,
        root_key: target.root_key, binding, budget: remainingBudget(this.limits, pass.spent),
        deadline_ms: pass.deadline, signal: pass.signal });
      pass.spent.work += result.resources.work;
      pass.spent.native_bytes += result.resources.native_bytes;
      pass.spent.model_inputs += result.resources.model_inputs_submitted;
      pass.spent.input_bytes += result.resources.model_input_bytes_submitted;
      if (result.status === "cancelled" || result.status === "deadline") { cursor.after = previousRoot; return; }
      if (result.status === "stale" || result.status === "superseded") return;
      if (result.status === "failed") {
        cursor.after = previousRoot;
        const reason = boundedProducerFailureReason(result.reason);
        this.lifecycle.fail(workspace, generationId, reason);
        this.input.warn("source index producer backfill failed", { workspace_id: workspace, reason });
        return;
      }
    }
  }

  private hasBudget(pass: Pass): boolean {
    const left = remainingBudget(this.limits, pass.spent);
    return left.work > 0 && left.native_bytes > 0 && left.model_inputs > 0 && left.input_bytes > 0;
  }

  private publishIfReady(workspaceId: string, generationId: string): void {
    const generation = this.repository.generation(workspaceId, generationId);
    if (generation === null || !generation.enumeration_complete ||
        generation.completed_count !== generation.target_count ||
        generation.status === "failed" || generation.status === "retired") return;
    const published = this.lifecycle.publish(workspaceId, generationId);
    if (published.status === "rejected") this.input.warn("source index producer activation refused", {
      workspace_id: workspaceId, reason: published.reason
    });
  }

  private nextWorkspace(): string | null {
    // Three indexed keyset seeks include retained/orphan selections and source records. No UNION census.
    // MIN uses each table's workspace-leading index; only three scalar results cross SQLite.
    const row = this.input.database.connection.prepare(`SELECT MIN(workspace_id) AS workspace_id FROM (
      SELECT MIN(workspace_id) AS workspace_id FROM workspaces WHERE workspace_id>?
      UNION ALL SELECT MIN(workspace_id) FROM source_index_selections WHERE workspace_id>?
      UNION ALL SELECT MIN(workspace_id) FROM source_records WHERE workspace_id>?
    )`).get(this.afterWorkspace, this.afterWorkspace, this.afterWorkspace) as { workspace_id: string | null };
    if (row.workspace_id === null) this.afterWorkspace = "";
    return row.workspace_id;
  }
}

export function createSourceIndexProducer(input: SourceIndexProducerInput): SourceIndexProducer {
  return new SourceIndexProducer(input);
}

async function bindIndexProfile(bind: SourceIndexProducerBind, eligible: () => boolean): Promise<SourceEmbeddingBindingResult> {
  if (!eligible()) return { status: "unsupported", reason: "producer_stopped" };
  const probe = await bind({ window_bytes: SOURCE_INDEX_PROBE_WINDOW_BYTES });
  if (probe.status !== "ready" || !eligible()) return probe;
  const windowBytes = sourceIndexWindowBytes(probe.profile.max_input_tokens);
  if (windowBytes === probe.profile.window_bytes) return probe;
  return await bind({ window_bytes: windowBytes, max_input_tokens: probe.profile.max_input_tokens });
}

async function waitLocally<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void;
  const stopped = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try { return await Promise.race([work, stopped]); }
  finally { signal.removeEventListener("abort", abort); }
}

function remainingBudget(limits: SourceIndexProducerLimits, spent: Pass["spent"]): SourceIndexBackfillBudget {
  return { work: Math.max(0, limits.work - spent.work), native_bytes: Math.max(0, limits.nativeBytes - spent.native_bytes),
    model_inputs: Math.max(0, limits.modelInputs - spent.model_inputs), input_bytes: Math.max(0, limits.inputBytes - spent.input_bytes),
    max_body_bytes: limits.maxBodyBytes };
}

function boundedProducerFailureReason(reason: string): string {
  return reason.length >= 1 && reason.length <= 256 ? reason : "backfill_failed";
}
