import { AlayaError, type SourceIndexTarget, type SourceSemanticNominationOccurrence } from "@do-soul/alaya-protocol";
import { authorizeSemanticScope, fieldContractSha256, sourceSemanticLibrarySourceEntry } from "@do-soul/alaya-core";
import { sourceRecordFromRow, SqliteFieldSourceRecordRepo, type StorageDatabase } from "@do-soul/alaya-storage";
import { SourceSemanticReadBudget } from "../../../../core-daemon/dist/runtime/field/source-semantic-read-stores.js";
import { prepareNominatedLibraryWindows } from "../../../../core-daemon/dist/runtime/recall-read-worker/source-semantic-library-nominated-windows.js";
import { FIELD_DELIVERY_LIMITS, packFieldWindows, selectFieldDelivery, type FieldDelivery, type LiteralDeliveryWindow } from "./field-delivery.js";
import type { NavigationCondition, solveConditionalNavigation } from "./conditional-navigation.js";
import type { bindSourceRecordsObservation } from "../snapshot/source-records/observation-projection.js";
import { NAVIGATION_SOURCE_READ_ALLOWANCE, readNavigationSource, type NavigationSourceRead, type ReadAccounting, type StructuralReadLedger } from "./structural-navigation.js";

const NAVIGATION_PREVIEW_BYTES = FIELD_DELIVERY_LIMITS.window_bytes;
export type AnchorAccounting = { status: "complete" | "partial"; attempts: number; completed: number;
  native_bytes_including_metadata: number; native_work: number; physical_reads: null };
export const anchorAccounting = (): AnchorAccounting => ({ status: "complete", attempts: 0, completed: 0,
  native_bytes_including_metadata: 0, native_work: 0, physical_reads: null });
export type DeliveryReads = { ordinal: number; question_id: string; arm: string; accounting: ReadAccounting; reused_delivery_reads: number;
  anchor_accounting?: AnchorAccounting; selected_roots?: string[]; delivered_roots?: string[];
  status?: "running" | "complete" | "failed"; capture_status?: "pending" | "published" | "failed" };
type DeliveryRow = { workspace: string; authorized_scopes: readonly string[] | null; interpretation_clock: string;
  original: string; conditions: readonly NavigationCondition[]; delivery_policy?: FieldDelivery };
type DeliveryContext = { row: DeliveryRow; database: StorageDatabase; solved: ReturnType<typeof solveConditionalNavigation>;
  targets: ReadonlyMap<string, SourceIndexTarget>; witnesses: readonly SourceSemanticNominationOccurrence[];
  projectSourceTime: ReturnType<typeof bindSourceRecordsObservation>; delivery: DeliveryReads;
  ledger?: StructuralReadLedger; cached: ReadonlyMap<string, NavigationSourceRead> };
function check(test: boolean, message: string): asserts test { if (!test) throw new AlayaError("VALIDATION", message); }

/** Selection, literal read and packing share one frozen page. The legacy prefix
 * remains the named comparison consumer; omitted policy retains it unchanged. */
export function readFieldDelivery(ctx: DeliveryContext) {
  const { row, database, solved, delivery } = ctx, policy = row.delivery_policy;
  const selected = policy ? selectFieldDelivery(solved, policy) : undefined;
  const ordered = selected?.rows ?? solved.rows;
  delivery.selected_roots = ordered.slice(0, FIELD_DELIVERY_LIMITS.slots).map(item => item.record_id); delivery.status = "running";
  try {
    const missing: { record_id: string; reason: string }[] = [];
    const read = policy?.windows === "native-anchor" ? ordered.flatMap((item, index) => {
      delivery.anchor_accounting ??= anchorAccounting();
      const result = readFieldAnchor({ database, workspace: row.workspace, clock: row.interpretation_clock,
        original_query: row.conditions.find(c => c.id === row.original)!.query, scopes: row.authorized_scopes,
        witnesses: ctx.witnesses, record_id: item.record_id, rank: index + 1, accounting: delivery.anchor_accounting });
      if (result.status === "unavailable") { missing.push({ record_id: item.record_id, reason: result.reason }); return []; }
      return [result.window];
    }) : readLegacyPrefixes(ctx, ordered);
    const packed = policy ? packFieldWindows(read, policy.byte_budget) : undefined;
    const { windows, ...packing } = packed ?? { windows: read };
    delivery.delivered_roots = windows.map(w => w.target.root_id); delivery.status = "complete";
    return { windows, fieldDelivery: policy ? { policy, selection: selected,
      packing, missing_locations: missing, status: missing.length ? "unavailable" : "complete" } : undefined };
  } catch (error) { delivery.status = "failed"; throw error; }
}

/** Historical control: ten field-ordered prefixes, also used with fixed-member
 * prefix packing to isolate selection from the native-window intervention. */
