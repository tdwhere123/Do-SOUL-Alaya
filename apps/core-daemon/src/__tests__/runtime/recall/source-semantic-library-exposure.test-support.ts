import { canonicalJson, sameRecallTarget, sourceGoldRootIdentity, sourceSemanticProofQualifier,
  type SourceEvidenceTarget, type SourceRecordIdentity, type SourceSemanticWorkerResult, type SoulInterpretationResponse
} from "@do-soul/alaya-protocol";
import { deliveredSourceSemanticLibraryProof, encodeSourceSemanticLibraryResponse, fieldContractSha256 } from "@do-soul/alaya-core";

type NativeRecall = Extract<SourceSemanticWorkerResult, { kind: "recall" }>;
type PublicRecall = Extract<SoulInterpretationResponse, { operation: "recall" }>;
export type ExposureSource = Readonly<{ record: SourceRecordIdentity; body: string }>;
type ExposureInterval = Readonly<{ start: number; end: number }>;
type PositionObservation = Readonly<{ target: SourceEvidenceTarget; preview: string; withinBudget: boolean }>;
type Status = "complete" | "partial" | "unknown";

/** Half-open source positions, never line/text equality. Adjacent extents share one union. */
function union(intervals: readonly ExposureInterval[]): ExposureInterval[] {
  const result: { start: number; end: number }[] = [];
  for (const interval of [...intervals].sort((a, b) => a.start - b.start || a.end - b.end)) {
    if (interval.start === interval.end) continue;
    const previous = result.at(-1);
    if (previous !== undefined && interval.start <= previous.end) previous.end = Math.max(previous.end, interval.end);
    else result.push({ ...interval });
  }
  return result;
}
/** Subtract the previously observed union without comparing source text. */
function difference(interval: ExposureInterval, observed: readonly ExposureInterval[]): ExposureInterval[] {
  const result: ExposureInterval[] = [];
  let start = interval.start;
  for (const previous of observed) {
    if (previous.end <= start) continue;
    if (previous.start >= interval.end) break;
    if (previous.start > start) result.push({ start, end: previous.start });
    start = Math.max(start, previous.end);
    if (start >= interval.end) break;
  }
  if (start < interval.end) result.push({ start, end: interval.end });
  return result;
}
const size = (intervals: readonly ExposureInterval[]) => intervals.reduce((sum, row) => sum + row.end - row.start, 0);
const status = (issues: readonly string[], known: number): Status => issues.length === 0 ? "complete" : known > 0 ? "partial" : "unknown";

function sourceFor(target: SourceEvidenceTarget, sources: readonly ExposureSource[]) {
  const matches = sources.filter(({ record }) => record.workspace_id === target.workspace_id
    && record.identity === target.root_id && record.source_version === target.source_version
    && record.content_digest === target.content_digest);
  return matches.length === 1 ? matches[0] : undefined;
}

/** Exact source-byte check at the declared offset; repeated text never supplies a missing address. */
function exposedInterval({ target, preview, withinBudget }: PositionObservation,
  source: ExposureSource | undefined): ExposureInterval | string {
  const span = target.span;
  if (target.root_kind !== "source_record" || span?.retained_extent !== "body") return "missing_body_address";
  if (source === undefined) return "source_mapping_missing_or_ambiguous";
  if (`sha256:${fieldContractSha256(source.body)}` !== target.content_digest) return "source_digest_mismatch";
  const body = Buffer.from(source.body, "utf8"), { content_start: start, content_end: end } = span;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > body.length) return "invalid_body_interval";
  if (!withinBudget) return "payload_omitted";
  const bytes = preview === "[empty source]" && start === end ? Buffer.alloc(0) : Buffer.from(preview, "utf8");
  const exposedEnd = start + bytes.length;
  if (exposedEnd > end || !body.subarray(start, exposedEnd).equals(bytes)
    || !Buffer.from(body.subarray(0, start).toString("utf8")).equals(body.subarray(0, start))) return "preview_source_mismatch";
  return { start, end: exposedEnd };
}

/** The interval authority for this harness, shared by pure controls and native-page adaptation.
 * Unknown increments are null. Cumulative known positions are a lower bound; the verified
 * union delta is not a claim of first exposure after an unmapped earlier observation. */
export function createSourcePositionExposureMeter() {
  const positions = new Map<string, readonly ExposureInterval[]>();
  let unresolvedHistory = false;
  return { observe(observations: readonly PositionObservation[], sources: readonly ExposureSource[], pageIssues: readonly string[] = []) {
    const issues = [...pageIssues], intervals: { root: string; start: number; end: number }[] = [];
    if (unresolvedHistory) issues.push("prior_observation_unresolved");
    if (pageIssues.length > 0) unresolvedHistory = true;
    const increments = new Map<string, readonly ExposureInterval[]>();
    let increment = 0;
    for (const [index, observation] of observations.entries()) {
      const { target } = observation, root = sourceGoldRootIdentity(target);
      const interval = exposedInterval(observation, sourceFor(target, sources));
      if (typeof interval === "string") { issues.push(`slot_${index}:${interval}`); unresolvedHistory = true; continue; }
      intervals.push({ root, ...interval });
      const before = positions.get(root) ?? [], added = difference(interval, before);
      increment += size(added); positions.set(root, union([...before, interval]));
      increments.set(root, union([...(increments.get(root) ?? []), ...added]));
      if (interval.end < target.span!.content_end) issues.push(`slot_${index}:preview_truncated`);
    }
    const observedStatus = status(issues, intervals.length);
    return { unit: "source_utf8_byte_positions" as const, status: observedStatus,
      increment: observedStatus === "complete" ? increment : null, known_increment: increment,
      known_increment_basis: "verified_interval_union" as const, history_complete: !unresolvedHistory,
      cumulative_known: [...positions.values()].reduce((sum, rows) => sum + size(rows), 0), intervals,
      newly_verified_intervals: [...increments].flatMap(([root, intervals]) => intervals.map(interval => ({ root, ...interval }))),
      cumulative_intervals: [...positions].map(([root, intervals]) => ({ root, intervals })), issues };
  } };
}

