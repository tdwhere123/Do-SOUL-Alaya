import { SOURCE_SEMANTIC_LIBRARY_INTERPRETATION_PAGE, SourceSemanticResourceExhausted,
  type SourceRecordIdentity, type SourceSemanticAccessSignal, type SourceSemanticAccessReceipt,
  type SourceSemanticResourceLedger } from "@do-soul/alaya-protocol";
import { CoreError } from "@do-soul/alaya-core";
import { SqliteSourceHintReader, type StorageDatabase } from "@do-soul/alaya-storage";

type SourceRecallHeader = Readonly<{ identity: string; object_id: string; source_hash: string | null; query_hint?: true }>;
type SourceObservation = SourceSemanticAccessReceipt["source_candidates"][number];
type Stop = SourceSemanticAccessReceipt["stopping_reasons"][number];
type HeaderPage = Readonly<{ rows: readonly SourceRecallHeader[]; rawEmpty: boolean;
  resourceLimited: boolean; truncated: boolean; committedThrough: string | null }>;
export type SourceRecallAccessMeter = SourceSemanticResourceLedger & Readonly<{ phase: string;
  observer?: Readonly<{ event: (kind: string, phase: string, data: () => unknown) => void }> }>;
type SourceRecallVerification = Readonly<{
  allows: (sourceId: string) => boolean;
  acceptSource: (record: SourceRecordIdentity, text: string) => SourceSemanticAccessSignal;
}>;
type SourceRecallAccess = Readonly<{
  records: SourceRecordIdentity[]; byId: Map<string, SourceRecordIdentity>;
  sources: Map<string, SourceObservation>; stops: Set<Stop>; meter: SourceRecallAccessMeter;
  sourceId?: string; preview: boolean;
  readSource: (record: SourceRecordIdentity, afterExtent?: () => void) => void;
  readHeaders: (after: string | null) => HeaderPage;
  navigate: () => Readonly<{ rows: readonly SourceRecallHeader[]; unavailable: boolean; resourceLimited: boolean }> | null;
  verify: (row: SourceRecallHeader, admission: SourceRecallVerification) => void;
  schedule: (pending: readonly SourceRecallHeader[], exploration: readonly SourceRecallHeader[]) => SourceRecallHeader[];
  sourceSignal: (text: string) => SourceSemanticAccessSignal;
  associateSource: (digest: string, signal: SourceSemanticAccessSignal) => void;
  previewExtent: (record: SourceRecordIdentity) => void;
  beforeRetain?: (record: SourceRecordIdentity) => void;
  discoveredLookup: () => void;
  onConclusiveEmpty?: () => void; beginCanonicalObservation?: () => void;
  filtered: (error: CoreError) => boolean;
}>;
const UNKNOWN: SourceSemanticAccessSignal = { source_text_score: null, interpretation_reading_score: 0 };
type HeaderMeter = SourceRecallAccessMeter & Readonly<{ read: (work: number, bytes: number) => void }>;

/** Original and hint routes consume the same bounded native header allowance. */
export function navigateSourceRecallHeaders(database: StorageDatabase, workspace: string, meter: HeaderMeter,
  navigation: (route: "original" | "hint") => string | null) {
  const rows: SourceRecallHeader[] = [];
  let nativeRemaining = 2 * SOURCE_SEMANTIC_LIBRARY_INTERPRETATION_PAGE + 2;
  let unavailable = false, resourceLimited = false;
  try {
    for (const route of ["original", "hint"] as const) {
      if (nativeRemaining === 0 || rows.length === SOURCE_SEMANTIC_LIBRARY_INTERPRETATION_PAGE) break;
      const query = navigation(route);
      if (query === null) continue;
      const nativeLimit = Math.min(meter.work, nativeRemaining);
      const nativeByteLimit = Math.min(Math.floor(meter.bytes / 8), 1_000_000);
      meter.reserve(nativeLimit, nativeByteLimit, "access navigation page");
      const page = new SqliteSourceHintReader(database.connection).pageInterpretationTextHints({
        workspaceId: workspace, query, limit: SOURCE_SEMANTIC_LIBRARY_INTERPRETATION_PAGE - rows.length,
        nativeLimit, nativeByteLimit, afterCursor: null
      });
      meter.read(page.nativeVisits, page.bytesRead); nativeRemaining -= page.nativeVisits;
      meter.observer?.event("interpretation_navigation", meter.phase, () => ({ route, ids: page.rows.map(row => row.object_id),
        unavailable: page.unavailable, resource_limited: page.resourceLimited, rank: "not_provided_by_native_cursor_route" }));
      unavailable ||= page.unavailable; resourceLimited ||= page.resourceLimited;
      for (const row of page.rows) {
        const header = { ...row, identity: row.object_id, query_hint: true as const };
        meter.retain(header, "access lexical header retention"); rows.push(header);
      }
    }
  } catch (error) { if (!(error instanceof SourceSemanticResourceExhausted)) throw error; resourceLimited = true; }
  return { rows, unavailable, resourceLimited };
}

