// Authored native source/index/acquisition machinery, never a historical capture rerun.
// Import only after the provider/credential guards in the invoking proof or test.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { initDatabase, SqliteFieldSourceRecordRepo, SqliteSourceIndexRepository } from '@do-soul/alaya-storage';
import { fieldContractSha256, acquireProfiledSourceIndex, resolveSourceSemanticComparisonProfile } from '@do-soul/alaya-core';
import { hashSourceRecordId, hashContentDigest, SOURCE_SPAN_IDENTITY_OPERATOR_ID, UNKNOWN_UTTERANCE_ATTRIBUTION,
  sourceIndexTarget, prepareSourceIndexDocument, unavailableSourceQueryPreparation,
  SOURCE_SEMANTIC_PROFILED_ACCESS_CONTRACT, SOURCE_SEMANTIC_PROFILED_LIBRARY_RESULT_VERSION,
  SOURCE_SEMANTIC_PROFILED_LIBRARY_PROTOCOL_VERSION } from '@do-soul/alaya-protocol';
import { navigationInventory, solveConditionalNavigation } from '../../../dist/runs/source-access-diagnostic/conditional-navigation.js';
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const json = path => JSON.parse(readFileSync(path, 'utf8'));
export const write = (path, value) => writeFileSync(path, JSON.stringify(value));
export function frozenFixture(root, { windowBytes = 1024, emptyMembers = false, texts: authoredTexts } = {}) {
  mkdirSync(root);
  const snapshot = join(root, 'authored.sqlite'), workspace = 'authored-frozen-workspace', clock = '2026-09-22T00:00:00.000Z';
  const db = initDatabase({ filename: snapshot }), records = new SqliteFieldSourceRecordRepo(db, fieldContractSha256);
  const index = new SqliteSourceIndexRepository(db, fieldContractSha256);
  const texts = authoredTexts ?? Array.from({ length: emptyMembers ? 0 : 12 }, (_, i) => `needle ${i} ` + '前🙂'.repeat(windowBytes > 4096 ? 9400 : 1000) + ` AUTHORED-NATIVE-END-${i} 京都。`);
  const members = [], documents = [];
  const configuration = { revision: 'authored-frozen-source', profile: { provider_kind: 'authored-numerical-fixture', model_id: 'no-model',
    model_revision: 'raw-v1', artifact_digest: `sha256:${'a'.repeat(64)}`, tokenizer_revision: 'no-tokenizer', dimensions: 3,
    preprocessing: 'exact-utf8', normalization: 'none', max_input_tokens: 1024, windowing: 'utf8-byte-windows.v1', window_bytes: windowBytes } };
  const budget = { work: 10_000_000, native_bytes: 16 * 1024 ** 2 };
  let expected, captured, empty;
  try {
    db.connection.prepare(`INSERT INTO workspaces(workspace_id,name,root_path,workspace_kind,workspace_state,created_at)
      VALUES (?,?,?,'local_repo','active',?)`).run(workspace, 'Authored frozen', root, clock);
    for (const [i, text] of texts.entries()) {
      const source = { workspace_id: workspace, source_id: `authored-message-${i}`, source_version: 'authored-v1',
        content_digest: hashContentDigest(text, fieldContractSha256), evidence_object_id: null, recorded_at: clock, event_time: null,
        valid_from: null, valid_to: null, operator_id: SOURCE_SPAN_IDENTITY_OPERATOR_ID, speaker: 'user', scope_class: 'project',
        attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION, source_representation: { kind: 'original_body' }, source_body: text };
      const record = records.insert({ ...source, record_id: hashSourceRecordId(source, fieldContractSha256) });
      members.push(record);
      const target = sourceIndexTarget({ kind: 'source_evidence', workspace_id: workspace, root_kind: 'source_record', root_id: record.record_id,
        source_version: record.source_version, content_digest: record.content_digest, evidence_object_id: null }, record.source_id, Buffer.byteLength(text));
      assert.equal(index.writeLexical(target, text, budget).status, 'accepted');
    }
    const generation = index.begin(index.select(workspace, configuration));
    index.capturePage(workspace, generation.generation_id, 128, budget);
    for (const source of index.listTargets(workspace, generation.generation_id, null, 128)) {
      const read = index.readDocument(workspace, generation.generation_id, source.root_key, 4 * 1024 ** 2, budget);
      assert.equal(read.status, 'ready');
      const document = prepareSourceIndexDocument({ source, body: read.body, profile: configuration.profile }, fieldContractSha256);
      documents.push(document);
      assert.equal(index.writeDocument(workspace, generation.generation_id, document, budget).status, 'accepted');
      for (const window of document.windows) assert.equal(index.writeVector(workspace, generation.generation_id, { window_id: window.window_id,
        input_digest: window.content_digest, embedding: new Float32Array([windowBytes > 4096 && documents.length === 1 ? window.ordinal === 0 ? 10 : 1 : window.ordinal + 1, 1, 0]), token_count: 1, truncated: false }).status, 'accepted');
    }
    assert.equal(index.activate(workspace, generation.generation_id).status, 'accepted');
    const state = index.state(workspace), g = index.generation(workspace, generation.generation_id);
    expected = { configuration, config_id: state.selection.config_id, profile_id: state.selection.profile_id,
      selection_revision: state.selection.selection_revision, generation_id: g.generation_id, source_epoch: g.source_epoch,
      status: g.status, enumeration_complete: g.enumeration_complete, target_count: g.target_count, completed_count: g.completed_count };
    const profile = resolveSourceSemanticComparisonProfile({ comparison: { profile: { contract: SOURCE_SEMANTIC_PROFILED_ACCESS_CONTRACT,
      result_version: SOURCE_SEMANTIC_PROFILED_LIBRARY_RESULT_VERSION, protocol_version: SOURCE_SEMANTIC_PROFILED_LIBRARY_PROTOCOL_VERSION,
      order_policy: 'native-route-round-robin-v1', acquisition_policy: 'source-index-interleaved-prefix.v1', channels: 'dual',
      declared_allowance: { max_attempts: 128, max_roots: 16, max_vector_windows: 4096 } } } });
    const acquire = (navigation, vector) => acquireProfiledSourceIndex({ repository: index, workspace, sha256: fieldContractSha256,
      original: { navigation, vector }, profile, budget: { work_units: 50_000_000, memory_bytes: 60_000_000 }, admitScope: () => 'admitted' });
    captured = acquire('needle', { status: 'available', profile: configuration.profile, profile_id: expected.profile_id,
      input_digest: `sha256:${fieldContractSha256('needle')}`, embedding: new Float32Array([1, 0, 0]) });
    empty = acquire('quartzunmatchablesentinel', { status: 'unavailable', reason: 'authored_no_query_vector' });
    assert.ok(emptyMembers ? captured.witness.length === 0 : captured.witness.length > 16); assert.equal(empty.witness.length, 0);
  } finally { db.close({ optimize: false }); }
  const prep = navigation => ({ ...unavailableSourceQueryPreparation('authored numerical inputs; no inference', 'not_requested'),
    navigation_digest: `sha256:${fieldContractSha256(navigation)}`, selected: { selection_revision: expected.selection_revision,
      config_id: expected.config_id, profile_id: expected.profile_id, profile: expected.configuration.profile } });
  const queries = [{ condition: 'original', preparation: { ...prep('needle'), status: 'ready' }, phase: captured.phase, witness: captured.witness }];
  const unknownQueries = [{ condition: 'original', preparation: prep('quartzunmatchablesentinel'), phase: empty.phase, witness: empty.witness }];
  const input = { contract: 'benchmark-conditional-navigation.v1', source_revision: 'authored-historical-origin', cache_root: root, channels: 'dual',
    rows: Array.from({ length: 8 }, (_, i) => ({ ordinal: i + 1, question_id: `authored-${i + 1}`, snapshot, snapshot_sha256: hash(readFileSync(snapshot)),
      workspace, interpretation_clock: clock, authorized_scopes: ['project'], expected_index: expected, original: 'original',
      conditions: [{ id: 'original', object: 'query', hypothesis: 'authored', query: 'needle', status: 'ready', residual: null, provenance: 'authored-before-labels' }], branches: [] })) };
  return { input, queries, unknownQueries, members, texts, documents };
}
/** Author the explicit pre-arm compatibility envelope using a genuine full native
 * witness. Poison previews prove that delivery never consumes stored prefixes. */
