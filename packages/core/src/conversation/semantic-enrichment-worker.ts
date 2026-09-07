import { randomUUID } from "node:crypto";
import type { SemanticArtifactCodec, SemanticArtifactRepositoryPort, SemanticArtifactWork,
  SemanticEnrichmentTask, SemanticSourceSnapshot, SemanticTransportAttempt } from "@do-soul/alaya-protocol";

export type SemanticTransportSpendCapability = "unsupported";
export type SemanticTransportCompletionTokenCapability = "unsupported" | "enforced";

export type SemanticTransportCapabilities = Readonly<{
  readonly configured: boolean;
  readonly requestBytes: "accounted";
  readonly completionTokens: SemanticTransportCompletionTokenCapability;
  readonly spend: SemanticTransportSpendCapability;
}>;

export type SemanticProviderExtractPort = Readonly<{
  extract(input: {
    readonly systemPrompt: string;
    readonly userPrompt: string;
    readonly abortSignal?: AbortSignal;
    readonly timeoutMs?: number;
  }): Promise<{ readonly rawJson: string }>;
  reconcile?(attempt: SemanticTransportAttempt, signal: AbortSignal): Promise<
    { readonly kind: "received"; readonly rawJson: string } |
    { readonly kind: "not_sent" } | { readonly kind: "unknown" }>;
}>;

export type SemanticResourceAccounting = Readonly<{
  readonly reservedRequestUtf8Bytes: number;
  readonly completionTokens: "unsupported";
  readonly spend: "unsupported";
}>;

export interface SemanticEnrichmentWorkerDependencies {
  readonly repo: SemanticArtifactRepositoryPort;
  readonly codec: SemanticArtifactCodec;
  readonly transport: {
    execute(logicalRequestJson: string, attemptId: string, signal: AbortSignal): Promise<string>;
    reconcile(attempt: SemanticTransportAttempt, signal: AbortSignal): Promise<
      { readonly kind: "received"; readonly rawJson: string } |
      { readonly kind: "not_sent" } | { readonly kind: "unknown" }>;
    readonly capabilities?: SemanticTransportCapabilities;
  };
  readonly audit: <T>(action: string, task: SemanticEnrichmentTask, mutate: () => T) => Promise<T>;
  readonly now: () => string;
  readonly leaseMs: number;
  readonly maxAttempts: number;
  readonly maxUnits: number;
  readonly maxLocalRecoveries: number;
  readonly transportTimeoutMs: number;
  readonly maxDispatchCalls?: number;
  readonly maxReservedUtf8Bytes?: number;
  readonly maxCompletionUtf8Bytes?: number;
}

const RESOURCE_LIMIT_ERROR = "SemanticResourceLimitError";
const DEFAULT_COMPLETION_UTF8_BYTES = 262_144;

/** Explicitly invoked worker; daemon scheduling remains the Garden composition owner's responsibility. */
export class SemanticEnrichmentWorker {
  private readonly maxDispatchCalls: number;
  private readonly maxReservedUtf8Bytes: number;
  private readonly maxCompletionUtf8Bytes: number;
  private dispatchCalls = 0;
  private reservedUtf8Bytes = 0;

  public constructor(private readonly deps: SemanticEnrichmentWorkerDependencies) {
    this.maxDispatchCalls = deps.maxDispatchCalls ?? deps.maxAttempts * deps.maxUnits;
    this.maxReservedUtf8Bytes = deps.maxReservedUtf8Bytes ?? deps.maxUnits * 16_384;
    this.maxCompletionUtf8Bytes = deps.maxCompletionUtf8Bytes ?? DEFAULT_COMPLETION_UTF8_BYTES;
    for (const bound of [deps.leaseMs, deps.maxAttempts, deps.maxUnits, deps.transportTimeoutMs,
      deps.maxLocalRecoveries, this.maxDispatchCalls, this.maxReservedUtf8Bytes, this.maxCompletionUtf8Bytes]) {
      if (!Number.isSafeInteger(bound) || bound < 1) throw new Error("invalid enrichment bound");
    }
  }

