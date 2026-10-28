import {
  BoundedIdSchema, SourceIndexGenerationStatusSchema, SourceIndexLexicalSelectionSchema,
  SourceIndexLexicalRepresentationSchema, SourceIndexOperationError, SourceIndexTargetSchema,
  canonicalJson, prepareSourceIndexLexical, sourceIndexLexicalGenerationId,
  type FieldContractSha256, type SourceIndexBudget, type SourceIndexLexicalRepository,
  type SourceIndexLexicalRepresentation, type SourceIndexLexicalSelection, type SourceIndexLexicalGeneration,
  type SourceIndexLexicalState, type SourceIndexLexicalCaptureResult, type SourceIndexLexicalReuseResult, type SourceIndexReadResult,
  type SourceIndexLexicalBinding, type SourceIndexResources,
  type SourceIndexGuardedWriteResult, type SourceIndexTarget, type SourceIndexWriteResult
} from "@do-soul/alaya-protocol";
import { analyzeSourceIndexLexical, readSourceIndexLexicalAnalysisStatus } from "@do-soul/alaya-cjk-segmentation";
import { advanceSegmentedLexicalDocument } from "./lexical-progress.js";
import type { StorageDatabase } from "../../sqlite/db.js";
import { cachedReadStatement } from "../../sqlite/dynamic-prepared-statement-cache.js";
import { StorageError } from "../../shared/errors.js";
import { SqliteFieldSourceRecordRepo } from "../field/source-repo.js";
import { readIntegerField, readJsonColumn, readNullableStringField, readRecord, readStringField } from "../shared/parse-row.js";
import { enumerateSourceIndexTargets, persistSourceIndexLexical } from "./capture-targets.js";
import { sourceIndexEpoch } from "./generation-state.js";
import { createLexicalDomain } from "./lexical-domain.js";
import { reclaimLexicalPage } from "./lexical-reclamation.js";
import { assertIndexBudget, assertIndexPageLimit, guardSourceIndexTarget, readSourceIndexDocument } from "./native-source.js";

/** Independent lexical persistence behind SourceIndexLifecycle; no vector configuration or writes. */
export class SqliteSourceIndexLexicalStore implements SourceIndexLexicalRepository {
  constructor(private readonly database: StorageDatabase, private readonly sha256: FieldContractSha256) {}

  reclaimLexicalPage(workspaceId: string, limit: number, budget: SourceIndexBudget) {
    return reclaimLexicalPage(this.database, workspaceId, limit, budget);
  }

