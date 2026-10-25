import { fieldContractSha256 } from "@do-soul/alaya-core";
import { AlayaError, hashAddressableSourceSpanId, sourceGoldRootIdentity } from "@do-soul/alaya-protocol";
import { SqliteFieldSourceRecordRepo, SqliteFieldSourceSpanRepo, type StorageDatabase } from "@do-soul/alaya-storage";
import type { AnswerTurnGold } from "../../longmemeval-semantic/answer-spans.js";
import { scoreConsumerByteVisibility, type ConsumerVisibilityInput } from "../../longmemeval-semantic/message-visibility.js";
import type { SourceGoldUnit } from "../../measurement/source-gold-join.js";
import { scoreOrdinaryByteVisibility } from "./ordinary-byte-visibility.js";
import { clipOrdinaryPreview, ordinaryBodyStreamUnavailableReason, ordinaryLiteralWindows, ordinaryUnmappedSources, type OrdinarySourcePreview }
  from "./ordinary-preview-stream.js";

type LineFact = Readonly<{ target: SourceGoldUnit } & (
  { status: "available"; ends: readonly number[] } | { status: "unavailable"; reason: string }
)>;
const rootKey = (target: SourceGoldUnit) => sourceGoldRootIdentity({ ...target, kind: "source_evidence", evidence_object_id: null });

/** Evaluator-only metadata read from the same immutable snapshot already admitted
 * by the frozen-capture owner. No inferred newline, role, or message boundaries.
 * Unreadable facts remain unavailable; a successfully read empty set is different.
 */
export function readOrdinaryLineFacts(database: StorageDatabase, targets: readonly SourceGoldUnit[]): readonly LineFact[] {
  const unique = [...new Map(targets.map(target => [rootKey(target), target])).values()];
  let records: SqliteFieldSourceRecordRepo, spans: SqliteFieldSourceSpanRepo;
  try {
    records = new SqliteFieldSourceRecordRepo(database, fieldContractSha256);
    spans = new SqliteFieldSourceSpanRepo(database, fieldContractSha256);
  } catch { return unique.map(target => ({ target, status: "unavailable", reason: "line_metadata_unreadable" })); }
  const workspaces = new Map<string, ReturnType<typeof spans.listByWorkspace> | null>();
  return unique.map(target => {
    const unavailable = (reason: string): LineFact => ({ target, status: "unavailable", reason });
    if (target.root_kind !== "source_record") return unavailable("line_facts_require_source_record");
    try {
      const record = records.findById(target.workspace_id, target.root_id);
      if (record?.source_body == null || record.source_version !== target.source_version
        || record.content_digest !== target.content_digest) return unavailable("line_source_identity_unavailable");
      if (!workspaces.has(target.workspace_id)) {
        try { workspaces.set(target.workspace_id, spans.listByWorkspace(target.workspace_id)); }
        catch { workspaces.set(target.workspace_id, null); }
      }
      const rows = workspaces.get(target.workspace_id);
      if (rows == null) return unavailable("line_metadata_unreadable");
      const lines = rows.filter(row => row.record_id === target.root_id && row.purpose === "line");
      const body = Buffer.from(record.source_body);
      if (lines.some(row => row.span_id !== hashAddressableSourceSpanId(row, fieldContractSha256)
        || row.end_offset > body.length || row.start_offset >= row.end_offset
        || !utf8Boundary(body, row.start_offset) || !utf8Boundary(body, row.end_offset))) {
        return unavailable("line_metadata_invalid");
      }
      return { target, status: "available", ends: [...new Set(lines.map(row => row.end_offset))].sort((a, b) => a - b) };
    } catch { return unavailable("line_metadata_unreadable"); }
  });
}

/** Label-blind single-budget packing over captured units only. Each unit's cap is
 * its admitted preview length, not an invented full-body allowance. No new root,
 * source read, or native page is supplied by this counterfactual. */
export function packOrdinaryLinePreviews(previews: readonly OrdinarySourcePreview[],
  lineEnds: ReadonlyMap<string, readonly number[]>, budget: number) {
  if (!Number.isSafeInteger(budget) || budget < 0) throw new AlayaError("CONFLICT", "invalid counterfactual byte budget");
  if (ordinaryBodyStreamUnavailableReason(previews) !== null) throw new AlayaError("UNAVAILABLE", "source-body stream mapping unavailable");
  const packed: OrdinarySourcePreview[] = [];
  let remaining = budget;
  for (const preview of previews) {
    if (preview.source.status === "not_delivered") continue;
    if (remaining === 0) return { previews: packed, may_extend: false };
    const cap = Math.min(Buffer.byteLength(preview.text), remaining);
    // Only literal body bytes enter B. Unmapped displays were refused above.
    const fitting = preview.source.status === "literal"
      ? (lineEnds.get(rootKey(preview.target)) ?? []).filter(value => value > 0 && value <= cap) : [];
    const end = fitting.length === 0 ? undefined : Math.max(...fitting);
    const clipped = clipOrdinaryPreview(preview, end ?? cap);
    if (clipped.text.length > 0) { packed.push(clipped); remaining -= Buffer.byteLength(clipped.text); }
    // A clipped codepoint's slack must not expose a later root in the control.
    if (end === undefined && cap < Buffer.byteLength(preview.text)) return { previews: packed, may_extend: false };
  }
  return { previews: packed, may_extend: remaining > 0 };
}

