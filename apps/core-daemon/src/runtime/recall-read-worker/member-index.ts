import { statementKeyCosine } from "@do-soul/alaya-core";
import {
  SourceSemanticResourceExhausted, SourceSemanticResourceLedger,
  sourceIndexTarget, sourceRecallTarget,
  type RecallMemberIndexLine, type SourceIndexTarget, type SourceSemanticResourceBudget
} from "@do-soul/alaya-protocol";
import type { SqliteSourceIndexRepository, StorageDatabase } from "@do-soul/alaya-storage";

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

/** Offline R32 check on frozen 372-row caches: after_pool K=6 is +7/-0 vs pool-only window. */
export const SOFT_NEIGHBOR_CAP = 6;
const SOFT_STRUCTURAL_GRADES: Readonly<Record<string, number>> = {
  supersedes: 800,
  next_round_in_session: 750,
  prev_round_in_session: 700,
  restates: 650
};
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
function memberSourceTarget(source: SourceIndexTarget): RecallMemberIndexLine["source_target"] {
  return {
    root_kind: source.target.root_kind,
    root_id: source.target.root_id,
    source_version: source.target.source_version,
    content_digest: source.target.content_digest,
    evidence_object_id: source.target.evidence_object_id
  };
}

function renderLine(listing: Listing, inputs: MemberIndexInputs, source: SourceIndexTarget, label: string,
  inPool: boolean): RecallMemberIndexLine | null {
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
    const text = statements ? parts.join("; ") : listing.first_message?.trim() || retainedSourceText(inputs.database, source);
    if (text.length > 0) {
      return { label, root_id: source.target.root_id, date: listing.event_time === null ? null : listing.event_time.slice(0, 10),
        line: clipUtf8(text, MEMBER_INDEX_LINE_BYTES), producer: statements ? "source-statements-v1" : "first-message",
        statement_ids: ids, in_pool: inPool, source_target: memberSourceTarget(source) };
    }
  }
  const fallback = retainedSourceText(inputs.database, source);
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

type StructuralNeighborEdge = Readonly<{ readonly grade: number; readonly sourceRoot: string; readonly targetRoot: string }>;

function structuralNeighborSql(asOf: string | undefined): string {
  const admitted = asOf === undefined ? "" : "AND alaya_utc_compare(admitted_at, @asOf) <= 0";
  const resolved = asOf === undefined
    ? `AND NOT EXISTS (
         SELECT 1 FROM relation_assertion_resolution_current r
         WHERE r.assertion_id = relation_assertions.assertion_id
           AND r.workspace_id = relation_assertions.workspace_id)`
    : `AND NOT EXISTS (
         SELECT 1 FROM relation_assertion_resolution_current r
         WHERE r.assertion_id = relation_assertions.assertion_id
           AND r.workspace_id = relation_assertions.workspace_id
           AND alaya_utc_compare(r.resolved_at, @asOf) <= 0)`;
  return `SELECT relation_kind AS kind,
       json_extract(anchors_json, '$.source_anchor.object_id') AS src,
       json_extract(anchors_json, '$.target_anchor.object_id') AS tgt
     FROM relation_assertions WHERE workspace_id = ? AND relation_kind IN (?, ?, ?, ?) ${admitted} ${resolved}`;
}

function loadStructuralNeighborEdges(
  database: StorageDatabase, workspaceId: string, asOf: string | undefined
): readonly StructuralNeighborEdge[] {
  const kinds = Object.keys(SOFT_STRUCTURAL_GRADES);
  const rows = (asOf === undefined
    ? database.connection.prepare(structuralNeighborSql(undefined)).all(workspaceId, ...kinds)
    : database.connection.prepare(structuralNeighborSql(asOf)).all({ asOf }, workspaceId, ...kinds)) as ReadonlyArray<{
    readonly kind: string; readonly src: string; readonly tgt: string;
  }>;
  const memoryToRoot = new Map<string, string>();
  for (const row of database.connection.prepare(`
    SELECT ssmb.memory_id AS memory_id, ssa.record_id AS record_id
    FROM source_statement_memory_bindings ssmb
    JOIN source_statement_artifacts ssa
      ON ssa.workspace_id = ssmb.workspace_id AND ssa.artifact_id = ssmb.artifact_id
    WHERE ssmb.workspace_id = ?`).all(workspaceId) as ReadonlyArray<{ readonly memory_id: string; readonly record_id: string }>) {
    if (!memoryToRoot.has(row.memory_id)) memoryToRoot.set(row.memory_id, row.record_id);
  }
  const toRoot = (id: string) => memoryToRoot.get(id) ?? id;
  return rows.flatMap((row) => {
    const grade = SOFT_STRUCTURAL_GRADES[row.kind];
    if (grade === undefined) return [];
    const sourceRoot = toRoot(row.src), targetRoot = toRoot(row.tgt);
    return sourceRoot === targetRoot ? [] : [{ grade, sourceRoot, targetRoot }];
  });
}

