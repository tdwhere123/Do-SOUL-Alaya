import { memorySourceRevision } from "../memory-entry/source-revision.js";
import { createHash, randomUUID } from "node:crypto";
import { GardenRole, GardenTaskKind, type AdmittedSemanticArtifact,
  type SemanticArtifactRepositoryPort, type SemanticArtifactWork,
  type SemanticEnrichmentTask, type SemanticExtractionProfile,
  type SemanticSourceSnapshot, type SemanticTransportAttempt } from "@do-soul/alaya-protocol";
import { buildWorkspaceFtsScopeMatch, buildFtsMatchExpression } from "../shared/fts-lane-routing.js";
import { assertSemanticArtifactCandidateSchema } from "./semantic-artifact-schema.js";
import type { SqliteConnection } from "../../sqlite/db.js";
import type { SqliteGardenTaskRepo } from "./garden-task-repo.js";
import { prepareGardenTaskClaimStatements, prepareGardenTaskMaintenanceStatements } from
  "./statements/garden-task-statement-groups.js";

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const sourceEventRevisionSql = (alias: string) => `(SELECT revision FROM event_log
  INDEXED BY garden_semantic_source_event_revision
  WHERE workspace_id=${alias}.workspace_id AND entity_type='memory_entry' AND entity_id=${alias}.object_id
    AND event_type IN ('soul.memory.created','soul.memory.updated') ORDER BY revision DESC LIMIT 1)`;

interface SemanticProjectionReadRow {
  workspace_id: string; object_id: string;
  projectionId: string | null; sourceRevision: string | null; projectionText: string | null;
  sourceId: string | null; intentId: string | null; eligible: number;
  observedSourceRevision: number | null;
  projectionBytes: number; sourceBytes: number; intentBytes: number;
}

export class SqliteSemanticArtifactRepo implements SemanticArtifactRepositoryPort {
  private readonly visitFunction = `semantic_visit_${randomUUID().replaceAll('-', '')}`;
  private readonly exhausted = new Error("semantic native candidate budget exhausted");
  private readonly visitState = new Map<number, { visits: number; bytes: number; limit: number }>();
  private nextVisitCall = 0;

  public constructor(
    private readonly db: SqliteConnection,
    private readonly garden: SqliteGardenTaskRepo,
    private readonly defaultProfile: SemanticExtractionProfile | null = null,
    private readonly enrichmentContract = "source_enrichment.v1"
  ) {
    assertSemanticArtifactCandidateSchema(db);
    db.function(this.visitFunction, (id: string, callId: number) => {
      const state = this.visitState.get(callId);
      if (state === undefined) throw new Error("semantic visit call is missing");
      state.visits++;
      state.bytes += Buffer.byteLength(id, 'utf8');
      if (state.visits >= state.limit) throw this.exhausted;
      return 1;
    });
  }

  public source(workspaceId: string, objectId: string): SemanticSourceSnapshot | null {
    const row = this.db.prepare(`SELECT object_id, content, run_id, created_at, source_kind,
      evidence_refs, updated_at, ${sourceEventRevisionSql('m')} AS sourceEventRevision FROM memory_entries m
      WHERE workspace_id = ? AND object_id = ? AND lifecycle_state = 'active'`)
      .get(workspaceId, objectId) as { object_id: string; content: string; run_id: string;
        created_at: string; source_kind: string; evidence_refs: string; updated_at: string;
        sourceEventRevision: number | null } | undefined;
    if (!row || row.source_kind !== 'user' || row.sourceEventRevision === null) return null;
    return { workspaceId, objectId, content: row.content, runId: row.run_id,
      createdAt: row.created_at, trustedRole: 'user', sourceEventRevision: row.sourceEventRevision,
      revision: memorySourceRevision(row.sourceEventRevision, row.content, row.evidence_refs, row.updated_at) };
  }

