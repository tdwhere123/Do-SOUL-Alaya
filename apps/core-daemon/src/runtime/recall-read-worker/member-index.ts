import { fieldContractSha256, statementKeyCosine } from "@do-soul/alaya-core";
import {
  SourceSemanticResourceExhausted, SourceSemanticResourceLedger,
  type RecallMemberIndexLine, type SourceIndexTarget, type SourceSemanticResourceBudget
} from "@do-soul/alaya-protocol";
import { SqliteFieldSourceRecordRepo, type SqliteSourceIndexRepository, type StorageDatabase } from "@do-soul/alaya-storage";
import { collectSoftStructuralNeighbors, type StructuralMemberScope } from "./member-index-neighbors.js";

/** Roots shown on a first page with its member index (ranked results included). */
export const MEMBER_INDEX_ROOTS = 32;
/** Roots refused only by the nomination limit that acquisition lists beyond its pool. */
export const MEMBER_INDEX_OVERFLOW = 16;
export const MEMBER_INDEX_LINE_BYTES = 218;
/** All member reads of one first page; exhaustion ends the list, it never shortens the ranked page. */
const MEMBER_INDEX_BUDGET: SourceSemanticResourceBudget = { work_units: 8_000_000, memory_bytes: 64 * 1024 * 1024 };

export type MemberIndexInputs = Readonly<{
  pool: readonly SourceIndexTarget[];
  overflow: readonly SourceIndexTarget[];
  neighbors?: readonly SourceIndexTarget[];
  conditions: readonly Float32Array[];
  vectors: Readonly<{ generation_id: string; dimensions: number }> | null;
  database?: StorageDatabase;
}>;

type Listing = ReturnType<SqliteSourceIndexRepository["readMemberListing"]>;
type Statement = Extract<Listing, { status: "ready" }>["statements"][number];

export function clipUtf8(text: string, bytes: number): string {
  const encoded = Buffer.from(text, "utf8");
  if (encoded.length <= bytes) return text;
  let end = bytes;
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end--;
  return encoded.subarray(0, end).toString("utf8").trimEnd() + "…";
}

/** Best cosine to any condition; null when the key vector or every condition is unavailable. */
function score(statement: Statement, conditions: readonly Float32Array[]): number | null {
  if (statement.embedding === null) return null;
  let best: number | null = null;
  for (const condition of conditions) {
    if (condition.length !== statement.embedding.length) continue;
    const value = statementKeyCosine(statement.embedding, condition);
    if (Number.isFinite(value) && (best === null || value > best)) best = value;
  }
  return best;
}

function memberSourceTarget(source: SourceIndexTarget): RecallMemberIndexLine["source_target"] {
  return {
    root_kind: source.target.root_kind,
    root_id: source.target.root_id,
    source_version: source.target.source_version,
    content_digest: source.target.content_digest,
    evidence_object_id: source.target.evidence_object_id
  };
}

/** Prefer condition-scored statements, then the first message or a guarded source prefix. */
function renderLine(listing: Listing, inputs: MemberIndexInputs, source: SourceIndexTarget, label: string,
  inPool: boolean, ledger: SourceSemanticResourceLedger): RecallMemberIndexLine | null {
  if (source.target.kind !== "source_evidence") return null;
  if (listing.status === "ready") {
    const rows = listing.statements.map(statement => ({ statement, score: score(statement, inputs.conditions) }));
    rows.sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity)
      || (a.statement.message_id < b.statement.message_id ? -1 : a.statement.message_id > b.statement.message_id ? 1 : 0));
    const parts: string[] = [], shown = new Set<string>(), ids: string[] = [];
    for (const { statement } of rows) {
      const text = (statement.role === "assistant" ? "assistant said " : "") + statement.text.trim();
      if (text.length === 0 || shown.has(text)) continue;
      shown.add(text); parts.push(text);
      const id = statement.source.auxiliary?.artifact_id;
      if (id !== undefined && ids.length < 64) ids.push(id);
    }
    const statements = parts.length > 0;
    const text = statements ? parts.join("; ") : listing.first_message?.trim();
    if (text) {
      return { label, root_id: source.target.root_id, date: listing.event_time === null ? null : listing.event_time.slice(0, 10),
        line: clipUtf8(text, MEMBER_INDEX_LINE_BYTES), producer: statements ? "source-statements-v1" : "first-message",
        statement_ids: ids, in_pool: inPool, source_target: memberSourceTarget(source) };
    }
  }
  const fallback = retainedSourceText(inputs.database, source, ledger);
  if (fallback.length === 0) return null;
  return { label, root_id: source.target.root_id, date: null, line: clipUtf8(fallback, MEMBER_INDEX_LINE_BYTES),
    producer: "first-message", statement_ids: [], in_pool: inPool, source_target: memberSourceTarget(source) };
}