  /** Roots unchanged since the active generation (same root_key, digest, body bytes) copy its projection; no analysis.
   * The trigger-maintained FTS rows follow the insert. Reads and writes of each projection are charged as native bytes. */
  reuseLexicalProjections(workspaceId: string, generationId: string, limit: number, budget: SourceIndexBudget): SourceIndexLexicalReuseResult {
    assertIndexBudget(budget); assertIndexPageLimit(limit);
    const resources = { work: 0, native_bytes: 0 };
    let visitedRoots = 0;
    try { return this.atomic(() => {
      if (budget.work < 1) return { reused: 0, resources, complete: false };
      const generation = this.requireGeneration(workspaceId, generationId);
      const state = this.lexicalState(workspaceId), from = state?.active_generation_id ?? null;
      if (this.guard(generation) !== null || from === null || from === generationId ||
          this.requireGeneration(workspaceId, from).selection.representation !== generation.selection.representation) {
        return { reused: 0, resources, complete: true };
      }
      const match = `FROM source_index_lexical_targets t JOIN source_index_roots r ON r.workspace_id=t.workspace_id AND r.root_key=t.root_key
        JOIN source_index_lexical_projections p ON p.workspace_id=t.workspace_id AND p.root_key=t.root_key AND p.generation_id=?
          AND p.content_digest=json_extract(r.target_json,'$.target.content_digest') AND p.body_bytes=json_extract(r.target_json,'$.body_bytes')
        WHERE t.workspace_id=? AND t.generation_id=? AND t.complete=0 AND NOT EXISTS (SELECT 1 FROM source_index_lexical_projections n
          WHERE n.workspace_id=t.workspace_id AND n.generation_id=t.generation_id AND n.root_key=t.root_key)`;
      const candidates = this.database.connection.prepare(`SELECT t.root_key AS root_key,octet_length(p.projection) AS bytes ${match}
        ORDER BY t.root_key LIMIT ?`).all(from, workspaceId, generationId, limit + 1);
      resources.work++;
      const insert = this.database.connection.prepare(`INSERT INTO source_index_lexical_projections
        (workspace_id,generation_id,root_key,content_digest,body_bytes,projection)
        SELECT p.workspace_id,?,p.root_key,p.content_digest,p.body_bytes,p.projection FROM source_index_lexical_projections p
        WHERE p.workspace_id=? AND p.generation_id=? AND p.root_key=?`);
      const complete = this.database.connection.prepare(`UPDATE source_index_lexical_targets SET complete=1
        WHERE workspace_id=? AND generation_id=? AND root_key=?`);
      let reused = 0;
      for (const raw of candidates.slice(0, limit)) {
        const row = readRecord(raw, "reusable lexical projection"), bytes = readIntegerField(row, "bytes");
        if (budget.work - resources.work < 2 || budget.native_bytes - resources.native_bytes < 2 * bytes) {
          return { reused, resources, complete: false };
        }
        const rootKey = readStringField(row, "root_key");
        visitedRoots++;
        insert.run(generationId, workspaceId, from, rootKey); complete.run(workspaceId, generationId, rootKey);
        resources.work += 2; resources.native_bytes += 2 * bytes; reused++;
      }
      return { reused, resources, complete: candidates.length <= limit };
    }); } catch (error) { throw new SourceIndexOperationError(error, resources, visitedRoots); }
  }

  selectLexical(workspaceId: string, representation: SourceIndexLexicalRepresentation): SourceIndexLexicalSelection {
    BoundedIdSchema.parse(workspaceId); SourceIndexLexicalRepresentationSchema.parse(representation);
    return this.atomic(() => {
      const previous = this.lexicalState(workspaceId);
      if (previous?.selection.representation === representation) return previous.selection;
      this.database.connection.prepare(`UPDATE source_index_lexical_generations SET status='retired',reason='selection_changed'
        WHERE workspace_id=? AND status!='retired'`).run(workspaceId);
      this.database.connection.prepare(`INSERT INTO source_index_lexical_selections
        (workspace_id,selection_revision,representation,active_generation_id) VALUES(?,?,?,NULL)
        ON CONFLICT(workspace_id) DO UPDATE SET selection_revision=excluded.selection_revision,
        representation=excluded.representation,active_generation_id=NULL`)
        .run(workspaceId, (previous?.selection.selection_revision ?? 0) + 1, representation);
      return this.lexicalState(workspaceId)!.selection;
    });
  }

  ensureLexicalSelection(workspaceId: string, representation: SourceIndexLexicalRepresentation): SourceIndexLexicalSelection {
    BoundedIdSchema.parse(workspaceId); SourceIndexLexicalRepresentationSchema.parse(representation);
    return this.atomic(() => {
      const existing = this.lexicalState(workspaceId);
      if (existing !== null) return existing.selection;
      this.database.connection.prepare(`INSERT INTO source_index_lexical_selections
        (workspace_id,selection_revision,representation,active_generation_id) VALUES(?,1,?,NULL)`)
        .run(workspaceId, representation);
      return this.lexicalState(workspaceId)!.selection;
    });
  }

  lexicalState(workspaceId: string): SourceIndexLexicalState {
    return this.atomic(() => {
      const raw = this.database.connection.prepare(`SELECT * FROM source_index_lexical_selections WHERE workspace_id=?`).get(workspaceId);
      if (raw === undefined) return null;
      const row = readRecord(raw, "source lexical selection");
      return { selection: selection(row), active_generation_id: readNullableStringField(row, "active_generation_id") };
    }, true);
  }