  /** Compose the Garden provider extract seam; spend is never inferred from request bytes. */
  public static composeProviderTransport(
    provider: SemanticProviderExtractPort | null | undefined,
    options: {
      readonly systemPrompt?: string;
      readonly timeoutMs?: number;
      readonly maxCompletionUtf8Bytes?: number;
    } = {}
  ): SemanticEnrichmentWorkerDependencies["transport"] {
    if (provider == null) {
      return {
        execute: async () => {
          throw new Error("semantic transport is unconfigured");
        },
        reconcile: async () => ({ kind: "not_sent" }),
        capabilities: {
          configured: false,
          requestBytes: "accounted",
          completionTokens: "unsupported",
          spend: "unsupported"
        }
      };
    }
    const maxCompletionUtf8Bytes = options.maxCompletionUtf8Bytes ?? DEFAULT_COMPLETION_UTF8_BYTES;
    if (!Number.isSafeInteger(maxCompletionUtf8Bytes) || maxCompletionUtf8Bytes < 1) {
      throw new Error("invalid enrichment bound");
    }
    const systemPrompt = options.systemPrompt ?? "";
    return {
      execute: async (logicalRequestJson, _attemptId, signal) => {
        if (signal.aborted) throw new Error("semantic transport cancelled");
        const result = await provider.extract({
          systemPrompt,
          userPrompt: logicalRequestJson,
          abortSignal: signal,
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
        });
        if (typeof result?.rawJson !== "string") throw new Error("semantic provider returned no raw json");
        admitCompletionUtf8(result.rawJson, maxCompletionUtf8Bytes);
        return result.rawJson;
      },
      reconcile: async (attempt, signal) => {
        if (provider.reconcile === undefined) return { kind: "unknown" };
        const resolution = await provider.reconcile(attempt, signal);
        if (resolution.kind === "received") {
          admitCompletionUtf8(resolution.rawJson, maxCompletionUtf8Bytes);
        }
        return resolution;
      },
      capabilities: {
        configured: true,
        requestBytes: "accounted",
        completionTokens: "unsupported",
        spend: "unsupported"
      }
    };
  }

  public resourceAccounting(): SemanticResourceAccounting {
    return {
      reservedRequestUtf8Bytes: this.reservedUtf8Bytes,
      completionTokens: "unsupported",
      spend: "unsupported"
    };
  }

  public async run(workspaceId: string, taskId: string, options: { readonly adoptClaim?: boolean } = {}): Promise<string> {
    this.dispatchCalls = 0;
    this.reservedUtf8Bytes = 0;
    const task = await this.acquire(workspaceId, taskId, options.adoptClaim === true);
    if (typeof task === 'string') return task;
    const source = this.deps.repo.source(workspaceId, task.objectId);
    if (!source || source.revision !== task.revision || !this.deps.repo.isCurrent(task)) return this.fail(task, 'superseded_source');
    const work = this.deps.codec.plan(source, task.profile);
    if (work.length === 0 || work.length > this.deps.maxUnits) return this.fail(task, 'work_unit_bound');
    for (const unit of work) {
      if (this.deps.repo.artifact(workspaceId, unit.key)) continue;
      const lost = await this.rejectIfSourceLost(task, source);
      if (lost !== null) return lost;
      const outcome = await this.enrich(task, source, unit);
      if (outcome !== 'ready') return outcome;
    }
    const lost = await this.rejectIfSourceLost(task, source);
    if (lost !== null) return lost;
    try {
      await this.deps.audit('published', task, () => {
        this.deps.repo.publish(task, source, work, this.deps.now());
        this.deps.repo.finish(task, 'completed', null, this.deps.now());
      });
    } catch (error) {
      if (isSupersededSource(error)) return this.fail(task, 'superseded_source');
      throw error;
    }
    return 'completed';
  }

