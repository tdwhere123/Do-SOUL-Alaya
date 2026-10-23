// Execute once through the Vitest wrapper OR standalone. Authored sources only.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync, copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
const { installProviderFreeBoundary } = await import('./provider-free-boundary.ts');
const { installStrictProviderFreeBoundary } = await import('./strict-provider-free-boundary.ts');
const safe = installProviderFreeBoundary(), strict = installStrictProviderFreeBoundary();
assert.notEqual(process.env.ALAYA_LOCAL_SOURCE_EMBEDDING_OFFLINE, '1');
const { frozenFixture, freezeFixture, hash, json, write } = await import('./frozen-nomination-fixture.mjs');
const tree = fileURLToPath(new URL('../../../../../', import.meta.url));
const cli = join(tree, 'apps/bench-runner/dist/runs/source-access-diagnostic/conditional-navigation-launch.js');
const preload = new URL('./frozen-nomination-proof-bootstrap.mjs', import.meta.url).href;
const root = mkdtempSync(join(tmpdir(), 'source-context-')), runs = [], invocations = [];
const bytes = path => readdirSync(path, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? bytes(join(path, e.name)) : statSync(join(path, e.name)).size), 0);
const owners = ['conditional-navigation-launch', 'conditional-navigation-input', 'conditional-navigation-frozen', 'conditional-navigation-run',
  'conditional-navigation', 'conditional-navigation-evaluate', 'field-delivery', 'field-delivery-read', 'navigation-read-budget'];
const bindings = owners.flatMap(name => ['src', 'dist'].map(dir => `apps/bench-runner/${dir}/runs/source-access-diagnostic/${name}.${dir === 'src' ? 'ts' : 'js'}`))
  .concat(['source-context-proof.mjs', 'frozen-nomination-fixture.mjs', 'frozen-nomination-proof-bootstrap.mjs'].map(name => `apps/bench-runner/src/__tests__/support/${name}`))
  .map(path => ({ path, sha256: hash(readFileSync(join(tree, path))) }));
