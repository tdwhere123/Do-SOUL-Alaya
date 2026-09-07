import { afterAll, afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeSemanticArtifactCandidateSchema, SqliteMemoryRecallReader, type StorageDatabase } from "@do-soul/alaya-storage";
import { SemanticEnrichmentWorker } from "../../../conversation/semantic-enrichment-worker.js";
import { artifactFixture, PROFILE, response, wireArtifacts } from "./artifact-lifecycle-fixture.js";
import { MEM, WS } from "./ids.js";

const probes: Record<string, unknown>[] = [];
afterAll(() => writeFileSync('/tmp/r3-artifact-lifecycle-probes.json', JSON.stringify({
  generatedAt: new Date().toISOString(), transport: 'local external-transport mock only', probes
}, null, 2)));
const databases = new Set<StorageDatabase>();
const directories: string[] = [];
afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const fixture = (filename?: string) => artifactFixture((database) => databases.add(database), filename);
function transport() {
  const calls: string[] = [];
  return { calls, execute: async (request: string) => { calls.push(request); return response(request); },
    reconcile: async () => ({ kind: 'unknown' as const }) };
}
function count(db: StorageDatabase, table: string): number {
  return (db.connection.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe('durable semantic artifact lifecycle', () => {
  it('reuses unchanged semantic work across distinct source occurrences and repeated reads', async () => {
    const f = await fixture();
    const t = transport();
    const first = await f.write(MEM.orion, 'Alice owns Orion');
    expect(first.startsWith('source_enrich_')).toBe(true);
    expect((f.garden.findById(first)?.payload as { enrichment_contract?: string }).enrichment_contract)
      .toBe('source_enrichment.v1');
    expect(t.calls).toHaveLength(0);
    const worker = f.worker(t);
    expect(await worker.run(WS, first)).toBe('completed');
    const second = await f.write(MEM.channel, 'Alice owns Orion');
    expect(await worker.run(WS, second)).toBe('completed');
    expect(f.enqueue(MEM.orion)).toBe(first);
    expect(await worker.run(WS, first)).toBe('completed');
    expect(t.calls).toHaveLength(1);
    expect(count(f.slice.database, 'garden_semantic_artifacts')).toBe(1);
    expect(count(f.slice.database, 'garden_semantic_bindings')).toBe(2);
    expect(f.repo.searchReady(WS, 'Orion', 10).map((row) => row.objectId).sort())
      .toEqual([MEM.orion, MEM.channel].sort());
    expect(f.repo.searchReady('other-workspace', 'Orion', 10)).toEqual([]);
    const before = f.slice.database.connection.prepare("SELECT total_changes() AS n").get();
    f.repo.searchReady(WS, 'Orion', 10);
    f.repo.searchReady(WS, 'Orion', 10);
    expect(f.slice.database.connection.prepare("SELECT total_changes() AS n").get()).toEqual(before);
    expect(t.calls).toHaveLength(1);
    probes.push({ probe: 'duplicate_unchanged', calls: t.calls.length,
      artifacts: count(f.slice.database, 'garden_semantic_artifacts'),
      bindings: count(f.slice.database, 'garden_semantic_bindings'), write_ack_ms: f.writeDurations });
  });

  it('changes only affected units and publishes only the changed source', async () => {
    const f = await fixture();
    const t = transport();
    const worker = f.worker(t);
    const task = await f.write(MEM.orion, 'Alice owns Orion. Bob owns Vega.');
    expect(await worker.run(WS, task)).toBe('completed');
    expect(t.calls[0]).not.toContain('Bob owns Vega');
    expect(t.calls.every((request) => !request.includes('sourceCorpus'))).toBe(true);
    const other = await f.write(MEM.channel, 'Charlie owns Lyra.');
    expect(await worker.run(WS, other)).toBe('completed');
    const before = f.slice.database.connection.prepare(`SELECT * FROM garden_semantic_projections WHERE object_id=?`).get(MEM.channel);
    const callsBefore = t.calls.length;
    const changed = await f.change(MEM.orion, 'Alice owns Orion. Bob owns Sirius.');
    expect(f.repo.searchReady(WS, 'Vega', 10)).toEqual([]);
    expect(await worker.run(WS, changed)).toBe('completed');
    expect(t.calls.length - callsBefore).toBe(1);
    expect(f.repo.searchReady(WS, 'Sirius', 10).map((row) => row.objectId)).toEqual([MEM.orion]);
    expect(f.slice.database.connection.prepare(`SELECT * FROM garden_semantic_projections WHERE object_id=?`).get(MEM.channel)).toEqual(before);
    probes.push({ probe: 'changed_source', additional_calls: t.calls.length - callsBefore,
      unchanged_source_projection: before, affected_source: MEM.orion,
      write_ack_ms: f.writeDurations, artifacts: count(f.slice.database, 'garden_semantic_artifacts') });
  });

  it('rolls source update and its EventLog back when durable enqueue rejects', async () => {
    const f = await fixture();
    await f.write(MEM.orion, 'Alice owns Orion');
    const beforeEvents = count(f.slice.database, 'event_log');
    const beforeTasks = count(f.slice.database, 'garden_tasks');
    f.rejectEnqueue();
    await expect(f.change(MEM.orion, 'Bob owns Orion')).rejects.toThrow(/backpressure/);
    expect((await f.slice.memoryEntryRepo.findById(MEM.orion))?.content).toBe('Alice owns Orion');
    expect(count(f.slice.database, 'event_log')).toBe(beforeEvents);
    expect(count(f.slice.database, 'garden_tasks')).toBe(beforeTasks);
  });

  it('recovers accepted source and pending intent after actual SQLite close/reopen', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'semantic-lifecycle-'));
    directories.push(directory);
    const f = await fixture(join(directory, 'source.sqlite'));
    const task = await f.write(MEM.orion, 'Alice owns Orion');
    f.slice.database.close();
    f.slice.database.reopenIfClosed();
    const restarted = wireArtifacts(f.slice.database);
    const t = transport();
    expect(restarted.repo.task(WS, task)?.status).toBe('pending');
    expect(await restarted.worker(t).run(WS, task)).toBe('completed');
    expect(restarted.repo.searchReady(WS, 'Orion', 10)).toHaveLength(1);
    expect(t.calls).toHaveLength(1);
  });

  it('resumes persisted raw response without another transport call after worker crash', async () => {
    const f = await fixture();
    const task = await f.write(MEM.orion, 'Alice owns Orion');
    const t = transport();
    const worker = f.worker(t, async (action, claimed, mutate) => {
      const result = await f.audit(action, claimed, mutate);
      if (action === 'received') throw new Error('process stopped after received commit');
      return result;
    });
    await expect(worker.run(WS, task)).rejects.toThrow(/process stopped/);
    f.advance();
    expect(await f.worker(t).run(WS, task)).toBe('completed');
    expect(t.calls).toHaveLength(1);
  });

  it('retains unknown external completion and bounds reconciliation without blind dispatch', async () => {
    const f = await fixture();
    const task = await f.write(MEM.orion, 'Alice owns Orion');
    let calls = 0;
    let reconciles = 0;
    const worker = f.worker({ execute: async () => { calls++; throw new Error('timeout'); },
      reconcile: async () => { reconciles++; return { kind: 'unknown' }; } });
    expect(await worker.run(WS, task)).toBe('uncertain');
    for (let index = 0; index < 3; index++) { f.advance(); await worker.run(WS, task); }
    expect(calls).toBe(1);
    expect(reconciles).toBe(2);
    probes.push({ probe: 'uncertain_bound', calls, reconciles, task: f.repo.task(WS, task) });
    expect(f.repo.task(WS, task)?.status).toBe('failed');
    expect(count(f.slice.database, 'garden_semantic_artifacts')).toBe(0);
  });

  it('fails closed when the reserved request-byte envelope is exhausted', async () => {
    const f = await fixture();
    const t = transport();
    const task = await f.write(MEM.orion, 'Alice owns Orion');
    const worker = f.worker(t, f.audit, 3, 1);
    expect(await worker.run(WS, task)).toBe('request_byte_envelope_exhausted');
    expect(t.calls).toHaveLength(0);
    expect(worker.resourceAccounting()).toEqual({
      reservedRequestUtf8Bytes: 0, completionTokens: 'unsupported', spend: 'unsupported'
    });
  });

  it('publishes a reconciled successful response without retransmitting an uncertain attempt', async () => {
    const f = await fixture();
    const task = await f.write(MEM.orion, 'Alice owns Orion');
    let raw = '';
    let calls = 0;
    const worker = f.worker({ execute: async (work) => { calls++; raw = response(work); throw new Error('lost response'); },
      reconcile: async () => ({ kind: 'received', rawJson: raw }) });
    expect(await worker.run(WS, task)).toBe('uncertain');
    f.advance();
    expect(await worker.run(WS, task)).toBe('completed');
    expect(calls).toBe(1);
    expect(f.repo.searchReady(WS, 'Orion', 10)).toHaveLength(1);
  });

  it('rejects stale source completion and corrupt or partial responses', async () => {
    const f = await fixture();
    const task = await f.write(MEM.orion, 'Alice owns Orion');
    const worker = f.worker({ execute: async (work) => {
      await f.change(MEM.orion, 'Bob owns Orion'); return response(work);
    }, reconcile: async () => ({ kind: 'unknown' }) });
    expect(await worker.run(WS, task)).toBe('superseded_source');
    expect(f.repo.searchReady(WS, 'Alice', 10)).toEqual([]);
    const malformed = f.enqueue(MEM.orion, { ...PROFILE, outputSchema: 'changed-schema' });
    expect(await f.worker({ execute: async () => '{"signals":[]}',
      reconcile: async () => ({ kind: 'unknown' }) }).run(WS, malformed)).toBe('admission_rejected');
  });

  it('atomically publishes projection and task completion despite lost postcommit acknowledgment', async () => {
    const f = await fixture();
    const task = await f.write(MEM.orion, 'Alice owns Orion');
    const t = transport();
    const worker = f.worker(t, async (action, claimed, mutate) => {
      const result = await f.audit(action, claimed, mutate);
      if (action === 'published') throw new Error('publication acknowledgment lost');
      return result;
    });
    await expect(worker.run(WS, task)).rejects.toThrow(/acknowledgment lost/);
    expect(f.repo.task(WS, task)?.status).toBe('completed');
    expect(f.repo.searchReady(WS, 'Orion', 10)).toHaveLength(1);
    expect(await f.worker(t).run(WS, task)).toBe('completed');
    expect(t.calls).toHaveLength(1);
  });
  it('republishes new compatible work identities for unchanged source revisions', async () => {
    const f = await fixture();
    const first = await f.write(MEM.orion, 'Alice owns Orion');
    const t = transport();
    expect(await f.worker(t).run(WS, first)).toBe('completed');
    const before = f.slice.database.connection.prepare('SELECT publication_key FROM garden_semantic_projections').get();
    const next = f.enqueue(MEM.orion, { ...PROFILE, promptRevision: 'fixture-prompt-v2' });
    expect(await f.worker(t).run(WS, next)).toBe('completed');
    expect(t.calls).toHaveLength(2);
    expect(count(f.slice.database, 'garden_semantic_bindings')).toBe(2);
    expect(f.slice.database.connection.prepare('SELECT publication_key FROM garden_semantic_projections').get()).not.toEqual(before);
  });

  it('rejects corrupted persisted artifact bytes before reuse', async () => {
    const f = await fixture();
    const first = await f.write(MEM.orion, 'Alice owns Orion');
    const t = transport();
    expect(await f.worker(t).run(WS, first)).toBe('completed');
    expect(() => f.slice.database.connection.prepare("UPDATE garden_semantic_artifacts SET payload_json='[]'").run())
      .toThrow(/immutable/);
    f.slice.database.connection.exec('DROP TRIGGER garden_semantic_artifact_immutable');
    f.slice.database.connection.prepare("UPDATE garden_semantic_artifacts SET payload_json='[]'").run();
    const next = await f.write(MEM.channel, 'Alice owns Orion');
    await expect(f.worker(t).run(WS, next)).rejects.toThrow(/integrity mismatch/);
    expect(t.calls).toHaveLength(1);
    expect(f.repo.task(WS, next)?.status).not.toBe('completed');
  });

  it('bounds never-resolving reconciliation and aborts its transport signal', async () => {
    const f = await fixture();
    const task = await f.write(MEM.orion, 'Alice owns Orion');
    let signal: AbortSignal | undefined;
    const worker = f.worker({ execute: async () => { throw new Error('timeout'); },
      reconcile: async (_attempt, receivedSignal) => {
        signal = receivedSignal;
        return new Promise(() => {});
      } });
    expect(await worker.run(WS, task)).toBe('uncertain');
    f.advance();
    expect(await worker.run(WS, task)).toBe('uncertain');
    expect(signal?.aborted).toBe(true);
  });

  it('rolls projection publication back when task completion fails inside the same transaction', async () => {
    const f = await fixture();
    const task = await f.write(MEM.orion, 'Alice owns Orion');
    f.slice.database.connection.exec(`CREATE TRIGGER reject_semantic_complete BEFORE UPDATE ON garden_tasks
      WHEN NEW.status='completed' BEGIN SELECT RAISE(ABORT, 'completion interrupted'); END;`);
    const t = transport();
    await expect(f.worker(t).run(WS, task)).rejects.toThrow(/completion interrupted/);
    expect(f.repo.searchReady(WS, 'Orion', 10)).toEqual([]);
    expect(count(f.slice.database, 'garden_semantic_bindings')).toBe(0);
    expect(count(f.slice.database, 'garden_semantic_artifacts')).toBe(1);
    f.slice.database.connection.exec('DROP TRIGGER reject_semantic_complete');
    f.advance();
    expect(await f.worker(t).run(WS, task)).toBe('completed');
    expect(t.calls).toHaveLength(1);
    probes.push({ probe: 'publication_before_completion_rollback', calls: t.calls.length,
      artifacts: count(f.slice.database, 'garden_semantic_artifacts'),
      bindings: count(f.slice.database, 'garden_semantic_bindings'),
      projections: count(f.slice.database, 'garden_semantic_projections'), task: f.repo.task(WS, task) });
  });

  it('allows only one SQLite claim and rejects a result from a superseded worker token', async () => {
    const f = await fixture();
    const task = await f.write(MEM.orion, 'Alice owns Orion');
    const t = transport();
    const results = await Promise.all([f.worker(t).run(WS, task), f.worker(t).run(WS, task)]);
    expect(results.sort()).toEqual(['busy', 'completed']);
    expect(t.calls).toHaveLength(1);
    const other = await f.write(MEM.channel, 'Bob owns Vega');
    const pending = f.repo.task(WS, other)!;
    await f.audit('claimed', pending, () => f.repo.claim(pending, 'old-claim', '2026-05-31T12:00:00.000Z'));
    const old = f.repo.task(WS, other)!;
    await f.audit('recovered', old, () => f.repo.recover(old));
    await f.audit('claimed', pending, () => f.repo.claim(pending, 'new-claim', '2026-05-31T12:00:01.000Z'));
    await expect(f.audit('received', old, () => f.repo.receive(old, 'late-attempt', '{}'))).rejects.toThrow(/stale worker claim/);
  });

  it('keeps admitted artifacts and raw source recall independently observable', async () => {
    const f = await fixture();
    const acceptedAt = performance.now();
    const task = await f.write(MEM.orion, 'Alice owns Orion');
    const sourceAckAt = performance.now();
    const input = { text: 'Alice owns Orion', familyCaps: { embedding: 'unavailable' as const } };
    const before = await f.slice.runRecall(input);
    expect(before.membership).toContain(MEM.orion);
    const t = transport();
    const workerStartedAt = performance.now();
    expect(await f.worker(t).run(WS, task)).toBe('completed');
    const publishedAt = performance.now();
    const readyArtifacts = f.repo.searchReadyObserved(WS, 'decision', 10);
    expect(JSON.stringify(readyArtifacts)).toContain(MEM.orion);
    const artifactKind = await f.slice.runRecall({ text: 'decision' });
    expect(artifactKind.membership).not.toContain(MEM.orion);
    expect(artifactKind.index.completeness.interpretation_coverage).not.toBe('complete');
    const queryStarted = performance.now();
    const delivered = await f.slice.runRecall(input);
    const repeated = await f.slice.runRecall(input);
    expect(delivered.membership).toContain(MEM.orion);
    expect(repeated.membership).toEqual(delivered.membership);
    expect(delivered.index.completeness.interpretation_coverage).not.toBe('complete');
    expect(t.calls).toHaveLength(1);
    expect(delivered.previews.get(MEM.orion)).toBe('Alice owns Orion');
    const phaseMetrics = { worker_execution_ms: publishedAt - workerStartedAt,
      actual_queue_lag_ms: workerStartedAt - sourceAckAt, actual_projection_lag_ms: publishedAt - sourceAckAt,
      actual_source_ack_ms: sourceAckAt - acceptedAt, rss_bytes: process.memoryUsage().rss,
      sqlite_allocated_bytes: Number(f.slice.database.connection.pragma('page_count', { simple: true })) *
        Number(f.slice.database.connection.pragma('page_size', { simple: true })),
      clock_basis: 'performance.now wall duration; fixture clock fixed; transport mock; no injected delay' };
    expect(phaseMetrics.worker_execution_ms).toBeLessThanOrEqual(500);
    expect(phaseMetrics.actual_source_ack_ms).toBeLessThanOrEqual(250);
    expect(phaseMetrics.rss_bytes).toBeLessThanOrEqual(1024 ** 3);
    expect(phaseMetrics.sqlite_allocated_bytes).toBeLessThanOrEqual(8 * 1024 ** 2);
    probes.push({ probe: 'artifact_and_source_recall', phaseMetrics, readyArtifacts, calls: t.calls.length,
      repeat_query_ms: performance.now() - queryStarted, membership: delivered.membership,
      index: delivered.index, artifactKindIndex: artifactKind.index,
      counters: delivered.counters, write_ack_ms: f.writeDurations });
  });

  it('canonicalizes profile field order and keeps large source bytes out of task payloads', async () => {
    const f = await fixture();
    const content = 'Alice owns Orion. '.repeat(300);
    const task = await f.write(MEM.orion, content);
    const reordered = { outputSchema: PROFILE.outputSchema, promptRevision: PROFILE.promptRevision,
      requestProfile: PROFILE.requestProfile, model: PROFILE.model, capability: PROFILE.capability };
    expect(f.enqueue(MEM.orion, reordered)).toBe(task);
    expect(count(f.slice.database, 'garden_tasks')).toBe(1);
    const row = f.garden.findById(task)!;
    expect(f.repo.task(WS, task)?.revision).toMatch(/^[a-f0-9]{64}$/u);
    expect(row.payload_json).not.toContain('Alice');
    expect(Buffer.byteLength(row.payload_json)).toBeLessThan(1024);
    probes.push({ probe: 'compact_canonical_intent', source_bytes: Buffer.byteLength(content),
      task_payload_bytes: Buffer.byteLength(row.payload_json), task_count: count(f.slice.database, 'garden_tasks') });
  });

  it('recovers the changed source and new intent together after a real file reopen', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'semantic-change-'));
    directories.push(directory);
    const f = await fixture(join(directory, 'source.sqlite'));
    const old = await f.write(MEM.orion, 'Alice owns Orion');
    const changed = await f.change(MEM.orion, 'Bob owns Orion');
    const db = f.slice.database;
    const pages = db.connection.pragma('page_count', { simple: true }) as number;
    const pageSize = db.connection.pragma('page_size', { simple: true }) as number;
    db.close();
    db.reopenIfClosed();
    const restarted = wireArtifacts(db);
    const t = transport();
    expect(restarted.repo.source(WS, MEM.orion)?.content).toBe('Bob owns Orion');
    expect(await restarted.worker(t).run(WS, old)).toBe('superseded_source');
    expect(await restarted.worker(t).run(WS, changed)).toBe('completed');
    expect(t.calls).toHaveLength(1);
    probes.push({ probe: 'changed_restart', calls: t.calls.length, db_page_bytes: pages * pageSize,
      old_status: restarted.repo.task(WS, old)?.status, new_status: restarted.repo.task(WS, changed)?.status,
      source: restarted.repo.source(WS, MEM.orion), write_ack_ms: f.writeDurations });
  });

  it('shares one durable dispatch across concurrent source occurrences and binds both after completion', async () => {
    const f = await fixture();
    const first = await f.write(MEM.orion, 'Alice owns Orion');
    const second = await f.write(MEM.channel, 'Alice owns Orion');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const t = { execute: async (request: string) => { calls++; await gate; return response(request); },
      reconcile: async () => ({ kind: 'unknown' as const }) };
    const a = f.worker(t).run(WS, first);
    const b = f.worker(t).run(WS, second);
    await new Promise((resolve) => setImmediate(resolve));
    release();
    expect((await Promise.all([a, b])).sort()).toEqual(['completed', 'work_busy']);
    f.advance();
    expect(await f.worker(t).run(WS, second)).toBe('completed');
    expect(calls).toBe(1);
    expect(count(f.slice.database, 'garden_semantic_bindings')).toBe(2);
    probes.push({ probe: 'cross_source_concurrent_reuse', calls,
      attempts: count(f.slice.database, 'garden_semantic_attempts'),
      bindings: count(f.slice.database, 'garden_semantic_bindings') });
  });

  it('recovers and shares persisted response bytes without spending a second external attempt', async () => {
    const f = await fixture();
    const first = await f.write(MEM.orion, 'Alice owns Orion');
    const t = transport();
    const crashed = f.worker(t, async (action, task, mutate) => {
      const result = await f.audit(action, task, mutate);
      if (action === 'received') throw new Error('stopped after raw commit');
      return result;
    }, 1);
    await expect(crashed.run(WS, first)).rejects.toThrow(/raw commit/);
    const second = await f.write(MEM.channel, 'Alice owns Orion');
    expect(await f.worker(t, f.audit, 1).run(WS, second)).toBe('completed');
    f.advance();
    expect(await f.worker(t, f.audit, 1).run(WS, first)).toBe('completed');
    expect(t.calls).toHaveLength(1);
    expect(count(f.slice.database, 'garden_semantic_bindings')).toBe(2);
    probes.push({ probe: 'local_recovery_at_dispatch_bound', calls: t.calls.length,
      task_claims: f.repo.task(WS, first)?.attempts,
      external_attempts: count(f.slice.database, 'garden_semantic_attempts') });
  });

  it('rejects older-profile late publication against the durable desired task identity', async () => {
    const f = await fixture();
    const first = await f.write(MEM.orion, 'Alice owns Orion');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const oldRun = f.worker({ execute: async (request) => { await gate; return response(request); },
      reconcile: async () => ({ kind: 'unknown' }) }).run(WS, first);
    await new Promise((resolve) => setImmediate(resolve));
    const newer = f.enqueue(MEM.orion, { ...PROFILE, promptRevision: 'fixture-prompt-v2' });
    expect(await f.worker(transport()).run(WS, newer)).toBe('completed');
    const before = f.slice.database.connection.prepare('SELECT * FROM garden_semantic_projections').get();
    release();
    expect(await oldRun).toBe('superseded_source');
    expect(f.slice.database.connection.prepare('SELECT * FROM garden_semantic_projections').get()).toEqual(before);
    expect(f.repo.isCurrent(f.repo.task(WS, newer)!)).toBe(true);
    probes.push({ probe: 'desired_profile_late_result', old: f.repo.task(WS, first)?.status,
      current: f.repo.task(WS, newer)?.status, publication: before });
  });

  it('reconciles a shared uncertain unit after its old source is superseded and fences late ownership', async () => {
    const f = await fixture();
    const first = await f.write(MEM.orion, 'Alice owns Orion.');
    let raw = '';
    let calls = 0;
    let reconciles = 0;
    const t = { execute: async (request: string) => {
      calls++;
      if (calls === 1) { raw = response(request); throw new Error('response lost'); }
      return response(request);
    }, reconcile: async () => { reconciles++; return { kind: 'received' as const, rawJson: raw }; } };
    expect(await f.worker(t).run(WS, first)).toBe('uncertain');
    const stale = f.repo.task(WS, first)!;
    const work = f.codec.plan(f.repo.source(WS, MEM.orion)!, PROFILE)[0]!;
    const attempt = f.repo.attempt(first, work.key)!;
    const next = await f.change(MEM.orion, 'Alice owns Orion. Bob owns Vega.');
    f.advance();
    expect(await f.worker(t).run(WS, next)).toBe('completed');
    expect(calls).toBe(2);
    expect(reconciles).toBe(1);
    await expect(f.audit('received', stale, () => f.repo.receive(stale, attempt.id, raw)))
      .rejects.toThrow(/stale semantic work ownership/);
    expect(await f.worker(t).run(WS, first)).toBe('superseded_source');
    probes.push({ probe: 'shared_uncertain_superseded_source', calls, reconciles,
      old_status: f.repo.task(WS, first)?.status, new_status: f.repo.task(WS, next)?.status });
  });

  it('bounds raw artifact candidates before stale filtering and reports every joined owner read', async () => {
    const f = await fixture();
    const first = await f.write(MEM.orion, 'Alice owns Orion');
    const second = await f.write(MEM.channel, 'Alice owns Orion');
    const worker = f.worker(transport());
    await worker.run(WS, first);
    await worker.run(WS, second);
    await f.memory.updateScoped(MEM.orion, WS, { content: 'Bob owns Orion' }, 'source changed');
    const capped = f.repo.searchReadyObserved(WS, 'decision', 1);
    expect(capped.rows).toEqual([]);
    expect(capped).toMatchObject({ candidateRowsRead: 1, candidateRowsReturned: 0, nativeVisits: 1, projectionRowsRead: 0,
      sourceRowsRead: 0, intentRowsRead: 0, sourceRevisionRowsRead: 0, rowsRead: 1, truncated: true });
    expect(capped.bytesRead).toBe(0);
    expect(capped.nativeBytes).toBeGreaterThan(0);
    const expanded = f.repo.searchReadyObserved(WS, 'decision', 3);
    expect(expanded.rows.map((row) => row.objectId)).toEqual([MEM.channel]);
    expect(expanded.rowsRead).toBe(10);
    expect(expanded).toMatchObject({ nativeVisits: 2, candidateRowsReturned: 2, sourceRevisionRowsRead: 2, truncated: false });
    expect(f.repo.searchReadyObserved('other-workspace', 'decision', 2).rowsRead).toBe(0);
    expect(f.repo.searchReady(WS, 'decision', 3)).toEqual(expanded.rows);
    probes.push({ probe: 'bounded_artifact_read', capped, expanded });
  });

  it('accepts A to B to A at one timestamp with fresh source revisions and reused artifacts', async () => {
    const f = await fixture();
    const t = transport();
    const worker = f.worker(t);
    const first = await f.write(MEM.orion, 'Alice owns Orion');
    const initial = f.repo.source(WS, MEM.orion)!;
    expect(await worker.run(WS, first)).toBe('completed');
    const second = await f.change(MEM.orion, 'Bob owns Orion');
    expect(await worker.run(WS, second)).toBe('completed');
    const again = await f.change(MEM.orion, 'Alice owns Orion');
    const current = f.repo.source(WS, MEM.orion)!;
    expect(again).not.toBe(first);
    expect(current.sourceEventRevision).toBeGreaterThan(initial.sourceEventRevision);
    expect(await worker.run(WS, again)).toBe('completed');
    expect(t.calls).toHaveLength(2);
    expect(f.repo.searchReady(WS, 'Alice', 10).map(row => row.objectId)).toEqual([MEM.orion]);
    const sourceEvents = f.slice.database.connection.prepare(`SELECT workspace_id, entity_type, entity_id,
      event_type, revision FROM event_log WHERE workspace_id=? AND entity_type='memory_entry' AND entity_id=?
      AND event_type IN ('soul.memory.created','soul.memory.updated') ORDER BY revision`).all(WS, MEM.orion);
    expect(sourceEvents.map(row => (row as { revision: number }).revision)).toEqual([0, 1, 2]);
    expect(initial.sourceEventRevision).toBe(0);
    expect(current.sourceEventRevision).toBe(2);
    const reader = new SqliteMemoryRecallReader(f.slice.database);
    reader.prepareIndex();
    const hydrated = reader.source(WS, MEM.orion);
    expect(hydrated.row?.sourceRevision).toBe(current.revision);
    expect(hydrated.row?.sourceRevision).not.toBe(initial.revision);
    expect(hydrated).toMatchObject({ rowsRead: 3, sourceRowsRead: 2, revisionRowsRead: 1 });
    probes.push({ probe: 'durable_source_hydration', hydrated });
    probes.push({ probe: 'fixed_clock_source_aba', first, second, again, initial, current, sourceEvents, calls: t.calls.length });
  });

  it('repins a completed profile after profile A to B to A and republishes without transport', async () => {
    const f = await fixture();
    const t = transport();
    const worker = f.worker(t);
    const first = await f.write(MEM.orion, 'Alice owns Orion');
    expect(await worker.run(WS, first)).toBe('completed');
    const firstPublication = f.slice.database.connection.prepare('SELECT publication_key FROM garden_semantic_projections').get();
    const second = f.enqueue(MEM.orion, { ...PROFILE, promptRevision: 'next-prompt' });
    expect(await worker.run(WS, second)).toBe('completed');
    expect(f.slice.database.connection.prepare('SELECT publication_key FROM garden_semantic_projections').get()).not.toEqual(firstPublication);
    const again = f.enqueue(MEM.orion, PROFILE);
    expect(again).toBe(first);
    expect(f.repo.task(WS, again)?.status).toBe('pending');
    expect(f.repo.searchReady(WS, 'decision', 10)).toEqual([]);
    expect(await worker.run(WS, again)).toBe('completed');
    expect(t.calls).toHaveLength(2);
    expect(f.slice.database.connection.prepare('SELECT publication_key FROM garden_semantic_projections').get()).toEqual(firstPublication);
    expect(f.repo.searchReady(WS, 'decision', 10)).toHaveLength(1);
    expect(f.enqueue(MEM.orion, PROFILE)).toBe(first);
    expect(f.repo.task(WS, first)?.status).toBe('completed');
    probes.push({ probe: 'profile_aba', first, second, again, calls: t.calls.length });
  });

  it('returns the same complete canonical result or empty truncation across publication permutations', async () => {
    const observations = [];
    for (const reverse of [false, true]) {
      const f = await fixture();
      const tasks = [await f.write(MEM.orion, 'Alice owns Orion'), await f.write(MEM.channel, 'Bob owns Orion')];
      const worker = f.worker(transport());
      for (const task of reverse ? tasks.reverse() : tasks) expect(await worker.run(WS, task)).toBe('completed');
      const capped = f.repo.searchReadyObserved(WS, 'decision', 1);
      const complete = f.repo.searchReadyObserved(WS, 'decision', 3);
      expect(capped).toMatchObject({ rows: [], truncated: true, nativeVisits: 1, candidateRowsReturned: 0 });
      expect(complete.rows.map(row => row.objectId)).toEqual([MEM.orion, MEM.channel].sort());
      expect(complete).toMatchObject({ nativeVisits: 2, candidateRowsReturned: 2, rowsRead: 10, truncated: false });
      observations.push({ capped, complete });
    }
    expect(observations[0]!.complete.rows).toEqual(observations[1]!.complete.rows);
    probes.push({ probe: 'publication_order_invariance', observations });
  });

  it('invalidates a projection on an accepted same-content update at the same timestamp', async () => {
    const f = await fixture();
    const task = await f.write(MEM.orion, 'Alice owns Orion');
    expect(await f.worker(transport()).run(WS, task)).toBe('completed');
    await f.memory.updateScoped(MEM.orion, WS, { content: 'Alice owns Orion' }, 'accepted new revision');
    expect(f.repo.searchReady(WS, 'decision', 10)).toEqual([]);
  });

  it('upgrades additive candidate schema 4 to the current indexed-projection revision', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'semantic-schema-upgrade-'));
    directories.push(directory);
    const f = await fixture(join(directory, 'source.sqlite'));
    const db = f.slice.database;
    db.connection.prepare('UPDATE garden_semantic_schema SET revision=4').run();
    db.close();
    db.reopenIfClosed();
    initializeSemanticArtifactCandidateSchema(db.connection);
    expect(db.connection.prepare('SELECT revision FROM garden_semantic_schema').all()).toEqual([{ revision: 6 }]);
  });

  it.each([1, 2, 3])('rejects old candidate schema %i after file reopen without silently reusing its FTS layout', async (revision) => {
    const directory = mkdtempSync(join(tmpdir(), 'semantic-schema-'));
    directories.push(directory);
    const f = await fixture(join(directory, 'source.sqlite'));
    const db = f.slice.database;
    db.connection.prepare('UPDATE garden_semantic_schema SET revision=?').run(revision);
    db.close();
    db.reopenIfClosed();
    expect(() => wireArtifacts(db)).toThrow(/incompatible semantic artifact candidate schema/);
    expect(() => initializeSemanticArtifactCandidateSchema(db.connection)).toThrow(/incompatible semantic artifact candidate schema/);
    expect(db.connection.prepare('SELECT revision FROM garden_semantic_schema').all()).toEqual([{ revision }]);
  });

  it('composes a fake provider extract port and does not advertise spend from request bytes', async () => {
    const f = await fixture();
    const task = await f.write(MEM.orion, 'Alice owns Orion');
    let extracts = 0;
    const worker = f.worker(SemanticEnrichmentWorker.composeProviderTransport({
      extract: async ({ userPrompt }) => {
        extracts += 1;
        return { rawJson: response(userPrompt) };
      }
    }));
    expect(await worker.run(WS, task)).toBe('completed');
    expect(extracts).toBe(1);
    expect(worker.resourceAccounting().reservedRequestUtf8Bytes).toBeGreaterThan(0);
    expect(worker.resourceAccounting()).toMatchObject({
      completionTokens: 'unsupported', spend: 'unsupported'
    });
    expect(f.repo.searchReady(WS, 'Orion', 10)).toHaveLength(1);
  });

  it('rejects an oversized composed completion without persisting raw bytes or claiming spend', async () => {
    const f = await fixture();
    const task = await f.write(MEM.orion, 'Alice owns Orion');
    const huge = JSON.stringify({
      signals: [{ object_kind: 'decision', confidence: 0.8, matched_text: 'x'.repeat(8_000), distilled_fact: 'x' }]
    });
    const worker = f.worker(SemanticEnrichmentWorker.composeProviderTransport({
      extract: async () => ({ rawJson: huge })
    }, { maxCompletionUtf8Bytes: 256 }));
    expect(await worker.run(WS, task)).toBe('completion_limit_exceeded');
    expect(count(f.slice.database, 'garden_semantic_artifacts')).toBe(0);
    expect(worker.resourceAccounting().spend).toBe('unsupported');
  });

  it('does not publish when a composed provider ignores cancellation past the deadline', async () => {
    const f = await fixture();
    const task = await f.write(MEM.orion, 'Alice owns Orion');
    let signal: AbortSignal | undefined;
    const worker = f.worker(SemanticEnrichmentWorker.composeProviderTransport({
      extract: async (input) => {
        signal = input.abortSignal;
        return new Promise(() => {});
      }
    }));
    expect(await worker.run(WS, task)).toBe('uncertain');
    expect(signal?.aborted).toBe(true);
    expect(count(f.slice.database, 'garden_semantic_artifacts')).toBe(0);
  });

  it('keeps an unconfigured composed transport unavailable unless artifacts already exist', async () => {
    const f = await fixture();
    const missing = await f.write(MEM.orion, 'Alice owns Orion');
    const unconfigured = SemanticEnrichmentWorker.composeProviderTransport(undefined);
    expect(await f.worker(unconfigured).run(WS, missing)).toBe('transport_unconfigured');
    expect(count(f.slice.database, 'garden_semantic_artifacts')).toBe(0);
    let extracts = 0;
    const first = await f.write(MEM.channel, 'Alice owns Orion');
    expect(await f.worker(SemanticEnrichmentWorker.composeProviderTransport({
      extract: async ({ userPrompt }) => {
        extracts += 1;
        return { rawJson: response(userPrompt) };
      }
    })).run(WS, first)).toBe('completed');
    expect(extracts).toBe(1);
    const reuse = await f.write(MEM.charlie, 'Alice owns Orion');
    const worker = f.worker(unconfigured);
    expect(await worker.run(WS, reuse)).toBe('completed');
    expect(extracts).toBe(1);
    expect(worker.resourceAccounting()).toEqual({
      reservedRequestUtf8Bytes: 0, completionTokens: 'unsupported', spend: 'unsupported'
    });
    expect(count(f.slice.database, 'garden_semantic_bindings')).toBe(2);
  });

  it('reconciles a lost composed extract without a second provider call', async () => {
    const f = await fixture();
    const task = await f.write(MEM.orion, 'Alice owns Orion');
    let raw = '';
    let extracts = 0;
    const worker = f.worker(SemanticEnrichmentWorker.composeProviderTransport({
      extract: async ({ userPrompt }) => {
        extracts += 1;
        raw = response(userPrompt);
        throw new Error('lost extract');
      },
      reconcile: async () => ({ kind: 'received', rawJson: raw })
    }));
    expect(await worker.run(WS, task)).toBe('uncertain');
    f.advance();
    expect(await worker.run(WS, task)).toBe('completed');
    expect(extracts).toBe(1);
    expect(worker.resourceAccounting().spend).toBe('unsupported');
  });

  it('does not call a composed provider from Recall when optional enrichment is missing', async () => {
    const f = await fixture();
    const task = await f.write(MEM.orion, 'Alice owns Orion');
    let extracts = 0;
    const transport = SemanticEnrichmentWorker.composeProviderTransport({
      extract: async ({ userPrompt }) => {
        extracts += 1;
        return { rawJson: response(userPrompt) };
      }
    });
    const before = await f.slice.runRecall({ text: 'Alice owns Orion', familyCaps: { embedding: 'unavailable' as const } });
    expect(before.membership).toContain(MEM.orion);
    expect(extracts).toBe(0);
    expect(before.counters.recall_provider_calls).toBe(0);
    expect(f.repo.task(WS, task)?.status).toBe('pending');
    expect(await f.worker(transport).run(WS, task)).toBe('completed');
    expect(extracts).toBe(1);
    const after = await f.slice.runRecall({ text: 'Alice owns Orion', familyCaps: { embedding: 'unavailable' as const } });
    expect(after.membership).toContain(MEM.orion);
    expect(extracts).toBe(1);
  });

});
