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

/** Prepare literal host prerequisites under the same source authorization and native budget.
 * The encoder still owns exposure: fitting may omit prepared prerequisite bytes. Nothing
 * here changes membership or the independent referring source's availability.
 */
export function readSourceDependencyDelivery(repository: Pick<SourceIndexQueryRepository, "readHostDependency">, input: Readonly<{
  target: SourceEvidenceTarget; span: readonly [number, number]; authorizedScopes: readonly string[] | null;
  budget: SourceSemanticResourceBudget;
  byteLimit?: number;
  continuation?: Readonly<{ reference: HostSourceDependency; start_offset: number; source_occurrence_id: string;
    source_span: readonly [number, number] }>;
}>): SourceDependencyDeliveryRead {
  const meter = new SourceSemanticResourceLedger(input.budget);
  let nativeBytes = 0;
  const roots: HostDependencyExposure["roots"][number][] = [];
  const prerequisites: HostDependencyExposure["prerequisites"][number][] = [];
  let status: HostDependencyExposure["status"] = "complete";
  const result = (): SourceDependencyDeliveryRead => ({ exposure: { status, roots, prerequisites }, resources: {
    work: meter.spentWork, native_bytes: nativeBytes, memory_bytes: meter.spentBytes, sql_internal_work: "unknown"
  } });
  const admit: SourceIndexScopeAdmission = (scope, source) => {
    try { authorizeSourceIndexScope(scope, source, input.authorizedScopes); return "admitted"; }
    catch { return "denied"; }
  };
  const read = (reference: Parameters<NonNullable<SourceIndexQueryRepository["readHostDependency"]>>[1], id: string | null,
    window?: Parameters<NonNullable<SourceIndexQueryRepository["readHostDependency"]>>[5]) => {
    const value = repository.readHostDependency!(input.target.workspace_id, reference, id, meter.remaining(), admit, window);
    nativeBytes += value.resources.native_bytes;
    meter.charge(value.resources.work, value.resources.memory_bytes, "host dependency native read");
    return value;
  };
  try {
    if (repository.readHostDependency === undefined || input.target.root_kind !== "source_record") {
      status = "unknown"; return result();
    }
    const own = read({ root_id: input.target.root_id, source_version: input.target.source_version,
      content_digest: input.target.content_digest }, null);
    if (own.status !== "ready") { status = own.status === "unknown" ? "unknown" : "partial"; return result(); }
    const pending: { reference: HostSourceDependency; ancestors: readonly string[] }[] = [];
    for (const occurrence of own.inventory.occurrences) {
      meter.charge(1, 0, "host dependency source extent");
      const [start, end] = occurrence.utf8_span;
      if (input.continuation !== undefined) {
        if (occurrence.occurrence_id !== input.continuation.source_occurrence_id) continue;
        if (start < input.continuation.source_span[0] || end > input.continuation.source_span[1]) {
          status = "partial"; return result();
        }
      } else if (end <= input.span[0] || start >= input.span[1]) continue;
      const dependencies = occurrence.semantic_dependencies;
      meter.retain(occurrence, "host dependency source declaration");
      roots.push({ occurrence_id: occurrence.occurrence_id, utf8_span: occurrence.utf8_span,
        ...(input.continuation === undefined ? {} : { previously_delivered: true as const }),
        ...(dependencies === undefined ? {} : { dependencies }) });
      if (!hostOccurrenceIsMessage(occurrence) || start < input.span[0] || end > input.span[1]) status = "partial";
      if (dependencies === undefined) { status = roots.length === 1 && prerequisites.length === 0 ? "unknown" : "partial"; continue; }
      const self = canonicalJson({ source_id: own.source.source_id, root_id: input.target.root_id,
        source_version: input.target.source_version, content_digest: input.target.content_digest, occurrence_id: occurrence.occurrence_id });
      for (const reference of dependencies) {
        meter.retain(reference, "host dependency traversal reference");
        pending.push({ reference, ancestors: [self] });
      }
    }
    const visited = new Set<string>();
    let remainingBytes = input.byteLimit ?? Number.MAX_SAFE_INTEGER;
    const requested = input.continuation === undefined ? undefined : canonicalJson(input.continuation.reference);
    let reached = requested === undefined;
    for (let next = 0; next < pending.length; next++) {
      if (prerequisites.length >= HOST_DEPENDENCY_EXPOSURE_LIMIT || visited.size >= HOST_DEPENDENCY_EXPOSURE_LIMIT) { status = "partial"; break; }
      const { reference, ancestors } = pending[next]!, key = canonicalJson(reference);
      meter.charge(key.length + ancestors.length, key.length * 2 + 64, "host dependency traversal");
      if (ancestors.includes(key)) { prerequisites.push({ reference, status: "cycle" }); status = "partial"; continue; }
      if (visited.has(key)) continue;
      visited.add(key);
      const selected = requested === undefined || key === requested;
      if (selected) reached = true;
      else status = "partial";
      const value = read(reference, reference.occurrence_id, { byte_limit: remainingBytes,
        ...(requested !== undefined && key === requested ? { start_offset: input.continuation!.start_offset } : {}),
        metadata_only: !selected });
      if (value.status !== "ready" || value.occurrence === undefined) {
        prerequisites.push({ ...(value.status === "denied" ? {} : { reference }),
          status: value.status === "ready" || value.status === "unknown" ? "unavailable" : value.status });
        status = "partial"; continue;
      }
      const dependencies = value.occurrence.semantic_dependencies;
      if (selected) {
        const prepared = { reference, status: value.content_complete ? "delivered" as const : "partial" as const,
          utf8_span: value.occurrence.utf8_span, content: value.text ?? "", content_span: value.content_span,
          ...((value.content_span?.[1] ?? 0) < value.occurrence.utf8_span[1]
            ? { next_offset: value.content_span?.[1] ?? value.occurrence.utf8_span[0] } : {}),
          ...(dependencies === undefined ? {} : { dependencies }) };
        meter.retain(prepared, "host dependency prepared exposure"); prerequisites.push(prepared);
        remainingBytes -= Buffer.byteLength(value.text ?? "");
        if (!value.content_complete) status = "partial";
      }
      if (dependencies === undefined) status = "partial";
      for (const child of dependencies ?? []) {
        meter.charge(1, 64 + ancestors.length * 8, "host dependency traversal frame");
        pending.push({ reference: child, ancestors: [...ancestors, key] });
      }
    }
    if (roots.length === 0) status = "unknown";
    else if (prerequisites.length === 0 && roots.every(row => row.dependencies === undefined)) status = "unknown";
    if (!reached) {
      status = "partial";
      if (prerequisites.length < HOST_DEPENDENCY_EXPOSURE_LIMIT) prerequisites.push({ status: "invalid" });
    }
    return result();
  } catch (error) {
    status = "partial";
    if (prerequisites.length < HOST_DEPENDENCY_EXPOSURE_LIMIT) prerequisites.push({
      status: error instanceof SourceSemanticResourceExhausted ? "resource_limited" : "invalid" });
    return result();
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
