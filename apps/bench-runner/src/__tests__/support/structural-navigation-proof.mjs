// Authored-only preparation, real compiled acquisition/read/delivery and frozen evaluation.
// Effect guards precede every application import, including child CLI entrypoints.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const { installProviderFreeBoundary } = await import('./provider-free-boundary.ts');
const { installStrictProviderFreeBoundary } = await import('./strict-provider-free-boundary.ts');
const safe = installProviderFreeBoundary(), strict = installStrictProviderFreeBoundary();
const tree = fileURLToPath(new URL('../../../../../', import.meta.url));
const cli = join(tree, 'apps/bench-runner/dist/runs/source-access-diagnostic/conditional-navigation-launch.js');
const preload = new URL('./strict-provider-free-cli-bootstrap.mjs', import.meta.url).href;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
// Freeze code evidence before preparation, selection, and authored evaluator labels.
const owners = ['conditional-navigation', 'conditional-navigation-run', 'conditional-navigation-evaluate', 'structural-navigation'];
const codeBinding = [...owners.flatMap(name => [`apps/bench-runner/src/runs/source-access-diagnostic/${name}.ts`,
  `apps/bench-runner/dist/runs/source-access-diagnostic/${name}.js`]),
  'apps/bench-runner/src/__tests__/longmemeval/measurement/structural-navigation.test.ts',
  'apps/bench-runner/src/__tests__/support/structural-navigation-proof.mjs'].map(path => ({ path, sha256: hash(readFileSync(join(tree, path))) }));
const assertCodeFrozen = () => codeBinding.forEach(({ path, sha256 }) => assert.equal(hash(readFileSync(join(tree, path))), sha256));
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const write = (path, value) => writeFileSync(path, JSON.stringify(value), { flag: 'wx' });
const root = mkdtempSync(join(tmpdir(), 'structural-navigation-'));
const captures = [], invocations = [], repairCases = [], repairFailures = [];
const verifyRepair = (name, assertion) => {
  try { assertion(); } catch (error) { repairFailures.push({ name, message: error.message }); }
};
const bytes = path => readdirSync(path, { withFileTypes: true }).reduce((sum, entry) => sum +
  (entry.isDirectory() ? bytes(join(path, entry.name)) : statSync(join(path, entry.name)).size), 0);