  beginLexical(input: SourceIndexLexicalSelection): SourceIndexLexicalGeneration {
    const captured = SourceIndexLexicalSelectionSchema.parse(structuredClone(input));
    return this.atomic(() => {
      if (canonicalJson(this.lexicalState(captured.workspace_id)?.selection) !== canonicalJson(captured)) {
        throw new StorageError("CONFLICT", "source lexical selection was superseded");
      }
      const epoch = sourceIndexEpoch(this.database, captured.workspace_id);
      const id = sourceIndexLexicalGenerationId(captured, epoch, this.sha256);
      this.database.connection.prepare(`INSERT INTO source_index_lexical_generations
        (workspace_id,generation_id,selection_revision,representation,source_epoch,status) VALUES(?,?,?,?,?,'building')
        ON CONFLICT DO NOTHING`).run(captured.workspace_id, id, captured.selection_revision, captured.representation, epoch);
      createLexicalDomain(this.database.connection, captured.workspace_id, id);
      return this.requireGeneration(captured.workspace_id, id);
    });
  }

  lexicalGeneration(workspaceId: string, generationId: string): SourceIndexLexicalGeneration | null {
    return this.atomic(() => {
      const raw = this.database.connection.prepare(`SELECT * FROM source_index_lexical_generations
        WHERE workspace_id=? AND generation_id=?`).get(workspaceId, generationId);
      if (raw === undefined) return null;
      const row = readRecord(raw, "source lexical generation");
      return { selection: selection(row), generation_id: readStringField(row, "generation_id"),
        source_epoch: readIntegerField(row, "source_epoch"), status: SourceIndexGenerationStatusSchema.parse(row.status),
        enumeration_complete: readIntegerField(row, "enumeration_complete") === 1,
        records_complete: readIntegerField(row, "records_complete") === 1,
        after_source_id: readNullableStringField(row, "after_source_id"),
        after_capsule_cursor: readNullableStringField(row, "after_capsule_cursor"),
        target_count: readIntegerField(row, "target_count"), completed_count: readIntegerField(row, "completed_count"),
        reason: readNullableStringField(row, "reason") };
    }, true);
  }

  captureLexicalPage(workspaceId: string, generationId: string, limit: number, budget: SourceIndexBudget): SourceIndexLexicalCaptureResult {
    assertIndexBudget(budget); assertIndexPageLimit(limit);
    const resources = { work: 0, native_bytes: 0 };
    try { return this.atomic(() => {
      const generation = this.requireGeneration(workspaceId, generationId);
      if (this.guard(generation) !== null || generation.enumeration_complete) return { generation, added: 0, resources };
      const page = enumerateSourceIndexTargets(this.database, this.records(), { ...generation, workspaceId, limit, budget }, resources,
        source => this.database.connection.prepare(`INSERT INTO source_index_lexical_targets
          (workspace_id,generation_id,root_key) VALUES(?,?,?) ON CONFLICT DO NOTHING`).run(workspaceId, generationId, source.root_key).changes);
      this.database.connection.prepare(`UPDATE source_index_lexical_generations SET after_source_id=?,after_capsule_cursor=?,
        records_complete=?,enumeration_complete=?,status=?,reason=? WHERE workspace_id=? AND generation_id=?`)
        .run(page.after_source_id, page.after_capsule_cursor, page.records_complete ? 1 : 0,
          page.enumeration_complete ? 1 : 0, page.enumeration_complete ? "building" : "partial", page.reason, workspaceId, generationId);
      return { generation: this.requireGeneration(workspaceId, generationId), added: page.added, resources };
    }); } catch (error) { throw new SourceIndexOperationError(error, resources); }
  }