  private async acquire(workspaceId: string, taskId: string, adoptClaim: boolean): Promise<SemanticEnrichmentTask | string> {
    let task = this.deps.repo.task(workspaceId, taskId);
    if (!task) return 'missing';
    if (task.status === 'completed' || task.status === 'failed') return task.status;
    if (task.status === 'claimed') {
      if (adoptClaim && task.claim !== null) {
        if (task.attempts > this.deps.maxLocalRecoveries) return this.fail(task, 'local_recovery_bound');
        return task;
      }
      if (task.claimedAt === null || Date.parse(this.deps.now()) - Date.parse(task.claimedAt) < this.deps.leaseMs) {
        return 'busy';
      }
      const abandoned = task;
      if (!await this.deps.audit('recovered', task, () => this.deps.repo.recover(abandoned))) return 'busy';
      task = this.deps.repo.task(workspaceId, taskId)!;
    }
    const claim = randomUUID();
    const pending = task;
    if (!await this.deps.audit('claimed', task, () => this.deps.repo.claim(pending, claim, this.deps.now()))) return 'busy';
    task = this.deps.repo.task(workspaceId, taskId)!;
    if (task.attempts > this.deps.maxLocalRecoveries) return this.fail(task, 'local_recovery_bound');
    return task;
  }

  private async enrich(task: SemanticEnrichmentTask, source: SemanticSourceSnapshot,
    work: SemanticArtifactWork): Promise<string> {
    let attempt = this.deps.repo.attempt(task.id, work.key);
    if (attempt?.state !== 'received') {
      const cutoff = new Date(Date.parse(this.deps.now()) - this.deps.leaseMs).toISOString();
      const owned = await this.deps.audit('claimed', task, () => this.deps.repo.acquireWork(task, work.key, cutoff));
      if (!owned) return 'work_busy';
    }
    const lost = await this.rejectIfSourceLost(task, source);
    if (lost !== null) return lost;
    if (attempt?.state === 'dispatched' || attempt?.state === 'uncertain') {
      const outcome = await this.reconcileOpenAttempt(task, source, attempt);
      if (outcome !== null) return outcome;
      attempt = this.deps.repo.attempt(task.id, work.key);
    }
    if (!attempt || attempt.state === 'not_sent') {
      const outcome = await this.dispatchAndReceive(task, source, work, attempt);
      if (outcome !== null) return outcome;
      attempt = this.deps.repo.attempt(task.id, work.key);
    }
    return this.admitReceivedAttempt(task, source, work, attempt);
  }

  private async reconcileOpenAttempt(task: SemanticEnrichmentTask, source: SemanticSourceSnapshot,
    attempt: SemanticTransportAttempt): Promise<string | null> {
    if (attempt.reconciliations >= this.deps.maxAttempts - 1) return this.fail(task, 'attempt_bound_unresolved');
    await this.deps.audit('reconciled', task, () => this.deps.repo.beginReconcile(task, attempt.id));
    let resolution;
    try {
      resolution = await this.bounded((signal) => this.deps.transport.reconcile(attempt, signal));
    } catch (error) {
      if (isResourceLimitError(error)) return this.fail(task, error.message);
      return 'uncertain';
    }
    if (resolution.kind === 'unknown') return 'uncertain';
    if (resolution.kind === 'received') {
      const rejected = this.rejectOversizedCompletion(task, resolution.rawJson);
      if (rejected !== null) return rejected;
      const lost = await this.rejectIfSourceLost(task, source);
      if (lost !== null) return lost;
    }
    return this.auditOrSupersede(task, 'reconciled', () => this.deps.repo.reconcile(
      task, attempt.id, resolution.kind === 'received' ? resolution.rawJson : null));
  }