  public enqueue(workspaceId: string, objectId: string, profile: SemanticExtractionProfile,
    now: string, capacity = 128): string {
    this.requireTransaction();
    const source = this.source(workspaceId, objectId);
    if (!source) throw new Error("source missing, revoked, or outside trusted scope");
    const canonicalProfile: SemanticExtractionProfile = {
      capability: profile.capability, model: profile.model, requestProfile: profile.requestProfile,
      promptRevision: profile.promptRevision, outputSchema: profile.outputSchema
    };
    if (Object.values(canonicalProfile).some((value) => typeof value !== 'string' || value.trim().length === 0)) {
      throw new Error("invalid semantic extraction profile");
    }
    if (this.defaultProfile !== null && profilesEqual(canonicalProfile, this.defaultProfile)) {
      const existingId = this.findSourceEnrichmentTaskId(workspaceId, objectId, source.sourceEventRevision);
      if (existingId !== null) {
        this.upsertIntent(workspaceId, objectId, existingId, capacity);
        return existingId;
      }
    }
    const payload = { source_object_id: objectId, source_revision: source.revision, profile: canonicalProfile };
    const id = `semantic:${digest(JSON.stringify([workspaceId, objectId, source.revision, canonicalProfile]))}`;
    const existing = this.garden.findById(id);
    if (existing) {
      if (existing.workspace_id !== workspaceId || existing.payload_json !== JSON.stringify(payload)) {
        throw new Error("semantic task identity conflict");
      }
      const current = this.db.prepare(`SELECT task_id FROM garden_semantic_intents
        WHERE workspace_id=? AND object_id=?`).get(workspaceId, objectId) as { task_id: string } | undefined;
      if (current?.task_id !== id) {
        if (existing.status === 'completed' || existing.status === 'failed') {
          const backlog = this.garden.countBacklog(workspaceId).reduce((sum, row) => sum + row.count, 0);
          if (!Number.isSafeInteger(capacity) || capacity < 1 || backlog >= capacity) {
            throw new Error("retryable semantic enrichment backpressure");
          }
          this.db.prepare(`UPDATE garden_tasks SET status='pending', claimed_by=NULL, claimed_at=NULL,
            completed_at=NULL, last_error_text=NULL, completion_envelope_json=NULL
            WHERE id=? AND workspace_id=? AND status IN ('completed','failed')`).run(id, workspaceId);
        }
        this.db.prepare(`INSERT INTO garden_semantic_intents VALUES (?, ?, ?)
          ON CONFLICT(workspace_id,object_id) DO UPDATE SET task_id=excluded.task_id`).run(workspaceId, objectId, id);
      }
      return id;
    }
    const count = this.garden.countBacklog(workspaceId).reduce((sum, row) => sum + row.count, 0);
    if (!Number.isSafeInteger(capacity) || capacity < 1 || count >= capacity) {
      throw new Error("retryable semantic enrichment backpressure");
    }
    this.garden.enqueue({ id, workspace_id: workspaceId, role: GardenRole.LIBRARIAN,
      kind: GardenTaskKind.BULK_ENRICH, payload, created_at: now });
    this.db.prepare(`INSERT INTO garden_semantic_intents VALUES (?, ?, ?)
      ON CONFLICT(workspace_id,object_id) DO UPDATE SET task_id=excluded.task_id`)
      .run(workspaceId, objectId, id);
    return id;
  }

  public isCurrent(task: SemanticEnrichmentTask): boolean {
    if (!this.sourceMatchesTask(task)) return false;
    const intent = this.db.prepare(`SELECT task_id FROM garden_semantic_intents
      WHERE workspace_id=? AND object_id=?`)
      .get(task.workspaceId, task.objectId) as { task_id: string } | undefined;
    if (intent === undefined || intent.task_id === task.id) return true;
    const incumbent = this.garden.findById(intent.task_id);
    return incumbent === null || this.outranksIntent(task, incumbent);
  }

  public task(workspaceId: string, taskId: string): SemanticEnrichmentTask | null {
    const row = this.garden.findById(taskId);
    if (!row || row.workspace_id !== workspaceId) return null;
    const mapped = this.mapTask(row);
    return mapped?.workspaceId === workspaceId ? mapped : null;
  }

  public claim(task: SemanticEnrichmentTask, token: string, now: string): boolean {
    this.requireTransaction();
    return prepareGardenTaskClaimStatements(this.db).claimStatement.run(
      token, now, task.id, task.workspaceId, task.workspaceId).changes === 1;
  }