type PositionExposure = ReturnType<ReturnType<typeof createSourcePositionExposureMeter>["observe"]>;

/** Compare observed unions, not declared window ends or text similarity. */
export function compareSourcePositionExposure(before: PositionExposure, after: PositionExposure) {
  if (before.status !== "complete" || after.status !== "complete") {
    return [{ root: null, status: "unknown" as const, lost_bytes: null }];
  }
  const remaining = new Map(after.cumulative_intervals.map(row => [row.root, row.intervals]));
  return before.cumulative_intervals.map(row => {
    const kept = remaining.get(row.root) ?? [];
    const lost_bytes = row.intervals.reduce((total, interval) => total + size(difference(interval, kept)), 0);
    return { root: row.root, status: lost_bytes === 0 ? "retained" as const : "lost" as const, lost_bytes };
  });
}

function observeQualifications(native: NativeRecall, sources: readonly ExposureSource[],
  history: { seen: Set<string>; unresolved: boolean }, pageIssues: readonly string[]) {
  const issues = [...pageIssues], qualifications: { root: string; qualifier: NativeRecall["slot_qualifiers"][number] }[] = [];
  if (history.unresolved) issues.push("prior_observation_unresolved");
  const evaluator_usage = { work_units: 0, memory_bytes: 0 };
  let increment = 0, observedSlots = 0;
  if (pageIssues.length === 0) for (const [index, entry] of native.index.entries.entries()) {
    if (entry.target.kind !== "source_evidence") { issues.push(`slot_${index}:source_target_missing`); continue; }
    const target = entry.target, root = sourceGoldRootIdentity(target), source = sourceFor(target, sources);
    const qualifiers = native.slot_qualifiers.filter(row => row.index === index);
    if (qualifiers.length === 0) issues.push(`slot_${index}:qualification_missing`);
    for (const qualifier of qualifiers) {
      if (qualifier.evidence_kind !== "semantic_proof") { observedSlots += 1; continue; }
      const verified = deliveredSourceSemanticLibraryProof(native.index, entry, qualifier, native.proofs ?? [], source?.record);
      evaluator_usage.work_units += verified.resource_usage.work_units;
      evaluator_usage.memory_bytes += verified.resource_usage.memory_bytes;
      if (verified.proof === undefined) { issues.push(`slot_${index}:qualification_unverified`); continue; }
      observedSlots += 1; qualifications.push({ root, qualifier });
      // The owner projects Q/H/C/computation, binding witnesses and support; routing metadata is not an increment.
      const { index: _index, ...qualification } = sourceSemanticProofQualifier(verified.proof, index);
      const key = canonicalJson({ root, qualification });
      if (!history.seen.has(key)) { history.seen.add(key); increment += 1; }
    }
  }
  if (issues.length > 0) history.unresolved = true;
  const observedStatus = status(issues, observedSlots);
  return { unit: "verified_native_qualifications" as const, status: observedStatus,
    increment: observedStatus === "complete" ? increment : null, known_increment: increment,
    known_increment_basis: "verified_qualification_union" as const, history_complete: !history.unresolved,
    cumulative_known: history.seen.size, qualifications, issues, evaluator_usage };
}

/** Evaluator-local state: one instance per observed stream, never shared by paired arms.
 * Qualification is replay-verified conditional support, not relevance, fidelity or world truth. */
export function createLibraryExposureMeter() {
  const positions = createSourcePositionExposureMeter(), qualifications = { seen: new Set<string>(), unresolved: false };
  return { observe(native: NativeRecall, encoded: PublicRecall, sources: readonly ExposureSource[]) {
    const pageIssues: string[] = [], observations: PositionObservation[] = [];
    const results = encoded.results;
    // The encoder owns public completeness changes (including partial source windows).
    let pageBound = false;
    try { pageBound = canonicalJson(encoded) === canonicalJson(encodeSourceSemanticLibraryResponse(native)); }
    catch { /* Invalid native binding is an unknown observation, not successful absence. */ }
    if (!pageBound || results === undefined || results.length !== native.index.entries.length) pageIssues.push("public_native_page_mismatch");
    else for (const [index, entry] of native.index.entries.entries()) {
      const result = results[index]!, target = result.target;
      if (target?.kind !== "source_evidence" || entry.target.kind !== "source_evidence" || !sameRecallTarget(target, entry.target)) {
        pageIssues.push(`slot_${index}:public_native_target_mismatch`); continue;
      }
      observations.push({ target, preview: result.content_preview, withinBudget: result.budget_state.within_budget });
    }
    return { contract: "source-position-exposure-v1" as const, scope: "observed_delivery_only" as const,
      // Native closure is independent of exact positions in an actually delivered window.
      native_completeness: { payload: native.coverage.payload, discovery_truncated: native.discovery.truncated,
        open_residuals: native.discovery.open_residuals },
      position: positions.observe(observations, sources, pageIssues),
      content_context: { status: "not_measured" as const, reason: "no_declared_content_context_signal" as const },
      proof_qualification: observeQualifications(native, sources, qualifications, pageIssues) };
  } };
}