  pendingLexicalTarget(workspaceId: string, generationId: string, budget: SourceIndexBudget) {
    assertIndexBudget(budget);
    return this.atomic(() => {
      this.requireGeneration(workspaceId, generationId);
      const resources = { work: 0, native_bytes: 0 };
      if (budget.work < 2 || budget.native_bytes < 8) return { source: null, resources, complete: false };
      const from = `FROM source_index_lexical_targets t JOIN source_index_roots r
        ON r.workspace_id=t.workspace_id AND r.root_key=t.root_key
        WHERE t.workspace_id=? AND t.generation_id=? AND t.complete=0 ORDER BY t.root_key LIMIT 1`;
      const raw = this.database.connection.prepare(`SELECT octet_length(r.target_json) AS bytes ${from}`).get(workspaceId, generationId);
      resources.work++;
      if (raw === undefined) return { source: null, resources, complete: true };
      resources.native_bytes += 8;
      const bytes = readIntegerField(readRecord(raw, "pending lexical size"), "bytes");
      if (bytes > budget.native_bytes - resources.native_bytes) return { source: null, resources, complete: false };
      const target = this.database.connection.prepare(`SELECT r.target_json ${from}`).get(workspaceId, generationId);
      resources.work++; resources.native_bytes += bytes;
      return { source: SourceIndexTargetSchema.parse(readJsonColumn(readRecord(target, "pending lexical target"), "target_json")),
        resources, complete: false };
    }, true);
  }

  readLexicalDocument(workspaceId: string, generationId: string, rootKey: string, maxBytes: number,
    budget: SourceIndexBudget): SourceIndexReadResult {
    return this.atomic(() => {
      const resources = { work: 0, native_bytes: 0 };
      const generation = this.lexicalGeneration(workspaceId, generationId);
      if (generation === null) return { status: "unbound", reason: "missing_generation", resources };
      const guard = this.guard(generation);
      if (guard !== null) return { status: guard, reason: guard, resources };
      const source = this.target(workspaceId, generationId, rootKey);
      if (source === null) return { status: "unbound", reason: "missing_target", resources };
      return readSourceIndexDocument(this.database, this.records(), source, maxBytes, budget);
    }, true);
  }

  advanceLexicalDocument(workspaceId: string, generationId: string, rootKey: string, maxBytes: number,
    budget: SourceIndexBudget): SourceIndexGuardedWriteResult & Readonly<{ analysis_units: number; complete: boolean }> {
    assertIndexBudget(budget);
    return this.atomic(() => {
      const rejected = (reason: Extract<SourceIndexGuardedWriteResult, { status: "rejected" }>["reason"]) =>
        ({ status: "rejected" as const, reason, resources: { work: 0, native_bytes: 0 }, analysis_units: 0, complete: false });
      const generation = this.lexicalGeneration(workspaceId, generationId);
      if (generation === null) return rejected("missing_generation");
      const stale = this.guard(generation);
      if (stale !== null) return rejected(stale);
      if (generation.selection.representation !== "segmented-unicode61.v2" || readSourceIndexLexicalAnalysisStatus() !== "ready") {
        return rejected("incomplete");
      }
      const source = this.target(workspaceId, generationId, rootKey);
      if (source === null) return rejected("missing_target");
      if (source.body_bytes > maxBytes) return rejected("incomplete");
      if (budget.work < 1 || budget.native_bytes < 8) return rejected("read_budget");
      const row = this.database.connection.prepare(`SELECT complete FROM source_index_lexical_targets
        WHERE workspace_id=? AND generation_id=? AND root_key=?`).get(workspaceId, generationId, rootKey) as { complete: number };
      if (row.complete === 1) return { status: "accepted" as const, resources: { work: 1, native_bytes: 8 },
        analysis_units: 0, complete: true };
      const remaining = { work: budget.work - 1, native_bytes: budget.native_bytes - 8 };
      try {
        const result = advanceSegmentedLexicalDocument(this.database, this.records(), source, generationId, remaining);
        return { ...result, resources: { work: result.resources.work + 1, native_bytes: result.resources.native_bytes + 8 } };
      } catch (error) { throw new SourceIndexOperationError(error, { work: 1, native_bytes: 8 }); }
    });
  }