  public recover(task: SemanticEnrichmentTask): boolean {
    this.requireTransaction();
    return prepareGardenTaskMaintenanceStatements(this.db).gcAbandonedClaimStatement.run(
      task.id, task.claim, task.claimedAt).changes === 1;
  }

  public artifact(workspaceId: string, key: string): AdmittedSemanticArtifact | null {
    const row = this.db.prepare(`SELECT artifact_key AS key, raw_json AS rawJson,
      payload_json AS payloadJson, search_text AS searchText, integrity FROM garden_semantic_artifacts
      WHERE workspace_id = ? AND artifact_key = ?`).get(workspaceId, key);
    if (!row) return null;
    const stored = row as AdmittedSemanticArtifact & { integrity: string };
    if (stored.integrity !== digest(JSON.stringify([stored.key, stored.rawJson, stored.payloadJson, stored.searchText]))) {
      throw new Error("semantic artifact integrity mismatch");
    }
    const payload = JSON.parse(stored.payloadJson) as unknown;
    const raw = JSON.parse(stored.rawJson) as { signals?: unknown[] };
    if (!Array.isArray(payload) || payload.length === 0 || !Array.isArray(raw.signals) ||
      payload.length !== raw.signals.length || payload.some((entry) =>
        typeof entry !== 'object' || entry === null || typeof entry.matched_text !== 'string')) {
      throw new Error("semantic artifact persisted shape mismatch");
    }
    return Object.freeze({ key: stored.key, rawJson: stored.rawJson,
      payloadJson: stored.payloadJson, searchText: stored.searchText });
  }

  public attempt(taskId: string, key: string): SemanticTransportAttempt | null {
    const row = this.db.prepare(`SELECT id, task_id AS taskId, artifact_key AS key,
      state, raw_json AS rawJson, ordinal, reconciliations FROM garden_semantic_attempts
      WHERE workspace_id=(SELECT workspace_id FROM garden_tasks WHERE id=?)
        AND artifact_key = ? ORDER BY ordinal DESC LIMIT 1`).get(taskId, key);
    return row ? row as SemanticTransportAttempt : null;
  }

  public acquireWork(task: SemanticEnrichmentTask, key: string, expiredBefore: string): boolean {
    this.assertClaim(task);
    this.db.prepare(`INSERT OR IGNORE INTO garden_semantic_work_claims VALUES (?, ?, ?)`)
      .run(task.workspaceId, key, task.id);
    this.db.prepare(`UPDATE garden_semantic_work_claims SET task_id=?
      WHERE workspace_id=? AND artifact_key=? AND task_id IN
        (SELECT id FROM garden_tasks WHERE status IN ('completed','failed')
          OR (status='claimed' AND claimed_at < ?))`)
      .run(task.id, task.workspaceId, key, expiredBefore);
    return this.db.prepare(`SELECT 1 FROM garden_semantic_work_claims
      WHERE workspace_id=? AND artifact_key=? AND task_id=?`).get(task.workspaceId, key, task.id) !== undefined;
  }

  public beginReconcile(task: SemanticEnrichmentTask, attemptId: string): void {
    this.assertAttemptOwnership(task, attemptId);
    this.db.prepare(`UPDATE garden_semantic_attempts SET reconciliations=reconciliations+1
      WHERE id=? AND state IN ('dispatched','uncertain')`).run(attemptId);
  }

  public dispatch(task: SemanticEnrichmentTask, key: string, attemptId: string): boolean {
    this.assertClaim(task);
    this.db.prepare(`INSERT OR IGNORE INTO garden_semantic_work_claims VALUES (?, ?, ?)`)
      .run(task.workspaceId, key, task.id);
    const owner = this.db.prepare(`SELECT task_id FROM garden_semantic_work_claims
      WHERE workspace_id=? AND artifact_key=?`).get(task.workspaceId, key) as { task_id: string };
    if (owner.task_id !== task.id) return false;
    const previous = this.attempt(task.id, key);
    if (previous && previous.state !== 'not_sent') throw new Error("unresolved external attempt");
    this.db.prepare(`INSERT INTO garden_semantic_attempts
      (id, task_id, workspace_id, artifact_key, state, raw_json, ordinal)
      VALUES (?, ?, ?, ?, 'dispatched', NULL,
        (SELECT COALESCE(MAX(ordinal),0)+1 FROM garden_semantic_attempts WHERE workspace_id=? AND artifact_key=?))`)
      .run(attemptId, task.id, task.workspaceId, key, task.workspaceId, key);
    return true;
  }