export function readSourceRecallHeaders(database: StorageDatabase, workspace: string, meter: HeaderMeter, after: string | null): HeaderPage {
  const reader = new SqliteSourceHintReader(database.connection);
  meter.reserve(1, 784, "interpretation access header page");
  const page = reader.pageBoundInterpretationHeaders({ workspaceId: workspace,
    limit: Math.min(SOURCE_SEMANTIC_LIBRARY_INTERPRETATION_PAGE, meter.work), afterCursor: after,
    nativeByteLimit: Math.min(Math.floor(meter.bytes / 8), 1_000_000) });
  meter.read(page.nativeVisits, page.bytesRead);
  meter.observer?.event("interpretation_cursor", meter.phase, () => ({ after, committed_through: page.committedThrough,
    ids: page.rows.map(row => row.object_id), truncated: page.truncated, resource_limited: page.resourceLimited }));
  const rawEmpty = after === null && page.rows.length === 0 && !page.truncated && !page.resourceLimited;
  const rows: SourceRecallHeader[] = [];
  for (const row of page.rows) {
    meter.charge(1, 0, "access capsule lifecycle check");
    if (row.lifecycle_state !== "active") continue;
    const header = { ...row, identity: row.object_id };
    meter.retain(header, "access interpretation header retention"); rows.push(header);
  }
  return { ...page, rows, rawEmpty };
}

/** Owns the union, source/header interleaving, read progression and verified-read reuse.
 * Verification supplies current authorized source bytes, never a proof-bearing payload.
 * The adapter retains descriptors; this phase retains only its native header queues.
 */
export function observeSourceRecallAccess(input: SourceRecallAccess): Readonly<{ pages: number; open: boolean }> {
  const { records, sources, stops, meter } = input;
  let pending: SourceRecallHeader[] = [], exploration: SourceRecallHeader[] = [];
  const seen = new Map<string, SourceRecallHeader | null>();
  let after: string | null = null, pages = 0, sourceOffset = 0, headersDone = false, open = false, readingInitialCensus = false;
  const admission: SourceRecallVerification = {
    allows: sourceId => {
      if (input.sourceId !== undefined) {
        meter.charge(1, 0, "access interpretation source membership");
        if (sourceId !== input.sourceId) return false;
      }
      if (!input.preview) return true;
      let current: SourceRecordIdentity | undefined;
      for (const record of records) {
        meter.charge(1, 0, "access preview verification tuple");
        if (record.source_id === sourceId) { current = record; break; }
      }
      if (current !== undefined && sources.get(current.identity)?.complete === true) return true;
      open = true; stops.add("unavailable"); return false;
    },
    acceptSource: (record, text) => acceptVerifiedSource(input, record, text)
  };
  try {
    const readFirstPage = () => {
      readingInitialCensus = true;
      const page = input.readHeaders(after); pages++;
      if (page.rawEmpty) {
        try { input.onConclusiveEmpty?.(); }
        catch (error) {
          if (error instanceof SourceSemanticResourceExhausted) throw new SourceSemanticResourceExhausted("empty interpretation completion");
          throw error;
        }
      }
      readingInitialCensus = false; return page;
    };
    let firstPage: HeaderPage | undefined;
    if (records.length > 0) {
      input.beginCanonicalObservation?.();
      input.readSource(records[sourceOffset++]!, () => { firstPage = readFirstPage(); });
    }
    firstPage ??= readFirstPage();
    const navigation = firstPage.rawEmpty ? null : input.navigate();
    if (navigation !== null) {
      appendHeaders(pending, navigation.rows, seen, meter);
      if (navigation.unavailable) { open = true; stops.add("unavailable"); }
      if (navigation.resourceLimited) { open = true; stops.add("budget"); }
    }
    while (!headersDone || sourceOffset < records.length || pending.length > 0) {
      if (!headersDone) {
        const page: HeaderPage = firstPage ?? input.readHeaders(after);
        if (firstPage === undefined) pages++;
        firstPage = undefined;
        appendHeaders(pending, page.rows, seen, meter, exploration);
        if (page.resourceLimited || page.truncated && (page.committedThrough === null || page.committedThrough === after)) {
          headersDone = true; open = true; stops.add("unavailable");
        } else if (!page.truncated) headersDone = true;
        else if (pages === 32) { headersDone = true; open = true; stops.add("interpretation_limit"); }
        after = page.committedThrough;
      }
      const through = Math.min(records.length, sourceOffset + SOURCE_SEMANTIC_LIBRARY_INTERPRETATION_PAGE);
      while (sourceOffset < through) input.readSource(records[sourceOffset++]!);
      if (pending.length === 0) continue;
      const scheduled = input.schedule(pending, exploration);
      const count = headersDone && sourceOffset === records.length ? scheduled.length : Math.min(2, scheduled.length);
      meter.charge(2 * count, count * 8, "access selected verification references");
      for (const row of scheduled.slice(0, count)) {
        seen.set(row.identity, null);
        try { input.verify(row, admission); }
        catch (error) {
          if (error instanceof SourceSemanticResourceExhausted) throw error;
          if (!(error instanceof CoreError)) throw error;
          if (!input.filtered(error)) { open = true; stops.add("unavailable"); }
        }
      }
      meter.charge(pending.length + exploration.length, (pending.length + exploration.length) * 8, "access pending verification retention");
      pending = pending.filter(row => seen.get(row.identity) !== null);
      exploration = exploration.filter(row => seen.get(row.identity) !== null);
    }
  } catch (error) {
    if (readingInitialCensus || !(error instanceof SourceSemanticResourceExhausted)) throw error;
    stops.add("budget"); open = true;
  }
  return { pages, open: open || !headersDone || pending.length > 0 };
}

