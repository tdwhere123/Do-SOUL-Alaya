// Authored boundary proof. Guard installation precedes every application import, including child CLIs.
import { installProviderFreeBoundary } from './provider-free-boundary.ts';
import { installStrictProviderFreeBoundary } from './strict-provider-free-boundary.ts';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
const safe = installProviderFreeBoundary(), strict = installStrictProviderFreeBoundary();
const root = mkdtempSync(join(tmpdir(), 'navigation-search-acquisition-'));
const tree = fileURLToPath(new URL('../../../../../', import.meta.url));
const cli = join(tree, 'apps/bench-runner/dist/runs/source-access-diagnostic/conditional-navigation-launch.js');
const localPreload = new URL('./strict-provider-free-cli-bootstrap.mjs', import.meta.url).href;
const transportPreload = new URL('./transport-diagnostic-bootstrap.mjs', import.meta.url).href;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value), { flag: 'wx' });
const invocations = [];
const run = async (args, preload = localPreload, extra = {}) => {
  invocations.push({ executable: process.execPath, args: ['--import', preload, cli, ...args], authored_environment: extra });
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--import', preload, cli, ...args],
    { env: { ...process.env, ...extra }, timeout: 30_000, maxBuffer: 2 * 1024 ** 2 });
  assert.equal(stderr, ''); return JSON.parse(stdout);
};
let server, proof;
try {
  const { readEvidenceSelectionResults } = await import(pathToFileURL(join(tree, 'apps/bench-runner/dist/runs/evidence-selection/execute.js')).href);
  const { initDatabase, SqliteSourceIndexRepository, SqliteFieldSourceRecordRepo } = await import('@do-soul/alaya-storage');
  const { fieldContractSha256 } = await import('@do-soul/alaya-core');
  const { sourceIndexTarget, hashSourceRecordId, hashContentDigest, SOURCE_SPAN_IDENTITY_OPERATOR_ID,
    UNKNOWN_UTTERANCE_ATTRIBUTION } = await import('@do-soul/alaya-protocol');
  const input = { question: 'blue', reference_clock: '2026-09-22T00:00:00.000Z' };
  const proposal = { status: 'proposed', conditions: [
    { query: 'red material', object: 'target', hypothesis: 'unreviewed', groups: [0, 1], residual: null },
    { query: 'round', object: 'target', hypothesis: 'unreviewed', groups: [0], residual: null },
    { query: 'small', object: 'target', hypothesis: 'unreviewed', groups: [1], residual: null }
  ], unresolved: ['Authored interpretation is not certified.'] };
  const raw = JSON.stringify(proposal), bodies = [];
  server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer test-key');
    assert.equal(req.url, '/v1/chat/completions');
    let bytes = ''; for await (const chunk of req) bytes += String(chunk); bodies.push(bytes);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: raw }, finish_reason: 'stop' }], usage: {
      prompt_tokens: 100, completion_tokens: 80, total_tokens: 180 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  writeJson(join(root, 'proposal.json'), { source_revision: 'authored-boundary-fixture', rows: [{ ordinal: 1, input }] });
  const settled = await run(['--propose', join(root, 'proposal.json'), '--out', join(root, 'provider')], transportPreload,
    { ALAYA_TEST_DIAGNOSTIC_MODE: 'transport', ALAYA_TEST_LOOPBACK_TARGET: `http://127.0.0.1:${server.address().port}` });
  assert.equal(bodies.length, 1);
  assert.equal(settled.status, 'complete');
  assert.equal(settled.task, 'input-only-navigation-search-cues.v4');
  assert.deepEqual(settled, readJson(join(root, 'provider/receipt.json')));
  assert.equal(settled.ledger.attempts, 1); assert.equal(settled.ledger.successfulShards, 1);
  assert.equal(settled.ledger.settledAttempts.length, 1);
  assert.deepEqual(settled.ledger.pendingKeys, []); assert.deepEqual(settled.ledger.unresolvedAttempts, []);
  assert.equal(settled.cost.unknown_usage_attempts, 0); assert.equal(settled.cost.outstanding_maximum_cny, 0.15);
  const request = readJson(join(root, 'provider/request.json')), body = JSON.parse(bodies[0]);
  assert.equal(body.model, 'step-3.5-flash-2603'); assert.equal(body.reasoning_effort, 'low');
  assert.equal(body.max_tokens, 8192); assert.equal(body.stream, true);
  assert.deepEqual(body.messages.map(row => row.role), ['system', 'user']);
  assert.equal(body.messages[0].content, request.lines[0].systemPrompt);
  assert.match(body.messages[0].content, /carriers TOTAL, not per group/);
  assert.match(body.messages[0].content, /Do not assign factual, read, support, confidence or search-readiness status/);
  assert.deepEqual(JSON.parse(body.messages[1].content), input);
  assert.equal(body.response_format.type, 'json_schema'); assert.equal(body.response_format.json_schema.strict, true);
  const schema = body.response_format.json_schema.schema;
  assert.equal(schema.properties.conditions.maxItems, 3); assert.equal(schema.properties.branches, undefined);
  assert.deepEqual(schema.properties.conditions.items.required, ['query', 'object', 'hypothesis', 'groups', 'residual']);
  assert.equal(schema.properties.conditions.items.properties.status, undefined);
  const strings = schema.properties.conditions.items.properties;
  for (const [field, maxLength] of [[strings.query, 2048], [strings.object, 128], [strings.hypothesis, 128],
    [strings.residual.anyOf[0], 8192], [schema.properties.unresolved.items, 8192]]) {
    assert.equal(field.pattern, '^[\\s\\S]*\\S[\\s\\S]*$');
    assert.equal(field.minLength, 1); assert.equal(field.maxLength, maxLength);
    for (const value of ['red material', '赤い石 圆形盒子', '\n red\r\nmaterial \n']) {
      assert.equal(new RegExp(field.pattern, 'u').exec(value)?.[0], value);
    }
    assert.equal(new RegExp(field.pattern, 'u').test(' \n\t'), false);
  }
  const { Ajv } = await import('ajv');
  assert.equal(new Ajv().compile(schema)(proposal), true);
  assert.equal(hash(JSON.stringify(['https://api.stepfun.com/v1/chat/completions', bodies[0]])), request.lines[0].requestDigest);
  const readback = readEvidenceSelectionResults(request.workset, join(root, 'provider/cache'), 8192);
  assert.equal(readback[0].status, 'interpreted'); assert.equal(readback[0].shard.raw_json, raw);
  assert.equal(settled.captures[0].capture.raw_json, raw);
  const sourceTexts = ['blue stone', 'red material round', 'red material small'];
  const snapshot = { snapshot_path: join(root, 'input.sqlite'), workspace_id: 'search-fixture' };
  const database = initDatabase({ filename: snapshot.snapshot_path });
  const repository = new SqliteSourceIndexRepository(database, fieldContractSha256);
  let expectedGold;
  try {
    database.connection.prepare(`INSERT INTO workspaces
      (workspace_id, name, root_path, workspace_kind, workspace_state, created_at)
      VALUES (?, 'Authored fixture', ?, 'local_repo', 'active', ?)`)
      .run(snapshot.workspace_id, root, input.reference_clock);
    const records = new SqliteFieldSourceRecordRepo(database, fieldContractSha256);
    for (const [i, source_body] of sourceTexts.entries()) {
      const row = { workspace_id: snapshot.workspace_id, source_id: `authored-${i}`, source_version: '1',
        content_digest: hashContentDigest(source_body, fieldContractSha256), source_representation: { kind: 'original_body' },
        evidence_object_id: null, recorded_at: input.reference_clock, event_time: null, valid_from: null, valid_to: null,
        operator_id: SOURCE_SPAN_IDENTITY_OPERATOR_ID, speaker: null, scope_class: 'project',
        attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION, source_body };
      const record = records.insert({ ...row, record_id: hashSourceRecordId(row, fieldContractSha256) });
      const source = sourceIndexTarget({ kind: 'source_evidence', workspace_id: record.workspace_id, root_kind: 'source_record', root_id: record.record_id,
        source_version: record.source_version, content_digest: record.content_digest, evidence_object_id: record.evidence_object_id },
      record.source_id, Buffer.byteLength(record.source_body));
      assert.equal(repository.writeLexical(source, record.source_body, { work: 1_000_000, native_bytes: 1_000_000 }).status, 'accepted');
      if (record.source_id === 'authored-1') {
        const { kind, evidence_object_id, ...target } = source.target;
        expectedGold = { session_index: 0, message_index: 0, source_id: record.source_id, target, start: 0, end: 18 };
      }
    }
  } finally { database.close({ optimize: false }); }
  assert.ok(expectedGold);
  const digest = hash(readFileSync(snapshot.snapshot_path));
  const config = { contract: 'benchmark-conditional-navigation.v1', source_revision: 'authored-boundary-fixture', channels: 'lexical', cache_root: root,
    comparison: { model: settled.captures }, rows: [{ ordinal: 1, question_id: 'authored-search', snapshot: snapshot.snapshot_path,
      snapshot_sha256: digest, workspace: snapshot.workspace_id, interpretation_clock: input.reference_clock, authorized_scopes: ['project'], expected_index: null,
      original: 'formed-0', conditions: [{ id: 'formed-0', query: input.question, object: 'original', hypothesis: 'question', status: 'ready', residual: null,
        provenance: 'authored-original' }], branches: [] }] };
  writeJson(join(root, 'config.json'), config);
  const compared = await run(['--config', join(root, 'config.json'), '--out', join(root, 'comparison')]);
  assert.equal(compared.status, 'complete'); assert.equal(compared.local_query_inputs, 4);
  assert.equal(compared.local_inference_inputs, 0); assert.equal(compared.index_builds, 0); assert.equal(compared.external_calls, 0);
  assert.equal(compared.acquisitions, 5); assert.equal(compared.acquisition_cache_hits, 1);
  const formations = readJson(join(root, 'comparison/formations.json'))[0].arms[2];
  assert.equal(formations.formation.interpretation_fidelity, 'unverified');
  assert.deepEqual(formations.branches, [['formed-1', 'formed-2'], ['formed-1', 'formed-3']]);
  assert.equal(formations.formation.conditions[0].query, 'red material');
  const model = readJson(join(root, 'comparison/001-model.json')), original = readJson(join(root, 'comparison/001-original.json'));
  assert.deepEqual(original.windows.map(row => row.text), ['blue stone']);
  assert.deepEqual(model.windows.map(row => row.text).sort(), [...sourceTexts].sort());
  assert.deepEqual(model.captures.map(row => row.condition), ['formed-0', 'formed-1', 'formed-2', 'formed-3']);
  assert.deepEqual(model.captures.map(row => row.share.allowance.max_roots), [8, 2, 2, 2]);
  assert.deepEqual(model.captures.map(row => row.share.allowance.max_attempts), [64, 21, 21, 21]);
  assert.deepEqual(model.captures.map(row => row.witness.map(hit => hit.source.source_id).sort()),
    [['authored-0'], ['authored-1', 'authored-2'], ['authored-1'], ['authored-2']]);
  for (const row of model.captures) assert.equal(row.phase.status, 'executed');
  const extraIds = new Set(model.windows.filter(row => row.text !== 'blue stone').map(row => row.target.root_id));
  assert.deepEqual(model.solved.rows.filter(row => extraIds.has(row.record_id)).map(row => row.navigation.tier).sort(), [1022, 1024]);
  assert.ok(model.solved.rows.every(row => row.conditional_support.status === 'unknown' && row.read.status === 'unobserved'));
  assert.ok(model.windows.every(row => row.read.status === 'complete'));
  // Labels were authored from the source fixture, not from delivery, and are opened only after frozen selection.
  writeJson(join(root, 'gold.json'), { rows: [{ arm: 'C', visibility: { gold_messages: { annotated: 1, complete: true }, messages: [expectedGold] } }] });
  writeJson(join(root, 'labels.json'), [{ ordinal: 1, path: join(root, 'gold.json') }]);
  await run(['--evaluate', join(root, 'comparison'), '--labels', join(root, 'labels.json'), '--out', join(root, 'evaluation.json')]);
  const evaluation = readJson(join(root, 'evaluation.json'));
  assert.deepEqual(evaluation.rows.map(row => row.visibility.any_at_5.status), ['miss', 'miss', 'hit']);
  assert.equal(evaluation.summary[2].paired.any_at_5.gains, 1);
  assert.equal(hash(readFileSync(snapshot.snapshot_path)), digest);
  assert.deepEqual(safe.violations, []); assert.deepEqual(strict.forbidden, []);
  proof = { proof_id: randomUUID(), kind: 'authored-compiled-native-cli-loopback-sqlite', task: settled.task,
    invocations, compiled_entry_sha256: hash(readFileSync(cli)), wire: body, wire_sha256: hash(bodies[0]), request_digest: request.lines[0].requestDigest, raw_response: proposal,
    readback: { status: readback[0].status, raw_unchanged: true }, settlement: { ledger: settled.ledger, cost: settled.cost },
    formation: formations, acquisition: model.captures, field: model.solved, windows: model.windows,
    original_windows: original.windows, comparison: compared, evaluation: evaluation.summary,
    external_calls: 0, loopback_calls: 1, natural_inference: 0, real_secret_reads: 0, index_rebuilds: 0,
    fixture_lexical_writes: 3, guard_violations: [], natural_fidelity: 'NOT_VERIFIED', natural_benefit: 'NOT_VERIFIED' };
} finally {
  if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  rmSync(root, { recursive: true, force: true });
  assert.deepEqual(safe.violations, []); assert.deepEqual(strict.forbidden, []);
  strict.restore(); safe.restore();
}
assert.equal(existsSync(root), false);
proof.scratch_removed = true; proof.server_closed = true;
if (process.argv[2]) writeJson(process.argv[2], proof);
console.log(JSON.stringify({ proof_id: proof.proof_id, status: 'passed', loopback_calls: 1, additional_acquisitions: 3,
  candidate_texts: proof.windows.map(row => row.text), conditional_support: 'unknown', scratch_removed: true }));