  public receive(task: SemanticEnrichmentTask, attemptId: string, rawJson: string): void {
    this.assertAttemptOwnership(task, attemptId);
    const result = this.db.prepare(`UPDATE garden_semantic_attempts SET state='received', raw_json=?
      WHERE id=? AND state='dispatched'`).run(rawJson, attemptId);
    if (result.changes !== 1) throw new Error("stale transport result");
  }

  public uncertain(task: SemanticEnrichmentTask, attemptId: string): void {
    this.assertAttemptOwnership(task, attemptId);
    this.db.prepare(`UPDATE garden_semantic_attempts SET state='uncertain'
      WHERE id=? AND state='dispatched'`).run(attemptId);
  }

  public reconcile(task: SemanticEnrichmentTask, attemptId: string, rawJson: string | null): void {
    this.assertAttemptOwnership(task, attemptId);
    const result = this.db.prepare(`UPDATE garden_semantic_attempts SET state=?, raw_json=?
      WHERE id=? AND state IN ('dispatched','uncertain')`)
      .run(rawJson === null ? 'not_sent' : 'received', rawJson, attemptId);
    if (result.changes !== 1) throw new Error("stale reconciliation");
  }

  public put(task: SemanticEnrichmentTask, artifact: AdmittedSemanticArtifact): void {
    this.assertClaim(task);
    const existing = this.artifact(task.workspaceId, artifact.key);
    if (existing) {
      if (existing.payloadJson !== artifact.payloadJson || existing.searchText !== artifact.searchText) {
        throw new Error("immutable artifact conflict");
      }
      return;
    }
    this.db.prepare(`INSERT INTO garden_semantic_artifacts VALUES (?, ?, ?, ?, ?, ?)`)
      .run(task.workspaceId, artifact.key, artifact.rawJson, artifact.payloadJson, artifact.searchText,
        digest(JSON.stringify([artifact.key, artifact.rawJson, artifact.payloadJson, artifact.searchText])));
  }

  public publish(task: SemanticEnrichmentTask, source: SemanticSourceSnapshot,
    work: readonly SemanticArtifactWork[], now: string): number {
    this.assertClaim(task);
    if (!this.isCurrent(task) || source.revision !== task.revision ||
      this.source(task.workspaceId, task.objectId)?.revision !== task.revision) {
      throw new Error("superseded source result");
    }
    const old = this.db.prepare(`SELECT publication_key FROM garden_semantic_projections
      WHERE workspace_id=? AND object_id=?`).get(task.workspaceId, task.objectId) as
      { publication_key: string } | undefined;
    const publicationKey = digest(JSON.stringify([source.revision, work.map((unit) => [unit.key, unit.bindingJson])]));
    if (old?.publication_key === publicationKey) return 0;
    const texts: string[] = [];
    for (const unit of work) {
      const artifact = this.artifact(task.workspaceId, unit.key);
      if (!artifact) throw new Error("artifact missing before publication");
      this.db.prepare(`INSERT OR IGNORE INTO garden_semantic_bindings VALUES (?, ?, ?, ?, ?, ?)`)
        .run(task.workspaceId, task.objectId, source.revision, digest(JSON.stringify([unit.bindingJson, unit.key])), unit.key, unit.bindingJson);
      texts.push(artifact.searchText);
    }
    const text = texts.join("\n");
    this.db.prepare(`INSERT INTO garden_semantic_projections
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, evidence_refs, updated_at, ? FROM memory_entries
      WHERE workspace_id=? AND object_id=?
      ON CONFLICT(workspace_id,object_id) DO UPDATE SET source_revision=excluded.source_revision,
      publication_key=excluded.publication_key, task_id=excluded.task_id, source_content=excluded.source_content,
      source_evidence_refs=excluded.source_evidence_refs, source_updated_at=excluded.source_updated_at, source_event_revision=excluded.source_event_revision, search_text=excluded.search_text, published_at=excluded.published_at`)
      .run(task.workspaceId, task.objectId, source.revision, publicationKey, task.id, source.content, text, now, source.sourceEventRevision, task.workspaceId, task.objectId);
    this.db.prepare("DELETE FROM garden_semantic_fts WHERE workspace_id=? AND object_id=?")
      .run(task.workspaceId, task.objectId);
    this.db.prepare("INSERT INTO garden_semantic_fts VALUES (?, ?, ?)").run(task.workspaceId, task.objectId, text);
    return 1;
  }