function acceptVerifiedSource(input: SourceRecallAccess, record: SourceRecordIdentity, text: string): SourceSemanticAccessSignal {
  const { records, byId, sources, meter } = input;
  if (input.preview) input.previewExtent(record);
  if (!byId.has(record.identity)) {
    input.beforeRetain?.(record);
    meter.retain(record, "access discovered current source"); input.discoveredLookup();
    byId.set(record.identity, record); records.push(record);
    meter.observer?.event("union_admission", meter.phase, () => ({ route: "interpretation_verification", position: records.length - 1,
      source_id: record.source_id, record_id: record.identity }));
  }
  if (!input.preview && sources.get(record.identity)?.complete !== true) {
    meter.charge(text.length, 0, "access verified source extent");
    const bodyBytes = Buffer.byteLength(text);
    meter.observer?.event("verification_reuse", meter.phase, () => ({ record_id: record.identity, source_id: record.source_id,
      start: 0, end: bodyBytes, body_bytes: bodyBytes }));
    const source = { source_id: record.source_id, record_id: record.identity,
      read_bytes: bodyBytes, body_bytes: bodyBytes, complete: true, signal: input.sourceSignal(text) };
    meter.retain(source, "access verified source observation"); sources.set(record.identity, source);
    input.associateSource(record.content_digest, source.signal);
  }
  return sources.get(record.identity)?.signal ?? UNKNOWN;
}
/** Reconcile against final verified source observations before invoking the mandatory Core ordering policy. */
export function orderSourceRecallObservations(records: readonly SourceRecordIdentity[], sources: Map<string, SourceObservation>,
  rows: readonly SourceSemanticAccessReceipt["interpretation_candidates"][number][], stops: Set<Stop>,
  meter: SourceRecallAccessMeter,
  order: <T extends { readonly identity: string; readonly signal: SourceSemanticAccessSignal }>(rows: readonly T[]) => T[],
  reconcile: (count: number) => void) {
  for (const record of records) if (!sources.has(record.identity)) sources.set(record.identity, {
    source_id: record.source_id, record_id: record.identity, read_bytes: 0, body_bytes: null, complete: false, signal: UNKNOWN
  });
  if ([...sources.values()].some(row => !row.complete)) stops.add("source_tail");
  const reconciled = new Array<SourceSemanticAccessReceipt["interpretation_candidates"][number]>(rows.length);
  for (let index = 0; index < reconciled.length; index++) {
    const row = rows[index]!;
    reconciled[index] = { ...row, signal: { ...row.signal,
      source_text_score: sources.get(row.record_id)?.signal.source_text_score ?? null } };
  }
  reconcile(reconciled.length);
  meter.retain(reconciled, "access reconciled interpretation signals");
  const orderedSources = order([...sources.values()].map(row => ({ ...row, identity: row.record_id })))
    .map(({ identity: _identity, ...row }) => row);
  const orderedInterpretations = order(reconciled.map(row => ({ ...row, identity: row.interpretation_id })))
    .map(({ identity: _identity, ...row }) => row);
  return { orderedSources, orderedInterpretations };
}

function appendHeaders(pending: SourceRecallHeader[], rows: readonly SourceRecallHeader[], seen: Map<string, SourceRecallHeader | null>,
  meter: SourceRecallAccessMeter, exploration?: SourceRecallHeader[]): void {
  for (const row of rows) {
    meter.charge(1, 0, "access header identity check");
    const existing = seen.get(row.identity);
    if (existing === null) continue;
    if (existing === undefined) {
      meter.charge(0, row.identity.length * 2 + 56, "access header identity retention");
      seen.set(row.identity, row); pending.push(row);
    }
    if (exploration !== undefined) { meter.charge(0, 8, "access cursor reference retention"); exploration.push(existing ?? row); }
  }
}
