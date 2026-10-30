// Independent authored text/time fixtures only. Install effect guards before application imports.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const { installProviderFreeBoundary } = await import('./provider-free-boundary.ts');
const { installStrictProviderFreeBoundary } = await import('./strict-provider-free-boundary.ts');
const safe = installProviderFreeBoundary(), strict = installStrictProviderFreeBoundary();
const tree = fileURLToPath(new URL('../../../../../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const write = (path, value) => writeFileSync(path, JSON.stringify(value), { flag: 'wx' });
const cli = join(tree, 'apps/bench-runner/dist/runs/source-access-diagnostic/conditional-navigation-launch.js');
const preload = new URL('./strict-provider-free-cli-bootstrap.mjs', import.meta.url).href;
const root = mkdtempSync(join(tmpdir(), 'temporal-navigation-'));
const invocations = [], captures = [], readFaults = [];
const bytes = path => readdirSync(path, { withFileTypes: true }).reduce((sum, entry) => sum +
  (entry.isDirectory() ? bytes(join(path, entry.name)) : statSync(join(path, entry.name)).size), 0);
let peak = 0, proof;
const run = async (args, expected = 0) => {
  let result;
  try { result = { ...await promisify(execFile)(process.execPath, args, { env: process.env, timeout: 120_000, maxBuffer: 2 * 1024 ** 2 }), code: 0 }; }
  catch (error) { result = error; }
  invocations.push({ args, code: result.code, stdout: result.stdout, stderr: result.stderr });
  assert.equal(result.code, expected, result.stderr);
  peak = Math.max(peak, bytes(root)); assert.ok(peak < 256 * 1024 ** 2);
  return result;
};
try {
  const { inspectSourceRecordsArtifact, createSourceRecordsSidecarWriter, sealSourceRecordsManifest,
    sourceRecordsManifestPath, sourceRecordsSidecarPath } = await import(pathToFileURL(join(tree, 'apps/bench-runner/dist/runs/snapshot/source-records/contract.js')).href);
  const { initDatabase, SqliteFieldSourceRecordRepo, SqliteSourceIndexRepository } = await import('@do-soul/alaya-storage');
  const { fieldContractSha256 } = await import('@do-soul/alaya-core');
  const { sourceIndexTarget } = await import('@do-soul/alaya-protocol');
  const home = join(root, 'fixture'); mkdirSync(home);
  const text = 'Copper comet ceremony notes remain in the cedar box.';
  const dates = Array.from({ length: 12 }, (_, i) => `2021/02/${String(i + 1).padStart(2, '0')}`);
  const fixture = [{ question_id: 'authored-temporal-navigation', question_type: 'fixture', question: 'Copper comet', answer: '',
    question_date: '2025-07-02T00:00:00.000Z', haystack_session_ids: dates.map((_, i) => `session-${i}`), haystack_dates: dates,
    haystack_sessions: dates.map(() => [{ role: 'user', content: text }]), answer_session_ids: [] }];
  const encoded = JSON.stringify(fixture); writeFileSync(join(home, 'longmemeval_s.json'), encoded);
  write(join(home, 'longmemeval_s.meta.json'), { sha256: hash(encoded), size_bytes: Buffer.byteLength(encoded), question_count: 1 });
  const preparation = { snapshotPath: join(home, 'prepared.sqlite'), dataDirRoot: join(home, 'import'), dataDir: home,
    pinnedMetaRoot: home, offset: 0, limit: 1, recordedAt: '2026-10-01T12:34:56.000Z', producerCommit: 'ea35791d12f40a66a64d075a9bd3a4506f6b1c32',
    importEffects: { configDirectoryRoot: home, sqliteWriteQueue: 'disabled', embeddingStartupProbe: 'omit', gardenCompute: 'disabled' } };
  write(join(home, 'prepare.json'), preparation);
  await run([fileURLToPath(new URL('./session-observation-proof.mjs', import.meta.url)), 'prepare', join(home, 'prepare.json')]);
  const messages = [], artifact = inspectSourceRecordsArtifact(preparation.snapshotPath, message => messages.push(message));
  assert.equal(messages.length, 12);
  const workspace = messages[0].record.workspace_id, product = join(home, 'lexical.sqlite');
  copyFileSync(preparation.snapshotPath, product);
  const database = initDatabase({ filename: product });
  try {
    const records = new SqliteFieldSourceRecordRepo(database, fieldContractSha256), repository = new SqliteSourceIndexRepository(database, fieldContractSha256);
    const rows = records.listPageBounded(workspace, { limit: 16 }, 4096).rows;
    assert.equal(rows.length, 12);
    for (const { record } of rows) {
      assert.equal(record.source_body, text);
      const target = sourceIndexTarget({ kind: 'source_evidence', workspace_id: workspace, root_kind: 'source_record', root_id: record.record_id,
        source_version: record.source_version, content_digest: record.content_digest, evidence_object_id: null }, record.source_id, Buffer.byteLength(text));
      assert.equal(repository.writeLexical(target, text, { work: 1_000_000, native_bytes: 1_000_000 }).status, 'accepted');
    }
  } finally { database.close({ optimize: false }); }
  const original = { id: 'original', query: 'Copper comet', object: 'notes', hypothesis: 'authored-session-coordinate', status: 'ready', residual: null, provenance: 'authored-no-label-input' };
  const time = { ...original, id: 'time', query: 'explicit observation window, not a lexical query', observation_window: {
    contract: 'benchmark-session-window.v1', coordinate: 'normalized_session_coordinate', from: '2021-02-09T00:00:00.000Z', until: '2021-02-13T00:00:00.000Z' } };
  const baseline = { contract: 'benchmark-conditional-navigation.v1', source_revision: 'authored-temporal-navigation', channels: 'lexical', cache_root: root,
    rows: [{ ordinal: 1, question_id: fixture[0].question_id, snapshot: product, snapshot_sha256: hash(readFileSync(product)), workspace,
      source_records: { snapshot: preparation.snapshotPath, manifest_sha256: artifact.manifest.manifest_sha256 }, observation_domain: 'admitted_nomination_union',
      interpretation_clock: fixture[0].question_date, authorized_scopes: ['project'], expected_index: null, original: 'original', conditions: [original], branches: [] }] };
  const temporal = structuredClone(baseline); temporal.rows[0].conditions.push(time); temporal.rows[0].branches = [['time']];
  const conjunction = structuredClone(temporal); conjunction.rows[0].branches = [['original', 'time']];
  const uncertain = structuredClone(temporal); uncertain.rows[0].conditions[1].observation_window.coordinate = 'utc_instant';
  const overlap = structuredClone(temporal); overlap.rows[0].conditions[1].observation_window.from = '2021-02-09T12:00:00.000Z';
  const unbound = structuredClone(temporal); delete unbound.rows[0].source_records;
  const legacy = structuredClone(baseline); delete legacy.rows[0].observation_domain;
  // All comparison inputs are fixed before any capture or evaluator label is opened.
  const variants = { baseline, temporal, conjunction, uncertain, overlap, unbound, legacy };
  for (const [name, value] of Object.entries(variants)) write(join(root, `${name}.json`), value);
  const navigate = async (name, expected = 0) => {
    const out = join(root, name), result = await run(['--import', preload, cli, '--config', join(root, `${name}.json`), '--out', out], expected);
    const receipt = JSON.parse(result.stdout), capture = expected === 0 ? json(join(out, '001.json')) : null;
    assert.equal(receipt.status, expected === 0 ? 'complete' : 'stopped');
    assert.equal(receipt.local_inference_inputs, 0); assert.equal(receipt.external_calls, 0);
    const frozen = { input_json: readFileSync(join(out, 'input.json'), 'utf8'), formations_json: readFileSync(join(out, 'formations.json'), 'utf8'),
      capture_json: capture === null ? null : readFileSync(join(out, '001.json'), 'utf8') };
    assert.equal(hash(frozen.input_json), receipt.input_sha256); assert.equal(hash(frozen.formations_json), receipt.formations_sha256);
    if (frozen.capture_json !== null) assert.equal(hash(frozen.capture_json), receipt.rows[0].sha256);
    const partial = join(out, '001-observations.json');
    captures.push({ name, input: json(join(root, `${name}.json`)), receipt, capture, frozen,
      partial_acquisitions: existsSync(partial) ? json(partial) : null }); return capture;
  };
  const selected = {};
  for (const name of Object.keys(variants)) selected[name] = await navigate(name);
  const base = selected.baseline, timed = selected.temporal;
  assert.equal(base.pool.length, 12); assert.equal(base.solved.single_condition_equivalent, true);
  assert.deepEqual(selected.legacy.solved, base.solved); assert.deepEqual(selected.legacy.windows, base.windows);
  assert.deepEqual(captures.find(row => row.name === 'legacy').receipt.observation_scans, []);
  const baselineScan = captures.find(row => row.name === 'baseline').receipt.observation_scans[0];
  assert.equal(baselineScan.status, 'complete'); assert.equal(baselineScan.admitted_sources, 12);
  assert.equal(baselineScan.accounting.status, 'complete'); assert.equal(baselineScan.accounting.unmetered_reads, 0);
  assert.deepEqual(baselineScan.accounting, base.observation.accounting);
  assert.equal(timed.solved.temporal_observations.length, 12);
  for (const name of ['temporal', 'conjunction', 'uncertain', 'overlap', 'unbound']) {
    const capture = selected[name];
    assert.deepEqual(capture.pool, base.pool); assert.deepEqual(capture.captures, base.captures);
    assert.deepEqual(capture.occurrences, base.occurrences); assert.deepEqual(capture.observation.accounting, base.observation.accounting);
    assert.equal(capture.observation.accounting.source_reads, 12); assert.equal(capture.windows.length, 10);
    assert.ok(capture.windows.every(row => row.text === text && row.read.status === 'complete'));
    assert.ok(capture.solved.rows.every(row => row.conditional_support.status === 'unknown' && row.read.status === 'unobserved'));
    for (const row of base.solved.rows) assert.ok(capture.solved.rows.find(other => other.record_id === row.record_id).navigation.tier >= row.navigation.tier);
  }
  for (const message of messages) {
    const observed = timed.solved.temporal_observations.find(row => row.record_id === message.record.identity);
    assert.equal(observed.observation.relation, message.session_index >= 8 ? 'inside' : 'outside');
    assert.equal(observed.tier, message.session_index >= 8 ? 1024 : 1);
    assert.equal(observed.observation.method, 'benchmark-session-window.v1');
    assert.equal('native_rank' in observed, false);
  }
  const promotions = timed.solved.rows.filter(row => row.navigation.tier > base.solved.rows.find(other => other.record_id === row.record_id).navigation.tier);
  assert.ok(promotions.length >= 3); // Four independent inside sessions; only one original top can saturate.
  assert.notDeepEqual(timed.solved.rows.map(row => row.record_id), base.solved.rows.map(row => row.record_id));
  assert.deepEqual(selected.conjunction.windows, base.windows);
  assert.deepEqual(selected.uncertain.windows, base.windows);
  assert.ok(selected.uncertain.solved.temporal_observations.every(row => row.observation.status === 'unsupported' && row.tier === null));
  assert.ok(selected.unbound.solved.temporal_observations.every(row => row.observation.status === 'unknown' && row.tier === null));
  assert.equal(selected.overlap.solved.temporal_observations.find(row => row.record_id === messages.find(row => row.session_index === 8).record.identity).observation.status, 'partial');
  // New historical/incomplete products, not mutation of any prepared or frozen input.
  const { shards, message_count, ...header } = artifact.sidecar;
  // Omit each member in turn, independent of observed order: this includes the
  // undelivered tail and proves admission is not deferred until convenient reads.
  for (const [name, members] of [['historical', messages.map(({ source_observation, ...message }) => message)],
    ...messages.map((_, index) => [`missing-member-${index}`, messages.filter((_, other) => other !== index)])]) {
    const snapshot = join(root, `${name}.sqlite`); copyFileSync(preparation.snapshotPath, snapshot);
    const writer = createSourceRecordsSidecarWriter(snapshot, header); for (const message of members) writer.append(message); writer.finish();
    const { manifest_sha256, ...body } = artifact.manifest;
    const manifest = sealSourceRecordsManifest({ ...body, message_count: members.length, sidecar_sha256: hash(readFileSync(sourceRecordsSidecarPath(snapshot))) });
    write(sourceRecordsManifestPath(snapshot), manifest);
    const value = structuredClone(temporal); value.rows[0].source_records = { snapshot, manifest_sha256: manifest.manifest_sha256 };
    write(join(root, `${name}.json`), value);
    const capture = await navigate(name, name === 'historical' ? 0 : 2);
    if (capture) assert.ok(capture.solved.temporal_observations.every(row => row.observation.reason === 'historical_granularity_not_retained' && row.tier === null));
    else {
      const stopped = captures.at(-1).receipt;
      assert.match(stopped.failure, /differs from read SQLite record/);
      const failedId = messages[Number(name.slice('missing-member-'.length))].record.identity;
      const scanOrder = [...new Set(base.occurrences.map(row => row.record_id))];
      const attempted = scanOrder.indexOf(failedId) + 1;
      assert.ok(attempted > 0);
      assert.equal(stopped.observation_scans.length, 1);
      const scan = stopped.observation_scans[0];
      assert.equal(scan.ordinal, 1); assert.equal(scan.question_id, fixture[0].question_id); assert.equal(scan.arm, 'supplied');
      assert.equal(scan.status, 'failed'); assert.equal(scan.failure, stopped.failure);
      assert.equal(scan.candidates, 12); assert.equal(scan.admitted_sources, attempted - 1);
      assert.equal(scan.accounting.status, 'complete'); assert.equal(scan.accounting.unmetered_reads, 0);
      assert.equal(scan.accounting.source_reads, attempted); assert.equal(scan.accounting.requested_prefix_bytes, attempted);
      assert.equal(scan.accounting.native_bytes, attempted * Buffer.byteLength(text));
      assert.ok(scan.accounting.metadata_bytes > 0);
      assert.equal(scan.accounting.dependency_work, 0);
      assert.deepEqual(scan.artifact_inspection, { artifact_messages_visited: 11, retained_question_messages: 11 });
      if (attempted === 12) assert.deepEqual(scan.accounting, base.observation.accounting);
      assert.deepEqual(stopped.rows, []);
      assert.equal(existsSync(join(root, name, '001.json')), false);
      if (name === 'missing-member-0') {
        await run(['--import', preload, cli, '--evaluate', join(root, name), '--labels', join(root, 'must-not-read-labels'), '--out', join(root, 'must-not-score.json')], 2);
        assert.equal(existsSync(join(root, 'must-not-score.json')), false);
      }
    }
  }
  for (const mode of ['throw', 'null']) {
    const name = `unmetered-read-${mode}`, trace = join(root, `${name}-trace.json`), fault = join(root, `${name}.mjs`);
    write(join(root, `${name}.json`), temporal);
    // Hide the second real SQLite read's meter at the repository boundary.
    writeFileSync(fault, `await import(${JSON.stringify(preload)});
      const { SqliteFieldSourceRecordRepo } = await import(${JSON.stringify(pathToFileURL(join(tree, 'packages/storage/dist/index.js')).href)});
      const { writeFileSync } = await import('node:fs');
      const original = SqliteFieldSourceRecordRepo.prototype.findByIdBounded, reads = [];
      SqliteFieldSourceRecordRepo.prototype.findByIdBounded = function (...args) {
        const read = original.apply(this, args);
        if (args[2] !== 1) return read;
        reads.push({ native_bytes: read.nativeBytes, metadata_bytes: read.metadataBytes, dependency_work: read.dependencyWork });
        writeFileSync(${JSON.stringify(trace)}, JSON.stringify(reads));
        if (reads.length === 2) { if (${JSON.stringify(mode)} === 'throw') throw new Error('authored read lost its meter'); return null; }
        return read;
      };`);
    const out = join(root, name);
    const result = await run(['--import', pathToFileURL(fault).href, cli, '--config', join(root, `${name}.json`), '--out', out], 2);
    const receipt = JSON.parse(result.stdout), witness = json(trace), scan = receipt.observation_scans[0];
    assert.equal(witness.length, 2); assert.equal(receipt.status, 'stopped'); assert.deepEqual(receipt.rows, []);
    assert.equal(scan.status, 'failed'); assert.equal(scan.failure, receipt.failure); assert.equal(scan.admitted_sources, 1);
    assert.deepEqual(scan.accounting, { status: 'partial', source_reads: 2, requested_prefix_bytes: 2,
      ...witness[0], unmetered_reads: 1 });
    assert.equal(existsSync(join(out, '001.json')), false);
    readFaults.push({ mode, receipt, witness });
  }
  const bad = structuredClone(temporal); bad.rows[0].source_records.manifest_sha256 = '0'.repeat(64);
  write(join(root, 'wrong-manifest.json'), bad); await navigate('wrong-manifest', 2);
  assert.deepEqual(captures.at(-1).receipt.observation_scans, []);
  for (const [name, value] of [['invalid-window', structuredClone(temporal)], ['undeclared-domain', structuredClone(temporal)]]) {
    if (name === 'invalid-window') value.rows[0].conditions[1].observation_window.until = time.observation_window.from;
    else delete value.rows[0].observation_domain;
    write(join(root, `${name}.json`), value);
    await run(['--import', preload, cli, '--config', join(root, `${name}.json`), '--out', join(root, name)], 2);
    assert.equal(existsSync(join(root, name)), false);
  }
  // Evaluator-only spans, authored from source messages, not from selected windows or ranks.
  const spans = messages.filter(message => message.session_index >= 8).map(message => ({ session_index: message.session_index, message_index: 0,
    source_id: message.record.source_id, target: { workspace_id: workspace, root_kind: 'source_record', root_id: message.record.identity,
      source_version: message.record.source_version, content_digest: message.record.content_digest }, start: 0, end: Buffer.byteLength(text) }));
  write(join(root, 'gold.json'), { rows: [{ arm: 'C', visibility: { gold_messages: { annotated: 4, complete: true }, messages: spans } }] });
  write(join(root, 'labels.json'), [{ ordinal: 1, path: join(root, 'gold.json') }]);
  const evaluations = {};
  for (const name of ['baseline', 'temporal', 'conjunction']) {
    await run(['--import', preload, cli, '--evaluate', join(root, name), '--labels', join(root, 'labels.json'), '--out', join(root, `${name}-evaluation.json`)]);
    evaluations[name] = json(join(root, `${name}-evaluation.json`));
  }
  assert.equal(evaluations.temporal.rows[0].visibility.all_at_5.status, 'hit');
  assert.equal(hash(readFileSync(preparation.snapshotPath)), artifact.manifest.db_sha256);
  assert.equal(hash(readFileSync(product)), baseline.rows[0].snapshot_sha256);
  proof = { kind: 'authored-temporal-navigation-compiled-preparation-sqlite-cli', fixture, manifest: artifact.manifest,
    compiled_cli_sha256: hash(readFileSync(cli)), inputs_frozen_before_capture: true, captures, promotions, invocations, evaluations, read_faults: readFaults,
    gold: { spans, authored_before_evaluation: true }, peak_scratch_bytes: peak, provider_calls: 0, model_calls: 0, embedding_calls: 0,
    natural_data_reads: 0, lexical_fixture_writes: 12, source_records_unchanged: true, support: 'unknown', natural_benefit: 'NOT_VERIFIED' };
} finally {
  rmSync(root, { recursive: true, force: true });
  assert.deepEqual(safe.violations, []); assert.deepEqual(strict.forbidden, []); strict.restore(); safe.restore();
}
assert.equal(existsSync(root), false); proof.scratch_removed = true;
if (process.argv[2]) write(process.argv[2], proof);
console.log(JSON.stringify({ status: 'passed', scratch_removed: true, provider_calls: 0, promotions: proof.promotions.length }));
