import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import {
  SOURCE_INDEX_MAX_BODY_BYTES, SOURCE_INDEX_MAX_PAGE_ROWS, SourceIndexCapacityExceeded, SourceIndexConfigurationSchema, SourceIndexOperationError,
  AlayaError, BoundedIdSchema, canonicalJson, SourceIndexLexicalRepresentationSchema,
  type SourceIndexLexicalRepresentation, type SourceIndexLexicalPassBudget, type SourceIndexLexicalPassResult,
  type SourceIndexLexicalRepository,
  prepareSourceIndexDocument,
  type FieldContractSha256, type SourceIndexBudget, type SourceIndexConfiguration, type SourceIndexDocument,
  type SourceIndexGuardedWriteResult, type SourceIndexReadResult, type SourceIndexRepository, type SourceIndexResources,
  type SourceIndexSelection, type SourceIndexVector, type SourceIndexWriteResult
} from "@do-soul/alaya-protocol";

import { readSourceIndexLexicalAnalysisStatus, warmCjkSegmentation } from "@do-soul/alaya-cjk-segmentation";

const LEXICAL_REUSE_BATCH_ROWS = 64, LEXICAL_REUSE_BATCHES_PER_PAGE = 16;

/** Owns Source projection build intent. No inference, provider, worker, or query side effects. */
export class SourceIndexLifecycle {
  public constructor(private readonly repository: SourceIndexRepository, private readonly sha256: FieldContractSha256) {}

  /** A changed selection immediately unbinds vectors; lexical text is model-independent. */
  public select(workspaceId: string, configuration: SourceIndexConfiguration): SourceIndexSelection {
    const captured = structuredClone({ workspaceId, configuration });
    BoundedIdSchema.parse(captured.workspaceId);
    return this.repository.select(captured.workspaceId, SourceIndexConfigurationSchema.parse(captured.configuration));
  }

  /** Configuration absence revokes the selection revision, not the success/failure of a build.
   * The retained profile is historical configuration, never evidence of runtime readiness.
   */
  public unbind(workspaceId: string): void {
    BoundedIdSchema.parse(workspaceId);
    this.repository.unbind(workspaceId);
  }

  /** Reuses the persisted build for the selected configuration and native source epoch. */
  public begin(selection: SourceIndexSelection) {
    return this.repository.begin(structuredClone(selection));
  }

  public capture(workspaceId: string, generationId: string, limit: number, budget: SourceIndexBudget) {
    return this.repository.capturePage(workspaceId, generationId, limit, structuredClone(budget));
  }

  /** Complete retained text and deterministic exact-byte manifests precede any vector work. */
  public prepare(workspaceId: string, generationId: string, rootKey: string, budget: SourceIndexBudget,
    maxBytes = SOURCE_INDEX_MAX_BODY_BYTES, expectedSelection?: SourceIndexSelection) {
    const captured = structuredClone({ workspaceId, generationId, rootKey, budget, maxBytes, expectedSelection });
    let completed: SourceIndexResources = { work: 0, native_bytes: 0 };
    try {
      const read = this.repository.readDocument(captured.workspaceId, captured.generationId, captured.rootKey,
        captured.maxBytes, captured.budget);
      if (read.status !== "ready") return read;
      completed = read.resources;
      const generation = this.repository.generation(captured.workspaceId, captured.generationId);
      if (generation === null) return preparationRejection("missing_generation", read.resources);
      if (captured.expectedSelection !== undefined && canonicalJson(generation.selection) !== canonicalJson(captured.expectedSelection)) {
        return preparationRejection("superseded", read.resources);
      }
      const remaining = { work: captured.budget.work - read.resources.work,
        native_bytes: captured.budget.native_bytes - read.resources.native_bytes };
      let document: SourceIndexDocument | undefined;
      try {
        document = prepareSourceIndexDocument({ source: read.source, body: read.body,
          profile: generation.selection.configuration.profile,
          ...(read.message_structure === undefined ? {} : { message_structure: read.message_structure }) }, this.sha256);
      } catch (error) {
        if (!(error instanceof SourceIndexCapacityExceeded)) throw error;
      }
      // Document persistence already owns lexical text; capacity refusal still preserves it under a fresh guard.
      const write = document === undefined ? this.repository.writeLexical(read.source, read.body, remaining)
        : this.repository.writeDocument(captured.workspaceId, captured.generationId, document, remaining);
      const resources = { work: read.resources.work + write.resources.work,
        native_bytes: read.resources.native_bytes + write.resources.native_bytes };
      if (write.status !== "accepted") return preparationRejection(write.reason, resources);
      return document === undefined ? { status: "partial" as const, reason: "window_capacity", resources }
        : { status: "ready" as const, document, resources };
    } catch (error) {
      throw new SourceIndexOperationError(error, completed);
    }
  }

