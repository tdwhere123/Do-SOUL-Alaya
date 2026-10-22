// Authored contract proof, not retrieval-quality evidence. One standalone execution owns CLI/process/SQLite coverage.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
await import('./representation-cli-bootstrap.mjs');
const tree = fileURLToPath(new URL('../../../../../', import.meta.url));
const bootstrap = new URL('./representation-cli-bootstrap.mjs', import.meta.url).href;
const head = (await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: tree, encoding: 'utf8' })).stdout.trim();
const buildInfo = JSON.parse(readFileSync(join(tree, 'apps/core-daemon/dist/build-info.json'), 'utf8'));
assert.equal(buildInfo.git_head, head, 'normal build metadata must identify this checkout HEAD');
const root = mkdtempSync(join(tmpdir(), 'representation-contract-'));
const logPath = join(root, 'encoder.jsonl');
process.env.ALAYA_AUTHORED_ENCODER_LOG = logPath;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = text => `sha256:${hash(text)}`;
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const write = (path, value) => writeFileSync(path, JSON.stringify(value), { flag: 'wx' });
const logs = () => existsSync(logPath) ? readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const size = dir => readdirSync(dir, { withFileTypes: true }).reduce((n, entry) => n +
  (entry.isDirectory() ? size(join(dir, entry.name)) : statSync(join(dir, entry.name)).size), 0);
