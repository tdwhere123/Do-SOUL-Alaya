// One authored preparation -> SQLite acquisition/read -> compiled CLI -> frozen evaluator proof.
// Numerical vector inputs are explicit fixtures, not local-model inference or natural quality.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
const { installProviderFreeBoundary } = await import('./provider-free-boundary.ts');
const { installStrictProviderFreeBoundary } = await import('./strict-provider-free-boundary.ts');
const safe = installProviderFreeBoundary(), strict = installStrictProviderFreeBoundary();
const tree = fileURLToPath(new URL('../../../../../', import.meta.url));
const cli = join(tree, 'apps/bench-runner/dist/runs/source-access-diagnostic/conditional-navigation-launch.js');
const preload = new URL('./field-delivery-proof-bootstrap.mjs', import.meta.url).href;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const write = (path, value) => writeFileSync(path, JSON.stringify(value), { flag: 'wx' });
const root = mkdtempSync(join(tmpdir(), 'field-delivery-'));
const captures = [], invocations = [], failures = [], comparisons = [];
const files = ['conditional-navigation', 'conditional-navigation-run', 'conditional-navigation-evaluate', 'field-delivery', 'field-delivery-read',
  'navigation-read-budget', 'structural-navigation'];
const bindings = files.flatMap(name => ['src', 'dist'].map(dir => `apps/bench-runner/${dir}/runs/source-access-diagnostic/${name}.${dir === 'src' ? 'ts' : 'js'}`))
  .concat(['apps/bench-runner/src/runs/longmemeval-semantic/message-visibility.ts', 'apps/bench-runner/dist/runs/longmemeval-semantic/message-visibility.js',
    'apps/bench-runner/src/__tests__/support/field-delivery-proof.mjs', 'apps/bench-runner/src/__tests__/support/field-delivery-proof-bootstrap.mjs'])
  .map(path => ({ path, sha256: hash(readFileSync(join(tree, path))) }));