let peak = 0, proof;
const run = async (args, expected = 0) => {
  let result;
  try { result = { ...await promisify(execFile)(process.execPath, args, { env: process.env, timeout: 120_000, maxBuffer: 2 * 1024 ** 2 }), code: 0 }; }
  catch (error) { result = error; }
  invocations.push({ args, code: result.code, stdout: result.stdout, stderr: result.stderr });
  if (expected !== null) assert.equal(result.code, expected, result.stderr);
  peak = Math.max(peak, bytes(root)); assert.ok(peak < 256 * 1024 ** 2);
  return result;
};
try {
  const { inspectSourceRecordsArtifact, createSourceRecordsSidecarWriter, sealSourceRecordsManifest,
    sourceRecordsManifestPath, sourceRecordsSidecarPath } = await import(join(tree, 'apps/bench-runner/dist/runs/snapshot/source-records/contract.js'));
  const { initDatabase, SqliteFieldSourceRecordRepo, SqliteSourceIndexRepository } = await import('@do-soul/alaya-storage');
  const { fieldContractSha256 } = await import('@do-soul/alaya-core');
  const { sourceIndexTarget } = await import('@do-soul/alaya-protocol');
  const home = join(root, 'fixture'); mkdirSync(home);
  // The next message is useful by authored conversation structure, not lexical strength.
  // Its identity and evaluator target are fixed by position BEFORE any ranks are seen.
  const texts = ['京都 ' + 'Copper comet '.repeat(16) + 'launch question.',
    'Copper comet ceremony location: 京都の杉箱。 ' + 'background '.repeat(200),
    ...Array.from({ length: 10 }, (_, i) => `Copper comet notes ${i}.`)];
  const fixture = [{ question_id: 'authored-structural-navigation', question_type: 'fixture', question: 'Copper comet', answer: '',
    question_date: '2025-07-02T00:00:00.000Z', haystack_session_ids: ['authored-session'], haystack_dates: ['2021/02/03'],
    haystack_sessions: [texts.map((content, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content }))], answer_session_ids: [] }];
  const encoded = JSON.stringify(fixture); writeFileSync(join(home, 'longmemeval_s.json'), encoded);
  write(join(home, 'longmemeval_s.meta.json'), { sha256: hash(encoded), size_bytes: Buffer.byteLength(encoded), question_count: 1 });
  const preparation = { snapshotPath: join(home, 'prepared.sqlite'), dataDirRoot: join(home, 'import'), dataDir: home,
    pinnedMetaRoot: home, offset: 0, limit: 1, recordedAt: '2026-10-01T12:34:56.000Z', producerCommit: 'ea35791d12f40a66a64d075a9bd3a4506f6b1c32',
    importEffects: { configDirectoryRoot: home, sqliteWriteQueue: 'disabled', embeddingStartupProbe: 'omit', gardenCompute: 'disabled' } };
  write(join(home, 'prepare.json'), preparation);
  await run([fileURLToPath(new URL('./session-observation-proof.mjs', import.meta.url)), 'prepare', join(home, 'prepare.json')]);
  const messages = [], artifact = inspectSourceRecordsArtifact(preparation.snapshotPath, message => messages.push(message));
  assert.deepEqual(messages.map(row => row.message_index), Array.from({ length: 12 }, (_, i) => i));
  const workspace = messages[0].record.workspace_id, product = join(home, 'lexical.sqlite');
  copyFileSync(preparation.snapshotPath, product);
  const database = initDatabase({ filename: product });
  try {
    const records = new SqliteFieldSourceRecordRepo(database, fieldContractSha256), repository = new SqliteSourceIndexRepository(database, fieldContractSha256);
    const rows = records.listPageBounded(workspace, { limit: 16 }, 4096).rows;
    assert.equal(rows.length, 12);
    for (const { record } of rows) {
      const target = sourceIndexTarget({ kind: 'source_evidence', workspace_id: workspace, root_kind: 'source_record', root_id: record.record_id,
        source_version: record.source_version, content_digest: record.content_digest, evidence_object_id: null }, record.source_id, Buffer.byteLength(record.source_body));
      assert.equal(repository.writeLexical(target, record.source_body, { work: 1_000_000, native_bytes: 1_000_000 }).status, 'accepted');
    }
  } finally { database.close({ optimize: false }); }
  const original = { id: 'original', query: 'Copper comet', object: 'notes', hypothesis: 'authored-session', status: 'ready', residual: null, provenance: 'authored-no-label-input' };
  const baseline = { contract: 'benchmark-conditional-navigation.v1', source_revision: 'authored-structural-navigation', channels: 'lexical', cache_root: root,
    rows: [{ ordinal: 1, question_id: fixture[0].question_id, snapshot: product, snapshot_sha256: hash(readFileSync(product)), workspace,
      source_records: { snapshot: preparation.snapshotPath, manifest_sha256: artifact.manifest.manifest_sha256 }, observation_domain: 'admitted_nomination_union',
      structural_navigation: { contract: 'benchmark-read-session-adjacency.v1', mode: 'off', max_source_reads: 522 },
      interpretation_clock: fixture[0].question_date, authorized_scopes: ['project'], expected_index: null, original: 'original', conditions: [original], branches: [] }] };
  const structural = structuredClone(baseline); structural.rows[0].structural_navigation.mode = 'adjacent';
  const conjunction = structuredClone(structural); conjunction.rows[0].structural_navigation.mode = 'original_and_adjacent';
  const unbound = structuredClone(structural); delete unbound.rows[0].source_records;
  const legacy = structuredClone(baseline); delete legacy.rows[0].structural_navigation;
  const exhausted = structuredClone(structural); exhausted.rows[0].structural_navigation.max_source_reads = 0;
  const deliveryExhausted = structuredClone(structural); deliveryExhausted.rows[0].structural_navigation.max_source_reads = 12;
  const unauthorized = structuredClone(structural); unauthorized.rows[0].authorized_scopes = [];
  const wrongManifest = structuredClone(structural); wrongManifest.rows[0].source_records.manifest_sha256 = '0'.repeat(64);
  const variants = { baseline, structural, conjunction, unbound, legacy, exhausted, deliveryExhausted, unauthorized, wrongManifest };
  const { shards, message_count, ...header } = artifact.sidecar;
  for (const [name, members] of [
    ['gapped', messages.map(row => ({ ...row, message_index: row.message_index * 2 }))],
    ['unrelated', messages.map(row => ({ ...row, session_id: `independent-${row.message_index}`, session_index: row.message_index, message_index: 0 }))],
    ['historical', messages.map(({ source_observation, ...row }) => row)],
    ['missingSeed', messages.filter(row => row.message_index !== 0)]
  ]) {
    const snapshot = join(root, `${name}.sqlite`); copyFileSync(preparation.snapshotPath, snapshot);
    const writer = createSourceRecordsSidecarWriter(snapshot, header); members.forEach(row => writer.append(row)); writer.finish();
    const { manifest_sha256, ...body } = artifact.manifest;
    const manifest = sealSourceRecordsManifest({ ...body, message_count: members.length, sidecar_sha256: hash(readFileSync(sourceRecordsSidecarPath(snapshot))) });
    write(sourceRecordsManifestPath(snapshot), manifest);
    const value = structuredClone(structural); value.rows[0].source_records = { snapshot, manifest_sha256: manifest.manifest_sha256 };
    variants[name] = value;
  }
  // Freeze EVERY input (including failure cases) before any selection or evaluation.
  for (const [name, value] of Object.entries(variants)) write(join(root, `${name}.json`), value);
  const navigate = async (name, expected = 0, entryPreload = preload, configName = name) => {
    const out = join(root, name);
    const result = await run(['--import', entryPreload, cli, '--config', join(root, `${configName}.json`), '--out', out], expected);
    const receipt = JSON.parse(result.stdout), capture = expected === 0 ? json(join(out, '001.json')) : null;
    assert.equal(receipt.status, expected === 0 ? 'complete' : 'stopped');
    assert.equal(receipt.local_inference_inputs, 0); assert.equal(receipt.external_calls, 0); assert.equal(receipt.index_builds, 0);
    const frozen = { input_json: readFileSync(join(out, 'input.json'), 'utf8'), formations_json: readFileSync(join(out, 'formations.json'), 'utf8'),
      capture_json: capture === null ? null : readFileSync(join(out, '001.json'), 'utf8') };
    assert.equal(hash(frozen.input_json), receipt.input_sha256); assert.equal(hash(frozen.formations_json), receipt.formations_sha256);
    if (capture) assert.equal(hash(frozen.capture_json), receipt.rows[0].sha256);
    else { assert.equal(existsSync(join(out, '001.json')), false); assert.deepEqual(receipt.rows, []); }
    captures.push({ name, receipt, capture, frozen }); return capture;
  };
  const selected = {};
  for (const name of Object.keys(variants)) selected[name] = await navigate(name, ['exhausted', 'deliveryExhausted', 'unauthorized', 'wrongManifest', 'missingSeed'].includes(name) ? 2 : 0);
  const base = selected.baseline, changed = selected.structural;
  const seed = messages[0].record.identity, neighbor = messages[1].record.identity;
  assert.equal(base.pool.length, 12); assert.equal(base.solved.native_single_condition[0], seed);
  assert.equal(base.solved.rows.at(-1).record_id, neighbor);
  assert.equal(changed.solved.rows[1].record_id, neighbor);
  assert.deepEqual(changed.structural.observation.edges.map(row => [row.from, row.to]), [[seed, neighbor]]);
  assert.equal(changed.structural.observation.seed.prefix_bytes, Buffer.byteLength(texts[0]));
  for (const name of ['structural', 'conjunction', 'unbound', 'gapped', 'unrelated', 'historical', 'legacy']) {
    const capture = selected[name];
    assert.deepEqual(capture.pool, base.pool); assert.deepEqual(capture.occurrences, base.occurrences); assert.deepEqual(capture.captures, base.captures);
    assert.equal(capture.windows.length, 10);
    for (const window of capture.windows) {
      const index = messages.find(row => row.record.identity === window.target.root_id).message_index;
      assert.equal(window.text, texts[index]); assert.equal(window.end, Buffer.byteLength(texts[index]));
    }
    assert.ok(capture.solved.rows.every(row => row.conditional_support.status === 'unknown' && row.read.status === 'unobserved'));
  }
  assert.deepEqual(base.solved, selected.legacy.solved); assert.deepEqual(base.windows, selected.legacy.windows);
  assert.deepEqual(selected.conjunction.windows, base.windows);
  const delivery = capture => capture.windows.map(({ source_time, ...window }) => window);
  for (const name of ['unbound', 'gapped', 'unrelated']) assert.deepEqual(delivery(selected[name]), delivery(base));
  assert.equal(selected.unbound.structural.observation.status, 'unknown');
  for (const name of ['gapped', 'unrelated']) assert.deepEqual(selected[name].structural.observation.edges, []);
  assert.deepEqual(selected.historical.structural.observation.edges.map(row => [row.from, row.to]), [[seed, neighbor]]);
  const baseCost = base.structural.reads, structureCost = changed.structural.reads;
  assert.deepEqual(baseCost.allowance, structureCost.allowance);
  assert.equal(baseCost.accounting.source_reads, 22); assert.equal(structureCost.accounting.source_reads, 21);
  assert.equal(baseCost.accounting.requested_prefix_bytes, 40972); assert.equal(structureCost.accounting.requested_prefix_bytes, 40971);
  assert.equal(structureCost.reused_delivery_reads, 1); assert.equal(baseCost.reused_delivery_reads, 0);
  const expectedNative = capture => texts.reduce((sum, text) => sum + Buffer.byteLength(text), 0) +
    capture.windows.filter(row => capture === base || row.target.root_id !== seed).reduce((sum, row) => sum + Buffer.byteLength(row.text), 0);
  assert.equal(baseCost.accounting.native_bytes, expectedNative(base)); assert.equal(structureCost.accounting.native_bytes, expectedNative(changed));
  assert.equal(baseCost.accounting.status, 'complete'); assert.equal(structureCost.accounting.status, 'complete');
  assert.match(captures.find(row => row.name === 'exhausted').receipt.failure, /allowance exhausted/);
  assert.equal(captures.find(row => row.name === 'exhausted').receipt.structural_reads[0].ledger.accounting.source_reads, 0);
  const exhaustedDelivery = captures.find(row => row.name === 'deliveryExhausted').receipt;
  assert.match(exhaustedDelivery.failure, /allowance exhausted/);
  assert.equal(exhaustedDelivery.observation_scans[0].status, 'complete');
  assert.equal(exhaustedDelivery.structural_reads[0].ledger.accounting.source_reads, 12);
  assert.equal(exhaustedDelivery.structural_reads[0].ledger.reused_delivery_reads, 1);
  // Read effects genuinely happen in SQLite before an authored boundary fault hides
  // a meter or makes admission fail. No injected native ranks or evaluator shortcut.
  const faults = [];
  for (const mode of ['throw', 'null', 'empty', 'limited', 'stale', 'unauthorized', 'misbound']) {
    const name = `seed-${mode}`, fault = join(root, `${name}.mjs`), trace = join(root, `${name}-trace.json`);
    writeFileSync(fault, `await import(${JSON.stringify(preload)});
      const { SqliteFieldSourceRecordRepo } = await import(${JSON.stringify(join(tree, 'packages/storage/dist/index.js'))});
      const { writeFileSync } = await import('node:fs');
      const original = SqliteFieldSourceRecordRepo.prototype.findByIdBounded;
      SqliteFieldSourceRecordRepo.prototype.findByIdBounded = function (...args) {
        const read = original.apply(this, args);
        if (args[1] !== ${JSON.stringify(seed)} || args[2] !== 4096) return read;
        writeFileSync(${JSON.stringify(trace)}, JSON.stringify({ native_bytes: read.nativeBytes, metadata_bytes: read.metadataBytes, dependency_work: read.dependencyWork }));
        const mode = ${JSON.stringify(mode)};
        if (mode === 'throw') throw new Error('authored seed meter lost');
        if (mode === 'null') return null;
        if (mode === 'empty') return { ...read, prefixBytes: 0, record: { ...read.record, source_body: '' } };
        if (mode === 'limited') return { ...read, resourceLimited: true };
        if (mode === 'stale') return { ...read, record: { ...read.record, source_version: 'stale' } };
        if (mode === 'unauthorized') return { ...read, record: { ...read.record, scope_class: 'private' } };
        return { ...read, record: { ...read.record, speaker: read.record.speaker === 'user' ? 'assistant' : 'user' } };
      };`);
    await navigate(name, 2, fault, 'structural');
    const receipt = captures.at(-1).receipt, meter = receipt.structural_reads[0].ledger.accounting;
    assert.equal(meter.unmetered_reads, ['throw', 'null'].includes(mode) ? 1 : 0);
    assert.equal(meter.status, ['throw', 'null'].includes(mode) ? 'partial' : 'complete');
    const witness = json(trace); assert.ok(witness.native_bytes > 0);
    if (!['throw', 'null'].includes(mode)) assert.ok(meter.native_bytes >= witness.native_bytes);
    faults.push({ mode, witness, meter });
  }
  // Retained independent counterexample: two authored rows, three messages each.
  const repairFixture = [1, 2].map(i => ({ question_id: `independent-structural-${i}`, question_type: 'authored', question: 'Copper comet', answer: '',
    question_date: '2025-07-02T00:00:00.000Z', haystack_session_ids: [`session-${i}`], haystack_dates: ['2021/02/03'],
    haystack_sessions: [[{ role: 'user', content: 'Copper comet '.repeat(8) + 'launch question.' },
      { role: 'assistant', content: 'Copper comet cedar crate reply.' }, { role: 'user', content: 'Copper comet dispatch.' }]], answer_session_ids: [] }));
  const repairHome = join(root, 'seed-admission'); mkdirSync(repairHome);
  const repairEncoded = JSON.stringify(repairFixture);
  writeFileSync(join(repairHome, 'longmemeval_s.json'), repairEncoded);
  write(join(repairHome, 'longmemeval_s.meta.json'), { sha256: hash(repairEncoded), size_bytes: Buffer.byteLength(repairEncoded), question_count: 2 });
  const repairPreparation = { ...preparation, snapshotPath: join(repairHome, 'prepared.sqlite'), dataDirRoot: join(repairHome, 'import'),
    dataDir: repairHome, pinnedMetaRoot: repairHome, limit: 2, importEffects: { ...preparation.importEffects, configDirectoryRoot: repairHome } };
  write(join(repairHome, 'prepare.json'), repairPreparation);
  await run([fileURLToPath(new URL('./session-observation-proof.mjs', import.meta.url)), 'prepare', join(repairHome, 'prepare.json')]);
  const repairMessages = [], repairArtifact = inspectSourceRecordsArtifact(repairPreparation.snapshotPath, row => repairMessages.push(row));
  const repairProduct = join(repairHome, 'lexical.sqlite'); copyFileSync(repairPreparation.snapshotPath, repairProduct);
  const repairDb = initDatabase({ filename: repairProduct });
  try {
    const repository = new SqliteSourceIndexRepository(repairDb, fieldContractSha256), records = new SqliteFieldSourceRecordRepo(repairDb, fieldContractSha256);
    for (const message of repairMessages) {
      const r = message.record, body = records.findByIdBounded(r.workspace_id, r.identity, 4096, 0).record.source_body;
      const target = sourceIndexTarget({ kind: 'source_evidence', workspace_id: r.workspace_id, root_kind: 'source_record', root_id: r.identity,
        source_version: r.source_version, content_digest: r.content_digest, evidence_object_id: null }, r.source_id, Buffer.byteLength(body));
      assert.equal(repository.writeLexical(target, body, { work: 1_000_000, native_bytes: 1_000_000 }).status, 'accepted');
    }
  } finally { repairDb.close({ optimize: false }); }
  const repairBase = { ...structural, rows: repairFixture.map((q, i) => ({ ...structural.rows[0], ordinal: i + 1, question_id: q.question_id,
    workspace: repairMessages.find(m => m.question_id === q.question_id).record.workspace_id, snapshot: repairProduct,
    snapshot_sha256: hash(readFileSync(repairProduct)), source_records: { snapshot: repairPreparation.snapshotPath, manifest_sha256: repairArtifact.manifest.manifest_sha256 },
    conditions: [{ ...original }, { ...original, id: 'extra', query: 'cedar crate' }], branches: [['extra']] })) };
  const absent = structuredClone(repairBase); absent.rows = absent.rows.slice(0, 1);
  absent.rows[0].conditions[0].query = 'unmatchablequartzsentinel'; absent.rows[0].conditions[1].query = 'Copper comet';
  const empty = structuredClone(absent); empty.rows[0].conditions = empty.rows[0].conditions.slice(0, 1); empty.rows[0].branches = [];
  const originalOnly = structuredClone(repairBase); originalOnly.rows = originalOnly.rows.slice(0, 1);
  originalOnly.rows[0].conditions = originalOnly.rows[0].conditions.slice(0, 1); originalOnly.rows[0].branches = [];
  const noStructure = structuredClone(originalOnly); delete noStructure.rows[0].structural_navigation;
  const noMetadata = structuredClone(noStructure); delete noMetadata.rows[0].observation_domain;
  const absentOff = structuredClone(absent); absentOff.rows[0].structural_navigation.mode = 'off';
  const absentLegacy = structuredClone(absent); delete absentLegacy.rows[0].structural_navigation;
  const absentConjunction = structuredClone(absent); absentConjunction.rows[0].structural_navigation.mode = 'original_and_adjacent';
  const comparison = structuredClone(noStructure); comparison.comparison = { model: [] };
  const subset = structuredClone(repairBase); subset.rows = subset.rows.slice(0, 1);
  subset.rows[0].conditions[0].query = 'cedar crate'; subset.rows[0].conditions[1].query = 'Copper comet';
  const repairInputs = { multi: repairBase, subset, absent, empty, originalOnly, noStructure, noMetadata, absentOff, absentLegacy, absentConjunction, comparison };
  for (const [name, input] of Object.entries(repairInputs)) write(join(root, `repair-${name}.json`), input);
  const repairNavigate = async (name, configName = name, entryPreload = preload) => {
    const out = join(root, `repair-${name}`);
    const invocation = await run(['--import', entryPreload, cli, '--config', join(root, `repair-${configName}.json`), '--out', out], null);
    const receipt = json(join(out, 'receipt.json'));
    const rows = receipt.rows.filter(row => row.path).map(row => {
      const encoded = readFileSync(join(out, row.path), 'utf8'); assert.equal(hash(encoded), row.sha256); return JSON.parse(encoded);
    });
    const frozen = { input: json(join(out, 'input.json')), formations: json(join(out, 'formations.json')),
      observations: readdirSync(out).filter(p => p.endsWith('-observations.json')).map(p => ({ path: p, value: json(join(out, p)) })) };
    assert.equal(receipt.external_calls, 0); assert.equal(receipt.index_builds, 0); assert.equal(receipt.local_inference_inputs, 0);
    const result = { name, exit: invocation.code, receipt, rows, frozen }; repairCases.push(result); return result;
  };
  const repairSelected = {};
  for (const name of Object.keys(repairInputs)) repairSelected[name] = await repairNavigate(name);
  // Actual native lexical calls return their own meters and witnesses; only the
  // completion state is faulted, never ranks, source identities or eligibility.
  for (const [name, configName, query, mode] of [
    ['unknown', 'absent', 'unmatchablequartzsentinel', 'partial'], ['partial', 'originalOnly', 'Copper comet', 'partial'],
    ['failedAcquisition', 'originalOnly', 'Copper comet', 'throw']
  ]) {
    const fault = join(root, `repair-${name}.mjs`);
    writeFileSync(fault, `await import(${JSON.stringify(preload)});
      const { SqliteSourceIndexRepository } = await import(${JSON.stringify(join(tree, 'packages/storage/dist/index.js'))});
      const original = SqliteSourceIndexRepository.prototype.readLexicalCandidates;
      SqliteSourceIndexRepository.prototype.readLexicalCandidates = function (...args) {
        const result = original.apply(this, args);
        if (args[1] !== ${JSON.stringify(query)}) return result;
        if (${JSON.stringify(mode)} === 'throw') throw new Error('authored acquisition meter lost');
        return { ...result, completion: 'partial', reason: 'authored incomplete native capture' };
      };`);
    repairSelected[name] = await repairNavigate(name, configName, fault);
  }
  for (const [name, configName, mode] of [
    ['legacyThrow', 'noStructure', 'throw'], ['legacyNull', 'noStructure', 'null'], ['noMetadataThrow', 'noMetadata', 'throw'],
    ['noMetadataNull', 'noMetadata', 'null'], ['legacyLimited', 'noStructure', 'limited'], ['legacyStale', 'noStructure', 'stale'],
    ['legacyDenied', 'noStructure', 'denied'], ['legacyMisbound', 'noStructure', 'misbound'],
    ['structureThrow', 'originalOnly', 'throw'], ['structureDeliveryThrow', 'originalOnly', 'delivery-throw'],
    ['structureDeliveryNull', 'originalOnly', 'delivery-null'], ['captureFailure', 'noStructure', 'capture'],
    ['structureCaptureFailure', 'originalOnly', 'capture'], ['multiDeliveryFailure', 'multi', 'second-row'],
    ['armDeliveryFailure', 'comparison', 'second-arm']
  ]) {
    const fault = join(root, `repair-${name}.mjs`), trace = join(root, `repair-${name}-trace.json`);
    writeFileSync(fault, `await import(${JSON.stringify(preload)});
      const storage = await import(${JSON.stringify(join(tree, 'packages/storage/dist/index.js'))});
      const fs = await import('node:fs'); const { syncBuiltinESMExports } = await import('node:module');
      const write = fs.default.writeFileSync, read = storage.SqliteFieldSourceRecordRepo.prototype.findByIdBounded;
      const mode = ${JSON.stringify(mode)}, trace = ${JSON.stringify(trace)}; let deliveries = 0;
      if (mode === 'capture') { fs.default.writeFileSync = function (path, ...args) {
        if (String(path).endsWith('/001.json')) throw new Error('authored capture write failure'); return write(path, ...args);
      }; syncBuiltinESMExports(); }
      storage.SqliteFieldSourceRecordRepo.prototype.findByIdBounded = function (...args) {
        const result = read.apply(this, args); if (args[2] !== 4096) return result;
        deliveries++; write(trace, JSON.stringify({ deliveries, native_bytes: result.nativeBytes, metadata_bytes: result.metadataBytes }));
        if (mode === 'capture' || mode === 'second-row' && deliveries <= 4 || mode === 'second-arm' && deliveries <= 3 || mode.startsWith('delivery-') && deliveries <= 1) return result;
        if (['throw', 'delivery-throw', 'second-row', 'second-arm'].includes(mode)) throw new Error('authored delivery meter lost');
        if (mode === 'null' || mode === 'delivery-null') return null;
        if (mode === 'limited') return { ...result, resourceLimited: true };
        if (mode === 'stale') return { ...result, record: { ...result.record, source_version: 'stale' } };
        if (mode === 'denied') return { ...result, record: { ...result.record, scope_class: 'private' } };
        return { ...result, record: { ...result.record, speaker: result.record.speaker === 'user' ? 'assistant' : 'user' } };
      };`);
    repairSelected[name] = await repairNavigate(name, configName, fault);
    repairSelected[name].hidden_meter = json(trace);
  }
  // All new selections, stopped attempts and inputs are now frozen, before labels.
  for (const name of ['absent', 'absentConjunction', 'empty', 'unknown']) verifyRepair(name, () => {
    const result = repairSelected[name]; assert.equal(result.exit, 0); assert.equal(result.receipt.status, 'complete');
    assert.equal(result.rows[0].structural.observation.seed, null);
    assert.equal(result.rows[0].structural.observation.status, 'unobserved');
    assert.equal(result.rows[0].structural.nomination.status, name === 'unknown' ? 'unknown' : 'measured_empty');
    assert.equal(result.receipt.rows[0].status, name === 'unknown' ? 'structure_unknown' : 'structure_unobserved');
    if (name === 'empty') { assert.equal(result.rows[0].windows.length, 0); assert.equal(result.receipt.structural_reads[0].ledger.accounting.source_reads, 0); }
    else { assert.ok(result.rows[0].windows.length > 0); assert.equal(result.rows[0].captures[0].witness.length, 0); }
  });
  verifyRepair('witnessed original amid supplemental members', () => {
    const result = repairSelected.multi; assert.equal(result.receipt.acquisitions, 4); assert.equal(result.rows.length, 2);
    for (const row of result.rows) {
      const id = row.structural.observation.seed.record_id;
      assert.ok(row.captures[0].witness.some(w => w.source.target.root_id === id));
      assert.equal(row.structural.nomination.status, 'witnessed'); assert.equal(row.structural.observation.status, 'observed');
      assert.equal(row.structural.observation.edges.length, 1);
    }
    assert.deepEqual(repairSelected.absentOff.rows[0].windows, repairSelected.absentLegacy.rows[0].windows);
    assert.deepEqual(repairSelected.absentOff.rows[0].solved.rows, repairSelected.absentLegacy.rows[0].solved.rows);
    const subset = repairSelected.subset.rows[0], subsetSeed = repairMessages.find(m => m.question_id === repairFixture[0].question_id && m.message_index === 1).record.identity;
    assert.equal(subset.captures[0].witness.length, 1); assert.equal(subset.pool.length, 3);
    assert.notEqual(subset.pool[0].record_id, subsetSeed); assert.equal(subset.structural.observation.seed.record_id, subsetSeed);
    assert.equal(subset.structural.observation.edges.length, 2);
    assert.equal(repairSelected.partial.rows[0].structural.nomination.completion, 'partial');
    assert.equal(repairSelected.partial.rows[0].structural.nomination.status, 'witnessed');
    assert.equal(repairSelected.failedAcquisition.receipt.status, 'stopped');
    assert.equal(repairSelected.failedAcquisition.receipt.observation_scans.length, 0);
  });
  for (const name of ['legacyThrow', 'legacyNull', 'noMetadataThrow', 'noMetadataNull', 'legacyLimited', 'legacyStale', 'legacyDenied', 'legacyMisbound']) verifyRepair(name, () => {
    const result = repairSelected[name]; assert.equal(result.receipt.status, 'stopped'); assert.equal(result.rows.length, 0);
    const delivery = result.receipt.delivery_reads[0]; assert.equal(delivery.ordinal, 1); assert.equal(delivery.arm, 'supplied');
    assert.equal(delivery.accounting.source_reads, 1); assert.equal(delivery.accounting.requested_prefix_bytes, 4096);
    const lost = name.endsWith('Throw') || name.endsWith('Null');
    assert.equal(delivery.accounting.unmetered_reads, lost ? 1 : 0); assert.equal(delivery.accounting.status, lost ? 'partial' : 'complete');
    assert.ok(result.hidden_meter.native_bytes > 0);
    if (!lost) { assert.equal(delivery.accounting.native_bytes, result.hidden_meter.native_bytes); assert.equal(delivery.accounting.metadata_bytes, result.hidden_meter.metadata_bytes); }
    assert.equal(result.receipt.observation_scans.length, name.startsWith('noMetadata') ? 0 : 1);
    if (!name.startsWith('noMetadata')) assert.equal(result.receipt.observation_scans[0].accounting.source_reads, 3);
  });
  for (const name of ['structureDeliveryThrow', 'structureDeliveryNull']) verifyRepair(name, () => {
    const result = repairSelected[name], delivery = result.receipt.delivery_reads[0], ledger = result.receipt.structural_reads[0].ledger;
    assert.equal(result.receipt.status, 'stopped'); assert.equal(result.receipt.observation_scans[0].status, 'complete');
    assert.equal(delivery.accounting.source_reads, 1); assert.equal(delivery.accounting.unmetered_reads, 1);
    assert.equal(delivery.accounting.status, 'partial'); assert.equal(delivery.reused_delivery_reads, 1);
    assert.equal(ledger.accounting.source_reads, 4); assert.equal(ledger.accounting.unmetered_reads, 1);
    assert.equal(ledger.accounting.native_bytes, result.receipt.observation_scans[0].accounting.native_bytes);
    assert.ok(result.hidden_meter.native_bytes > 0);
  });
  for (const name of ['noStructure', 'noMetadata', 'originalOnly', 'captureFailure', 'structureCaptureFailure']) verifyRepair(name, () => {
    const result = repairSelected[name], delivery = result.receipt.delivery_reads[0], structure = name === 'originalOnly' || name === 'structureCaptureFailure';
    assert.equal(delivery.accounting.source_reads, structure ? 2 : 3); assert.equal(delivery.accounting.status, 'complete');
    assert.equal(delivery.reused_delivery_reads, structure ? 1 : 0);
    if (structure) {
      const scan = result.receipt.observation_scans[0].accounting, total = result.receipt.structural_reads[0].ledger.accounting;
      for (const field of ['source_reads', 'native_bytes', 'metadata_bytes', 'requested_prefix_bytes']) assert.equal(total[field], scan[field] + delivery.accounting[field]);
    }
    if (name.endsWith('Failure')) { assert.equal(result.receipt.status, 'stopped'); assert.equal(result.rows.length, 0); }
  });
  verifyRepair('row and arm association', () => {
    const multi = repairSelected.multiDeliveryFailure.receipt;
    assert.equal(multi.rows.length, 1); assert.equal(multi.rows[0].ordinal, 1);
    assert.deepEqual(multi.delivery_reads.map(row => [row.ordinal, row.arm, row.accounting.source_reads]), [[1, 'supplied', 2], [2, 'supplied', 1]]);
    assert.equal(multi.structural_reads[1].ledger.accounting.unmetered_reads, 1);
    const arms = repairSelected.armDeliveryFailure.receipt;
    assert.deepEqual(arms.delivery_reads.map(row => [row.arm, row.accounting.source_reads, row.accounting.unmetered_reads]), [['original', 3, 0], ['mechanical', 1, 1]]);
    assert.equal(arms.rows.length, 1); assert.equal(arms.rows[0].arm, 'original');
    assert.equal(repairSelected.structureThrow.receipt.structural_reads[0].ledger.accounting.unmetered_reads, 1);
  });
  // No label access until all success and failure captures have frozen.
  assertCodeFrozen();
  const message = messages[1], spans = [{ session_index: 0, message_index: 1, source_id: message.record.source_id,
    target: { workspace_id: workspace, root_kind: 'source_record', root_id: neighbor,
      source_version: message.record.source_version, content_digest: message.record.content_digest }, start: 0, end: Buffer.byteLength(texts[1]) }];
  write(join(root, 'gold.json'), { rows: [{ arm: 'C', visibility: { gold_messages: { annotated: 1, complete: true }, messages: spans } }] });
  write(join(root, 'labels.json'), [{ ordinal: 1, path: join(root, 'gold.json') }]);
  const evaluations = {};
  for (const name of ['baseline', 'structural', 'conjunction', 'unbound', 'gapped', 'unrelated']) {
    await run(['--import', preload, cli, '--evaluate', join(root, name), '--labels', join(root, 'labels.json'), '--out', join(root, `${name}-evaluation.json`)]);
    evaluations[name] = json(join(root, `${name}-evaluation.json`));
  }
  for (const metric of ['any_at_5', 'all_at_5', 'any_at_10', 'all_at_10']) {
    assert.equal(evaluations.structural.rows[0].visibility[metric].status, 'hit');
    assert.equal(evaluations.baseline.rows[0].visibility[metric].status, 'miss');
    assert.equal(evaluations.conjunction.rows[0].visibility[metric].status, 'miss');
    for (const name of ['gapped', 'unrelated']) {
      assert.equal(evaluations[name].rows[0].status, 'complete'); assert.equal(evaluations[name].rows[0].visibility[metric].status, 'miss');
    }
  }
  assert.equal(evaluations.unbound.rows[0].visibility, null);
  assert.equal(evaluations.unbound.summary[0].status, 'unavailable');
  const repairLabels = repairFixture.map((q, i) => {
    const m = repairMessages.find(m => m.question_id === q.question_id && m.message_index === 1), r = m.record;
    const path = join(root, `repair-gold-${i}.json`);
    write(path, { rows: [{ arm: 'C', visibility: { gold_messages: { annotated: 1, complete: true }, messages: [{ session_index: 0, message_index: 1,
      source_id: r.source_id, target: { workspace_id: r.workspace_id, root_kind: 'source_record', root_id: r.identity,
        source_version: r.source_version, content_digest: r.content_digest }, start: 0, end: Buffer.byteLength(q.haystack_sessions[0][1].content) }] } }] });
    return { ordinal: i + 1, path };
  });
  write(join(root, 'repair-labels.json'), repairLabels);
  const repairEvaluations = {};
  for (const name of ['absent', 'empty', 'unknown', 'absentConjunction', 'absentOff', 'absentLegacy', 'multi', 'partial']) {
    const output = join(root, `repair-${name}-evaluation.json`);
    const result = await run(['--import', preload, cli, '--evaluate', join(root, `repair-${name}`), '--labels', join(root, 'repair-labels.json'), '--out', output], null);
    repairEvaluations[name] = existsSync(output) ? json(output) : { exit: result.code };
    verifyRepair(`${name} frozen evaluation`, () => {
      assert.equal(result.code, 0);
      const evaluated = repairEvaluations[name], unavailable = ['absent', 'empty', 'unknown', 'absentConjunction'].includes(name);
      assert.equal(evaluated.summary[0].denominator, name === 'multi' ? 2 : 1);
      if (unavailable) { assert.equal(evaluated.rows[0].visibility, null); assert.equal(evaluated.summary[0].status, 'unavailable'); assert.equal(evaluated.summary[0].metrics, null); }
      else for (const row of evaluated.rows) for (const metric of ['any_at_5', 'any_at_10', 'all_at_5', 'all_at_10']) assert.equal(row.visibility[metric].status, 'hit');
    });
  }
  await run(['--import', preload, cli, '--evaluate', join(root, 'seed-null'), '--labels', join(root, 'must-not-read-labels'), '--out', join(root, 'must-not-score.json')], 2);
  assert.equal(existsSync(join(root, 'must-not-score.json')), false);
  assert.equal(hash(readFileSync(preparation.snapshotPath)), artifact.manifest.db_sha256);
  assert.equal(hash(readFileSync(product)), baseline.rows[0].snapshot_sha256);
  assertCodeFrozen();
  proof = { kind: 'authored-structural-navigation-compiled-sqlite-cli', code_binding: codeBinding, fixture, manifest: artifact.manifest,
    compiled_cli_sha256: hash(readFileSync(cli)), inputs_frozen_before_capture: true, captures, invocations, evaluations, faults,
    repair: { fixture: repairFixture, cases: repairCases, evaluations: repairEvaluations, failures: repairFailures },
    gold: { spans, fixed_message_index: 1 }, peak_scratch_bytes: peak, provider_calls: 0, model_calls: 0, embedding_calls: 0,
    natural_data_reads: 0, lexical_fixture_writes: texts.length + repairMessages.length, source_records_unchanged: true, support: 'unknown', natural_benefit: 'NOT_VERIFIED' };
} finally {
  rmSync(root, { recursive: true, force: true });
  assert.deepEqual(safe.violations, []); assert.deepEqual(strict.forbidden, []); strict.restore(); safe.restore();
}
assert.equal(existsSync(root), false); proof.scratch_removed = true;
if (process.argv[2]) write(process.argv[2], proof);
assert.deepEqual(repairFailures, [], 'seed admission and delivery accounting regressions');
console.log(JSON.stringify({ status: 'passed', scratch_removed: true, provider_calls: 0 }));
