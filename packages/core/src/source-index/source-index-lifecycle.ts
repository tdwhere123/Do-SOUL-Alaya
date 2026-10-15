import {
  SOURCE_INDEX_MAX_BODY_BYTES, SourceIndexCapacityExceeded, SourceIndexConfigurationSchema, BoundedIdSchema,
  prepareSourceIndexDocument,
  type FieldContractSha256, type SourceIndexBudget, type SourceIndexConfiguration, type SourceIndexDocument,
  type SourceIndexGuardedWriteResult, type SourceIndexReadResult, type SourceIndexRepository, type SourceIndexResources,
  type SourceIndexSelection, type SourceIndexVector
} from "@do-soul/alaya-protocol";

/** Owns Source projection build intent. No inference, provider, worker, or query side effects. */
export class SourceIndexLifecycle {
  public constructor(private readonly repository: SourceIndexRepository, private readonly sha256: FieldContractSha256) {}

  /** A changed selection immediately unbinds vectors; lexical text is model-independent. */
  public select(workspaceId: string, configuration: SourceIndexConfiguration): SourceIndexSelection {
    const captured = structuredClone({ workspaceId, configuration });
    BoundedIdSchema.parse(captured.workspaceId);
    return this.repository.select(captured.workspaceId, SourceIndexConfigurationSchema.parse(captured.configuration));
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
    maxBytes = SOURCE_INDEX_MAX_BODY_BYTES) {
    const captured = structuredClone({ workspaceId, generationId, rootKey, budget, maxBytes });
    const read = this.repository.readDocument(captured.workspaceId, captured.generationId, captured.rootKey,
      captured.maxBytes, captured.budget);
    if (read.status !== "ready") return read;
    const generation = this.repository.generation(captured.workspaceId, captured.generationId);
    if (generation === null) return preparationRejection("missing_generation", read.resources);
    const remaining = { work: captured.budget.work - read.resources.work,
      native_bytes: captured.budget.native_bytes - read.resources.native_bytes };
    let document: SourceIndexDocument | undefined;
    try {
      document = prepareSourceIndexDocument({ source: read.source, body: read.body,
        profile: generation.selection.configuration.profile }, this.sha256);
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
  }

  /** The future embedding backfill producer supplies an explicit non-truncated runtime result. */
  public acceptVector(workspaceId: string, generationId: string, vector: SourceIndexVector) {
    return this.repository.writeVector(workspaceId, generationId, structuredClone(vector));
  }

  /** No caller-provided ready/count flag: storage verifies captured coverage under selection/epoch CAS. */
  public publish(workspaceId: string, generationId: string) {
    return this.repository.activate(workspaceId, generationId);
  }

  public fail(workspaceId: string, generationId: string, reason: string): void {
    this.repository.fail(workspaceId, generationId, reason);
  }
}

function preparationRejection(reason: Extract<SourceIndexGuardedWriteResult, { status: "rejected" }>["reason"],
  resources: SourceIndexResources): Exclude<SourceIndexReadResult, { status: "ready" }> {
  const status = reason === "incomplete" || reason === "read_budget" || reason === "native_source_unavailable" ? "partial"
    : reason === "missing_generation" || reason === "missing_target" ? "unbound" : reason;
  return { status, reason, resources };
}