  writeLexicalDocument(workspaceId: string, generationId: string, source: SourceIndexTarget, body: string,
    budget: SourceIndexBudget): SourceIndexGuardedWriteResult & Readonly<{ analysis_units: number }> {
    assertIndexBudget(budget);
    const exact = prepareSourceIndexLexical({ source, body }, this.sha256);
    const resources = { work: 0, native_bytes: 0 };
    let analysis = 0;
    const reject = (reason: Extract<SourceIndexGuardedWriteResult, { status: "rejected" }>["reason"]) =>
      ({ status: "rejected" as const, reason, resources, analysis_units: analysis });
    try { return this.atomic(() => {
      const generation = this.lexicalGeneration(workspaceId, generationId);
      if (generation === null) return reject("missing_generation");
      const stale = this.guard(generation);
      if (stale !== null) return reject(stale);
      const target = this.target(workspaceId, generationId, exact.source.root_key);
      if (target === null) return reject("missing_target");
      if (canonicalJson(target) !== canonicalJson(exact.source)) return reject("stale");
      if (generation.selection.representation === "segmented-unicode61.v2") return reject("incomplete");
      const segmented = generation.selection.representation === "segmented-unicode61.v1";
      if (segmented && readSourceIndexLexicalAnalysisStatus() !== "ready") return reject("incomplete");
      const guard = guardSourceIndexTarget(this.database, this.records(), exact.source, budget);
      Object.assign(resources, guard.resources);
      if (guard.status !== "ready") return reject(guard.status === "partial" ? guard.reason : "stale");
      if (segmented && budget.work - resources.work < body.length) return reject("read_budget");
      analysis = segmented ? body.length : 0; resources.work += analysis;
      const projection = segmented ? analyzeSourceIndexLexical(body, "source") : body;
      if (!persistSourceIndexLexical(this.database, exact.source, body, guard.dependencies, budget, resources)) return reject("read_budget");
      this.database.connection.prepare(`INSERT INTO source_index_lexical_projections
        (workspace_id,generation_id,root_key,content_digest,body_bytes,projection) VALUES(?,?,?,?,?,?)
        ON CONFLICT(workspace_id,generation_id,root_key) DO UPDATE SET content_digest=excluded.content_digest,
        body_bytes=excluded.body_bytes,projection=excluded.projection`).run(workspaceId, generationId, exact.source.root_key,
          exact.source.target.content_digest, exact.source.body_bytes, projection);
      this.database.connection.prepare(`UPDATE source_index_lexical_targets SET complete=1
        WHERE workspace_id=? AND generation_id=? AND root_key=?`).run(workspaceId, generationId, exact.source.root_key);
      return { status: "accepted", resources, analysis_units: analysis };
    }); } catch (error) { throw new SourceIndexOperationError(error, resources, 0, analysis); }
  }

  activateLexical(workspaceId: string, generationId: string): SourceIndexWriteResult {
    return this.atomic(() => {
      const generation = this.lexicalGeneration(workspaceId, generationId);
      if (generation === null) return { status: "rejected", reason: "missing_generation" };
      const guard = this.guard(generation);
      if (guard !== null) return { status: "rejected", reason: guard };
      if (!generation.enumeration_complete || generation.completed_count !== generation.target_count ||
          generation.selection.representation !== "raw-unicode61.v1" && readSourceIndexLexicalAnalysisStatus() !== "ready") {
        return { status: "rejected", reason: "incomplete" };
      }
      this.database.connection.prepare(`UPDATE source_index_lexical_generations SET status='retired',reason='replaced'
        WHERE workspace_id=? AND generation_id!=? AND status!='retired'`).run(workspaceId, generationId);
      this.database.connection.prepare(`UPDATE source_index_lexical_generations SET status=?,reason=NULL
        WHERE workspace_id=? AND generation_id=?`).run(generation.target_count === 0 ? "valid_empty" : "ready", workspaceId, generationId);
      this.database.connection.prepare(`UPDATE source_index_lexical_selections SET active_generation_id=? WHERE workspace_id=?`)
        .run(generationId, workspaceId);
      return { status: "accepted" };
    });
  }