function rankSoftNeighborRoots(
  edges: readonly StructuralNeighborEdge[], anchors: ReadonlySet<string>, exclude: ReadonlySet<string>, cap: number
): readonly string[] {
  const best = new Map<string, number>();
  for (const edge of edges) {
    const hops = [anchors.has(edge.sourceRoot) ? edge.targetRoot : null, anchors.has(edge.targetRoot) ? edge.sourceRoot : null];
    for (const neighbor of hops) {
      if (neighbor === null || exclude.has(neighbor)) continue;
      const prior = best.get(neighbor);
      if (prior === undefined || edge.grade > prior) best.set(neighbor, edge.grade);
    }
  }
  return [...best.entries()].sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1))
    .slice(0, cap).map(([root]) => root);
}

function retainedSourceText(database: StorageDatabase | undefined, source: SourceIndexTarget): string {
  if (database === undefined || source.target.root_kind !== "source_record") return "";
  const body = database.connection.prepare(
    `SELECT source_body FROM source_records WHERE workspace_id = ? AND record_id = ? LIMIT 1`
  ).pluck().get(source.target.workspace_id, source.target.root_id);
  return typeof body === "string" ? body.trim() : "";
}

function sourceIndexTargetForRoot(
  database: StorageDatabase, workspaceId: string, rootId: string
): SourceIndexTarget | null {
  const row = database.connection.prepare(`
    SELECT record_id, source_id, source_version, content_digest, evidence_object_id, source_body
    FROM source_records WHERE workspace_id = ? AND record_id = ? LIMIT 1
  `).get(workspaceId, rootId) as {
    readonly record_id: string; readonly source_id: string; readonly source_version: string;
    readonly content_digest: string; readonly evidence_object_id: string | null; readonly source_body: string | null;
  } | undefined;
  if (row === undefined || row.source_body === null) return null;
  return sourceIndexTarget(sourceRecallTarget({
    workspace_id: workspaceId, root_kind: "source_record", root_id: row.record_id,
    source_version: row.source_version, content_digest: row.content_digest, evidence_object_id: row.evidence_object_id
  }), row.source_id, Buffer.byteLength(row.source_body, "utf8"));
}

/** 1-hop Soft session-structural source_evidence neighbors of delivered/pool anchors, capped and graded. */
export function collectSoftStructuralNeighbors(
  database: StorageDatabase,
  input: Readonly<{ workspaceId: string; asOf?: string; anchors: readonly string[]; exclude: ReadonlySet<string>; cap?: number }>
): readonly SourceIndexTarget[] {
  const cap = input.cap ?? SOFT_NEIGHBOR_CAP;
  if (cap < 1 || input.anchors.length === 0) return [];
  const roots = rankSoftNeighborRoots(
    loadStructuralNeighborEdges(database, input.workspaceId, input.asOf),
    new Set(input.anchors), input.exclude, cap
  );
  return roots.flatMap((root) => {
    const source = sourceIndexTargetForRoot(database, input.workspaceId, root);
    return source === null ? [] : [source];
  });
}

export function renderPageMemberIndex(
  repository: Pick<SqliteSourceIndexRepository, "readMemberListing">,
  database: StorageDatabase,
  input: Readonly<{ workspaceId: string; asOf: string; delivered: ReadonlySet<string>; shown: number; memberInputs: MemberIndexInputs }>
): readonly RecallMemberIndexLine[] {
  const poolRoots = input.memberInputs.pool.flatMap(source =>
    source.target.kind === "source_evidence" ? [source.target.root_id] : []);
  const exclude = new Set([...input.delivered, ...poolRoots]);
  return renderMemberIndex(repository, {
    ...input.memberInputs,
    neighbors: collectSoftStructuralNeighbors(database, {
      workspaceId: input.workspaceId, asOf: input.asOf, anchors: [...exclude], exclude
    }),
    database
  }, input.delivered, input.shown);
}