function readLegacyPrefixes(ctx: DeliveryContext, selected: ReturnType<typeof solveConditionalNavigation>["rows"]) {
  const { row, database, targets, projectSourceTime, delivery, ledger, cached } = ctx;
  const records = new SqliteFieldSourceRecordRepo(database, fieldContractSha256);
  return selected.slice(0, FIELD_DELIVERY_LIMITS.slots).map((item, index) => {
    const target = targets.get(item.record_id)!;
    const reuse = cached.get(item.record_id);
    const read = reuse ?? readNavigationSource(records, row.workspace, item.record_id, NAVIGATION_PREVIEW_BYTES, delivery.accounting, ledger);
    if (reuse) { delivery.reused_delivery_reads++; if (ledger) ledger.reused_delivery_reads++; }
    check(read !== null && read.record !== null && read.record.source_body !== null && !read.invalidOffset && !read.resourceLimited,
      "authorized source window unavailable");
    check(read.record.source_id === target.source_id && read.record.record_id === target.target.root_id
      && read.record.workspace_id === target.target.workspace_id
      && read.record.content_digest === target.target.content_digest && read.record.source_version === target.target.source_version,
      "source read identity changed");
    authorizeSemanticScope(read.record.scope_class, row.authorized_scopes);
    return { rank: index + 1, source_id: target.source_id, target: target.target, start: 0, end: read.prefixBytes,
      source_time: projectSourceTime(sourceRecordFromRow(read.record)), text: read.record.source_body,
      read: { status: read.prefixBytes === read.bodyBytes ? "complete" : "partial",
        body_bytes: read.bodyBytes, native_bytes: read.nativeBytes + read.metadataBytes } };
  });
}

/** Reuses the existing source-bound located-window operation, including its
 * metered currentness probe, scope, retained chunks, digest and UTF-8 checks.
 * No lexical offset is inferred from query text, catalog spelling or gold. */
export function readFieldAnchor(input: {
  database: StorageDatabase; workspace: string; clock: string; original_query: string; scopes: readonly string[] | null;
  witnesses: readonly SourceSemanticNominationOccurrence[]; record_id: string; rank: number;
  accounting: AnchorAccounting;
}): { status: "unavailable"; reason: string } | { status: "available"; window: LiteralDeliveryWindow } {
  const candidates = input.witnesses.filter(hit => hit.source.target.root_id === input.record_id);
  const located = candidates.find(hit => hit.route.kind === "vector" && hit.route.window?.status === "available");
  if (!located || located.route.kind !== "vector" || located.route.window?.status !== "available") {
    return { status: "unavailable", reason: candidates.some(hit => hit.route.kind === "lexical" && hit.route.hit?.status === "available")
      ? "lexical_location_reader_unavailable" : "native_location_missing" };
  }
  const { source, route } = located, boundWindow = located.route.window.window;
  const target = source.target;
  const entry = sourceSemanticLibrarySourceEntry({ workspaceId: input.workspace, root_id: target.root_id,
    source_version: target.source_version, content_digest: target.content_digest,
    evidence_object_id: target.evidence_object_id, hypothesis_id: "benchmark-source-navigation" });
  const allowance = { work_units: NAVIGATION_SOURCE_READ_ALLOWANCE.work_units,
    memory_bytes: NAVIGATION_SOURCE_READ_ALLOWANCE.native_bytes };
  const meter = new SourceSemanticReadBudget(allowance);
  const account = input.accounting;
  // One logical hydration attempt; the reusable owner may read multiple chunks.
  // Physical operation count and metadata/native split are not exposed by it.
  account.attempts++; account.status = "partial";
  try {
    const windows = prepareNominatedLibraryWindows({ database: input.database }, {
      workspace_id: input.workspace, as_of: input.clock,
      authorized_scopes: input.scopes === null ? { mode: "unrestricted" } : { mode: "named", scopes: input.scopes },
      request: { kind: "recall", original_query: input.original_query, accepts_unreviewed_conditional_results: true,
        budget: { schema_version: 1, ...allowance,
          page_budget: NAVIGATION_PREVIEW_BYTES, finalization_reserve: 0, min_envelope: 1 }, output_byte_limit: NAVIGATION_PREVIEW_BYTES }
    }, input.scopes, meter, [entry], [{ source, lexical: [], vector: {
      rank: route.native_rank, cosine: route.cosine, window: boundWindow } }]);
    const window = windows[0], span = window?.entry.target.kind === "source_evidence" ? window.entry.target.span : undefined;
    if (!window || !span) throw new AlayaError("UNAVAILABLE", "native located window unavailable");
    account.completed++;
    return { status: "available", window: { rank: input.rank, source_id: source.source_id, target,
      start: span.content_start, end: span.content_end, text: window.preview } };
  } finally {
    account.native_bytes_including_metadata += meter.nativeBytes; account.native_work += meter.nativeWork;
    account.status = account.attempts === account.completed ? "complete" : "partial";
  }
}
