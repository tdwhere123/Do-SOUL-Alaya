// Execute once, standalone OR via the Vitest wrapper. Authored data only.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
const { installProviderFreeBoundary } = await import('./provider-free-boundary.ts');
const { installStrictProviderFreeBoundary } = await import('./strict-provider-free-boundary.ts');
const safe = installProviderFreeBoundary(), strict = installStrictProviderFreeBoundary();
const { frozenFixture, freezeFixture, removeLocations, hash, json, write } = await import('./frozen-nomination-fixture.mjs');
const tree = fileURLToPath(new URL('../../../../../', import.meta.url));
const cli = join(tree, 'apps/bench-runner/dist/runs/source-access-diagnostic/conditional-navigation-launch.js');
const preload = new URL('./frozen-nomination-proof-bootstrap.mjs', import.meta.url).href;
const root = mkdtempSync(join(tmpdir(), 'frozen-nominations-')), runs = [], invocations = [];
const bytes = path => readdirSync(path, { withFileTypes: true }).reduce((sum, e) => sum + (e.isDirectory() ? bytes(join(path, e.name)) : statSync(join(path, e.name)).size), 0);
const owners = ['conditional-navigation-launch', 'conditional-navigation-input', 'conditional-navigation-frozen', 'conditional-navigation-run',
  'conditional-navigation', 'conditional-navigation-evaluate', 'field-delivery', 'field-delivery-read', 'navigation-read-budget'];
const bindings = owners.flatMap(name => ['src', 'dist'].map(dir => `apps/bench-runner/${dir}/runs/source-access-diagnostic/${name}.${dir === 'src' ? 'ts' : 'js'}`))
  .concat(['frozen-nomination-fixture.mjs', 'frozen-nomination-proof.mjs', 'frozen-nomination-proof-bootstrap.mjs'].map(name => `apps/bench-runner/src/__tests__/support/${name}`))
  .map(path => ({ path, sha256: hash(readFileSync(join(tree, path))) }));