/** Post-freeze comparison, not a production replay. Fresh packing at each B can
 * be non-monotone, so no repacked FHB/LHB is inferred or reported. */
export function scoreOrdinaryLineCounterfactual(input: ConsumerVisibilityInput & Readonly<{
  previews: readonly OrdinarySourcePreview[]; line_facts: readonly LineFact[];
}>) {
  const baseline = scoreOrdinaryByteVisibility(input), literal = ordinaryLiteralWindows(input.previews ?? []);
  const facts = new Map(input.line_facts.map(fact => [rootKey(fact.target), fact]));
  const duplicateFacts = facts.size !== input.line_facts.length;
  const unavailable = baseline.captured_source_utf8_bytes === null ? "ordinary_captured_stream_unavailable"
    : duplicateFacts ? "line_metadata_ambiguous"
      : literal.some(window => window.start !== 0) ? "counterfactual_requires_source_zero_prefixes"
        : literal.some(window => facts.get(rootKey(window.target))?.status !== "available")
          ? "line_metadata_unavailable" : null;
  const lineEnds = new Map([...facts].flatMap(([key, fact]) => fact.status === "available" ? [[key, fact.ends] as const] : []));
  const budgets = baseline.budgets.map(control => {
    const packed = unavailable === null ? packOrdinaryLinePreviews(input.previews, lineEnds, control.byte_budget)
      : { previews: [], may_extend: false };
    const windows = ordinaryLiteralWindows(packed.previews);
    const bytes = windows.reduce((total, window) => total + Buffer.byteLength(window.text), 0);
    const score = scoreConsumerByteVisibility({ gold: input.gold, windows, byte_budget: control.byte_budget,
      unique_utf8_bytes: bytes, unmapped_sources: ordinaryUnmappedSources(packed.previews),
      ...(unavailable === null ? {} : { unavailableReason: unavailable }) });
    const retain = (metric: typeof score.any_at_budget) => metric.status === "miss"
      && baseline.captured_stream_complete === false && packed.may_extend
      ? { status: "unknown" as const, reason: "ordinary_captured_stream_incomplete" } : metric;
    return { byte_budget: control.byte_budget, prefix: control,
      aligned: { source_utf8_bytes: unavailable === null ? bytes : null,
        any_at_budget: retain(score.any_at_budget), all_at_budget: retain(score.all_at_budget),
        intervals: windows.map(({ text: _text, ...interval }) => interval), unmapped_sources: ordinaryUnmappedSources(packed.previews) } };
  });
  return { contract: "ordinary-captured-line-counterfactual-v2" as const,
    domain: "captured_preview_units_same_order_and_caps_not_native_page_replay" as const,
    status: unavailable === null ? "available" as const : "unavailable" as const, reason: unavailable,
    premise: lineEndPremise(input.gold, duplicateFacts ? new Map() : facts), budgets };
}

function lineEndPremise(gold: AnswerTurnGold | undefined, facts: ReadonlyMap<string, LineFact>) {
  let onBoundary = 0, offBoundary = 0, unavailable = 0;
  for (const span of gold?.spans ?? []) {
    const fact = facts.get(rootKey(span.target));
    if (fact?.status !== "available") unavailable++;
    else if (fact.ends.includes(span.end)) onBoundary++;
    else offBoundary++;
  }
  const annotated = gold?.annotated_turns ?? null;
  const unmapped = annotated === null ? null : annotated - (gold?.spans.length ?? 0);
  return { annotated, on_boundary: onBoundary, off_boundary: offBoundary, unavailable, unmapped,
    exact_rate: gold?.complete && unavailable === 0 && annotated !== null && annotated > 0 ? onBoundary / annotated : null,
    scope: "evidence_end_boundary_only_other_theorem_premises_checked_separately" as const };
}

function utf8Boundary(bytes: Buffer, offset: number): boolean {
  return Number.isSafeInteger(offset) && offset >= 0 && offset <= bytes.length
    && (offset === bytes.length || (bytes[offset]! & 0xc0) !== 0x80);
}