  public finish(task: SemanticEnrichmentTask, status: "completed" | "failed", reason: string | null, now: string): void {
    this.assertClaim(task);
    const result = prepareGardenTaskClaimStatements(this.db).completeStatement.run(
      status, now, reason, task.id, task.claim);
    if (result.changes !== 1) throw new Error("stale completion");
  }

  public searchReady(workspaceId: string, query: string, limit: number) {
    return this.searchReadyObserved(workspaceId, query, limit).rows;
  }

  public searchReadyObserved(workspaceId: string, query: string, limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 512) throw new Error("invalid projection read limit");
    const terms = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
    const observation = { rowsRead: 0, candidateRowsRead: 0, candidateRowsReturned: 0,
      nativeVisits: 0, nativeBytes: 0, sourceRevisionRowsRead: 0, projectionRowsRead: 0,
      sourceRowsRead: 0, intentRowsRead: 0, bytesRead: 0, truncated: false,
      byteAccounting: "utf8_candidate_and_validation_columns" as const };
    if (terms.length === 0) return { ...observation, rows: [] };
    const match = `${buildWorkspaceFtsScopeMatch(workspaceId)} AND search_text:(${buildFtsMatchExpression(terms.slice(0, 32))})`;
    const callId = ++this.nextVisitCall;
    const state = { visits: 0, bytes: 0, limit };
    this.visitState.set(callId, state);
    let read: SemanticProjectionReadRow[];
    try {
      read = this.readReadyRows(workspaceId, match, limit, callId);
    } catch (error) {
      if (error !== this.exhausted) throw error;
      return { ...observation, rows: [], rowsRead: state.visits, candidateRowsRead: state.visits,
        nativeVisits: state.visits, nativeBytes: state.bytes, bytesRead: 0, truncated: true };
    } finally {
      this.visitState.delete(callId);
    }
    const rows: { objectId: string; sourceRevision: string; projectionText: string }[] = [];
    observation.nativeVisits = observation.candidateRowsRead = state.visits;
    observation.nativeBytes = state.bytes;
    observation.candidateRowsReturned = read.length;
    for (const row of read) {
      observation.projectionRowsRead += Number(row.projectionId !== null);
      observation.sourceRowsRead += Number(row.sourceId !== null);
      observation.intentRowsRead += Number(row.intentId !== null);
      observation.sourceRevisionRowsRead += Number(row.observedSourceRevision !== null);
      observation.bytesRead += Buffer.byteLength(JSON.stringify({ workspace_id: row.workspace_id,
        object_id: row.object_id }), 'utf8') + row.projectionBytes + row.sourceBytes +
        row.intentBytes + (row.observedSourceRevision === null ? 0 : Buffer.byteLength(String(row.observedSourceRevision)));
      if (row.eligible === 1) rows.push({ objectId: row.object_id,
        sourceRevision: row.sourceRevision!, projectionText: row.projectionText! });
    }
    observation.rowsRead = observation.candidateRowsRead + observation.projectionRowsRead +
      observation.sourceRowsRead + observation.intentRowsRead + observation.sourceRevisionRowsRead;
    return { ...observation, rows };
  }

  private readReadyRows(workspaceId: string, match: string, limit: number, callId: number): SemanticProjectionReadRow[] {
    // Complete canonical ordering or no winners: a native budget abort never exposes an arrival-order prefix.
    return this.db.prepare(`WITH candidate AS MATERIALIZED (
      SELECT workspace_id, object_id
      FROM garden_semantic_fts WHERE garden_semantic_fts MATCH ? AND workspace_id=?
        AND ${this.visitFunction}(object_id, ?)
      ORDER BY object_id LIMIT ?
    ), validated AS MATERIALIZED (
      SELECT c.workspace_id, c.object_id,
        p.object_id AS projectionId, p.source_revision AS sourceRevision, p.search_text AS projectionText,
        m.object_id AS sourceId, i.object_id AS intentId,
        ${sourceEventRevisionSql('m')} AS observedSourceRevision,
        p.source_event_revision AS expectedSourceRevision,
        CASE WHEN m.lifecycle_state='active' AND i.task_id=p.task_id
          AND m.content=p.source_content AND m.evidence_refs=p.source_evidence_refs
          AND m.updated_at=p.source_updated_at THEN 1 ELSE 0 END AS sourceEligible,
        ${columnBytes('p', ['workspace_id', 'object_id', 'source_revision', 'search_text', 'task_id',
          'source_content', 'source_evidence_refs', 'source_updated_at', 'source_event_revision'])} AS projectionBytes,
        ${columnBytes('m', ['workspace_id', 'object_id', 'content', 'evidence_refs', 'updated_at', 'lifecycle_state'])} AS sourceBytes,
        ${columnBytes('i', ['workspace_id', 'object_id', 'task_id'])} AS intentBytes
      FROM candidate c
      LEFT JOIN garden_semantic_projections p ON p.workspace_id=c.workspace_id AND p.object_id=c.object_id
      LEFT JOIN memory_entries m ON m.workspace_id=p.workspace_id AND m.object_id=p.object_id
      LEFT JOIN garden_semantic_intents i ON i.workspace_id=p.workspace_id AND i.object_id=p.object_id
    ) SELECT *, CASE WHEN sourceEligible=1 AND observedSourceRevision=expectedSourceRevision
        THEN 1 ELSE 0 END AS eligible FROM validated ORDER BY object_id`)
      .all(match, workspaceId, callId, limit) as SemanticProjectionReadRow[];
  }

  private assertAttemptOwnership(task: SemanticEnrichmentTask, attemptId: string): void {
    this.assertClaim(task);
    const owned = this.db.prepare(`SELECT 1 FROM garden_semantic_attempts a
      JOIN garden_semantic_work_claims c ON c.workspace_id=a.workspace_id AND c.artifact_key=a.artifact_key
      WHERE a.id=? AND c.workspace_id=? AND c.task_id=?`).get(attemptId, task.workspaceId, task.id);
    if (!owned) throw new Error("stale semantic work ownership");
  }

  private requireTransaction(): void {
    if (!this.db.inTransaction) throw new Error("semantic mutation requires owner transaction");
  }

  private assertClaim(task: SemanticEnrichmentTask): void {
    this.requireTransaction();
    const live = this.task(task.workspaceId, task.id);
    if (!live || live.status !== 'claimed' || live.claim !== task.claim || live.attempts !== task.attempts) {
      throw new Error("stale worker claim");
    }
    if (this.isCurrent(task)) {
      this.db.prepare(`INSERT INTO garden_semantic_intents VALUES (?, ?, ?)
        ON CONFLICT(workspace_id,object_id) DO UPDATE SET task_id=excluded.task_id`)
        .run(task.workspaceId, task.objectId, task.id);
    }
  }

  private mapTask(row: { readonly id: string; readonly workspace_id: string; readonly payload: unknown;
    readonly status: SemanticEnrichmentTask["status"]; readonly claimed_by: string | null;
    readonly claimed_at: string | null; readonly attempt_count: number }): SemanticEnrichmentTask | null {
    const payload = asRecord(row.payload);
    if (payload === null) return null;
    const objectId = readNonEmptyString(payload.source_object_id);
    if (objectId === null) return null;
    const profile = this.readProfile(payload);
    if (profile === null) return null;
    const source = this.source(row.workspace_id, objectId);
    const revision = source?.revision ?? readNonEmptyString(payload.source_revision) ??
      (payload.source_revision === undefined ? null : String(payload.source_revision));
    if (revision === null) return null;
    return { id: row.id, workspaceId: row.workspace_id, objectId, revision, profile,
      status: row.status, claim: row.claimed_by, claimedAt: row.claimed_at, attempts: row.attempt_count };
  }

  private readProfile(payload: Record<string, unknown>): SemanticExtractionProfile | null {
    const nested = payload.profile;
    if (isProfile(nested)) return nested;
    if (readNonEmptyString(payload.enrichment_contract) === this.enrichmentContract && this.defaultProfile !== null) {
      return this.defaultProfile;
    }
    return null;
  }

  private outranksIntent(
    task: SemanticEnrichmentTask,
    incumbent: { readonly id: string; readonly payload: unknown }
  ): boolean {
    const candidate = this.garden.findById(task.id);
    const next = asRecord(candidate?.payload);
    const current = asRecord(incumbent.payload);
    if (next === null || current === null) return false;
    if (readNonEmptyString(next.enrichment_contract) !== this.enrichmentContract) return false;
    if (readNonEmptyString(current.enrichment_contract) !== this.enrichmentContract) return false;
    const nextRevision = Number(next.source_revision);
    const currentRevision = Number(current.source_revision);
    return Number.isInteger(nextRevision) && Number.isInteger(currentRevision) &&
      nextRevision > currentRevision;
  }

  private sourceMatchesTask(task: SemanticEnrichmentTask): boolean {
    const source = this.source(task.workspaceId, task.objectId);
    const row = this.garden.findById(task.id);
    if (source === null || row === null) return false;
    const payload = asRecord(row.payload);
    if (payload === null) return false;
    if (readNonEmptyString(payload.enrichment_contract) === this.enrichmentContract) {
      return Number(payload.source_revision) === source.sourceEventRevision;
    }
    return source.revision === task.revision;
  }

  private findSourceEnrichmentTaskId(workspaceId: string, objectId: string, sourceEventRevision: number): string | null {
    const row = this.db.prepare(`SELECT id FROM garden_tasks WHERE workspace_id=? AND kind='bulk_enrich'
      AND json_extract(payload_json,'$.source_object_id')=?
      AND CAST(json_extract(payload_json,'$.source_revision') AS INTEGER)=?
      AND json_extract(payload_json,'$.enrichment_contract')=?`).get(
      workspaceId, objectId, sourceEventRevision, this.enrichmentContract) as { id: string } | undefined;
    return row?.id ?? null;
  }

  private upsertIntent(workspaceId: string, objectId: string, taskId: string, capacity: number): void {
    const existing = this.garden.findById(taskId);
    if (existing === null || existing.workspace_id !== workspaceId) {
      throw new Error("semantic task identity conflict");
    }
    const current = this.db.prepare(`SELECT task_id FROM garden_semantic_intents
      WHERE workspace_id=? AND object_id=?`).get(workspaceId, objectId) as { task_id: string } | undefined;
    if (current?.task_id === taskId) return;
    if (existing.status === 'completed' || existing.status === 'failed') {
      const backlog = this.garden.countBacklog(workspaceId).reduce((sum, row) => sum + row.count, 0);
      if (!Number.isSafeInteger(capacity) || capacity < 1 || backlog >= capacity) {
        throw new Error("retryable semantic enrichment backpressure");
      }
      this.db.prepare(`UPDATE garden_tasks SET status='pending', claimed_by=NULL, claimed_at=NULL,
        completed_at=NULL, last_error_text=NULL, completion_envelope_json=NULL
        WHERE id=? AND workspace_id=? AND status IN ('completed','failed')`).run(taskId, workspaceId);
    }
    this.db.prepare(`INSERT INTO garden_semantic_intents VALUES (?, ?, ?)
      ON CONFLICT(workspace_id,object_id) DO UPDATE SET task_id=excluded.task_id`)
      .run(workspaceId, objectId, taskId);
  }
}

function profilesEqual(left: SemanticExtractionProfile, right: SemanticExtractionProfile): boolean {
  return left.capability === right.capability && left.model === right.model &&
    left.requestProfile === right.requestProfile && left.promptRevision === right.promptRevision &&
    left.outputSchema === right.outputSchema;
}

function isProfile(value: unknown): value is SemanticExtractionProfile {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return ['capability', 'model', 'requestProfile', 'promptRevision', 'outputSchema']
    .every((key) => typeof record[key] === 'string' && (record[key] as string).trim().length > 0);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

// Counts the exact UTF-8 fields inspected by validation, not SQLite page or index IO.
function columnBytes(alias: string, columns: readonly string[]): string {
  return columns.map((column) => `COALESCE(length(CAST(${alias}.${column} AS BLOB)),0)`).join(' + ');
}
