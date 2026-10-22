// Authored inputs only. Effect guards install before every application import.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const tree = fileURLToPath(new URL('../../../../../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const write = (path, value) => writeFileSync(path, JSON.stringify(value), { flag: 'wx' });
const cli = join(tree, 'apps/bench-runner/dist/runs/source-access-diagnostic/conditional-navigation-launch.js');
const preparation = join(tree, 'apps/bench-runner/dist/runs/snapshot/source-records/prepare.js');
const preload = new URL('./strict-provider-free-cli-bootstrap.mjs', import.meta.url).href;
if (process.argv[2] === 'prepare') {
  const guard = await import('./source-import-boundary.mjs');
  const { prepareSourceRecordsSnapshot } = await import(preparation);
  const manifest = await prepareSourceRecordsSnapshot(json(process.argv[3]));
  assert.equal(guard.receipt().operations.some(row => row.blocked), false);
  process.stdout.write(JSON.stringify(manifest));
} else {
  const { installProviderFreeBoundary } = await import('./provider-free-boundary.ts');
  const { installStrictProviderFreeBoundary } = await import('./strict-provider-free-boundary.ts');
  const safe = installProviderFreeBoundary(), strict = installStrictProviderFreeBoundary();
  const root = mkdtempSync(join(tmpdir(), 'session-observation-'));
  const invocations = [], captured = [];
  let proof, peak = 0;
  const bytes = path => readdirSync(path, { withFileTypes: true }).reduce((sum, entry) =>
    sum + (entry.isDirectory() ? bytes(join(path, entry.name)) : statSync(join(path, entry.name)).size), 0);
  const run = async (args, expected = 0) => {
    let result;
    try { result = { ...await promisify(execFile)(process.execPath, args, { env: process.env,
      timeout: 120_000, maxBuffer: 2 * 1024 ** 2 }), code: 0 }; }
    catch (error) { result = error; }
    invocations.push({ args, code: result.code, stdout: result.stdout, stderr: result.stderr });
    assert.equal(result.code, expected, result.stderr);
    peak = Math.max(peak, bytes(root)); assert.ok(peak < 256 * 1024 ** 2);
    return result;
  };
  try {
    const { inspectSourceRecordsArtifact, createSourceRecordsSidecarWriter, sealSourceRecordsManifest,
      sourceRecordsSidecarPath, sourceRecordsManifestPath } = await import(join(tree, 'apps/bench-runner/dist/runs/snapshot/source-records/contract.js'));
    const { initDatabase, SqliteSourceIndexRepository, SqliteFieldSourceRecordRepo } = await import('@do-soul/alaya-storage');
    const { fieldContractSha256 } = await import('@do-soul/alaya-core');
    const { sourceIndexTarget } = await import('@do-soul/alaya-protocol');
    const recorded = '2026-10-01T12:34:56.000Z', questionClock = '2025-07-02T00:00:00.000Z';
    const text = 'Copper comet: the ceremony happened in 1999.';
    const make = (name, dates) => {
      const home = join(root, name); mkdirSync(home);
      const data = [{ question_id: 'authored-observation', question_type: 'fixture', question: 'Copper comet', answer: '',
        question_date: questionClock, haystack_session_ids: ['repeated-session', 'repeated-session'],
        haystack_dates: dates, haystack_sessions: [[{ role: 'user', content: text }], [{ role: 'user', content: text }]], answer_session_ids: [] }];
      const encoded = JSON.stringify(data);
      writeFileSync(join(home, 'longmemeval_s.json'), encoded);
      write(join(home, 'longmemeval_s.meta.json'), { sha256: hash(encoded), size_bytes: Buffer.byteLength(encoded), question_count: 1 });
      const input = { snapshotPath: join(home, 'original.sqlite'), dataDirRoot: join(home, 'import'), dataDir: home,
        pinnedMetaRoot: home, offset: 0, limit: 1, recordedAt: recorded, producerCommit: 'ea35791d12f40a66a64d075a9bd3a4506f6b1c32',
        importEffects: { configDirectoryRoot: home, sqliteWriteQueue: 'disabled', embeddingStartupProbe: 'omit', gardenCompute: 'disabled' } };
      write(join(home, 'prepare.json'), input); return { home, input, data };
    };
    const prepare = async (fixture, expected = 0) => run([fileURLToPath(import.meta.url), 'prepare', join(fixture.home, 'prepare.json')], expected);
    const first = make('first', ['2021/02/03', '2022/04/05 (Tue) 14:23']);
    await prepare(first);
    const messages = [];
    const artifact = inspectSourceRecordsArtifact(first.input.snapshotPath, row => messages.push(row));
    assert.equal(messages.length, 2);
    assert.deepEqual(messages.map(row => row.source_observed_at), ['2021-02-03T00:00:00.000Z', '2022-04-05T14:23:00.000Z']);
    assert.notEqual(messages[0].record.identity, messages[1].record.identity);
    assert.equal(messages[0].record.content_digest, messages[1].record.content_digest);
    const workspace = messages[0].record.workspace_id;
    const { shards: ignoredShards, message_count: ignoredCount, ...validationHeader } = artifact.sidecar;
    for (const [name, altered, pattern] of [
      ['invalid-date', { ...messages[0], source_observation: { contract: 'longmemeval-session-observation.v1', raw_date: '2021/02/30' } }, /invalid LongMemEval timestamp/],
      ['conflicting-date', { ...messages[0], source_observation: { contract: 'longmemeval-session-observation.v1', raw_date: '2021/02/04' } }, /normalization conflict/]
    ]) {
      const validator = createSourceRecordsSidecarWriter(join(root, name), validationHeader);
      assert.throws(() => validator.append(altered), pattern);
    }
    const conflict = createSourceRecordsSidecarWriter(join(root, 'conflicting-session'), validationHeader);
    conflict.append(messages[0]);
    assert.throws(() => conflict.append({ ...messages[1], session_index: 0 }), /session observation conflict/);
    // New derived products only: no writes or resealing of the prepared original.
    const index = (source, destination) => {
      copyFileSync(source, destination);
      const db = initDatabase({ filename: destination });
      try {
        const records = new SqliteFieldSourceRecordRepo(db, fieldContractSha256);
        const repository = new SqliteSourceIndexRepository(db, fieldContractSha256);
        const rows = records.listPageBounded(workspace, { limit: 8 }, 4096).rows;
        assert.equal(rows.length, 2);
        for (const { record } of rows) {
          assert.equal(record.source_body, text); assert.equal(record.event_time, null);
          assert.equal(record.recorded_at, recorded); assert.equal(record.valid_from, null); assert.equal(record.valid_to, null);
          const target = sourceIndexTarget({ kind: 'source_evidence', workspace_id: workspace, root_kind: 'source_record',
            root_id: record.record_id, source_version: record.source_version, content_digest: record.content_digest,
            evidence_object_id: null }, record.source_id, Buffer.byteLength(record.source_body));
          assert.equal(repository.writeLexical(target, record.source_body, { work: 1_000_000, native_bytes: 1_000_000 }).status, 'accepted');
        }
        return rows.map(row => row.record);
      } finally { db.close({ optimize: false }); }
    };
    const product = join(first.home, 'lexical.sqlite'), sqlite = index(first.input.snapshotPath, product);
    const config = { contract: 'benchmark-conditional-navigation.v1', source_revision: 'authored-observation-time', channels: 'lexical', cache_root: root,
      rows: [{ ordinal: 1, question_id: 'authored-observation', snapshot: product, snapshot_sha256: hash(readFileSync(product)), workspace,
        source_records: { snapshot: first.input.snapshotPath, manifest_sha256: artifact.manifest.manifest_sha256 },
        interpretation_clock: questionClock, authorized_scopes: ['project'], expected_index: null, original: 'original',
        conditions: [{ id: 'original', query: 'Copper comet', object: 'original', hypothesis: 'question', status: 'ready',
          residual: null, provenance: 'independently-authored' }], branches: [] }] };
    const navigate = async (name, value, expected = 0) => {
      const path = join(root, `${name}.json`), out = join(root, name); write(path, value);
      const result = await run(['--import', preload, cli, '--config', path, '--out', out], expected);
      const receipt = JSON.parse(result.stdout);
      assert.equal(receipt.status, expected === 0 ? 'complete' : 'stopped');
      const capture = expected === 0 ? json(join(out, '001.json')) : null;
      captured.push({ name, input: value, receipt, capture }); return capture;
    };
    const selected = await navigate('bound', config);
    assert.equal(selected.windows.length, 2);
    const bySession = selected.windows.toSorted((a, b) => a.source_time.binding.session_index - b.source_time.binding.session_index);
    assert.deepEqual(bySession.map(row => row.source_time.observation), [
      { status: 'known', raw: '2021/02/03', normalized: '2021-02-03T00:00:00.000Z', level: 'session', provenance: 'longmemeval.haystack_dates',
        precision: 'day', timezone: 'unspecified', normalization: 'utc_coordinate_not_event_time' },
      { status: 'known', raw: '2022/04/05 (Tue) 14:23', normalized: '2022-04-05T14:23:00.000Z', level: 'session', provenance: 'longmemeval.haystack_dates',
        precision: 'minute', timezone: 'unspecified', normalization: 'utc_coordinate_not_event_time' }]);
    assert.ok(selected.windows.every(row => row.source_time.recorded_at === recorded && row.source_time.event_time === null));
    assert.equal(selected.interpretation_clock, questionClock);
    assert.ok(selected.solved.rows.every(row => row.conditional_support.status === 'unknown'));
    const unboundConfig = structuredClone(config); delete unboundConfig.rows[0].source_records;
    const unbound = await navigate('unbound', unboundConfig);
    assert.deepEqual(unbound.solved, selected.solved); assert.deepEqual(unbound.captures, selected.captures);
    assert.deepEqual(unbound.windows.map(({ source_time, ...row }) => row), selected.windows.map(({ source_time, ...row }) => row));
    assert.ok(unbound.windows.every(row => row.source_time.observation.status === 'unknown' && row.source_time.observation.reason === 'artifact_not_bound'));
    const badDigest = structuredClone(config); badDigest.rows[0].source_records.manifest_sha256 = '0'.repeat(64);
    await navigate('wrong-manifest', badDigest, 2);
    const badSnapshot = structuredClone(config); badSnapshot.rows[0].snapshot_sha256 = '0'.repeat(64);
    await navigate('wrong-snapshot', badSnapshot, 2);
    // Construct a new historical-format fixture; never rewrite a prepared artifact.
    const historical = join(root, 'historical.sqlite'); copyFileSync(first.input.snapshotPath, historical);
    const { shards, message_count, ...header } = artifact.sidecar;
    const writer = createSourceRecordsSidecarWriter(historical, header);
    for (const { source_observation, ...message } of messages) writer.append(message);
    writer.finish();
    const { manifest_sha256, ...body } = artifact.manifest;
    const oldManifest = sealSourceRecordsManifest({ ...body, sidecar_sha256: hash(readFileSync(sourceRecordsSidecarPath(historical))) });
    write(sourceRecordsManifestPath(historical), oldManifest);
    const oldConfig = structuredClone(config); oldConfig.rows[0].source_records = { snapshot: historical, manifest_sha256: oldManifest.manifest_sha256 };
    const old = await navigate('historical', oldConfig);
    assert.deepEqual(old.solved, selected.solved);
    assert.ok(old.windows.every(row => row.source_time.observation.reason === 'historical_granularity_not_retained'));
    const next = make('changed', ['2021/02/04', '2022/04/05 (Tue) 14:23']); await prepare(next);
    const nextMessages = [], nextArtifact = inspectSourceRecordsArtifact(next.input.snapshotPath, row => nextMessages.push(row));
    assert.notEqual(nextArtifact.manifest.dataset.sha256, artifact.manifest.dataset.sha256);
    assert.notEqual(nextMessages[0].record.identity, messages[0].record.identity);
    const reusePath = join(root, 'reuse-conflict.json');
    write(reusePath, { ...next.input, snapshotPath: first.input.snapshotPath, dataDirRoot: first.input.dataDirRoot });
    const refusedReuse = await run([fileURLToPath(import.meta.url), 'prepare', reusePath], 1);
    assert.match(refusedReuse.stderr, /preparation identity conflict/);
    const mismatch = structuredClone(config); mismatch.rows[0].source_records = { snapshot: next.input.snapshotPath,
      manifest_sha256: nextArtifact.manifest.manifest_sha256 };
    await navigate('wrong-source-identity', mismatch, 2);
    const nextProduct = join(next.home, 'lexical.sqlite'); index(next.input.snapshotPath, nextProduct);
    mismatch.rows[0].snapshot = nextProduct; mismatch.rows[0].snapshot_sha256 = hash(readFileSync(nextProduct));
    const changed = await navigate('changed-observation', mismatch);
    assert.equal(changed.windows.find(row => row.source_time.binding.session_index === 0).source_time.observation.raw, '2021/02/04');
    for (const [name, dates] of [['malformed', ['2021/02/30', '2022/04/05']], ['missing', []],
      ['misaligned', ['2021/02/03', '2022/04/05', '2023/01/01']]]) {
      const invalid = make(name, dates); await prepare(invalid, 1);
      assert.equal(existsSync(invalid.input.snapshotPath), false); assert.equal(existsSync(invalid.input.dataDirRoot), false);
    }
    // Independently authored relevance span; evaluation starts only after all captures freeze.
    const goldRecord = messages[0].record;
    write(join(root, 'labels.json'), [{ ordinal: 1, path: join(root, 'gold.json') }]);
    write(join(root, 'gold.json'), { rows: [{ arm: 'C', visibility: { gold_messages: { annotated: 1, complete: true },
      messages: [{ session_index: 0, message_index: 0, source_id: goldRecord.source_id,
        target: { workspace_id: workspace, root_kind: 'source_record', root_id: goldRecord.identity,
          source_version: goldRecord.source_version, content_digest: goldRecord.content_digest },
        start: 0, end: Buffer.byteLength(text) }] } }] });
    await run(['--import', preload, cli, '--evaluate', join(root, 'bound'), '--labels', join(root, 'labels.json'), '--out', join(root, 'evaluation.json')]);
    const evaluation = json(join(root, 'evaluation.json'));
    assert.equal(evaluation.rows[0].visibility.any_at_5.status, 'hit');
    assert.equal(evaluation.rows[0].visibility.all_at_5.status, 'hit');
    assert.equal(hash(readFileSync(first.input.snapshotPath)), artifact.manifest.db_sha256);
    assert.equal(hash(readFileSync(product)), config.rows[0].snapshot_sha256);
    assert.deepEqual(safe.violations, []); assert.deepEqual(strict.forbidden, []);
    proof = { kind: 'authored-session-observation-compiled-preparation-sqlite-cli', fixture: first.data, changed_fixture: next.data,
      compiled: { cli_sha256: hash(readFileSync(cli)), preparation_sha256: hash(readFileSync(preparation)) },
      original_manifest: artifact.manifest, changed_manifest: nextArtifact.manifest, sqlite_records: sqlite,
      captures: captured, invocations, evaluation, peak_scratch_bytes: peak, source_records_unchanged: true,
      provider_calls: 0, model_calls: 0, natural_data_reads: 0, lexical_fixture_writes: 4, embedding_builds: 0,
      ranking_unchanged_under_matched_input: true, support: 'unknown', natural_benefit: 'NOT_VERIFIED' };
  } finally {
    rmSync(root, { recursive: true, force: true });
    assert.deepEqual(safe.violations, []); assert.deepEqual(strict.forbidden, []);
    strict.restore(); safe.restore();
  }
  assert.equal(existsSync(root), false); proof.scratch_removed = true;
  if (process.argv[2]) write(process.argv[2], proof);
  console.log(JSON.stringify({ status: 'passed', scratch_removed: true, observation: 'session', support: 'unknown', provider_calls: 0 }));
}
