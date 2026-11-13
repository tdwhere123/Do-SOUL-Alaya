import { statementKeyCosine } from "@do-soul/alaya-core";
import {
  SourceSemanticResourceExhausted, SourceSemanticResourceLedger,
  type RecallMemberIndexLine, type SourceIndexTarget, type SourceSemanticResourceBudget
} from "@do-soul/alaya-protocol";
import type { SqliteSourceIndexRepository } from "@do-soul/alaya-storage";

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
  conditions: readonly Float32Array[];
  vectors: Readonly<{ generation_id: string; dimensions: number }> | null;
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

/** One member's line: its statements by best cosine to the caller's conditions (unscored after scored, by
 * message), else its first message. A member whose listing is unknown or empty is not listed. */
function renderLine(listing: Listing, inputs: MemberIndexInputs, source: SourceIndexTarget, label: string,
  inPool: boolean): RecallMemberIndexLine | null {
  if (listing.status !== "ready" || source.target.kind !== "source_evidence") return null;
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
  const statements = parts.length > 0, text = statements ? parts.join("; ") : listing.first_message ?? "";
  if (text.length === 0) return null;
  return { label, root_id: source.target.root_id, date: listing.event_time === null ? null : listing.event_time.slice(0, 10),
    line: clipUtf8(text, MEMBER_INDEX_LINE_BYTES), producer: statements ? "source-statements-v1" : "first-message",
    statement_ids: ids, in_pool: inPool };
}

/** Members after the delivered page: pool roots not on it (acquisition order), then the listed overflow. */
export function renderMemberIndex(repository: Pick<SqliteSourceIndexRepository, "readMemberListing">, inputs: MemberIndexInputs,
  delivered: ReadonlySet<string>, shown: number): readonly RecallMemberIndexLine[] {
  const ledger = new SourceSemanticResourceLedger(MEMBER_INDEX_BUDGET);
  const rootOf = (source: SourceIndexTarget) => source.target.kind === "source_evidence" ? source.target.root_id : null;
  const members: { source: SourceIndexTarget; pool: boolean }[] = [], seen = new Set(delivered);
  for (const [sources, pool] of [[inputs.pool, true], [inputs.overflow, false]] as const) {
    for (const source of sources) {
      const root = rootOf(source);
      if (root === null || seen.has(root)) continue;
      seen.add(root); members.push({ source, pool });
    }
  }
  const lines: RecallMemberIndexLine[] = [];
  for (const member of members) {
    if (shown + lines.length >= MEMBER_INDEX_ROOTS) break;
    const listing = repository.readMemberListing(member.source, inputs.vectors,
      { work_units: ledger.work, memory_bytes: ledger.bytes });
    try { ledger.charge(listing.resources.work, listing.resources.memory_bytes, "member index listing"); }
    catch (error) {
      if (error instanceof SourceSemanticResourceExhausted) break;
      throw error;
    }
    if (listing.status === "resource_limited") break;
    const line = renderLine(listing, inputs, member.source, `R${String(shown + lines.length + 1).padStart(2, "0")}`, member.pool);
    if (line !== null) lines.push(line);
  }
  return lines;
}