const invocations = [], profiles = {}, captures = {}, checks = [];
let peak = 0, proof;
const run = async (entry, args, expected = 0) => {
  let result;
  try { result = { ...await promisify(execFile)(process.execPath, ['--import', bootstrap, entry, ...args],
    { env: process.env, timeout: 120000, maxBuffer: 2 * 1024 ** 2 }), code: 0 }; }
  catch (error) { result = error; }
  invocations.push({ entry: entry.replace(tree, ''), args, code: result.code, stderr: result.stderr });
  assert.equal(result.code, expected, result.stderr);
  peak = Math.max(peak, size(root)); assert.ok(peak < 256 * 1024 ** 2);
  return result;
};
try {
  const { writeEncoderTree } = await import(new URL('../../../../../packages/core/src/__tests__/embedding-recall/local-onnx-authored-transformers.mjs', import.meta.url));
  const { LocalOnnxEmbeddingClient, SourceIndexAcquisition, fieldContractSha256 } = await import('@do-soul/alaya-core');
  const { sourceIndexProfileId } = await import('@do-soul/alaya-protocol');
  const { createForkLocalOnnxEmbeddingHost } = await import(join(tree, 'packages/core/dist/embedding-recall/local-onnx-process/ipc-client.js'));
  const { prepareNativeSourceRecordsSnapshot } = await import(join(tree, 'apps/bench-runner/dist/runs/snapshot/source-records/native.js'));
  const { readCurrentExtractionAuthorityRevision } = await import(join(tree, 'apps/bench-runner/dist/runs/extraction/authority/inspection.js'));
  const { SemanticChainConfigSchema } = await import(join(tree, 'apps/bench-runner/dist/runs/recall-measurement/contract.js'));
  const { inspectSemanticChainSourceIndex } = await import(join(tree, 'apps/bench-runner/dist/runs/recall-measurement/source-index-binding.js'));
  const { StorageDatabase, SqliteSourceIndexRepository } = await import('@do-soul/alaya-storage');
  const { default: Sqlite } = await import('better-sqlite3');
  const cache = join(root, 'model-cache'), model = 'authored-bert-encoder';
  writeEncoderTree(cache, model);
  const representation = { kind: 'paired-prefix.v1', query_prefix: 'query: ', passage_prefix: 'passage: ' };
  const body = '  Blue stone in 京都.\r\n', query = 'Blue stone';
  const snapshot = await prepareNativeSourceRecordsSnapshot({ snapshotPath: join(root, 'input.sqlite'),
    dataDirRoot: join(root, 'source-publication'), workspaceId: 'authored-library', runId: 'authored-run',
    producerCommit: head, sources: [
      { source_id: 'note', source_version: '1', title: 'Authored note', content_bytes: body,
        source_observed_at: '2026-09-21T00:00:00.000Z', recorded_at: '2026-09-21T00:00:00.000Z' }
    ] });
  const config = SemanticChainConfigSchema.parse({ snapshot_path: snapshot.snapshot_path, snapshot_sha256: snapshot.db_sha256,
    implementation_revision: readCurrentExtractionAuthorityRevision(), interpretation_clock: '2026-09-22T00:00:00.000Z',
    workspace_id: snapshot.workspace_id, run_id: snapshot.run_id,
    query_workset: { contract: 'source-semantic-proposal-workset-v3', kind: 'query', model: 'gemini-2.5-flash-lite',
      request_profile: 'gemini-2.5-nonthinking-v1', provider_url: 'http://127.0.0.1:9', items: [{ original_query: query }] },
    query_cache_root: join(root, 'unattempted-query'), correspondence_cache_root: join(root, 'unattempted-correspondence'),
    max_output_tokens: 4096, discovery_page_cap: 1, correspondence_pair_cap: 0, access_policy: 'query-conditioned-v1',
    authorized_scopes: { mode: 'named', scopes: ['project'] }, output_byte_limit: 1000000,
    budget: { schema_version: 1, work_units: 10000000, memory_bytes: 60000000, page_budget: 10000, finalization_reserve: 50000, min_envelope: 10 } });
  write(join(root, 'config.json'), config);
  const setupEntry = join(tree, 'apps/bench-runner/dist/runs/recall-measurement/launch.js');
  const queryEntry = join(tree, 'apps/bench-runner/dist/runs/source-access-diagnostic/conditional-navigation-launch.js');
  const windows = {};
  for (const name of ['raw', 'paired']) {
    const execution = { cache_root: cache, model_id: model, ...(name === 'raw' ? {} : { representation }) };
    write(join(root, `${name}-execution.json`), execution);
    await run(setupEntry, ['source-prepare', '--config', join(root, 'config.json'), '--execution', join(root, `${name}-execution.json`), '--root', join(root, name)]);
    const bound = json(join(root, name, 'chain-config.json'));
    const report = json(join(root, name, 'preparation.json')).payload ?? json(join(root, name, 'preparation.json'));
    const observed = inspectSemanticChainSourceIndex(bound.snapshot_path, config.workspace_id, config.budget);
    assert.equal(observed.complete, true); assert.equal(observed.index.status, 'ready');
    profiles[name] = observed.index;
    const db = new Sqlite(bound.snapshot_path, { readonly: true, fileMustExist: true });
    try {
      windows[name] = db.prepare('SELECT start_byte,end_byte,content_digest FROM source_index_windows ORDER BY start_byte').all();
      assert.equal(windows[name].length, 1);
      assert.deepEqual(windows[name][0], { start_byte: 0, end_byte: Buffer.byteLength(body), content_digest: digest(body) });
      assert.equal(db.prepare('SELECT body FROM source_index_text').get().body, body);
      const vector = db.prepare('SELECT embedding_blob,token_count FROM source_index_vectors').get();
      const text = name === 'raw' ? body : 'passage: ' + body;
      assert.equal(vector.token_count, Array.from(text).length + 2);
      // Independently compute expected fixture bytes, not a provided vector/profile shim.
      const ids = [101, ...Array.from(text, c => c.codePointAt(0) + 1000), 102];
      const mean = Array.from({ length: 384 }, (_, i) => ids.reduce((n, id) => n + ((id * (i + 1)) % 97 + 1) / 97, 0) / ids.length);
      const norm = Math.hypot(...mean), expected = Float32Array.from(mean, n => n / norm);
      assert.deepEqual(Buffer.from(vector.embedding_blob), Buffer.from(expected.buffer));
    } finally { db.close(); }
    const navigation = { contract: 'benchmark-conditional-navigation.v1', source_revision: 'authored-representation-contract', channels: 'dual',
      cache_root: cache, model_id: model, rows: [{ ordinal: 1, question_id: 'authored-query', snapshot: bound.snapshot_path,
        snapshot_sha256: bound.snapshot_sha256, workspace: config.workspace_id, interpretation_clock: config.interpretation_clock,
        authorized_scopes: ['project'], expected_index: observed.index, original: 'original', conditions: [
          { id: 'original', query, object: 'note', hypothesis: 'authored', status: 'ready', residual: null, provenance: 'authored-no-label-input' }
        ], branches: [] }] };
    write(join(root, `${name}-query.json`), navigation);
    await run(queryEntry, ['--config', join(root, `${name}-query.json`), '--out', join(root, `${name}-query`)]);
    const receipt = json(join(root, `${name}-query`, 'receipt.json'));
    assert.equal(receipt.status, 'complete'); assert.equal(receipt.local_inference_inputs, 1); assert.equal(receipt.index_builds, 0);
    const acquisition = json(join(root, `${name}-query`, '001.json')).captures[0];
    assert.equal(acquisition.preparation.status, 'ready');
    assert.equal(acquisition.preparation.navigation_digest, digest(query));
    assert.equal(acquisition.preparation.selected.profile_id, observed.index.profile_id);
    assert.equal(acquisition.preparation.token_count, Array.from(name === 'raw' ? query : 'query: ' + query).length + 2);
    assert.ok(acquisition.witness.some(row => row.route.kind === 'vector'));
    captures[name] = { receipt, preparation: acquisition.preparation, setup: report.setup, vector_windows: windows[name] };
    assert.equal(hash(readFileSync(bound.snapshot_path)), bound.snapshot_sha256);
    if (name === 'paired') {
      const mismatch = structuredClone(navigation); mismatch.rows[0].expected_index = profiles.raw;
      write(join(root, 'mismatch.json'), mismatch);
      await run(queryEntry, ['--config', join(root, 'mismatch.json'), '--out', join(root, 'mismatch-query')], 2);
      const refusal = json(join(root, 'mismatch-query', 'receipt.json'));
      assert.equal(refusal.status, 'stopped'); assert.equal(refusal.local_inference_inputs, 0);
      checks.push({ case: 'raw selection cannot admit paired index', receipt: refusal });
    }
  }
  const overlimit = { cache_root: cache, model_id: model,
    representation: { ...representation, passage_prefix: 'p'.repeat(70) } };
  write(join(root, 'overlimit-execution.json'), overlimit);
  await run(setupEntry, ['source-prepare', '--config', join(root, 'config.json'), '--execution', join(root, 'overlimit-execution.json'),
    '--root', join(root, 'overlimit')], 2);
  const partial = json(join(root, 'overlimit', 'preparation.json')).payload;
  assert.equal(partial.contract, 'semantic-chain-source-preparation-failure-v1');
  assert.equal(partial.setup.status, 'token_limit'); assert.equal(partial.setup.resources.model_inputs, 1);
  assert.equal(partial.setup.resources.input_bytes, Buffer.byteLength(body));
  assert.ok(!existsSync(join(root, 'overlimit', 'chain-config.json')));
  assert.ok(!existsSync(join(root, 'overlimit', 'source-index.sqlite')));
  checks.push({ case: 'prefix refusal retains incurred preparation costs without publishing partial index', report: partial });
  assert.deepEqual(windows.raw, windows.paired);
  assert.notEqual(profiles.raw.profile_id, profiles.paired.profile_id);
  assert.notEqual(profiles.raw.generation_id, profiles.paired.generation_id);
  assert.equal(hash(readFileSync(snapshot.snapshot_path)), snapshot.db_sha256);
  // Public client through the actual compiled child; corrupt only transport in explicit fault cases.
  const client = new LocalOnnxEmbeddingClient({ cacheDir: cache, modelId: model });
  try {
    const options = { window_bytes: 56, representation: { ...representation } };
    const pendingBind = client.bindSourceEmbedding(options); options.representation.query_prefix = 'MUTATED';
    const paired = await pendingBind; assert.equal(paired.status, 'ready');
    assert.equal(paired.profile.representation.query_prefix, 'query: ');
    const raw = await client.bindSourceEmbedding({ window_bytes: 56 }); assert.equal(raw.status, 'ready');
    assert.equal(raw.profile_id, profiles.raw.profile_id); assert.equal(paired.profile_id, profiles.paired.profile_id);
    const inputs = [{ input_id: 'same', text: 'mutation', role: 'query' }];
    const pending = paired.embedInputs(inputs, { profile_id: paired.profile_id, timeoutMs: 5000 });
    inputs[0].text = 'changed'; inputs[0].role = 'passage';
    const rows = await pending;
    assert.equal(rows[0].status, 'embedded'); assert.equal(rows[0].input_digest, digest('mutation'));
    assert.equal(rows[0].prepared_input_digest, digest('query: mutation')); assert.equal(rows[0].role, 'query');
    const omitted = await paired.embedInputs([{ input_id: 'query: spoof', text: 'raw' }], { profile_id: paired.profile_id, timeoutMs: 5000 });
    assert.equal(omitted[0].reason, 'source_embedding_role_required');
    const limited = await client.bindSourceEmbedding({ window_bytes: 56, representation, max_input_tokens: 5 });
    const count = logs().filter(row => row.kind === 'encode').length;
    const refused = await limited.embedInputs([{ input_id: 'x', text: 'x', role: 'query' }], { profile_id: limited.profile_id, timeoutMs: 5000 });
    assert.equal(refused[0].reason, 'input_token_limit'); assert.equal(refused[0].token_count, 10);
    assert.equal(logs().filter(row => row.kind === 'encode').length, count);
    const db = new Sqlite(json(join(root, 'paired', 'chain-config.json')).snapshot_path, { readonly: true });
    try {
      const repo = new SqliteSourceIndexRepository(new StorageDatabase('proof-readonly', db), fieldContractSha256);
      const selection = repo.state(config.workspace_id).selection;
      const rejected = await SourceIndexAcquisition.prepareQuery({ navigation: query, selection, bind: async () => raw,
        signal: new AbortController().signal, remainingMs: () => 5000 });
      assert.equal(rejected.receipt.reason, 'selected_profile_mismatch'); assert.equal(rejected.receipt.submitted_inputs, 0);
      checks.push({ case: 'query runtime cannot cross-match dimensions', receipt: rejected.receipt });
    } finally { db.close(); }
    const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(paired.embedInputs([{ input_id: 'cancel', text: 'cancel', role: 'query' }],
      { profile_id: paired.profile_id, timeoutMs: 5000, signal: cancelled.signal }));
    const controller = new AbortController();
    const started = paired.embedInputs([{ input_id: 'inflight', text: 'cancel-inflight', role: 'query' }],
      { profile_id: paired.profile_id, timeoutMs: 5000, signal: controller.signal });
    const rejected = assert.rejects(started);
    const marker = Array.from('query: cancel-inflight', c => c.codePointAt(0) + 1000);
    const deadline = Date.now() + 5000;
    while (!logs().some(row => row.kind === 'encode' && JSON.stringify(row.ids) === JSON.stringify([101, ...marker, 102]))) {
      assert.ok(Date.now() < deadline, 'encoder occupancy must be observed before cancelling');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    controller.abort(); await rejected;
    const staleAfterAbort = await paired.embedInputs([{ input_id: 'after-abort', text: 'x', role: 'query' }],
      { profile_id: paired.profile_id, timeoutMs: 5000 });
    assert.equal(staleAfterAbort[0].reason, 'stale_child');
    checks.push({ case: 'actual encoder occupancy cancelled; old child binding refuses reuse', staleAfterAbort });
    await client.close();
    const stale = await paired.embedInputs([{ input_id: 'stale', text: 'x', role: 'query' }], { profile_id: paired.profile_id, timeoutMs: 5000 });
    assert.equal(stale[0].status, 'not_embedded');
    checks.push({ case: 'mutation, missing role, prefix limit, pre-cancel and closed binding', omitted, refused, stale });
  } finally { await client.close(); }
  for (const fault of ['role_lost', 'invalid_role', 'role_swapped', 'representation_lost', 'response_role_changed', 'prepared_digest_lost']) {
    const host = createForkLocalOnnxEmbeddingHost();
    const bad = new LocalOnnxEmbeddingClient({ cacheDir: cache, modelId: model, ipcHost: { spawn() {
      const child = host.spawn(), send = child.send.bind(child), on = child.on.bind(child);
      child.on = (event, listener) => on(event, event !== 'message' ? listener : message => {
        if (message.sourceResults) for (const row of message.sourceResults) {
          if (fault === 'response_role_changed') row.role = 'passage';
          if (fault === 'prepared_digest_lost') delete row.prepared_input_digest;
        }
        listener(message);
      });
      child.send = (message, callback) => {
        const copy = structuredClone(message);
        if (fault === 'representation_lost' && copy.op === 'bind_source') delete copy.bindingOptions.representation;
        if (copy.op === 'embed_source') for (const input of copy.inputs) {
          if (fault === 'role_lost') delete input.role;
          if (fault === 'invalid_role') input.role = 'not-a-role';
          if (fault === 'role_swapped') input.role = 'passage';
        }
        return send(copy, callback);
      }; return child;
    } } });
    try {
      const binding = bad.bindSourceEmbedding({ window_bytes: 56, representation });
      if (fault === 'representation_lost') await assert.rejects(binding, /configuration mismatch/);
      else {
        const bound = await binding;
        const pending = bound.embedInputs([{ input_id: 'x', text: 'x', role: 'query' }], { profile_id: bound.profile_id, timeoutMs: 5000 });
        if (fault === 'invalid_role') await assert.rejects(pending, /role/);
        else if (fault === 'role_swapped' || fault === 'response_role_changed' || fault === 'prepared_digest_lost') await assert.rejects(pending, /preparation evidence/);
        else assert.equal((await pending)[0].reason, 'source_embedding_role_required');
      }
      checks.push({ case: fault, rejected: true });
    } finally { await bad.close(); }
  }
  const all = logs();
  for (const text of [body, 'passage: ' + body, query, 'query: ' + query]) assert.ok(all.some(row => row.kind === 'tokenize' && row.text === text));
  assert.ok(!all.some(row => row.kind === 'tokenize' && /^(query: query: |passage: passage: )/u.test(row.text)));
  const forks = all.filter(row => row.kind === 'fork');
  for (const fork of forks) {
    assert.ok(all.some(row => row.kind === 'guard_installed' && row.pid === fork.child && row.credential_names.length === 0));
    assert.ok(all.some(row => row.kind === 'child_exit' && row.child === fork.child));
  }
  assert.ok(all.filter(row => row.kind === 'guard_exit').every(row => row.violations.length === 0));
  peak = Math.max(peak, size(root)); assert.ok(peak < 256 * 1024 ** 2);
  proof = { contract: 'authored-representation-contract-proof.v1', head, buildInfo, profiles, captures, checks, invocations,
    prepared_observations: all.filter(row => ['load', 'tokenize', 'encode', 'fork', 'child_exit', 'guard_installed', 'guard_exit'].includes(row.kind)),
    ipc_evidence: all.filter(row => row.kind === 'ipc_response').map(row => ({ ...row, message: { ...row.message,
      sourceResults: row.message.sourceResults?.map(({ vector, ...result }) => ({ ...result,
        ...(vector ? { vector_sha256: hash(Buffer.from(Float32Array.from(vector).buffer)) } : {}) })) } })),
    peak_disposable_bytes: peak, model_inference: false, external_calls: 0, quality_claim: false };
} finally { delete process.env.ALAYA_AUTHORED_ENCODER_LOG; rmSync(root, { recursive: true, force: true }); }
proof.cleaned = !existsSync(root);
if (process.argv[2]) write(process.argv[2], proof);
process.stdout.write(JSON.stringify({ status: 'proved', cleaned: proof.cleaned, peak_disposable_bytes: peak,
  cli_invocations: invocations.length, cases: checks.length }) + '\n');