let peak = 0;
function invoke(args, name, expected = 0, fault) {
  const tracePath = join(root, `trace-${invocations.length}.json`);
  let result;
  try { result = { status: 0, stdout: execFileSync(process.execPath, ['--import', preload, cli, ...args], { encoding: 'utf8', timeout: 120_000,
    maxBuffer: 16 * 1024 ** 2, env: { ...process.env, ALAYA_AUTHORED_FROZEN_TRACE: tracePath, ...(fault ? { ALAYA_AUTHORED_FROZEN_FAULT: fault } : {}) } }) }; }
  catch (error) { result = error; }
  const boundary = json(tracePath); assert.deepEqual(boundary.forbidden, []);
  assert.equal(result.status, expected, `${name}: ${result.stderr?.toString()}`);
  invocations.push({ name, args, status: result.status, stderr: result.stderr?.toString(), boundary });
  peak = Math.max(peak, bytes(root)); assert.ok(peak < 2 * 1024 ** 3);
  return result.stdout?.trim() ? JSON.parse(result.stdout) : null;
}
function navigate(name, config, expected = 0, fault) {
  const configPath = join(root, `${name}.json`), out = join(root, name); write(configPath, config);
  const receipt = invoke(['--config', configPath, '--out', out], name, expected, fault);
  const captures = receipt?.rows.filter(ref => ref.path).map(ref => ({ ref, capture: json(join(out, ref.path)) })) ?? [];
  const run = { name, config, out, receipt, captures }; runs.push(run); return run;
}
try {
  const fixture = frozenFixture(join(root, 'native-fixture'));
  const ready = freezeFixture(join(root, 'origin-ready'), fixture);
  const missing = freezeFixture(join(root, 'origin-missing'), fixture, (_input, queries) => queries.slice(0, 5).forEach(q => removeLocations(q)));
  const allMissing = freezeFixture(join(root, 'origin-all-missing'), fixture, (_input, queries) => queries.forEach(q => removeLocations(q, true)));
  const unknown = freezeFixture(join(root, 'origin-unknown'), fixture, (input, queries) => {
    input.rows.forEach(row => { row.conditions[0].query = 'quartzunmatchablesentinel'; });
    queries.forEach((_, i) => { queries[i] = structuredClone(fixture.unknownQueries); });
  });
  const emptyFixture = frozenFixture(join(root, 'empty-native-fixture'), { emptyMembers: true });
  const validEmpty = freezeFixture(join(root, 'origin-empty'), emptyFixture);
  const wideFixture = frozenFixture(join(root, 'wide-native-fixture'), { windowBytes: 65536 });
  const wide = freezeFixture(join(root, 'origin-wide'), wideFixture);
  for (const [name, input] of Object.entries({ ready, missing, allMissing, unknown, validEmpty, wide })) navigate(name, input);
  const get = name => runs.find(run => run.name === name);
  const arm = (run, ordinal, name) => run.captures.find(c => c.ref.ordinal === ordinal && c.ref.arm === name).capture;
  for (const run of runs) {
    assert.equal(run.receipt.status, 'complete'); assert.equal(run.receipt.rows.length, 16);
    for (const key of ['local_query_inputs', 'local_inference_inputs', 'distinct_cached_queries', 'acquisitions', 'acquisition_cache_hits', 'external_calls', 'index_builds']) assert.equal(run.receipt[key], 0);
    assert.equal(run.receipt.frozen_nominations.origin.source_revision, 'authored-historical-origin');
    assert.equal(run.receipt.source_revision, 'authored-current-execution');
    assert.equal(run.receipt.frozen_nominations.inherited_costs.local_query_inputs, 8);
    for (let ordinal = 1; ordinal <= 8; ordinal++) {
      const prefix = arm(run, ordinal, 'window-prefix'), native = arm(run, ordinal, 'window-native-anchor');
      assert.deepEqual(prefix.captures, native.captures); assert.deepEqual(prefix.occurrences, native.occurrences);
      assert.deepEqual(prefix.pool, native.pool); assert.deepEqual(prefix.solved.rows, native.solved.rows);
      assert.deepEqual(prefix.field_delivery.selection.rows, native.field_delivery.selection.rows);
      assert.equal(prefix.field_delivery.policy.selection, 'field-order'); assert.equal(native.field_delivery.policy.selection, 'field-order');
      for (const c of [prefix, native]) {
        assert.equal(c.field_delivery.policy.byte_budget, 8192); assert.equal(c.field_delivery.packing.total_slots, 10);
        assert.equal(c.field_delivery.packing.unique_utf8_bytes, c.windows.reduce((n, w) => n + Buffer.byteLength(w.text), 0));
        assert.ok(c.windows.every(w => !w.text.includes('POISON_STORED_PREFIX')));
      }
    }
  }
  const baseline = get('ready');
  const trace = invocations.find(i => i.name === 'ready').boundary.trace;
  const prefixTrace = trace.filter(r => r.method === 'findByIdBounded' && r.requested_bytes === 4096);
  const anchorTrace = trace.filter(r => r.method === 'findCurrentBounded' && r.requested_bytes === 1 || r.method === 'findByIdBounded' && r.offset > 0);
  const prefixMeters = baseline.receipt.delivery_reads.filter(r => r.arm === 'window-prefix');
  const anchorMeters = baseline.receipt.delivery_reads.filter(r => r.arm === 'window-native-anchor');
  assert.equal(prefixMeters.reduce((n, r) => n + r.accounting.source_reads, 0), prefixTrace.length);
  assert.equal(prefixMeters.reduce((n, r) => n + r.accounting.native_bytes + r.accounting.metadata_bytes, 0), prefixTrace.reduce((n, r) => n + r.native_bytes + r.metadata_bytes, 0));
  assert.equal(anchorMeters.reduce((n, r) => n + r.anchor_accounting.native_bytes_including_metadata, 0), anchorTrace.reduce((n, r) => n + r.native_bytes + r.metadata_bytes, 0));
  assert.ok(anchorMeters.every(r => r.anchor_accounting.physical_reads === null && r.read_ledger.located_accounting.physical_reads === null));
  // Independent native lane interleave expectation, not a call to the field solver.
  const q = fixture.queries[0], byChannel = channel => q.witness.filter(w => w.route.kind === channel).sort((a, b) => a.route.native_rank - b.route.native_rank);
  const lexical = byChannel('lexical'), vector = byChannel('vector'), expectedIds = [];
  for (let i = 0; i < Math.max(lexical.length, vector.length); i++) for (const hit of [lexical[i], vector[i]]) {
    if (hit && !expectedIds.includes(hit.source.target.root_id)) expectedIds.push(hit.source.target.root_id);
  }
  assert.equal(expectedIds.length, 12);
  for (const name of ['window-prefix', 'window-native-anchor']) {
    const c = arm(baseline, 1, name);
    assert.deepEqual(c.field_delivery.selection.rows.map(r => r.record_id), expectedIds.slice(0, 10));
    for (const w of c.windows) {
      const i = fixture.members.findIndex(m => m.record_id === w.target.root_id);
      assert.equal(w.text, Buffer.from(fixture.texts[i]).subarray(w.start, w.end).toString('utf8'));
      assert.ok(!w.text.includes('�'));
    }
  }
  const native = arm(baseline, 1, 'window-native-anchor');
  assert.equal(native.windows.length, 10); assert.ok(native.windows.some(w => w.start > 4096 && w.text.includes('AUTHORED-NATIVE-END-') && w.text.includes('京都。')));
  const prefix = arm(baseline, 1, 'window-prefix');
  assert.equal(prefix.field_delivery.packing.unique_utf8_bytes, 8192); assert.ok(prefix.windows.every(w => w.start === 0));
  assert.equal(get('missing').receipt.rows.filter(r => r.status === 'delivery_unavailable').length, 5);
  assert.equal(get('allMissing').receipt.rows.filter(r => r.status === 'delivery_unavailable').length, 8);
  assert.equal(get('unknown').receipt.rows.filter(r => r.status === 'nomination_unknown').length, 16);
  assert.ok(get('validEmpty').captures.every(c => c.capture.frozen_nomination.status === 'measured_empty' && c.capture.windows.length === 0 && c.capture.tail.status === 'exhausted'));
  const exhausted = get('wide').receipt.delivery_reads.filter(r => r.arm === 'window-native-anchor');
  assert.ok(exhausted.every(r => r.read_ledger.reserved.logical_requests > 0 && r.read_ledger.reserved.logical_requests < 10));
  assert.ok(get('wide').captures.filter(r => r.ref.arm === 'window-native-anchor').every(c => c.capture.field_delivery.missing_locations.some(m => m.reason === 'shared_read_allowance_exhausted')));
  for (const fault of ['prefix-null', 'anchor-throw', 'publication']) {
    const run = navigate(`failed-${fault}`, ready, 2, fault);
    assert.equal(run.receipt.status, 'stopped');
    const affected = run.receipt.delivery_reads.at(-1);
    assert.equal(affected.capture_status, 'failed');
    assert.ok(affected.accounting.source_reads > 0 || affected.anchor_accounting?.attempts > 0);
    if (fault === 'prefix-null') { assert.equal(affected.accounting.status, 'partial'); assert.equal(affected.accounting.unmetered_reads, 1); assert.ok(affected.accounting.native_bytes > 0); }
    if (fault === 'anchor-throw') { assert.equal(affected.anchor_accounting.status, 'partial'); assert.ok(affected.anchor_accounting.native_bytes_including_metadata > 0); }
    if (fault === 'publication') { assert.equal(affected.status, 'complete'); assert.equal(affected.anchor_accounting.completed, 10); assert.equal(run.receipt.rows.length, 3); }
  }
  // Early artifact/config refusals: every process has model/preparation/acquisition
  // tripwires active even when admission fails before the output directory exists.
  const badReceipt = structuredClone(ready); badReceipt.frozen_nominations.receipt.sha256 = '0'.repeat(64);
  navigate('bad-receipt', badReceipt, 2);
  for (const [name, mutate] of [
    ['foreign-scope', c => { c.rows[0].authorized_scopes = []; }],
    ['foreign-profile', c => { c.rows[0].expected_index.configuration.profile.representation = { kind: 'paired-prefix.v1', query_prefix: 'query: ', passage_prefix: 'passage: ' }; }],
    ['foreign-input', c => { c.rows[0].conditions[0].query = 'foreign query'; }],
    ['dropped-membership', c => { c.rows.pop(); }],
    ['unsupported-structure', c => { c.rows[0].structural_navigation = { contract: 'benchmark-read-session-adjacency.v1', mode: 'off', max_source_reads: 522 }; }],
    ['unsupported-policy', c => { c.rows[0].delivery_policy = { contract: 'benchmark-field-delivery.v1', selection: 'condition-cover', windows: 'prefix', byte_budget: 8192 }; }],
    ['unsupported-model', c => { c.model_id = 'no-model'; }], ['unsupported-channels', c => { c.channels = 'lexical'; }],
    ['unsupported-formation', c => { c.comparison = { model: [] }; }]
  ]) { const input = structuredClone(ready); mutate(input); navigate(name, input, 2); }
  const rebound = (name, mutateInput, mutateCapture) => {
    const home = join(root, `origin-${name}`), input = freezeFixture(home, fixture, mutateInput);
    if (mutateCapture) {
      const capturePath = join(home, '001.json'), capture = json(capturePath); mutateCapture(capture); write(capturePath, capture);
      const receipt = json(join(home, 'receipt.json')); receipt.rows[0].sha256 = hash(readFileSync(capturePath)); write(join(home, 'receipt.json'), receipt);
      input.frozen_nominations.receipt.sha256 = hash(readFileSync(join(home, 'receipt.json')));
    }
    return input;
  };
  for (const [name, mutate] of [
    ['malformed-witness', c => { c.captures[0].witness[0].source.root_key = 'unchecked'; }],
    ['missing-status', c => { delete c.captures[0].phase.status; }],
    ['missing-identity', c => { delete c.question_id; }],
    ['prefix-only', c => { c.captures[0].witness = c.captures[0].phase.result.occurrence_prefix; }],
    ['solved-order', c => { c.solved.rows.reverse(); }],
    ['modern-arm', c => { c.arm = 'supplied'; }],
    ['foreign-source', c => {
      for (const w of c.captures[0].witness) w.source.source_id = 'foreign-source';
      c.captures[0].phase.result.occurrence_prefix = c.captures[0].witness.slice(0, 16);
    }]
  ]) navigate(name, rebound(name, undefined, mutate), 2);
  const { default: Database } = await import('better-sqlite3');
  const { StorageDatabase, SqliteFieldSourceRecordRepo } = await import('@do-soul/alaya-storage');
  const { hashSourceRecordId, hashContentDigest } = await import('@do-soul/alaya-protocol');
  const { fieldContractSha256 } = await import('@do-soul/alaya-core');
  for (const problem of ['changed-source', 'old-schema']) {
    const snapshot = join(root, `${problem}.sqlite`); copyFileSync(fixture.input.rows[0].snapshot, snapshot);
    const connection = new Database(snapshot), database = new StorageDatabase(snapshot, connection);
    try {
      if (problem === 'old-schema') connection.exec('DROP TABLE source_index_selections');
      else {
        const next = { ...fixture.members[0], source_version: 'authored-v2', source_body: 'changed authored source',
          content_digest: hashContentDigest('changed authored source', fieldContractSha256), recorded_at: '2026-09-23T00:00:00.000Z' };
        new SqliteFieldSourceRecordRepo(database, fieldContractSha256).insert({ ...next, record_id: hashSourceRecordId(next, fieldContractSha256) });
      }
    } finally { database.close({ optimize: false }); }
    const input = rebound(problem, input => input.rows.forEach(r => { r.snapshot = snapshot; r.snapshot_sha256 = hash(readFileSync(snapshot)); }));
    const stopped = navigate(problem, input, 2);
    assert.equal(stopped.receipt.local_inference_inputs, 0); assert.equal(stopped.receipt.acquisitions, 0);
    assert.equal(stopped.receipt.rows.length, 0);
    // Native source mutation can invalidate generation coverage before its per-root guard.
    assert.match(stopped.receipt.failure, problem === 'old-schema' ? /no such table/ : /prepared profile\/generation\/coverage mismatch|frozen source index admission/);
  }
  const denied = rebound('denied-scope', input => input.rows.forEach(r => { r.authorized_scopes = []; }));
  const scopeRun = navigate('denied-scope', denied, 2); assert.ok(scopeRun.receipt.frozen_admissions[0].scope_reads.native_bytes > 0);
  for (const kind of ['input', 'capture']) {
    const input = rebound(`drift-${kind}`), file = join(root, `origin-drift-${kind}`, kind === 'input' ? 'input.json' : '008.json');
    writeFileSync(file, readFileSync(file, 'utf8') + ' '); navigate(`drift-${kind}`, input, 2);
  }
  // All retrieval outputs are now frozen. Labels are authored only from the known
  // fixture identity; no retrieval or source opens occur after this boundary.
  const target = fixture.queries[0].witness[0].source.target;
  const { kind, evidence_object_id, ...goldTarget } = target;
  write(join(root, 'labels.json'), { rows: [{ arm: 'C', visibility: { gold_messages: { annotated: 2, complete: false },
    messages: [{ session_index: 0, message_index: 0, source_id: fixture.queries[0].witness[0].source.source_id, target: goldTarget, start: 0, end: 1 }] } }] });
  write(join(root, 'labels-manifest.json'), Array.from({ length: 8 }, (_, i) => ({ ordinal: i + 1, path: join(root, 'labels.json') })));
  for (const run of runs.filter(r => r.receipt)) {
    const output = join(root, `${run.name}-evaluation.json`);
    invoke(['--evaluate', run.out, '--labels', join(root, 'labels-manifest.json'), '--out', output], `evaluate-${run.name}`);
    run.evaluation = json(output);
    assert.equal(run.evaluation.rows.length, 16); assert.ok(run.evaluation.summary.every(s => s.denominator === 8));
  }
  for (const name of ['unknown', 'denied-scope', 'failed-prefix-null']) assert.ok(get(name).evaluation.summary.every(s => s.status === 'unavailable' && s.metrics === null && s.paired === null));
  for (const name of ['missing', 'allMissing']) {
    const summary = get(name).evaluation.summary; assert.equal(summary[0].status, 'scored'); assert.equal(summary[0].metrics.all_at_10.unknown, 8);
    assert.equal(summary[1].status, 'unavailable'); assert.equal(summary[1].metrics, null); assert.equal(summary[1].paired, null);
  }
  assert.equal(get('ready').evaluation.summary[1].status, 'scored');
  assert.equal(get('ready').evaluation.summary[1].metrics.all_at_10.unknown, 8);
  assert.deepEqual(get('ready').evaluation.summary[1].paired.all_at_10, { gains: 0, losses: 0, unknown_pairs: 8 });
  // Later-capture mutation must fail before even an absent label path is opened.
  const later = join(baseline.out, '008-window-native-anchor.json'); writeFileSync(later, readFileSync(later, 'utf8') + ' ');
  invoke(['--evaluate', baseline.out, '--labels', join(root, 'MUST-NOT-OPEN-LABELS'), '--out', join(root, 'rejected-evaluation.json')], 'later-capture-drift', 2);
  assert.ok(invocations.at(-1).stderr.includes('selected capture digest drift'));
  bindings.forEach(b => assert.equal(hash(readFileSync(join(tree, b.path))), b.sha256));
  assert.deepEqual(safe.violations, []); assert.deepEqual(strict.forbidden, []);
  const evidence = { contract: 'authored-frozen-nomination-entry-proof.v1', base_commit: '625611edf591f26c2148581c62aecb3ab487063b',
    claim: 'Authored frozen delivery mechanism only. No historical admission, natural run, inference or acquisition at the entry.', bindings,
    scratch_peak_bytes: peak, runs, invocations, forbidden_effects: [], temporary_databases: 'disposed in finally' };
  if (process.argv[2]) {
    const compressed = gzipSync(JSON.stringify(evidence)); assert.ok(compressed.length < 32 * 1024 ** 2);
    writeFileSync(process.argv[2], compressed, { flag: 'wx' });
  }
  process.stdout.write(JSON.stringify({ status: 'complete', runs: runs.length, invocations: invocations.length, scratch_peak_bytes: peak }) + '\n');
} finally { rmSync(root, { recursive: true, force: true }); strict.restore(); safe.restore(); }