  /** Explicit model-independent pass. Warming precedes native reads, never a query snapshot/backfill.
   * Selection changes withdraw prior lexical eligibility just as vector selection does for vectors.
   * Pending-target anti-join and captured census cursors are durable; restarts need no caller cursor.
   * deadlineMs is an optional absolute wall-clock deadline, as in SourceIndexBackfill. Checks do not
   * preempt a native call; batch yields admit queued cancellation. Interruption retains the last
   * observed generation snapshot and all consumed resources, never inventing a post-stop readback. */
  public async prepareLexical(workspaceId: string, representation: SourceIndexLexicalRepresentation,
    budget: SourceIndexLexicalPassBudget, signal?: AbortSignal, deadlineMs?: number): Promise<SourceIndexLexicalPassResult> {
    BoundedIdSchema.parse(workspaceId); SourceIndexLexicalRepresentationSchema.parse(representation);
    const limits = structuredClone(budget);
    if ([limits.work, limits.native_bytes, limits.capture_page, limits.max_capture_pages, limits.max_roots, limits.max_body_bytes]
        .some(value => !Number.isSafeInteger(value) || value < 0) || limits.capture_page < 1 ||
        limits.capture_page > SOURCE_INDEX_MAX_PAGE_ROWS || limits.max_body_bytes > SOURCE_INDEX_MAX_BODY_BYTES ||
        deadlineMs !== undefined && !Number.isSafeInteger(deadlineMs)) {
      throw new AlayaError("VALIDATION", "invalid source lexical preparation budget");
    }
    const cancelled = new AlayaError("CANCELLED", "cancelled"), expired = new AlayaError("TIMEOUT", "deadline_exceeded");
    const checkpoint = () => {
      if (signal?.aborted) throw cancelled;
      if (deadlineMs !== undefined && Date.now() >= deadlineMs) throw expired;
    };
    checkpoint();
    const store = this.repository.lexical;
    if (store === undefined) throw new AlayaError("UNAVAILABLE", "source lexical preparation is not wired");
    const selection = store.selectLexical(workspaceId, representation);
    const resources = { work: 0, native_bytes: 0 };
    let analysis = 0, visitedRoots = 0, capturePages = 0, generation: SourceIndexLexicalPassResult["generation"] = null;
    const reclamation = { pages: 0, projections: 0, targets: 0, generations: 0, complete: false };
    const left = () => ({ work: Math.max(0, limits.work - resources.work),
      native_bytes: Math.max(0, limits.native_bytes - resources.native_bytes) });
    const debit = (cost: SourceIndexResources) => { resources.work += cost.work; resources.native_bytes += cost.native_bytes; };
    const result = (status: SourceIndexLexicalPassResult["status"], reason: string | null,
      accounting: "complete" | "lower_bound" = "complete"): SourceIndexLexicalPassResult =>
      ({ status, reason, resources, analysis_units: analysis, selection, generation, accounting, model_inputs: 0,
        visited_roots: visitedRoots, capture_pages: capturePages, reclamation });
    // A budget-limited stop is not an interruption: report the generation it actually advanced.
    const settled = (status: SourceIndexLexicalPassResult["status"], reason: string | null) => {
      if (generation !== null) generation = store.lexicalGeneration(workspaceId, generation.generation_id) ?? generation;
      return result(status, reason);
    };
    try {
      checkpoint();
      await reclaimRetiredLexical(store, workspaceId, limits, left, debit, checkpoint, reclamation);
      const warmed = representation !== "segmented-unicode61.v1" || await warmCjkSegmentation();
      checkpoint();
      if (!warmed || representation === "segmented-unicode61.v1" && readSourceIndexLexicalAnalysisStatus() !== "ready") {
        return result("unavailable", "segmenter_unavailable");
      }
      generation = store.beginLexical(selection);
      checkpoint();
      // A published generation for this epoch is final; later passes only observe it.
      if (generation.status === "ready" || generation.status === "valid_empty") return result("ready", null);
      for (let page = 0; page < limits.max_capture_pages && !generation.enumeration_complete; page++) {
        capturePages++;
        const captured = store.captureLexicalPage(workspaceId, generation.generation_id, limits.capture_page, left());
        debit(captured.resources); generation = captured.generation;
        checkpoint();
        await yieldToEventLoop(); checkpoint();
        if (captured.resources.work === 0) break;
      }
      // Unchanged roots copy the active generation's projections; only new or changed roots are analyzed.
      for (let batch = 0; batch < limits.max_capture_pages * LEXICAL_REUSE_BATCHES_PER_PAGE && visitedRoots < limits.max_roots; batch++) {
        const reuse = store.reuseLexicalProjections(workspaceId, generation.generation_id,
          Math.min(LEXICAL_REUSE_BATCH_ROWS, limits.max_roots - visitedRoots), left());
        debit(reuse.resources); visitedRoots += reuse.reused; checkpoint();
        if (reuse.reused === 0 || reuse.complete) break;
        await yieldToEventLoop(); checkpoint();
      }
      for (let root = 0; visitedRoots < limits.max_roots; root++) {
        const pending = store.pendingLexicalTarget(workspaceId, generation.generation_id, left());
        debit(pending.resources);
        if (pending.source !== null) visitedRoots++;
        checkpoint();
        if (pending.source === null) {
          if (!pending.complete) return settled("partial", "read_budget");
          break;
        }
        const read = store.readLexicalDocument(workspaceId, generation.generation_id, pending.source.root_key, limits.max_body_bytes, left());
        debit(read.resources); checkpoint();
        if (read.status !== "ready") return settled(read.status, read.reason);
        // The pass's first root funds its own analysis (bounded by max_body_bytes), so a root
        // larger than the pass allowance still advances instead of stalling every pass.
        const allowance = left();
        const write = store.writeLexicalDocument(workspaceId, generation.generation_id, read.source, read.body,
          root === 0 ? { ...allowance, work: allowance.work + read.body.length } : allowance);
        debit(write.resources); analysis += write.analysis_units;
        checkpoint();
        if (write.status !== "accepted") {
          const rejected = preparationRejection(write.reason, resources);
          return settled(rejected.status, rejected.reason);
        }
        await yieldToEventLoop(); checkpoint();
      }
      await yieldToEventLoop(); checkpoint();
      generation = store.lexicalGeneration(workspaceId, generation.generation_id);
      checkpoint();
      if (generation === null) return result("unbound", "missing_generation");
      const publish = store.activateLexical(workspaceId, generation.generation_id);
      generation = store.lexicalGeneration(workspaceId, generation.generation_id);
      if (publish.status === "accepted") return result("ready", null);
      const rejected = preparationRejection(publish.reason, resources);
      return result(rejected.status, rejected.reason);
    } catch (error) {
      if (error === cancelled) return result("partial", cancelled.message);
      if (error === expired) return result("partial", expired.message);
      if (error instanceof SourceIndexOperationError) {
        debit(error.resources); visitedRoots += error.visited_roots;
      }
      return result("unavailable", error instanceof Error ? error.message : "lexical_preparation_failed", "lower_bound");
    }
  }