  private async dispatchAndReceive(task: SemanticEnrichmentTask, source: SemanticSourceSnapshot,
    work: SemanticArtifactWork, attempt: SemanticTransportAttempt | null): Promise<string | null> {
    if (this.deps.transport.capabilities?.configured === false) {
      return this.fail(task, 'transport_unconfigured');
    }
    const charge = Buffer.byteLength(work.requestJson, "utf8");
    if ((attempt?.ordinal ?? 0) >= this.deps.maxAttempts || this.dispatchCalls >= this.maxDispatchCalls) {
      return this.fail(task, 'dispatch_bound');
    }
    if (this.reservedUtf8Bytes + charge > this.maxReservedUtf8Bytes) {
      return this.fail(task, 'request_byte_envelope_exhausted');
    }
    const lost = await this.rejectIfSourceLost(task, source);
    if (lost !== null) return lost;
    const id = randomUUID();
    let reserved: boolean | string;
    try {
      reserved = await this.deps.audit('dispatched', task, () => this.deps.repo.dispatch(task, work.key, id));
    } catch (error) {
      if (isSupersededSource(error)) return this.fail(task, 'superseded_source');
      throw error;
    }
    if (reserved !== true) return 'work_busy';
    let raw: string;
    try {
      this.dispatchCalls += 1;
      this.reservedUtf8Bytes += charge;
      raw = await this.bounded((signal) => this.deps.transport.execute(work.requestJson, id, signal));
    } catch (error) {
      if (isResourceLimitError(error)) return this.fail(task, error.message);
      await this.deps.audit('uncertain', task, () => this.deps.repo.uncertain(task, id));
      return 'uncertain';
    }
    const rejected = this.rejectOversizedCompletion(task, raw);
    if (rejected !== null) return rejected;
    const after = await this.rejectIfSourceLost(task, source);
    if (after !== null) return after;
    return this.auditOrSupersede(task, 'received', () => this.deps.repo.receive(task, id, raw));
  }

  private async admitReceivedAttempt(task: SemanticEnrichmentTask, source: SemanticSourceSnapshot,
    work: SemanticArtifactWork, attempt: SemanticTransportAttempt | null): Promise<string> {
    if (attempt?.state !== 'received' || attempt.rawJson === null) return 'uncertain';
    const rejected = this.rejectOversizedCompletion(task, attempt.rawJson);
    if (rejected !== null) return rejected;
    const lost = await this.rejectIfSourceLost(task, source);
    if (lost !== null) return lost;
    let artifact;
    try {
      artifact = this.deps.codec.admit(source, work, attempt.rawJson);
    } catch {
      return this.fail(task, 'admission_rejected');
    }
    const admitted = artifact;
    const outcome = await this.auditOrSupersede(task, 'admitted', () => this.deps.repo.put(task, admitted));
    return outcome ?? 'ready';
  }

  private rejectOversizedCompletion(task: SemanticEnrichmentTask, rawJson: string): Promise<string> | null {
    try {
      admitCompletionUtf8(rawJson, this.maxCompletionUtf8Bytes);
      return null;
    } catch (error) {
      if (isResourceLimitError(error)) return this.fail(task, error.message);
      throw error;
    }
  }

  private async rejectIfSourceLost(task: SemanticEnrichmentTask, source: SemanticSourceSnapshot): Promise<string | null> {
    const live = this.deps.repo.source(task.workspaceId, task.objectId);
    if (live !== null && live.revision === source.revision && live.revision === task.revision
      && this.deps.repo.isCurrent(task)) {
      return null;
    }
    return this.fail(task, 'superseded_source');
  }

  private async auditOrSupersede(task: SemanticEnrichmentTask, action: string, mutate: () => void): Promise<string | null> {
    try {
      await this.deps.audit(action, task, mutate);
      return null;
    } catch (error) {
      if (isSupersededSource(error)) return this.fail(task, 'superseded_source');
      throw error;
    }
  }

  private async bounded<T>(execute: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        execute(controller.signal),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("external completion uncertain after deadline"));
          }, this.deps.transportTimeoutMs);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async fail(task: SemanticEnrichmentTask, reason: string): Promise<string> {
    await this.deps.audit('failed', task, () => this.deps.repo.finish(task, 'failed', reason, this.deps.now()));
    return reason;
  }
}

function admitCompletionUtf8(rawJson: string, maxCompletionUtf8Bytes: number): void {
  if (Buffer.byteLength(rawJson, "utf8") > maxCompletionUtf8Bytes) {
    throw resourceLimitError("completion_limit_exceeded");
  }
}

function resourceLimitError(reason: string): Error {
  const error = new Error(reason);
  error.name = RESOURCE_LIMIT_ERROR;
  return error;
}

function isResourceLimitError(error: unknown): error is Error {
  return error instanceof Error && error.name === RESOURCE_LIMIT_ERROR;
}

function isSupersededSource(error: unknown): boolean {
  return error instanceof Error && error.message === "superseded source result";
}
