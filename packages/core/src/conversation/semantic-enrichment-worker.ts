import { randomUUID } from "node:crypto";
import type { SemanticArtifactCodec, SemanticArtifactRepositoryPort, SemanticArtifactWork,
  SemanticEnrichmentTask, SemanticSourceSnapshot, SemanticTransportAttempt } from "@do-soul/alaya-protocol";

export interface SemanticEnrichmentWorkerDependencies {
  readonly repo: SemanticArtifactRepositoryPort;
  readonly codec: SemanticArtifactCodec;
  readonly transport: {
    execute(logicalRequestJson: string, attemptId: string, signal: AbortSignal): Promise<string>;
    reconcile(attempt: SemanticTransportAttempt, signal: AbortSignal): Promise<
      { readonly kind: "received"; readonly rawJson: string } |
      { readonly kind: "not_sent" } | { readonly kind: "unknown" }>;
  };
  readonly audit: <T>(action: string, task: SemanticEnrichmentTask, mutate: () => T) => Promise<T>;
  readonly now: () => string;
  readonly leaseMs: number;
  readonly maxAttempts: number;
  readonly maxUnits: number;
  readonly maxLocalRecoveries: number;
  readonly transportTimeoutMs: number;
  readonly maxDispatchCalls?: number;
}

/** Explicitly invoked worker; daemon scheduling remains the Garden composition owner's responsibility. */
export class SemanticEnrichmentWorker {
  private readonly maxDispatchCalls: number;
  private dispatchCalls = 0;

  public constructor(private readonly deps: SemanticEnrichmentWorkerDependencies) {
    this.maxDispatchCalls = deps.maxDispatchCalls ?? deps.maxAttempts * deps.maxUnits;
    for (const bound of [deps.leaseMs, deps.maxAttempts, deps.maxUnits, deps.transportTimeoutMs,
      deps.maxLocalRecoveries, this.maxDispatchCalls]) {
      if (!Number.isSafeInteger(bound) || bound < 1) throw new Error("invalid enrichment bound");
    }
  }

  public async run(workspaceId: string, taskId: string, options: { readonly adoptClaim?: boolean } = {}): Promise<string> {
    this.dispatchCalls = 0;
    const task = await this.acquire(workspaceId, taskId, options.adoptClaim === true);
    if (typeof task === 'string') return task;
    const source = this.deps.repo.source(workspaceId, task.objectId);
    if (!source || source.revision !== task.revision || !this.deps.repo.isCurrent(task)) return this.fail(task, 'superseded_source');
    const work = this.deps.codec.plan(source, task.profile);
    if (work.length === 0 || work.length > this.deps.maxUnits) return this.fail(task, 'work_unit_bound');
    for (const unit of work) {
      if (this.deps.repo.artifact(workspaceId, unit.key)) continue;
      const outcome = await this.enrich(task, source, unit);
      if (outcome !== 'ready') return outcome;
    }
    if (!this.deps.repo.isCurrent(task) || this.deps.repo.source(workspaceId, task.objectId)?.revision !== task.revision) {
      return this.fail(task, 'superseded_source');
    }
    await this.deps.audit('published', task, () => {
      this.deps.repo.publish(task, source, work, this.deps.now());
      this.deps.repo.finish(task, 'completed', null, this.deps.now());
    });
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
    if (attempt?.state === 'dispatched' || attempt?.state === 'uncertain') {
      if (attempt.reconciliations >= this.deps.maxAttempts - 1) return this.fail(task, 'attempt_bound_unresolved');
      let resolution;
      const unresolved = attempt;
      await this.deps.audit('reconciled', task, () => this.deps.repo.beginReconcile(task, unresolved.id));
      try {
        resolution = await this.bounded((signal) => this.deps.transport.reconcile(unresolved, signal));
      } catch {
        return 'uncertain';
      }
      if (resolution.kind === 'unknown') return 'uncertain';
      const prior = attempt;
      await this.deps.audit('reconciled', task, () => this.deps.repo.reconcile(
        task, prior.id, resolution.kind === 'received' ? resolution.rawJson : null));
      attempt = this.deps.repo.attempt(task.id, work.key);
    }
    if (!attempt || attempt.state === 'not_sent') {
      if ((attempt?.ordinal ?? 0) >= this.deps.maxAttempts || this.dispatchCalls >= this.maxDispatchCalls) {
        return this.fail(task, 'dispatch_bound');
      }
      const id = randomUUID();
      const reserved = await this.deps.audit('dispatched', task, () => this.deps.repo.dispatch(task, work.key, id));
      if (!reserved) return 'work_busy';
      let raw: string;
      try {
        this.dispatchCalls += 1;
        raw = await this.bounded((signal) => this.deps.transport.execute(work.requestJson, id, signal));
      } catch {
        await this.deps.audit('uncertain', task, () => this.deps.repo.uncertain(task, id));
        return 'uncertain';
      }
      await this.deps.audit('received', task, () => this.deps.repo.receive(task, id, raw));
      attempt = this.deps.repo.attempt(task.id, work.key);
    }
    if (attempt?.state !== 'received' || attempt.rawJson === null) return 'uncertain';
    let artifact;
    try {
      artifact = this.deps.codec.admit(source, work, attempt.rawJson);
    } catch {
      return this.fail(task, 'admission_rejected');
    }
    const admitted = artifact;
    await this.deps.audit('admitted', task, () => this.deps.repo.put(task, admitted));
    return 'ready';
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