let peak = 0;
function invoke(args, name, expected = 0, fault) {
  const tracePath = join(root, `trace-${invocations.length}.json`);
  let result;
  try { result = { status: 0, stdout: execFileSync(process.execPath, ['--import', preload, cli, ...args], { encoding: 'utf8', timeout: 120_000,
    maxBuffer: 8 * 1024 ** 2, env: { ...process.env, ALAYA_AUTHORED_FROZEN_TRACE: tracePath, ...(fault ? { ALAYA_AUTHORED_FROZEN_FAULT: fault } : {}) } }) }; }
  catch (error) { result = error; }
  const boundary = json(tracePath); assert.deepEqual(boundary.forbidden, []);
  assert.equal(result.status, expected, `${name}: ${result.stderr?.toString()}`);
  invocations.push({ name, args, status: result.status, stderr: result.stderr?.toString(), boundary });
  peak = Math.max(peak, bytes(root)); assert.ok(peak <= 2 * 1024 ** 3);
  return result.stdout?.trim() ? JSON.parse(result.stdout) : null;
}
function navigate(name, config, expected = 0, fault) {
  const path = join(root, `${name}.json`), out = join(root, name); write(path, config);
  const receipt = invoke(['--config', path, '--out', out], name, expected, fault);
  const captures = receipt?.rows.filter(ref => ref.path).map(ref => ({ ref, capture: json(join(out, ref.path)) })) ?? [];
  const run = { name, config, out, receipt, captures }; runs.push(run); return run;
}
try {
  // Meaningful user fact is deliberately outside the generic retrieved tail chunk.
  const short = 'needle user: I volunteered at the spring holiday dinner.\n' + 'assistant: needle generic acknowledgement. '.repeat(43);
  assert.ok(Buffer.byteLength(short) > 1024 && Buffer.byteLength(short) < 4096);
  const texts = [short, ...Array.from({ length: 11 }, (_, i) => `needle ${i + 1} ` + '前🙂'.repeat(1000) + ` authored tail ${i + 1} 京都。`)];
  const fixture = frozenFixture(join(root, 'native-fixture'), { texts });
  const lexicalId = fixture.queries[0].witness.filter(hit => hit.route.kind === 'lexical')[1].source.target.root_id;
  const lexicalIndex = fixture.members.findIndex(member => member.record_id === lexicalId);
  const lexicalOnly = (_input, perRow) => perRow.forEach(queries => {
    const query = queries[0], before = query.witness.length;
    query.witness = query.witness.filter(hit => hit.source.target.root_id !== lexicalId || hit.route.kind !== 'vector');
    const removed = before - query.witness.length, result = query.phase.result;
    // An authored bounded envelope, not a new runtime acquisition or absence claim.
    result.counts.retained_occurrences -= removed; result.counts.duplicate_occurrences -= removed; result.counts.nomination_limit += removed;
    result.occurrence_prefix = query.witness.slice(0, 16); result.prefix_coverage.omitted_occurrences = Math.max(0, query.witness.length - 16);
  });
  const ready = freezeFixture(join(root, 'origin-ready'), fixture, lexicalOnly);
  ready.frozen_nominations.comparison = 'source-context';
  // Check the authored fixture before any compiled entry, independently of the solver.
  const original = json(join(root, 'origin-ready', '001.json')).captures[0].witness;
  const lanes = ['lexical', 'vector'].map(kind => original.filter(hit => hit.route.kind === kind).sort((a, b) => a.route.native_rank - b.route.native_rank));
  const expectedIds = [];
  for (let i = 0; i < Math.max(...lanes.map(lane => lane.length)); i++) for (const lane of lanes) {
    const id = lane[i]?.source.target.root_id; if (id && !expectedIds.includes(id)) expectedIds.push(id);
  }
  assert.equal(expectedIds.length, 12); assert.equal(expectedIds[0], fixture.members[0].record_id);
  assert.ok(expectedIds.slice(0, 10).includes(lexicalId));
  const main = navigate('mixed', ready);
  const strictInput = structuredClone(ready); delete strictInput.frozen_nominations.comparison;
  const native = navigate('strict', strictInput);
  const unknown = freezeFixture(join(root, 'origin-unknown'), fixture, (input, queries) => {
    lexicalOnly(input, queries);
    queries.forEach(qs => { const hit = qs[0].witness.find(hit => hit.route.kind === 'vector' && hit.source.target.root_id !== fixture.members[0].record_id);
      hit.route.window = { status: 'unavailable', reason: 'authored_unknown_location' }; qs[0].phase.result.occurrence_prefix = qs[0].witness.slice(0, 16); });
  });
  unknown.frozen_nominations.comparison = 'source-context';
  navigate('unknown-location', unknown);
  const nominationUnknown = freezeFixture(join(root, 'origin-nomination-unknown'), fixture, (input, queries) => {
    input.rows.forEach(row => { row.conditions[0].query = 'quartzunmatchablesentinel'; });
    queries.forEach((_, i) => { queries[i] = structuredClone(fixture.unknownQueries); });
  });
  nominationUnknown.frozen_nominations.comparison = 'source-context'; navigate('nomination-unknown', nominationUnknown);
  const arm = (run, ordinal, name) => run.captures.find(c => c.ref.ordinal === ordinal && c.ref.arm === name).capture;
  const mixed = arm(main, 1, 'window-source-context'), prefix = arm(main, 1, 'window-prefix');
  assert.deepEqual(mixed.field_delivery.selection.rows.map(row => row.record_id), expectedIds.slice(0, 10));
  assert.equal(main.receipt.status, 'complete'); assert.equal(main.receipt.rows.length, 16);
  for (let ordinal = 1; ordinal <= 8; ordinal++) {
    const a = arm(main, ordinal, 'window-prefix'), b = arm(main, ordinal, 'window-source-context');
    assert.deepEqual(a.field_delivery.selection.rows, b.field_delivery.selection.rows); assert.deepEqual(a.solved.rows, b.solved.rows);
    assert.deepEqual(a.captures, b.captures); assert.equal(b.field_delivery.selection.rows.length, 10);
    assert.equal(b.field_delivery.policy.byte_budget, 8192); assert.equal(b.field_delivery.status, 'complete');
    assert.ok(b.windows.length <= 10 && b.field_delivery.packing.unique_utf8_bytes <= 8192);
    assert.equal(b.field_delivery.packing.unique_utf8_bytes, b.windows.reduce((n, w) => n + Buffer.byteLength(w.text), 0));
    for (const w of b.windows) {
      const i = fixture.members.findIndex(m => m.record_id === w.target.root_id);
      assert.equal(w.text, Buffer.from(texts[i]).subarray(w.start, w.end).toString('utf8')); assert.ok(!w.text.includes('�'));
    }
  }
  const whole = mixed.windows.find(w => w.target.root_id === fixture.members[0].record_id);
  assert.equal(whole.context_route, 'whole-source'); assert.equal(whole.text, short); assert.equal(whole.start, 0);
  const generic = fixture.queries[0].witness.find(hit => hit.source.target.root_id === fixture.members[0].record_id && hit.route.kind === 'vector');
  assert.ok(generic.route.window.window.start_byte >= 1024);
  assert.ok(!Buffer.from(short).subarray(generic.route.window.window.start_byte, generic.route.window.window.end_byte).toString('utf8').includes('spring holiday dinner'));
  assert.ok(mixed.windows.some(w => w.context_route === 'native-anchor' && w.start > 4096 && w.text.includes('authored tail')));
  const lexical = mixed.windows.find(w => w.target.root_id === lexicalId);
  assert.equal(lexical.context_route, 'lexical-prefix'); assert.equal(lexical.start, 0);
  const lexicalExpected = `needle ${lexicalIndex} ` + '前🙂'.repeat(583) + '前';
  assert.equal(Buffer.byteLength(lexicalExpected), lexicalIndex < 10 ? 4093 : 4094);
  assert.equal(lexical.text, lexicalExpected);
  assert.ok(mixed.field_delivery.packing.source_context_packing.some(p => p.status === 'partial' || p.status === 'omitted'));
  assert.equal(prefix.field_delivery.packing.unique_utf8_bytes, 8192);
  assert.ok(native.receipt.rows.filter(r => r.arm === 'window-native-anchor').every(r => r.status === 'delivery_unavailable'));
  assert.ok(native.captures.filter(r => r.ref.arm === 'window-native-anchor').every(r => r.capture.field_delivery.missing_locations.some(m => m.record_id === lexicalId)));
  const mixedTrace = invocations.find(i => i.name === 'mixed').boundary.trace;
  const current = mixedTrace.filter(t => t.method === 'findCurrentBounded' && t.requested_bytes === 4096);
  const accounts = main.receipt.delivery_reads.filter(r => r.arm === 'window-source-context');
  assert.equal(accounts.reduce((n, r) => n + r.accounting.source_reads, 0), current.length);
  assert.equal(accounts.reduce((n, r) => n + r.accounting.native_bytes + r.accounting.metadata_bytes, 0), current.reduce((n, t) => n + t.native_bytes + t.metadata_bytes, 0));
  assert.ok(accounts.every(r => r.anchor_accounting.attempts > 0 && r.anchor_accounting.physical_reads === null
    && r.read_ledger.reserved.logical_requests === 10 && r.read_ledger.reserved.requested_bytes <= 41472));
  for (const fault of ['context-null', 'context-throw', 'context-length', 'context-scope', 'context-digest', 'anchor-throw', 'context-publication']) {
    const run = navigate(`failed-${fault}`, ready, 2, fault), affected = run.receipt.delivery_reads.at(-1);
    assert.equal(run.receipt.status, 'stopped'); assert.equal(affected.arm, 'window-source-context'); assert.equal(affected.capture_status, 'failed');
    assert.ok(affected.accounting.source_reads > 0 || affected.anchor_accounting?.attempts > 0);
    const trace = invocations.at(-1).boundary.trace;
    // Prefix-control calls are separate. The context arm never attempts a legacy id-prefix fallback.
    assert.equal(trace.filter(t => t.method === 'findByIdBounded' && t.requested_bytes === 4096).length, 10);
    if (fault === 'context-null' || fault === 'context-throw') {
      assert.equal(affected.accounting.status, 'partial'); assert.equal(affected.accounting.unmetered_reads, 1);
      if (fault === 'context-throw') assert.ok(affected.accounting.native_bytes > 0);
    }
    if (fault === 'anchor-throw') { assert.equal(affected.anchor_accounting.status, 'partial'); assert.ok(affected.anchor_accounting.native_bytes_including_metadata > 0); }
    if (fault === 'context-publication') { assert.equal(affected.status, 'complete'); assert.equal(affected.read_ledger.reserved.logical_requests, 10); }
  }
  for (const problem of ['extent-mismatch', 'denied-scope', 'invalid-provenance']) {
    const input = freezeFixture(join(root, `origin-${problem}`), fixture, (input, queries) => {
      lexicalOnly(input, queries);
      if (problem === 'denied-scope') input.rows.forEach(r => { r.authorized_scopes = []; });
      if (problem === 'extent-mismatch') queries.forEach(q => {
        for (const hit of q[0].witness) if (hit.source.target.root_id === fixture.members[0].record_id) hit.source.body_bytes++;
        q[0].phase.result.occurrence_prefix = q[0].witness.slice(0, 16);
      });
    });
    input.frozen_nominations.comparison = 'source-context';
    if (problem === 'invalid-provenance') input.frozen_nominations.receipt.sha256 = '0'.repeat(64);
    const run = navigate(problem, input, 2);
    if (problem === 'invalid-provenance') assert.equal(run.receipt, null);
    else { assert.equal(run.receipt.rows.length, 0); assert.ok(run.receipt.frozen_admissions[0].index_guard.native_bytes > 0); }
  }
  const { default: Database } = await import('better-sqlite3');
  const stalePath = join(root, 'stale.sqlite'); copyFileSync(fixture.input.rows[0].snapshot, stalePath);
  const connection = new Database(stalePath);
  try { connection.prepare('UPDATE source_records SET retained_content_bytes = retained_content_bytes + 1 WHERE record_id = ?').run(fixture.members[0].record_id); }
  finally { connection.close(); }
  const stale = freezeFixture(join(root, 'origin-stale'), fixture, input => input.rows.forEach(row => {
    row.snapshot = stalePath; row.snapshot_sha256 = hash(readFileSync(stalePath));
  }));
  stale.frozen_nominations.comparison = 'source-context'; navigate('stale', stale, 2);
  for (const run of runs.filter(r => r.receipt)) {
    for (const key of ['local_query_inputs', 'local_inference_inputs', 'distinct_cached_queries', 'acquisitions', 'acquisition_cache_hits', 'external_calls', 'index_builds']) assert.equal(run.receipt[key], 0);
    assert.equal(hash(readFileSync(run.config.rows[0].snapshot)), run.config.rows[0].snapshot_sha256);
  }
  // Every delivery is now frozen; only the existing evaluator sees authored labels.
  const { kind, evidence_object_id, ...target } = fixture.queries[0].witness.find(w => w.source.target.root_id === fixture.members[0].record_id).source.target;
  write(join(root, 'labels.json'), { rows: [{ arm: 'C', visibility: { gold_messages: { annotated: 1, complete: true },
    messages: [{ session_index: 0, message_index: 0, source_id: fixture.members[0].source_id, target, start: 0, end: 55 }] } }] });
  write(join(root, 'labels-manifest.json'), Array.from({ length: 8 }, (_, i) => ({ ordinal: i + 1, path: join(root, 'labels.json') })));
  for (const run of runs.filter(r => r.receipt)) {
    const output = join(root, `${run.name}-evaluation.json`);
    invoke(['--evaluate', run.out, '--labels', join(root, 'labels-manifest.json'), '--out', output], `evaluate-${run.name}`);
    run.evaluation = json(output); assert.equal(run.evaluation.rows.length, 16); assert.ok(run.evaluation.summary.every(s => s.denominator === 8));
  }
  assert.ok(main.evaluation.rows.every(row => row.visibility.any_at_5.status === 'hit'
    && row.visibility.any_at_10.status === 'unknown' && row.visibility.all_at_10.status === 'unknown'
    && row.byte_visibility.all_at_budget.status === 'hit'));
  for (const name of ['unknown-location', 'strict']) {
    const evaluation = runs.find(r => r.name === name).evaluation;
    assert.equal(evaluation.summary[0].status, 'scored'); assert.equal(evaluation.summary[1].status, 'unavailable');
    assert.equal(evaluation.summary[1].metrics, null); assert.equal(evaluation.summary[1].paired, null);
  }
  assert.ok(runs.find(r => r.name === 'nomination-unknown').evaluation.rows.every(row => row.visibility === null && row.byte_visibility === null));
  const badRoot = join(root, 'rebound-route-drift'); mkdirSync(badRoot);
  for (const name of readdirSync(main.out)) copyFileSync(join(main.out, name), join(badRoot, name));
  const later = join(badRoot, '008-window-source-context.json'), capture = json(later);
  capture.field_delivery.context_routes[0].route = 'lexical-prefix'; write(later, capture);
  const receipt = json(join(badRoot, 'receipt.json')); receipt.rows.find(r => r.path === '008-window-source-context.json').sha256 = hash(readFileSync(later));
  write(join(badRoot, 'receipt.json'), receipt);
  invoke(['--evaluate', badRoot, '--labels', join(root, 'MUST-NOT-OPEN-LABELS'), '--out', join(root, 'rejected-evaluation.json')], 'route-drift-before-labels', 2);
  assert.ok(invocations.at(-1).stderr.includes('source context route drift'));
  bindings.forEach(b => assert.equal(hash(readFileSync(join(tree, b.path))), b.sha256));
  assert.deepEqual(safe.violations, []); assert.deepEqual(strict.forbidden, []);
  const evidence = { contract: 'authored-source-context-delivery-proof.v1', base_commit: 'e39953f1d63d420a8ff1f9242933854a7d406f04', bindings,
    claim: 'Authored mechanism only; fixture construction uses numerical source/index machinery, compiled entries prohibit all new model/query/acquisition/index effects.',
    scratch_peak_bytes: peak, runs, invocations, forbidden_effects: [], cleanup: 'All owned SQLite handles closed; disposable files removed in finally.' };
  if (process.argv[2]) { const compressed = gzipSync(JSON.stringify(evidence)); assert.ok(compressed.length <= 32 * 1024 ** 2); writeFileSync(process.argv[2], compressed, { flag: 'wx' }); }
  process.stdout.write(JSON.stringify({ status: 'complete', runs: runs.length, invocations: invocations.length, scratch_peak_bytes: peak }) + '\n');
} catch (error) {
  if (process.argv[2]) writeFileSync(process.argv[2].replace(/\.json\.gz$/, '-failed.json.gz'), gzipSync(JSON.stringify({
    status: 'failed', error: String(error), bindings, runs, invocations, scratch_peak_bytes: peak })), { flag: 'wx' });
  throw error;
} finally { rmSync(root, { recursive: true, force: true }); strict.restore(); safe.restore(); }