  private target(workspaceId: string, generationId: string, rootKey: string): SourceIndexTarget | null {
    const raw = this.database.connection.prepare(`SELECT r.target_json FROM source_index_lexical_targets t JOIN source_index_roots r
      ON r.workspace_id=t.workspace_id AND r.root_key=t.root_key WHERE t.workspace_id=? AND t.generation_id=? AND t.root_key=?`)
      .get(workspaceId, generationId, rootKey);
    return raw === undefined ? null : SourceIndexTargetSchema.parse(readJsonColumn(readRecord(raw, "lexical target"), "target_json"));
  }
  private guard(generation: SourceIndexLexicalGeneration): "stale" | "superseded" | null {
    if (generation.status === "retired" || canonicalJson(this.lexicalState(generation.selection.workspace_id)?.selection) !==
        canonicalJson(generation.selection)) return "superseded";
    return sourceIndexEpoch(this.database, generation.selection.workspace_id) === generation.source_epoch ? null : "stale";
  }
  private requireGeneration(workspaceId: string, generationId: string): SourceIndexLexicalGeneration {
    const generation = this.lexicalGeneration(workspaceId, generationId);
    if (generation === null) throw new StorageError("NOT_FOUND", "source lexical generation not found");
    return generation;
  }
  private records(): SqliteFieldSourceRecordRepo { return new SqliteFieldSourceRecordRepo(this.database, this.sha256); }
  private atomic<T>(operation: () => T, read = false): T {
    this.database.reopenIfClosed();
    const transaction = this.database.connection.transaction(operation);
    return read ? transaction() : transaction.immediate();
  }
}
/** Snapshot-bound read. No native analyzer initialization or preparation effects. */
export function readSourceIndexLexicalBinding(database: StorageDatabase, workspaceId: string, budget: SourceIndexBudget): {
  state: { status: "legacy" } | { status: "unavailable"; reason: string } |
    { status: "ready" | "partial" | "valid_empty"; binding: SourceIndexLexicalBinding };
  resources: SourceIndexResources;
} {
  const resources = { work: 0, native_bytes: 0 };
  const unavailable = (reason: string) => ({ state: { status: "unavailable" as const, reason }, resources });
  if (budget.work < 1 || budget.native_bytes < 8) return unavailable("read_budget");
  const from = `FROM source_index_lexical_selections s LEFT JOIN source_index_lexical_generations g
    ON g.workspace_id=s.workspace_id AND g.generation_id=s.active_generation_id WHERE s.workspace_id=?`;
  resources.work++;
  const size = cachedReadStatement(database, `SELECT 24+octet_length(s.representation)+COALESCE(octet_length(g.representation),0)+
    COALESCE(octet_length(s.active_generation_id),0)+COALESCE(octet_length(g.status),0) AS bytes ${from}`).get(workspaceId);
  if (size === undefined) return { state: { status: "legacy" }, resources };
  resources.native_bytes += 8;
  const bytes = readIntegerField(readRecord(size, "lexical binding size"), "bytes");
  if (budget.work < 3 || budget.native_bytes < bytes + 16) return unavailable("read_budget");
  resources.work++; resources.native_bytes += bytes;
  const row = readRecord(cachedReadStatement(database, `SELECT s.selection_revision,s.representation,s.active_generation_id,
    g.selection_revision AS generation_revision,g.representation AS generation_representation,g.source_epoch,g.status ${from}`)
    .get(workspaceId), "lexical binding");
  // Until the selected representation first publishes, readers keep the raw index rather than losing lexical recall.
  if (row.active_generation_id === null) return { state: { status: "legacy" }, resources };
  if (row.selection_revision !== row.generation_revision || row.representation !== row.generation_representation) return unavailable("lexical_selection_mismatch");
  const status = row.status;
  if (status !== "ready" && status !== "valid_empty" && status !== "partial") return unavailable("lexical_generation_unavailable");
  resources.work++; resources.native_bytes += 8;
  const sourceEpoch = readIntegerField(row, "source_epoch"), currentEpoch = sourceIndexEpoch(database, workspaceId);
  if (sourceEpoch < 0 || sourceEpoch > currentEpoch) return unavailable("invalid_lexical_epoch");
  return { state: { status: sourceEpoch === currentEpoch ? status : "partial",
    binding: { ...selection({ ...row, workspace_id: workspaceId }),
      generation_id: readStringField(row, "active_generation_id"), source_epoch: sourceEpoch } }, resources };
}

function selection(row: Record<string, unknown>): SourceIndexLexicalSelection {
  return SourceIndexLexicalSelectionSchema.parse({ workspace_id: row.workspace_id,
    selection_revision: row.selection_revision, representation: row.representation });
}
