import {
  HOST_DEPENDENCY_EXPOSURE_LIMIT, SourceSemanticResourceExhausted, SourceSemanticResourceLedger,
  canonicalJson, hostOccurrenceIsMessage,
  type HostDependencyExposure, type HostSourceDependency, type SourceEvidenceTarget,
  type SourceIndexQueryRepository, type SourceIndexScopeAdmission, type SourceSemanticResourceBudget
} from "@do-soul/alaya-protocol";
import { authorizeSourceIndexScope } from "./source-semantic-access.js";

export type SourceDependencyDeliveryRead = Readonly<{
  exposure: HostDependencyExposure;
  resources: import("@do-soul/alaya-protocol").SourceIndexQueryResources;
}>;

type DependencyDeliveryInput = Readonly<{
  target: SourceEvidenceTarget; span: readonly [number, number]; authorizedScopes: readonly string[] | null;
  budget: SourceSemanticResourceBudget;
  byteLimit?: number;
  continuation?: Readonly<{ reference: HostSourceDependency; start_offset: number; source_occurrence_id: string;
    source_span: readonly [number, number] }>;
}>;
type NativeDependencyReader = NonNullable<SourceIndexQueryRepository["readHostDependency"]>;
type ReadyDependencyRead = Extract<ReturnType<NativeDependencyReader>, { status: "ready" }>;
type DependencyVisit = { reference: HostSourceDependency; ancestors: readonly string[] };

/** Prepare literal host prerequisites under the same source authorization and native budget.
 * The encoder still owns exposure: fitting may omit prepared prerequisite bytes. Nothing
 * here changes membership or the independent referring source's availability.
 */
export function readSourceDependencyDelivery(
  repository: Pick<SourceIndexQueryRepository, "readHostDependency">,
  input: DependencyDeliveryInput
): SourceDependencyDeliveryRead {
  return new DependencyDeliveryRead(repository, input).read();
}

/** One operation owns partial exposure and accounting, including work completed
 * before a later native read or resource charge fails. */
class DependencyDeliveryRead {
  private readonly meter: SourceSemanticResourceLedger;
  private nativeBytes = 0;
  private readonly roots: HostDependencyExposure["roots"][number][] = [];
  private readonly prerequisites: HostDependencyExposure["prerequisites"][number][] = [];
  private readonly pending: DependencyVisit[] = [];
  private status: HostDependencyExposure["status"] = "complete";
  private readonly admit: SourceIndexScopeAdmission = (scope, source) => {
    try { authorizeSourceIndexScope(scope, source, this.input.authorizedScopes); return "admitted"; }
    catch { return "denied"; }
  };

  constructor(
    private readonly repository: Pick<SourceIndexQueryRepository, "readHostDependency">,
    private readonly input: DependencyDeliveryInput
  ) {
    this.meter = new SourceSemanticResourceLedger(input.budget);
  }

  read(): SourceDependencyDeliveryRead {
    try {
      if (this.repository.readHostDependency === undefined || this.input.target.root_kind !== "source_record") {
        this.status = "unknown";
        return this.result();
      }
      const own = this.readNative({ root_id: this.input.target.root_id,
        source_version: this.input.target.source_version, content_digest: this.input.target.content_digest }, null);
      if (own.status !== "ready") {
        this.status = own.status === "unknown" ? "unknown" : "partial";
        return this.result();
      }
      if (this.captureRoots(own)) this.traversePrerequisites();
    } catch (error) {
      this.status = "partial";
      if (this.prerequisites.length < HOST_DEPENDENCY_EXPOSURE_LIMIT) this.prerequisites.push({
        status: error instanceof SourceSemanticResourceExhausted ? "resource_limited" : "invalid" });
    }
    return this.result();
  }

  private result(): SourceDependencyDeliveryRead {
    return { exposure: { status: this.status, roots: this.roots, prerequisites: this.prerequisites }, resources: {
      work: this.meter.spentWork, native_bytes: this.nativeBytes,
      memory_bytes: this.meter.spentBytes, sql_internal_work: "unknown"
    } };
  }

  private readNative(reference: Parameters<NativeDependencyReader>[1], id: string | null,
    window?: Parameters<NativeDependencyReader>[5]): ReturnType<NativeDependencyReader> {
    const value = this.repository.readHostDependency!(this.input.target.workspace_id,
      reference, id, this.meter.remaining(), this.admit, window);
    this.nativeBytes += value.resources.native_bytes;
    this.meter.charge(value.resources.work, value.resources.memory_bytes, "host dependency native read");
    return value;
  }

  /** False preserves the partial roots already observed when a continuation
   * occurrence lies outside its previously delivered source interval. */
  private captureRoots(own: ReadyDependencyRead): boolean {
    for (const occurrence of own.inventory.occurrences) {
      this.meter.charge(1, 0, "host dependency source extent");
      const [start, end] = occurrence.utf8_span;
      if (this.input.continuation !== undefined) {
        if (occurrence.occurrence_id !== this.input.continuation.source_occurrence_id) continue;
        if (start < this.input.continuation.source_span[0] || end > this.input.continuation.source_span[1]) {
          this.status = "partial";
          return false;
        }
      } else if (end <= this.input.span[0] || start >= this.input.span[1]) continue;
      const dependencies = occurrence.semantic_dependencies;
      this.meter.retain(occurrence, "host dependency source declaration");
      this.roots.push({ occurrence_id: occurrence.occurrence_id, utf8_span: occurrence.utf8_span,
        ...(this.input.continuation === undefined ? {} : { previously_delivered: true as const }),
        ...(dependencies === undefined ? {} : { dependencies }) });
      if (!hostOccurrenceIsMessage(occurrence) || start < this.input.span[0] || end > this.input.span[1]) this.status = "partial";
      if (dependencies === undefined) {
        this.status = this.roots.length === 1 && this.prerequisites.length === 0 ? "unknown" : "partial";
        continue;
      }
      const self = canonicalJson({ source_id: own.source.source_id, root_id: this.input.target.root_id,
        source_version: this.input.target.source_version, content_digest: this.input.target.content_digest,
        occurrence_id: occurrence.occurrence_id });
      for (const reference of dependencies) {
        this.meter.retain(reference, "host dependency traversal reference");
        this.pending.push({ reference, ancestors: [self] });
      }
    }
    return true;
  }