/** Members after the delivered page: remaining pool, then Soft 1-hop neighbors, then overflow. */
export function renderMemberIndex(repository: Pick<SqliteSourceIndexRepository, "readMemberListing">, inputs: MemberIndexInputs,
  delivered: ReadonlySet<string>, shown: number): readonly RecallMemberIndexLine[] {
  const ledger = new SourceSemanticResourceLedger(MEMBER_INDEX_BUDGET);
  const rootOf = (source: SourceIndexTarget) => source.target.kind === "source_evidence" ? source.target.root_id : null;
  const members: { source: SourceIndexTarget; pool: boolean }[] = [], seen = new Set(delivered);
  for (const [sources, pool] of [
    [inputs.pool, true], [inputs.neighbors ?? [], false], [inputs.overflow, false]
  ] as const) {
    for (const source of sources) {
      const root = rootOf(source);
      if (root === null || seen.has(root)) continue;
      seen.add(root); members.push({ source, pool });
    }
  }
  const listingVectors = inputs.conditions.length > 0 ? inputs.vectors : null;
  const lines: RecallMemberIndexLine[] = [];
  for (const member of members) {
    if (shown + lines.length >= MEMBER_INDEX_ROOTS) break;
    const listing = repository.readMemberListing(member.source, listingVectors,
      { work_units: ledger.work, memory_bytes: ledger.bytes });
    try {
      ledger.charge(listing.resources.work, listing.resources.memory_bytes, "member index listing");
      if (listing.status === "resource_limited") break;
      const label = `R${String(shown + lines.length + 1).padStart(2, "0")}`;
      const line = renderLine(listing, inputs, member.source, label, member.pool, ledger);
      if (line !== null) lines.push(line);
    }
    catch (error) {
      if (error instanceof SourceSemanticResourceExhausted) break;
      throw error;
    }
  }
  return lines;
}

function retainedSourceText(database: StorageDatabase | undefined, source: SourceIndexTarget,
  ledger: SourceSemanticResourceLedger): string {
  if (database === undefined || source.target.root_kind !== "source_record") return "";
  const target = source.target;
  const records = new SqliteFieldSourceRecordRepo(database, fieldContractSha256);
  ledger.charge(1, 0, "member source currentness");
  if (records.readTargetAvailability(target.workspace_id, target.root_id) !== "ok") return "";
  const prefix = records.findByIdBounded(target.workspace_id, target.root_id, MEMBER_INDEX_LINE_BYTES, 0, {
    workLimit: ledger.work, nativeByteLimit: ledger.bytes
  });
  if (prefix === null) return "";
  ledger.charge(1 + prefix.dependencyWork, prefix.nativeBytes + prefix.metadataBytes, "member source prefix");
  const row = prefix.record;
  return !prefix.resourceLimited && row?.source_version === target.source_version && row.content_digest === target.content_digest
    ? row.source_body?.trim() ?? "" : "";
}

export function renderPageMemberIndex(
  repository: Pick<SqliteSourceIndexRepository, "readMemberListing">,
  database: StorageDatabase,
  input: StructuralMemberScope & Readonly<{ delivered: ReadonlySet<string>; shown: number; memberInputs: MemberIndexInputs }>
): readonly RecallMemberIndexLine[] {
  const poolRoots = input.memberInputs.pool.flatMap(source =>
    source.target.kind === "source_evidence" ? [source.target.root_id] : []);
  const exclude = new Set([...input.delivered, ...poolRoots]);
  const inReadSnapshot = <T>(fn: () => T): T =>
    database.connection.inTransaction ? fn() : database.connection.transaction(fn)();
  return inReadSnapshot(() => {
    const neighbors = collectSoftStructuralNeighbors(database, { ...input, anchors: [...exclude], exclude });
    return renderMemberIndex(repository, { ...input.memberInputs, neighbors, database }, input.delivered, input.shown);
  });
}
