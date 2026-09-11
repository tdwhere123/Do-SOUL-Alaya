import type { QueryInterpretation, QueryProgram } from "@do-soul/alaya-protocol";
import type { SourceRootObserverRow } from "./observe.js";

const MAX_NORMALIZATION_TAIL = 8192;
const MAX_STREAM_CURSOR = 65536;

type LiteralProgress = Readonly<{ offset: number; found: boolean }>;
type SourceStreamItem = Readonly<{
  kind: SourceRootObserverRow["kind"];
  rootId: string;
  revision: string;
  digest: string;
  offset: number;
  tail: string;
  literals: readonly LiteralProgress[];
  limited?: boolean;
}>;
type SourceStream = SourceStreamItem & Readonly<{ afterCursor: string; pending?: readonly SourceStreamItem[] }>;

/** Carries only an unfinished normalization segment and per-obligation KMP state. */
export function scanSourceLiterals(query: QueryInterpretation, row: SourceRootObserverRow,
  cursor: string | null, afterCursor: string | null): Readonly<{
    row: SourceRootObserverRow; cursor: string | null; needsContent: boolean; limited: boolean
  }> {
  const needles = sourceLiteralNeedles(query);
  if (needles.length === 0 || row.content === undefined) return { row, cursor: afterCursor, needsContent: false, limited: false };
  const parsed = parseSourceStream(cursor);
  const prior = row.content_start === 0 ? undefined : parsed;
  const start = row.content_start ?? prior?.offset ?? 0;
  if (start !== 0 && (prior === undefined || prior.rootId !== row.root_id || prior.kind !== row.kind
    || prior.revision !== row.revision || prior.digest !== row.digest || prior.offset !== start)) {
    return { row: { ...row, content_complete: false }, cursor, needsContent: true, limited: true };
  }
  if (prior?.limited) return { row: { ...row, content_complete: false }, cursor, needsContent: true, limited: true };
  const normalized = `${prior?.tail ?? ""}${row.content}`.normalize("NFC");
  const split = row.content_complete === false ? lastStarterOffset(normalized) : normalized.length;
  const stable = normalized.slice(0, split);
  const tail = normalized.slice(split);
  const literals = needles.map((needle, index) => matchStable(needle, stable, prior?.literals[index]));
  const limited = tail.length > MAX_NORMALIZATION_TAIL;
  const complete = row.content_complete !== false && !limited;
  const verdicts = Object.fromEntries(needles.map((needle, index) =>
    [needle, literals[index]!.found ? "true" : complete ? "false" : "unresolved"] as const));
  const needsContent = !complete && literals.some((literal) => !literal.found);
  const stacked = prior === undefined ? parseSourceStream(afterCursor) : undefined;
  const pending = prior?.pending ?? (stacked === undefined ? [] : [streamItem(stacked), ...stacked.pending ?? []]);
  const collection = prior?.afterCursor ?? stacked?.afterCursor ?? afterCursor ?? "";
  const stream: SourceStreamItem = { kind: row.kind, rootId: row.root_id, revision: row.revision, digest: row.digest,
    offset: row.content_end ?? start + Buffer.byteLength(row.content, "utf8"),
    tail: limited ? "" : tail, literals,
    ...(limited ? { limited: true } : {}) };
  const head = needsContent ? stream : pending[0];
  const waiting = needsContent ? pending : pending.slice(1);
  const next = head === undefined ? (collection || null)
    : `o:${JSON.stringify({ ...head, afterCursor: collection, pending: waiting })}`;
  const cursorLimited = next !== null && next.length > MAX_STREAM_CURSOR;
  return { row: { ...row, content_complete: start === 0 && row.content_complete !== false,
    literal_verdicts: verdicts }, cursor: cursorLimited ? cursor : next, needsContent: head !== undefined,
    limited: limited || cursorLimited };
}

function streamItem(stream: SourceStream): SourceStreamItem {
  const { afterCursor: _after, pending: _pending, ...item } = stream;
  return item;
}

function matchStable(needle: string, content: string, prior?: LiteralProgress): LiteralProgress {
  if (prior?.found) return prior;
  const failure = new Array<number>(needle.length).fill(0);
  for (let i = 1, j = 0; i < needle.length; i += 1) {
    while (j > 0 && needle[i] !== needle[j]) j = failure[j - 1]!;
    if (needle[i] === needle[j]) j += 1;
    failure[i] = j;
  }
  let offset = prior?.offset ?? 0;
  for (let i = 0; i < content.length; i += 1) {
    while (offset > 0 && content[i] !== needle[offset]) offset = failure[offset - 1]!;
    if (content[i] === needle[offset]) offset += 1;
    if (offset === needle.length) return { offset: 0, found: true };
  }
  return { offset, found: false };
}

function lastStarterOffset(value: string): number {
  let offset = 0;
  let last = 0;
  for (const char of value) {
    if (!/\p{M}/u.test(char)) last = offset;
    offset += char.length;
  }
  return last;
}

function parseSourceStream(cursor: string | null): SourceStream | undefined {
  if (!cursor?.startsWith("o:{") || cursor.length > MAX_STREAM_CURSOR) return undefined;
  try {
    const value = JSON.parse(cursor.slice(2)) as SourceStream;
    return typeof value.tail === "string" && Array.isArray(value.literals) ? value : undefined;
  } catch { return undefined; }
}

function sourceLiteralNeedles(query: QueryInterpretation): readonly string[] {
  const needles = new Set<string>();
  const add = (guard: { readonly predicate_name?: string; readonly entity_id?: string } | undefined): void => {
    if (guard?.predicate_name === "source.literal.nfc.v1" && guard.entity_id) needles.add(guard.entity_id.normalize("NFC"));
  };
  const visit = (node: QueryProgram): void => {
    if (node.kind === "relation") add(node.guard);
    else if (node.kind === "hyperedge") node.premises.forEach(visit);
    else if (node.kind === "alternative") node.options.forEach(visit);
    else if (node.kind === "sequence") node.steps.forEach(visit);
    else if (node.kind === "closure" || node.kind === "repeat") visit(node.body);
  };
  add(query.source_guard);
  query.interpretation_proposal?.conditions?.forEach(add);
  visit(query.program);
  return [...needles];
}
