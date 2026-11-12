import type { RecallMemberIndexLine, SourceIndexTarget } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "@do-soul/alaya-storage";

/** Roots shown on a first page with its member index (ranked results included). */
export const MEMBER_INDEX_ROOTS = 32;
/** Roots refused only by the nomination limit that acquisition lists beyond its pool. */
export const MEMBER_INDEX_OVERFLOW = 16;
/** One line per member; the 32-root shape was chosen at this width over 64 × 100 B. */
export const MEMBER_INDEX_LINE_BYTES = 218;

export type MemberIndexInputs = Readonly<{
  pool: readonly SourceIndexTarget[];
  overflow: readonly SourceIndexTarget[];
  conditions: readonly Float32Array[];
  generation: string | null;
}>;

const INPUTS = new WeakMap<object, MemberIndexInputs>();

/** Binds index inputs to the nomination object the field receives, outside its retained state. */
export function rememberMemberIndexInputs(nomination: object, inputs: MemberIndexInputs): void {
  INPUTS.set(nomination, inputs);
}
export function memberIndexInputsOf(nomination: object): MemberIndexInputs | undefined {
  return INPUTS.get(nomination);
}

type StatementRow = { artifact_id: string; gist: string; embedding_blob: Buffer | null };
type Prepared = ReturnType<typeof prepareStatements>;
const PREPARED = new WeakMap<object, Prepared>();

function prepareStatements(database: StorageDatabase) {
  const connection = database.connection;
  return {
    statements: connection.prepare(`SELECT a.artifact_id, e.gist, v.embedding_blob
      FROM source_statement_artifacts a
      JOIN evidence_capsules e ON e.workspace_id = a.workspace_id AND e.object_id = a.artifact_id AND e.lifecycle_state = 'active'
      LEFT JOIN source_index_windows w ON w.workspace_id = a.workspace_id AND w.generation_id = ?
        AND w.root_key = json_extract(a.target_json, '$.root_key')
      LEFT JOIN source_index_vectors v ON v.workspace_id = w.workspace_id AND v.generation_id = w.generation_id
        AND v.window_id = w.window_id
      WHERE a.workspace_id = ? AND a.record_id = ? ORDER BY a.artifact_id`),
    record: connection.prepare(`SELECT source_body, event_time FROM source_records WHERE workspace_id = ? AND record_id = ?`),
    inventory: connection.prepare(`SELECT canonical_inventory FROM source_host_inventories WHERE workspace_id = ? AND record_id = ?`)
  };
}

function prepare(database: StorageDatabase): Prepared {
  const cached = PREPARED.get(database.connection);
  if (cached !== undefined) return cached;
  const prepared = prepareStatements(database);
  PREPARED.set(database.connection, prepared);
  return prepared;
}

export function clipUtf8(text: string, bytes: number): string {
  const encoded = Buffer.from(text, "utf8");
  if (encoded.length <= bytes) return text;
  let end = bytes;
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end--;
  return encoded.subarray(0, end).toString("utf8").trimEnd() + "…";
}

function score(blob: Buffer | null, conditions: readonly Float32Array[]): number {
  if (blob === null || conditions.length === 0) return -1;
  const vector = new Float32Array(blob.byteLength / 4);
  for (let i = 0; i < vector.length; i++) vector[i] = blob.readFloatLE(i * 4);
  let best = -1;
  for (const condition of conditions) {
    if (condition.length !== vector.length) continue;
    let dot = 0, left = 0, right = 0;
    for (let i = 0; i < vector.length; i++) { dot += vector[i]! * condition[i]!; left += vector[i]! ** 2; right += condition[i]! ** 2; }
    const value = left > 0 && right > 0 ? dot / Math.sqrt(left * right) : -1;
    if (Number.isFinite(value) && value > best) best = value;
  }
  return best;
}

function firstMessage(prepared: Prepared, workspace: string, record: string, body: string): string {
  const row = prepared.inventory.get(workspace, record) as { canonical_inventory: string } | undefined;
  if (row === undefined) return "";
  try {
    const span = (JSON.parse(row.canonical_inventory) as { occurrences?: { utf8_span?: [number, number] }[] }).occurrences?.[0]?.utf8_span;
    return span === undefined ? "" : Buffer.from(body, "utf8").subarray(span[0], span[1]).toString("utf8").trim();
  } catch { return ""; }
}

/** One member's line: its statements by best cosine to the caller's conditions, else its first message. */
function renderLine(prepared: Prepared, workspace: string, inputs: MemberIndexInputs, source: SourceIndexTarget, label: string,
  inPool: boolean): RecallMemberIndexLine | null {
  const record = source.target.kind === "source_evidence" ? source.target.root_id : null;
  if (record === null) return null;
  const host = prepared.record.get(workspace, record) as { source_body: string; event_time: string | null } | undefined;
  if (host === undefined) return null;
  const seen = new Set<string>(), rows: { text: string; message: string; score: number; id: string }[] = [];
  for (const row of prepared.statements.all(inputs.generation, workspace, record) as StatementRow[]) {
    if (seen.has(row.artifact_id)) continue;
    seen.add(row.artifact_id);
    let gist: { statement?: { text?: unknown }; message?: { role?: unknown; message_id?: unknown } };
    try { gist = JSON.parse(row.gist); } catch { continue; }
    const text = typeof gist.statement?.text === "string" ? gist.statement.text.trim() : "";
    if (text.length === 0) continue;
    rows.push({ text: (gist.message?.role === "assistant" ? "assistant said " : "") + text,
      message: typeof gist.message?.message_id === "string" ? gist.message.message_id : "",
      score: score(row.embedding_blob, inputs.conditions), id: row.artifact_id });
  }
  rows.sort((a, b) => b.score - a.score || (a.message < b.message ? -1 : a.message > b.message ? 1 : 0));
  const parts: string[] = [], shown = new Set<string>(), ids: string[] = [];
  for (const row of rows) {
    if (shown.has(row.text)) continue;
    shown.add(row.text); parts.push(row.text);
    if (ids.length < 64) ids.push(row.id);
  }
  const statements = parts.length > 0;
  const line = clipUtf8(statements ? parts.join("; ") : firstMessage(prepared, workspace, record, host.source_body), MEMBER_INDEX_LINE_BYTES);
  return { label, root_id: record, date: host.event_time === null ? null : host.event_time.slice(0, 10), line,
    producer: statements ? "source-statements-v1" : "first-message", statement_ids: ids, in_pool: inPool };
}

/** Members after the delivered page: pool roots not on it (acquisition order), then the listed overflow. */
export function renderMemberIndex(database: StorageDatabase, workspace: string, inputs: MemberIndexInputs,
  delivered: ReadonlySet<string>, shown: number): readonly RecallMemberIndexLine[] {
  const prepared = prepare(database);
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
    const line = renderLine(prepared, workspace, inputs, member.source, `R${String(shown + lines.length + 1).padStart(2, "0")}`, member.pool);
    if (line !== null) lines.push(line);
  }
  return lines;
}