  private traversePrerequisites(): void {
    const visited = new Set<string>();
    let remainingBytes = this.input.byteLimit ?? Number.MAX_SAFE_INTEGER;
    const requested = this.input.continuation === undefined ? undefined : canonicalJson(this.input.continuation.reference);
    let reached = requested === undefined;
    for (let next = 0; next < this.pending.length; next++) {
      if (this.prerequisites.length >= HOST_DEPENDENCY_EXPOSURE_LIMIT || visited.size >= HOST_DEPENDENCY_EXPOSURE_LIMIT) {
        this.status = "partial";
        break;
      }
      const { reference, ancestors } = this.pending[next]!, key = canonicalJson(reference);
      this.meter.charge(key.length + ancestors.length, key.length * 2 + 64, "host dependency traversal");
      if (ancestors.includes(key)) {
        this.prerequisites.push({ reference, status: "cycle" });
        this.status = "partial";
        continue;
      }
      if (visited.has(key)) continue;
      visited.add(key);
      const selected = requested === undefined || key === requested;
      if (selected) reached = true;
      else this.status = "partial";
      const value = this.readNative(reference, reference.occurrence_id, { byte_limit: remainingBytes,
        ...(requested !== undefined && key === requested ? { start_offset: this.input.continuation!.start_offset } : {}),
        metadata_only: !selected });
      if (value.status !== "ready" || value.occurrence === undefined) {
        this.prerequisites.push({ ...(value.status === "denied" ? {} : { reference }),
          status: value.status === "ready" || value.status === "unknown" ? "unavailable" : value.status });
        this.status = "partial";
        continue;
      }
      const dependencies = value.occurrence.semantic_dependencies;
      if (selected) {
        const prepared = { reference, status: value.content_complete ? "delivered" as const : "partial" as const,
          utf8_span: value.occurrence.utf8_span, content: value.text ?? "", content_span: value.content_span,
          ...((value.content_span?.[1] ?? 0) < value.occurrence.utf8_span[1]
            ? { next_offset: value.content_span?.[1] ?? value.occurrence.utf8_span[0] } : {}),
          ...(dependencies === undefined ? {} : { dependencies }) };
        this.meter.retain(prepared, "host dependency prepared exposure");
        this.prerequisites.push(prepared);
        remainingBytes -= Buffer.byteLength(value.text ?? "");
        if (!value.content_complete) this.status = "partial";
      }
      if (dependencies === undefined) this.status = "partial";
      for (const child of dependencies ?? []) {
        this.meter.charge(1, 64 + ancestors.length * 8, "host dependency traversal frame");
        this.pending.push({ reference: child, ancestors: [...ancestors, key] });
      }
    }
    if (this.roots.length === 0) this.status = "unknown";
    else if (this.prerequisites.length === 0 && this.roots.every(row => row.dependencies === undefined)) this.status = "unknown";
    if (!reached) {
      this.status = "partial";
      if (this.prerequisites.length < HOST_DEPENDENCY_EXPOSURE_LIMIT) this.prerequisites.push({ status: "invalid" });
    }
  }
}

/** Bind prepared dependency bytes to the source interval that survived final encoding.
 * Dependency payload is optional: exhausting its allowance cannot shrink ordinary source.
 */
export function fitSourceDependencyExposure(exposure: HostDependencyExposure, span: readonly [number, number] | undefined,
  byteLimit: number): HostDependencyExposure | undefined {
  let fitted: HostDependencyExposure = { ...exposure, roots: exposure.roots.filter(row =>
    row.previously_delivered || span !== undefined && row.utf8_span[0] >= span[0] && row.utf8_span[1] <= span[1]) };
  if (fitted.roots.length !== exposure.roots.length) fitted = { status: "partial", roots: fitted.roots, prerequisites: [] };
  if (Buffer.byteLength(JSON.stringify(fitted)) <= byteLimit) return fitted;
  fitted = { status: "partial", roots: fitted.roots.map(({ occurrence_id, utf8_span, previously_delivered }) => ({ occurrence_id, utf8_span,
    ...(previously_delivered === undefined ? {} : { previously_delivered }) })),
    prerequisites: fitted.prerequisites.map(({ reference, utf8_span, content_span }) => ({ reference, utf8_span,
      ...(utf8_span === undefined ? {} : { next_offset: content_span?.[0] ?? utf8_span[0] }), status: "omitted" as const })) };
  if (Buffer.byteLength(JSON.stringify(fitted)) <= byteLimit) return fitted;
  const summary: HostDependencyExposure = { status: "partial", roots: [], prerequisites: [] };
  return Buffer.byteLength(JSON.stringify(summary)) <= byteLimit ? summary : undefined;
}