export function freezeFixture(home, fixture, mutate = () => {}) {
  mkdirSync(home);
  const input = structuredClone(fixture.input), perRow = input.rows.map(() => structuredClone(fixture.queries));
  mutate(input, perRow);
  write(join(home, 'input.json'), input);
  const rows = input.rows.map((row, i) => {
    const captures = perRow[i], inventory = navigationInventory(captures), solved = solveConditionalNavigation({ ...row, ...inventory });
    const path = `${String(row.ordinal).padStart(3, '0')}.json`;
    write(join(home, path), { ordinal: row.ordinal, question_id: row.question_id, captures, pool: inventory.pool,
      occurrences: inventory.occurrences, solved, windows: [{ text: 'POISON_STORED_PREFIX_MUST_NOT_BE_DELIVERED' }],
      interpretation_clock: row.interpretation_clock, inventory: 'admitted_nomination_union', tail: { status: 'unknown', reason: 'not_a_delivery_input' } });
    return { ordinal: row.ordinal, question_id: row.question_id, path, sha256: hash(readFileSync(join(home, path))) };
  });
  const receipt = { contract: input.contract, source_revision: input.source_revision, status: 'complete', failure: null, rows,
    input_sha256: hash(readFileSync(join(home, 'input.json'))), local_query_inputs: 8, external_calls: 0, index_builds: 0 };
  write(join(home, 'receipt.json'), receipt);
  return { ...input, source_revision: 'authored-current-execution', frozen_nominations: { family: 'conditional-navigation-pilot.v1',
    receipt: { path: join(home, 'receipt.json'), sha256: hash(readFileSync(join(home, 'receipt.json'))) }, byte_budget: 8192 } };
}
export function removeLocations(queries, all = false) {
  const first = queries[0].witness.find(hit => hit.route.kind === 'vector').source.target.root_id;
  queries[0].witness = queries[0].witness.map(hit => hit.route.kind === 'vector' && (all || hit.source.target.root_id === first)
    ? { ...hit, route: { ...hit.route, window: { status: 'unavailable', reason: 'authored_location_not_retained' } } } : hit);
  queries[0].phase.result.occurrence_prefix = queries[0].witness.slice(0, 16);
}