const size = path => readdirSync(path, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? size(join(path, e.name)) : statSync(join(path, e.name)).size), 0);
let peak = 0, result;
const run = (args, env = {}, code = 0) => {
  let outcome;
  try { outcome = { stdout: execFileSync(process.execPath, ['--import', preload, cli, ...args],
    { encoding: 'utf8', timeout: 90_000, env: { ...process.env, ...env }, maxBuffer: 8 * 1024 ** 2 }), status: 0 }; }
  catch (error) { outcome = error; }
  invocations.push({ args, env, status: outcome.status, stdout: outcome.stdout, stderr: outcome.stderr?.toString() });
  assert.equal(outcome.status, code, outcome.stderr?.toString());
  peak = Math.max(peak, size(root)); assert.ok(peak < 256 * 1024 ** 2);
  return JSON.parse(outcome.stdout);
};
try {
  const { inspectSourceRecordsArtifact } = await import(pathToFileURL(join(tree, 'apps/bench-runner/dist/runs/snapshot/source-records/contract.js')).href);
  const { StorageDatabase, SqliteFieldSourceRecordRepo, SqliteSourceIndexRepository } = await import('@do-soul/alaya-storage');
  const { fieldContractSha256 } = await import('@do-soul/alaya-core');
  const { sourceIndexTarget, prepareSourceIndexDocument } = await import('@do-soul/alaya-protocol');
  const { default: Database } = await import('better-sqlite3');
  const texts = ['needle '.repeat(16) + 'red '.repeat(16), 'needle '.repeat(15) + 'blue '.repeat(16),
    'needle red blue neutral bundle.', ...Array.from({ length: 8 }, (_, i) => i === 0 ? 'needle neutral neutral' : `needle neutral note ${i}.`),
    '前🙂'.repeat(1000) + 'needle red blue nonprefix witness 京都。' + '終🙂'.repeat(2)];
  // Fixed ordinal 2 is the evaluator's complete-message target; no label file exists yet.
  const home = join(root, 'fixture'); mkdirSync(home);
  const fixture = [{ question_id: 'authored', question_type: 'fixture', question: 'needle', answer: '',
    question_date: '2026-09-22T00:00:00.000Z', haystack_session_ids: ['authored-session'], haystack_dates: ['2021/02/03'],
    haystack_sessions: [texts.map(content => ({ role: 'user', content }))], answer_session_ids: [] }];
  const encoded = JSON.stringify(fixture); writeFileSync(join(home, 'longmemeval_s.json'), encoded);
  write(join(home, 'longmemeval_s.meta.json'), { sha256: hash(encoded), size_bytes: Buffer.byteLength(encoded), question_count: 1 });
  const preparation = { snapshotPath: join(home, 'prepared.sqlite'), dataDirRoot: join(home, 'import'), dataDir: home,
    pinnedMetaRoot: home, offset: 0, limit: 1, recordedAt: '2026-10-01T12:34:56.000Z',
    producerCommit: '175855c3a7c36dd0264a1070da419002a4cffcb7', importEffects: { configDirectoryRoot: home,
      sqliteWriteQueue: 'disabled', embeddingStartupProbe: 'omit', gardenCompute: 'disabled' } };
  write(join(home, 'prepare.json'), preparation);
  const prepareArgs = [fileURLToPath(new URL('./session-observation-proof.mjs', import.meta.url)), 'prepare', join(home, 'prepare.json')];
  const prepared = execFileSync(process.execPath, prepareArgs, { env: process.env, encoding: 'utf8', timeout: 120_000 });
  invocations.push({ args: prepareArgs, status: 0, stdout: prepared });
  const messages = [], artifact = inspectSourceRecordsArtifact(preparation.snapshotPath, m => messages.push(m));
  const snapshot = { snapshot_path: join(root, 'source.sqlite'), workspace_id: messages[0].record.workspace_id };
  copyFileSync(preparation.snapshotPath, snapshot.snapshot_path);
  const connection = new Database(snapshot.snapshot_path), database = new StorageDatabase(snapshot.snapshot_path, connection);
  const repository = new SqliteSourceIndexRepository(database, fieldContractSha256);
  const records = new SqliteFieldSourceRecordRepo(database, fieldContractSha256).listByWorkspace(snapshot.workspace_id);
  const members = texts.map((text, i) => records.find(r => r.record_id === messages.find(m => m.message_index === i).record.identity));
  const configuration = { revision: 'authored-delivery-v1', profile: { provider_kind: 'authored-numerical-fixture', model_id: 'no-model', model_revision: 'v1',
    artifact_digest: `sha256:${'a'.repeat(64)}`, tokenizer_revision: 'no-tokenizer', dimensions: 3, preprocessing: 'exact-utf8', normalization: 'none',
    max_input_tokens: 1024, windowing: 'utf8-byte-windows.v1', window_bytes: 1024 } };
  let expected;
  const budget = { work: 1_000_000, native_bytes: 2 * 1024 ** 2 };
  try {
    for (const record of records) {
      const target = sourceIndexTarget({ kind: 'source_evidence', workspace_id: record.workspace_id, root_kind: 'source_record', root_id: record.record_id,
        source_version: record.source_version, content_digest: record.content_digest, evidence_object_id: record.evidence_object_id }, record.source_id, Buffer.byteLength(record.source_body));
      assert.equal(repository.writeLexical(target, record.source_body, budget).status, 'accepted');
    }
    const generation = repository.begin(repository.select(snapshot.workspace_id, configuration));
    repository.capturePage(snapshot.workspace_id, generation.generation_id, 128, budget);
    for (const source of repository.listTargets(snapshot.workspace_id, generation.generation_id, null, 128)) {
      const read = repository.readDocument(snapshot.workspace_id, generation.generation_id, source.root_key, 128 * 1024, budget);
      assert.equal(read.status, 'ready');
      const document = prepareSourceIndexDocument({ source, body: read.body, profile: configuration.profile }, fieldContractSha256);
      assert.equal(repository.writeDocument(snapshot.workspace_id, generation.generation_id, document, budget).status, 'accepted');
      for (const window of document.windows) {
        // Hand-authored numerical fixture, independent of labels. Later native windows
        // outrank earlier windows; the index owner supplies exact offsets and digests.
        const vector = new Float32Array([window.ordinal + 1, 1, 0]);
        assert.equal(repository.writeVector(snapshot.workspace_id, generation.generation_id, { window_id: window.window_id,
          input_digest: window.content_digest, embedding: vector, token_count: 1, truncated: false }).status, 'accepted');
      }
    }
    assert.equal(repository.activate(snapshot.workspace_id, generation.generation_id).status, 'accepted');
    const state = repository.state(snapshot.workspace_id), g = repository.generation(snapshot.workspace_id, generation.generation_id);
    expected = { configuration, config_id: state.selection.config_id, profile_id: state.selection.profile_id, selection_revision: state.selection.selection_revision,
      generation_id: g.generation_id, source_epoch: g.source_epoch, status: g.status, enumeration_complete: g.enumeration_complete,
      target_count: g.target_count, completed_count: g.completed_count };
  } finally { database.close({ optimize: false }); }
  const condition = id => ({ id, query: id, object: 'bundle', hypothesis: 'authored', status: 'ready', residual: null, provenance: 'authored-before-labels' });
  const baseline = { contract: 'benchmark-conditional-navigation.v1', source_revision: 'authored-provider-free-field-delivery', channels: 'lexical', cache_root: root,
    rows: [{ ordinal: 1, question_id: 'authored', snapshot: snapshot.snapshot_path, snapshot_sha256: hash(readFileSync(snapshot.snapshot_path)),
      workspace: snapshot.workspace_id, interpretation_clock: '2026-09-22T00:00:00.000Z', authorized_scopes: ['project'], expected_index: expected,
      original: 'needle', conditions: ['needle', 'red', 'blue'].map(condition), branches: [['red'], ['blue']] }] };
  const policy = { contract: 'benchmark-field-delivery.v1', selection: 'field-order', windows: 'prefix', byte_budget: 64 };
  const variant = changes => { const c = structuredClone(baseline); c.rows[0].delivery_policy = { ...policy, ...changes }; return c; };
  const variants = { legacy: baseline, control: variant({}), selected: variant({ selection: 'condition-cover' }),
    zero: variant({ selection: 'condition-cover', byte_budget: 0 }), missing: variant({ windows: 'native-anchor' }),
    anchored: variant({ windows: 'native-anchor', byte_budget: 8192 }), anchorControl: variant({ byte_budget: 8192 }),
    combined: variant({ selection: 'condition-cover', windows: 'native-anchor', byte_budget: 8192 }),
    partial: variant({ windows: 'native-anchor', byte_budget: 8192 }),
    unchanged: variant({ byte_budget: 40960 }), noOp: variant({ selection: 'condition-cover' }),
    noOpControl: variant({}), regressionControl: variant({ byte_budget: 22 }),
    regressionSelected: variant({ selection: 'condition-cover', byte_budget: 22 }) };
  for (const name of ['anchored', 'anchorControl', 'combined', 'partial']) variants[name].channels = 'dual';
  for (const name of ['noOp', 'noOpControl']) {
    variants[name].rows[0].conditions = [condition('needle')]; variants[name].rows[0].branches = [];
  }
  for (const name of ['regressionControl', 'regressionSelected']) {
    variants[name].rows[0].original = 'neutral'; variants[name].rows[0].conditions = ['neutral', 'red', 'blue'].map(condition);
    variants[name].rows[0].branches = [['red', 'blue']];
  }
  // The same candidate/acquisition/read envelope and byte budget in every composed arm.
  const composed = (mode, windows = 'native-anchor') => {
    const value = variant({ windows, byte_budget: 8192 }); value.channels = 'dual';
    value.rows[0].conditions = [condition('needle')]; value.rows[0].branches = [];
    Object.assign(value.rows[0], { source_records: { snapshot: preparation.snapshotPath, manifest_sha256: artifact.manifest.manifest_sha256 },
      observation_domain: 'admitted_nomination_union', structural_navigation: { contract: 'benchmark-read-session-adjacency.v1', mode, max_source_reads: 522 } });
    return value;
  };
  Object.assign(variants, { composedOff: composed('off'), composedAdjacent: composed('adjacent'), composedAnd: composed('original_and_adjacent'),
    composedPrefix: composed('adjacent', 'prefix'), composedExhausted: composed('adjacent'), composedPartial: composed('adjacent'),
    composedUnbound: composed('adjacent'), composedUnboundMissing: composed('adjacent'), composedAbsent: composed('adjacent'), composedUnknown: composed('adjacent') });
  variants.composedExhausted.rows[0].structural_navigation.max_source_reads = 12;
  variants.composedPartial.rows[0].structural_navigation.max_source_reads = 13;
  for (const name of ['composedUnbound', 'composedUnboundMissing']) delete variants[name].rows[0].source_records;
  variants.composedUnboundMissing.channels = 'lexical';
  for (const name of ['composedAbsent', 'composedUnknown']) {
    variants[name].channels = 'lexical'; variants[name].rows[0].conditions = ['needle', 'red', 'blue'].map(condition);
    variants[name].rows[0].branches = [['red'], ['blue']];
    variants[name].rows[0].conditions[0].query = 'unmatchablequartzsentinel';
  }
  const progress = structuredClone(variants.selected);
  progress.rows.push({ ...structuredClone(progress.rows[0]), ordinal: 2, question_id: 'authored-second' });
  write(join(root, 'progress.json'), progress);
  for (const [name, config] of Object.entries(variants)) write(join(root, `${name}.json`), config);
  for (const [name] of Object.entries(variants)) {
    const out = join(root, name), receipt = run(['--config', join(root, `${name}.json`), '--out', out],
      name === 'partial' ? { ALAYA_AUTHORED_DELIVERY_FAULT: 'partial-location' } : name.startsWith('composed')
        ? { ALAYA_AUTHORED_DELIVERY_FAULT: name === 'composedUnknown' ? 'composed-unknown' : 'composed-meter',
          ALAYA_AUTHORED_DELIVERY_TRACE: join(root, `${name}-trace.json`) } : {});
    const capture = json(join(out, '001.json'));
    assert.equal(receipt.external_calls, 0); assert.equal(receipt.local_inference_inputs, 0);
    captures.push({ name, receipt, capture, frozen: { input: json(join(out, 'input.json')), formations: json(join(out, 'formations.json')) } });
  }
  const get = name => captures.find(c => c.name === name);
  for (const name of ['control', 'selected', 'zero', 'missing']) {
    assert.deepEqual(get(name).capture.pool, get('legacy').capture.pool);
    assert.deepEqual(get(name).capture.occurrences, get('legacy').capture.occurrences);
    assert.deepEqual(get(name).receipt.read_allowance_per_question_arm, get('legacy').receipt.read_allowance_per_question_arm);
  }
  assert.deepEqual(get('unchanged').capture.windows, get('legacy').capture.windows);
  assert.deepEqual(get('noOp').capture.windows, get('noOpControl').capture.windows);
  assert.equal(get('noOp').capture.field_delivery.selection.status, 'no_op');
  assert.deepEqual(get('combined').capture.windows, get('anchored').capture.windows);
  assert.equal(get('combined').capture.field_delivery.selection.status, 'no_op');
  assert.equal(get('regressionControl').capture.windows[0].target.root_id, members[3].record_id);
  assert.equal(get('regressionSelected').capture.windows[0].target.root_id, members[2].record_id);
  assert.deepEqual(get('regressionControl').capture.pool, get('regressionSelected').capture.pool);
  assert.deepEqual(get('regressionControl').capture.occurrences, get('regressionSelected').capture.occurrences);
  assert.equal(get('selected').capture.windows[0].target.root_id, members[2].record_id);
  assert.notEqual(get('control').capture.windows[0].target.root_id, members[2].record_id);
  assert.equal(get('zero').capture.windows.length, 0);
  assert.equal(get('missing').receipt.rows[0].status, 'delivery_unavailable');
  assert.equal(get('missing').capture.windows.length, 0);
  assert.equal(get('partial').receipt.rows[0].status, 'delivery_unavailable');
  assert.equal(get('partial').capture.windows.length, 9);
  assert.equal(get('partial').capture.field_delivery.missing_locations.length, 1);
  assert.equal(get('partial').receipt.delivery_reads[0].anchor_accounting.completed, 9);
  assert.deepEqual(get('anchored').capture.occurrences, get('anchorControl').capture.occurrences);
  const longWindow = get('anchored').capture.windows.find(w => w.target.root_id === members[11].record_id);
  assert.ok(longWindow.start > 4096);
  assert.equal(longWindow.text, Buffer.from(texts[11]).subarray(longWindow.start, longWindow.end).toString('utf8'));
  assert.ok(!longWindow.text.includes('�'));
  assert.ok(longWindow.text.includes('nonprefix witness 京都。'));
  for (const name of ['control', 'selected', 'zero', 'anchorControl', 'anchored']) {
    const c = get(name).capture;
    assert.equal(c.field_delivery.packing.unique_utf8_bytes, c.windows.reduce((n, w) => n + Buffer.byteLength(w.text), 0));
  }
  const off = get('composedOff'), adjacent = get('composedAdjacent');
  for (const name of ['composedAdjacent', 'composedAnd', 'composedPrefix', 'composedExhausted', 'composedPartial', 'composedUnbound']) {
    const c = get(name);
    assert.deepEqual(c.capture.pool, off.capture.pool); assert.deepEqual(c.capture.captures, off.capture.captures);
    assert.deepEqual(c.receipt.structural_reads[0].ledger.allowance, name === 'composedExhausted' || name === 'composedPartial'
      ? { ...off.receipt.structural_reads[0].ledger.allowance, source_reads: name === 'composedExhausted' ? 12 : 13 }
      : off.receipt.structural_reads[0].ledger.allowance);
    assert.equal(c.capture.field_delivery.policy.byte_budget, 8192);
  }
  assert.deepEqual(get('composedAnd').capture.solved.rows, off.capture.solved.rows);
  assert.deepEqual(get('composedAnd').capture.windows, off.capture.windows);
  assert.equal(off.capture.structural.observation.seed, null);
  const seed = adjacent.capture.structural.observation.seed.record_id;
  assert.equal(seed, adjacent.capture.solved.original_nominee.record_id);
  assert.ok(adjacent.capture.structural.observation.edges.length > 0);
  assert.ok(adjacent.capture.structural.observation.edges.length <= 2);
  for (const c of captures.filter(c => c.name.startsWith('composed'))) {
    const ledger = c.receipt.structural_reads[0].ledger, totals = c.receipt.structural_reads[0].totals;
    const trace = json(join(root, `${c.name}-trace.json`)); c.native_trace = trace;
    const prefix = trace.filter(r => r.located === 0), located = trace.filter(r => r.located > 0);
    assert.equal(ledger.accounting.source_reads, prefix.length);
    assert.equal(ledger.accounting.native_bytes, prefix.reduce((n, r) => n + r.native_bytes, 0));
    assert.equal(ledger.accounting.metadata_bytes, prefix.reduce((n, r) => n + r.metadata_bytes, 0));
    assert.equal(ledger.located_accounting.native_bytes_including_metadata, located.reduce((n, r) => n + r.native_bytes + r.metadata_bytes, 0));
    assert.equal(ledger.located_accounting.native_work, located.reduce((n, r) => n + 5 + r.dependency_work, 0));
    assert.equal(totals.native_bytes_including_metadata, trace.reduce((n, r) => n + r.native_bytes + r.metadata_bytes, 0));
    assert.equal(totals.physical_reads, null);
    assert.equal(totals.logical_requests, ledger.reserved.logical_requests);
    assert.ok(ledger.reserved.requested_bytes <= ledger.allowance.requested_prefix_bytes);
    for (const w of c.capture.windows) {
      const i = members.findIndex(r => r.record_id === w.target.root_id);
      assert.equal(w.text, Buffer.from(texts[i]).subarray(w.start, w.end).toString('utf8'));
      if (c.name !== 'composedPrefix') assert.ok(c.capture.captures.some(q => q.witness.some(hit => hit.source.target.root_id === w.target.root_id
        && hit.route.kind === 'vector' && hit.route.window?.status === 'available'
        && hit.route.window.window.start_byte === w.start && hit.route.window.window.end_byte >= w.end)));
    }
  }
  const adjacentLedger = adjacent.receipt.structural_reads[0].ledger;
  assert.equal(adjacentLedger.accounting.source_reads, 12);
  assert.equal(adjacentLedger.located_accounting.attempts, 10);
  assert.equal(adjacentLedger.reused_delivery_reads, 0);
  assert.equal(get('composedPrefix').receipt.structural_reads[0].ledger.reused_delivery_reads, 1);
  assert.ok(adjacent.capture.windows.find(w => w.target.root_id === members[11].record_id).start > 4096);
  for (const [name, attempts] of [['composedExhausted', 0], ['composedPartial', 1]]) {
    const c = get(name); assert.equal(c.receipt.rows[0].status, 'delivery_unavailable');
    assert.equal(c.receipt.structural_reads[0].ledger.located_accounting.attempts, attempts);
    assert.equal(c.capture.windows.length, attempts);
    assert.ok(c.capture.field_delivery.missing_locations.every(r => r.reason === 'shared_read_allowance_exhausted'));
  }
  for (const name of ['composedAbsent', 'composedUnknown']) {
    assert.equal(get(name).capture.structural.observation.seed, null);
    assert.equal(get(name).capture.structural.nomination.status, name === 'composedAbsent' ? 'measured_empty' : 'unknown');
    assert.ok(get(name).capture.pool.length > 0);
  }
  assert.equal(get('composedUnbound').capture.structural.observation.status, 'unknown');
  assert.equal(get('composedUnbound').receipt.rows[0].status, 'structure_unknown');
  // Failure runs occur before labels, after real SQLite reads. No retries of a failed arm.
  for (const fault of ['composed-throw', 'composed-null', 'composed-limited', 'composed-stale', 'composed-capture']) {
    const tracePath = join(root, `${fault}-trace.json`), out = join(root, `failure-composedAdjacent-${fault}`);
    const receipt = run(['--config', join(root, 'composedAdjacent.json'), '--out', out],
      { ALAYA_AUTHORED_DELIVERY_FAULT: fault, ALAYA_AUTHORED_DELIVERY_TRACE: tracePath }, 2);
    const trace = json(tracePath), ledger = receipt.structural_reads[0].ledger, meter = ledger.located_accounting;
    const known = trace.filter(r => r.located > 0 && !(['composed-null', 'composed-throw'].includes(fault) && r === trace.at(-1)));
    assert.equal(meter.native_bytes_including_metadata, known.reduce((n, r) => n + r.native_bytes + r.metadata_bytes, 0));
    // Null hides the returned meters, but the native owner still charges its
    // fixed five-work lookup cost; a throw occurs before that debit.
    assert.equal(meter.native_work, known.reduce((n, r) => n + 5 + r.dependency_work, 0) + (fault === 'composed-null' ? 5 : 0));
    assert.ok(meter.native_bytes_including_metadata > 0);
    assert.equal(meter.completed, fault === 'composed-capture' ? 10 : 1);
    assert.equal(meter.status, fault === 'composed-capture' ? 'complete' : 'partial');
    assert.deepEqual(meter, receipt.delivery_reads[0].anchor_accounting);
    assert.equal(ledger.accounting.source_reads, 12);
    assert.equal(receipt.delivery_reads[0].capture_status, 'failed');
    failures.push({ arm: 'composedAdjacent', fault, receipt, native_trace: trace,
      observations: json(join(out, '001-observations.json')),
      frozen: { input: json(join(out, 'input.json')), formations: json(join(out, 'formations.json')) } });
  }
  for (const arm of ['legacy', 'selected', 'anchored']) for (const fault of arm === 'anchored'
    ? ['throw', 'null', 'capture'] : ['throw', 'null', 'scope', 'content', 'capture']) {
    const trace = join(root, `${arm}-${fault}-trace.json`), out = join(root, `failure-${arm}-${fault}`);
    const receipt = run(['--config', join(root, `${arm}.json`), '--out', out],
      { ALAYA_AUTHORED_DELIVERY_FAULT: fault, ALAYA_AUTHORED_DELIVERY_TRACE: trace }, 2);
    const meter = receipt.delivery_reads[0];
    assert.equal(meter.ordinal, 1); assert.equal(meter.arm, 'supplied');
    assert.equal((meter.anchor_accounting ?? meter.accounting).status, ['throw', 'null'].includes(fault) ? 'partial' : 'complete');
    if (fault !== 'capture') assert.ok(json(trace).native_bytes > 0);
    if (fault === 'capture') { assert.equal(meter.capture_status, 'failed');
      assert.ok((meter.anchor_accounting?.native_bytes_including_metadata ?? meter.accounting.native_bytes) > 0); }
    failures.push({ arm, fault, receipt, native_trace: fault === 'capture' ? null : json(trace),
      observations: json(join(out, '001-observations.json')),
      frozen: { input: json(join(out, 'input.json')), formations: json(join(out, 'formations.json')) } });
  }
  const progressReceipt = run(['--config', join(root, 'progress.json'), '--out', join(root, 'failure-progress-capture-second')],
    { ALAYA_AUTHORED_DELIVERY_FAULT: 'capture-second' }, 2);
  assert.equal(progressReceipt.rows.length, 1);
  assert.deepEqual(progressReceipt.delivery_reads.map(d => [d.ordinal, d.capture_status]), [[1, 'published'], [2, 'failed']]);
  failures.push({ arm: 'progress', fault: 'capture-second', receipt: progressReceipt,
    retained_capture: json(join(root, 'failure-progress-capture-second/001.json')), native_trace: null,
    observations: json(join(root, 'failure-progress-capture-second/002-observations.json')),
    frozen: { input: json(join(root, 'failure-progress-capture-second/input.json')),
      formations: json(join(root, 'failure-progress-capture-second/formations.json')) } });
  const comparisonCases = [
    { name: 'paired-ready', fault: null, original: true, mechanical: true },
    { name: 'original-unavailable', fault: 'original-location', original: false, mechanical: true },
    { name: 'compared-unavailable', fault: 'compared-location', original: true, mechanical: false },
    { name: 'both-unavailable', fault: 'partial-location', original: false, mechanical: false },
    { name: 'partially-available-original', fault: 'original-location', original: false, mechanical: true, rows: 2 }
  ];
  for (const test of comparisonCases) {
    const config = structuredClone(variants.anchored);
    config.comparison = { model: [] };
    config.rows[0].conditions = [{ ...condition('needle'), query: 'needle\nred' }];
    config.rows[0].branches = [];
    if (test.rows === 2) config.rows.push({ ...structuredClone(config.rows[0]), ordinal: 2, question_id: 'paired-second' });
    write(join(root, `${test.name}.json`), config);
    const out = join(root, test.name), receipt = run(['--config', join(root, `${test.name}.json`), '--out', out],
      test.fault ? { ALAYA_AUTHORED_DELIVERY_FAULT: test.fault } : {});
    assert.equal(receipt.external_calls, 0); assert.equal(receipt.local_inference_inputs, 0);
    assert.deepEqual(receipt.rows.map(r => r.status), [test.original ? 'complete' : 'delivery_unavailable',
      test.mechanical ? 'complete' : 'delivery_unavailable', 'formation_unavailable',
      ...(test.rows === 2 ? ['complete', 'complete', 'formation_unavailable'] : [])]);
    comparisons.push({ ...test, receipt, captures: receipt.rows.filter(r => r.path).map(r => json(join(out, r.path))),
      frozen: { input: json(join(out, 'input.json')), formations: json(join(out, 'formations.json')) } });
  }
  // ALL captures now frozen. Only now construct evaluator-only full-message labels.
  const r = members[2], target = { workspace_id: r.workspace_id, root_kind: 'source_record', root_id: r.record_id,
    source_version: r.source_version, content_digest: r.content_digest };
  write(join(root, 'labels.json'), { rows: [{ arm: 'C', visibility: { gold_messages: { annotated: 1, complete: true },
    messages: [{ session_index: 0, message_index: 2, source_id: r.source_id, target, start: 0, end: Buffer.byteLength(texts[2]) }] } }] });
  write(join(root, 'label-manifest.json'), [1, 2].map(ordinal => ({ ordinal, path: join(root, 'labels.json') })));
  const regression = structuredClone(json(join(root, 'labels.json'))), rr = members[3];
  regression.rows[0].visibility.messages[0] = { session_index: 0, message_index: 3, source_id: rr.source_id,
    target: { workspace_id: rr.workspace_id, root_kind: 'source_record', root_id: rr.record_id,
      source_version: rr.source_version, content_digest: rr.content_digest }, start: 0, end: 22 };
  write(join(root, 'regression-labels.json'), regression);
  write(join(root, 'regression-manifest.json'), [{ ordinal: 1, path: join(root, 'regression-labels.json') }]);
  for (const capture of captures) {
    const out = join(root, `${capture.name}-evaluation.json`);
    const labels = capture.name.startsWith('regression') ? 'regression-manifest.json' : 'label-manifest.json';
    run(['--evaluate', join(root, capture.name), '--labels', join(root, labels), '--out', out]);
    capture.evaluation = json(out);
  }
  for (const failure of failures) {
    const name = `failure-${failure.arm}-${failure.fault}`, out = join(root, `${name}-evaluation.json`);
    run(['--evaluate', join(root, name), '--labels', join(root, 'label-manifest.json'), '--out', out]);
    failure.evaluation = json(out);
    if (failure.arm === 'progress') {
      assert.notEqual(failure.evaluation.rows[0].visibility, null);
      assert.equal(failure.evaluation.rows[1].visibility, null);
      assert.equal(failure.evaluation.summary[0].denominator, 2);
    } else {
      assert.equal(failure.evaluation.rows[0].visibility, null);
      assert.equal(failure.evaluation.summary[0].denominator, 1);
    }
  }
  for (const test of comparisons) {
    const out = join(root, `${test.name}-evaluation.json`);
    run(['--evaluate', join(root, test.name), '--labels', join(root, 'label-manifest.json'), '--out', out]);
    test.evaluation = json(out);
    for (const summary of test.evaluation.summary) {
      const available = test[summary.arm] === true;
      assert.equal(summary.denominator, test.rows ?? 1);
      assert.equal(summary.status, available ? 'scored' : 'unavailable');
      assert.equal(summary.metrics !== null, available);
      assert.equal(summary.paired !== null, summary.arm === 'mechanical' && test.original && test.mechanical);
      const rows = test.evaluation.rows.filter(r => r.arm === summary.arm);
      assert.equal(rows[0].visibility !== null, available);
      assert.equal(rows[0].byte_visibility !== null, available);
      if (test.rows === 2) assert.equal(rows[1].visibility !== null, summary.arm !== 'model');
      if (available) for (const [metric, counts] of Object.entries(summary.metrics)) {
        const control = comparisons[0].evaluation.summary.find(s => s.arm === summary.arm).metrics[metric];
        assert.deepEqual(counts, Object.fromEntries(Object.entries(control).map(([key, count]) => [key, count * (test.rows ?? 1)])));
        assert.equal(Object.values(counts).reduce((n, count) => n + count, 0), test.rows ?? 1);
      }
    }
  }
  const partialGold = structuredClone(json(join(root, 'labels.json')));
  partialGold.rows[0].visibility.gold_messages = { annotated: 2, complete: false };
  write(join(root, 'partial-gold.json'), partialGold);
  write(join(root, 'partial-gold-manifest.json'), [{ ordinal: 1, path: join(root, 'partial-gold.json') }]);
  run(['--evaluate', join(root, 'paired-ready'), '--labels', join(root, 'partial-gold-manifest.json'), '--out', join(root, 'partial-gold-evaluation.json')]);
  const unknownPair = json(join(root, 'partial-gold-evaluation.json'));
  assert.equal(unknownPair.summary[1].status, 'scored');
  assert.equal(unknownPair.summary[1].metrics.all_at_10.unknown, 1);
  assert.deepEqual(unknownPair.summary[1].paired.all_at_10, { gains: 0, losses: 0, unknown_pairs: 1 });
  const byteStatus = name => get(name).evaluation.rows[0].byte_visibility.any_at_budget.status;
  assert.equal(byteStatus('regressionControl'), 'hit'); assert.equal(byteStatus('regressionSelected'), 'miss');
  assert.equal(byteStatus('control'), 'miss'); assert.equal(byteStatus('selected'), 'hit'); assert.equal(byteStatus('zero'), 'miss');
  assert.equal(get('missing').evaluation.rows[0].visibility, null);
  assert.equal(get('missing').evaluation.summary[0].denominator, 1);
  assert.equal(get('partial').evaluation.rows[0].visibility, null);
  assert.equal(get('partial').evaluation.summary[0].denominator, 1);
  for (const name of ['composedExhausted', 'composedPartial', 'composedUnbound', 'composedUnboundMissing', 'composedAbsent', 'composedUnknown']) {
    assert.equal(get(name).evaluation.rows[0].visibility, null);
    assert.equal(get(name).evaluation.summary[0].denominator, 1);
    assert.equal(get(name).evaluation.summary[0].metrics, null);
  }
  for (const name of ['composedOff', 'composedAdjacent', 'composedAnd', 'composedPrefix']) {
    assert.notEqual(get(name).evaluation.rows[0].visibility, null);
    assert.equal(get(name).evaluation.summary[0].denominator, 1);
  }
  bindings.forEach(b => assert.equal(hash(readFileSync(join(tree, b.path))), b.sha256));
  assert.deepEqual(safe.violations, []); assert.deepEqual(strict.forbidden, []);
  result = { contract: 'authored-field-delivery-proof.v1', claim: 'mechanism only; authored numerical vector input, no inference or natural efficacy',
    bindings, snapshot_sha256: baseline.rows[0].snapshot_sha256, texts, members: members.map(r => ({ source_id: r.source_id, record_id: r.record_id })),
    captures, failures, comparisons, unknownPair, invocations, scratch_peak_bytes: peak,
    matched: { complementary_pair: { byte_budget: 64, gain: 1, loss: 0 },
      regression_pair: { byte_budget: 22, gain: 0, loss: 1 }, zero_budget_loss_against_selected: 1 }, forbidden_effects: [] };
  if (process.argv[2]) write(process.argv[2], result);
  process.stdout.write(JSON.stringify({ status: 'complete', captures: captures.length, failures: failures.length, comparisons: comparisons.length, scratch_peak_bytes: peak }) + '\n');
} finally { rmSync(root, { recursive: true, force: true }); strict.restore(); safe.restore(); }