  /** Durable anti-join resume: no caller cursor can advance past unfinished windows. */
  public pendingWindows(workspaceId: string, generationId: string, rootKey: string, limit: number, budget: SourceIndexBudget) {
    return this.repository.pendingWindows(workspaceId, generationId, rootKey, limit, structuredClone(budget));
  }

  public acceptVector(workspaceId: string, generationId: string, vector: SourceIndexVector): SourceIndexWriteResult;
  public acceptVector(workspaceId: string, generationId: string, vector: SourceIndexVector,
    budget: SourceIndexBudget): SourceIndexGuardedWriteResult;
  public acceptVector(workspaceId: string, generationId: string, vector: SourceIndexVector,
    budget?: SourceIndexBudget): SourceIndexWriteResult | SourceIndexGuardedWriteResult {
    const captured = structuredClone({ workspaceId, generationId, vector, budget });
    return captured.budget === undefined
      ? this.repository.writeVector(captured.workspaceId, captured.generationId, captured.vector)
      : this.repository.writeVector(captured.workspaceId, captured.generationId, captured.vector, captured.budget);
  }

  /** No caller-provided ready/count flag: storage verifies captured coverage under selection/epoch CAS. */
  public publish(workspaceId: string, generationId: string) {
    return this.repository.activate(workspaceId, generationId);
  }

  public fail(workspaceId: string, generationId: string, reason: string): void {
    this.repository.fail(workspaceId, generationId, reason);
  }
}

/** Maintenance shares the preparation budget/deadline, but not its native census/root-visit counters.
 * Page receipts distinguish committed cleanup from interrupted preparation; no unbounded drain loop. */
async function reclaimRetiredLexical(store: SourceIndexLexicalRepository, workspaceId: string,
  limits: SourceIndexLexicalPassBudget, left: () => SourceIndexBudget, debit: (cost: SourceIndexResources) => void,
  checkpoint: () => void, receipt: { pages: number; projections: number; targets: number; generations: number; complete: boolean }) {
  for (let page = 0; page < limits.max_capture_pages; page++) {
    checkpoint();
    const remaining = left();
    if (remaining.work < 4 || remaining.native_bytes < 71) return;
    const reclaimed = store.reclaimLexicalPage(workspaceId, limits.capture_page, remaining);
    debit(reclaimed.resources); receipt.pages++; receipt.complete = reclaimed.complete;
    receipt.projections += reclaimed.projections; receipt.targets += reclaimed.targets; receipt.generations += reclaimed.generations;
    checkpoint();
    if (reclaimed.complete || reclaimed.projections + reclaimed.targets + reclaimed.generations === 0) return;
    await yieldToEventLoop(); checkpoint();
  }
}

function preparationRejection(reason: Extract<SourceIndexGuardedWriteResult, { status: "rejected" }>["reason"],
  resources: SourceIndexResources): Exclude<SourceIndexReadResult, { status: "ready" }> {
  const status = reason === "incomplete" || reason === "read_budget" || reason === "native_source_unavailable" ? "partial"
    : reason === "missing_generation" || reason === "missing_target" ? "unbound" : reason;
  return { status, reason, resources };
}
