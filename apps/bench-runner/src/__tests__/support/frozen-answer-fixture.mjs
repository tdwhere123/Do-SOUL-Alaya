// Authored frozen files only: no SQLite, source acquisition, index or model construction.
// Import after provider-free-boundary installation.
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { sourceIndexTarget, sourceIndexProfileId, sourceIndexConfigurationId, sourceIndexGenerationId,
  unavailableSourceQueryPreparation } from '@do-soul/alaya-protocol';
import { navigationInventory, solveConditionalNavigation } from '../../../dist/runs/source-access-diagnostic/conditional-navigation.js';
import { frozenDeliveryPolicy } from '../../../dist/runs/source-access-diagnostic/conditional-navigation-input.js';
import { materializeFrozenAnswers } from '../../../dist/runs/frozen-answer/input.js';
import { FROZEN_ANSWER_ROOT_MARKER } from '../../../dist/runs/frozen-answer/authority.js';
import { initializeExtractionTargetRoot } from '../../../dist/runs/extraction/authority/target-root-binding.js';
import { openExtractionAttemptLedger } from '../../../dist/runs/extraction/authority/attempt-ledger.js';
import { writeExtractionAuthorityReceiptArtifactExclusive } from '../../../dist/runs/extraction/authority/receipt/artifact-io.js';
import { readCurrentExtractionAuthorityRevision } from '../../../dist/runs/extraction/authority/inspection.js';
import { nativeChatQuoteBasis } from '../../../dist/runs/extraction/authority/native-chat-quote.js';
import { STEP_OPENAPI_QUOTE_BASIS } from '../../../dist/runs/extraction/authority/step-quote.js';
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const json = path => JSON.parse(readFileSync(path, 'utf8'));
export const write = (path, value) => writeFileSync(path, JSON.stringify(value));
export const config = () => ({ model: STEP_OPENAPI_QUOTE_BASIS.selected_model,
  providerUrl: STEP_OPENAPI_QUOTE_BASIS.selected_provider_url,
  requestProfile: 'step-3.5-2603-low-json-schema-v1', apiKey: null });

export function captures(root, questions = 1) {
  mkdirSync(root);
  const workspace = 'authored-answer', clock = '2026-09-22T00:00:00.000Z';
  const configuration = { revision: 'authored-no-index', profile: { provider_kind: 'authored', model_id: 'no-model',
    model_revision: '1', artifact_digest: `sha256:${hash('authored')}`, tokenizer_revision: 'none', dimensions: 3,
    preprocessing: 'exact-utf8', normalization: 'none', max_input_tokens: 128, windowing: 'utf8-byte-windows.v1', window_bytes: 128 } };
  const expected = { configuration, profile_id: sourceIndexProfileId(configuration.profile, hash),
    config_id: sourceIndexConfigurationId(configuration, hash), selection_revision: 1, source_epoch: 1,
    status: 'ready', enumeration_complete: true, target_count: 2, completed_count: 2 };
  expected.generation_id = sourceIndexGenerationId({ ...expected, workspace_id: workspace }, 1, hash);
  const input = { contract: 'benchmark-conditional-navigation.v1', source_revision: 'authored-not-acquired', cache_root: root,
    channels: 'dual', frozen_nominations: { family: 'conditional-navigation-pilot.v1', receipt: { path: '/not-opened', sha256: hash('origin') },
      byte_budget: 24, comparison: 'balanced-prefix' }, rows: [] };
  const frozen = { family: 'conditional-navigation-pilot.v1', origin: { source_revision: 'authored-origin',
    receipt_sha256: hash('origin'), input_sha256: hash('origin-input') }, inherited_costs: { external_calls: 0, index_builds: 0 }, rows: [] };
  const refs = [];
  for (let ordinal = 1; ordinal <= questions; ordinal++) {
    const query = `What is in authored box ${ordinal}?`, texts = ['User: cedar.   END FIRST!', 'Assistant: red. END NEXT!'];
    const sources = texts.map((text, i) => sourceIndexTarget({ kind: 'source_evidence', workspace_id: workspace, root_kind: 'source_record',
      root_id: `sha256:${hash(`${ordinal}-${i}`)}`, source_version: 'authored-1', content_digest: `sha256:${hash(text)}`, evidence_object_id: null },
    `authored-${ordinal}-${i}`, Buffer.byteLength(text)));
    const witness = sources.map((source, i) => ({ reference: `authored-${i}`, attempt: i + 1, view: 'original', source,
      route: { kind: 'lexical', native_rank: i + 1, lane: 'unicode61', lane_rank: i + 1, bm25: -1 } }));
    const allowance = { max_attempts: 2, max_roots: 2, max_vector_windows: 0 };
    const preparation = { ...unavailableSourceQueryPreparation('authored frozen input', 'not_requested'), navigation_digest: `sha256:${hash(query)}`,
      selected: { selection_revision: 1, config_id: expected.config_id, profile_id: expected.profile_id, profile: configuration.profile } };
    const phase = { policy: 'source-index-interleaved-prefix.v1', channels: 'dual', declared_allowance: allowance, allowance,
      status: 'executed', reason: null, budget: { work_units: 100, memory_bytes: 10000 }, accounting: 'complete',
      result: { navigation_digest: preparation.navigation_digest, completion: 'complete', occurrence_prefix: witness,
        prefix_coverage: { kind: 'retained_occurrence_prefix', omitted_occurrences: 0 },
        counts: { attempts: 2, retained_occurrences: 2, distinct_roots: 2, duplicate_occurrences: 0, denied: 0, unknown: 0,
          nomination_limit: 0, resource_refused_before_start: 0, resource_refused_after_start: 0 },
        lanes: ['original', 'hint'].flatMap(view => ['lexical', 'vector'].map(route => {
          const active = view === 'original' && route === 'lexical';
          return { view, route, availability: active ? { status: 'captured', captured_occurrences: 2 } : { status: 'absent' },
            consumed_occurrences: active ? 2 : 0, remaining_captured_occurrences: 0, last_native_rank: active ? 2 : null };
        })), resources: { work: 0, memory_bytes: 0, native_bytes: 0, sql_internal_work: 'unknown' }, resource_refusals: [],
        lexical: { completion: 'complete', index_coverage: 'partial', reason: null, limitations: [], tokenization: null },
        vector: { completion: 'unavailable', state: null, reason: 'authored', inspected_windows: 0, invalid_windows: 0,
          validation: 'not_run', ranking: 'exact_over_inspected_subset', input: { status: 'unavailable', reason: 'authored' } }, limitations: [] } };
    const queries = [{ condition: 'original-id', preparation, phase, witness }];
    const row = { ordinal, question_id: `authored-question-${ordinal}`, snapshot: '/never-opened.sqlite', snapshot_sha256: hash('no-db'),
      workspace, interpretation_clock: clock, authorized_scopes: ['project'], expected_index: expected, original: 'original-id',
      conditions: [{ id: 'original-id', object: 'query', hypothesis: 'authored', query, status: 'ready', residual: null, provenance: 'authored' }], branches: [] };
    input.rows.push(row);
    const inventory = navigationInventory(queries), solved = solveConditionalNavigation({ ...row, ...inventory });
    frozen.rows.push({ ordinal, question_id: row.question_id, capture_sha256: hash(`capture-${ordinal}`), captures: queries, nomination: 'witnessed' });
    for (const arm of ['window-prefix', 'window-balanced-prefix']) {
      const lengths = arm === 'window-prefix' ? [24, 0] : [12, 12];
      const windows = sources.flatMap((source, i) => lengths[i] === 0 ? [] : [{ rank: i + 1, source_id: source.source_id, target: source.target,
        start: 0, end: lengths[i], text: texts[i].slice(0, lengths[i]),
        source_time: { contract: 'benchmark-session-observation.v1', recorded_at: clock, event_time: null, valid_from: null, valid_to: null,
          observation: { status: 'unknown', reason: 'artifact_not_bound' } },
        read: { status: 'complete', body_bytes: source.body_bytes, native_bytes: source.body_bytes } }]);
      const capture = { ordinal, question_id: row.question_id, arm, interpretation_clock: clock, captures: queries,
        pool: inventory.pool, occurrences: inventory.occurrences, solved, windows,
        frozen_nomination: { status: 'witnessed', capture_sha256: hash(`capture-${ordinal}`) },
        tail: { status: windows.length === 2 ? 'exhausted' : 'open', reason: 'authored' },
        field_delivery: { policy: frozenDeliveryPolicy(input, arm), status: 'complete', selection: { rows: solved.rows }, missing_locations: [],
          packing: { unique_utf8_bytes: 24, input_utf8_bytes: texts.reduce((n, text) => n + Buffer.byteLength(text), 0),
            byte_budget: 24, total_slots: 10, per_message_slots: 1, duplicate_input_bytes: 0,
            prefix_packing: sources.map((source, i) => ({ record_id: source.target.root_id, read_start: 0, read_end: source.body_bytes,
              status: lengths[i] === 0 ? 'omitted' : lengths[i] === source.body_bytes ? 'complete' : 'partial',
              delivered_start: lengths[i] === 0 ? null : 0, delivered_end: lengths[i] || null })) } } };
      const path = `${ordinal}-${arm}.json`; write(join(root, path), capture);
      refs.push({ ordinal, question_id: row.question_id, arm, status: 'complete', path, sha256: hash(readFileSync(join(root, path))) });
    }
  }
  write(join(root, 'input.json'), input); write(join(root, 'formations.json'), []); write(join(root, 'frozen-nominations.json'), frozen);
  write(join(root, 'receipt.json'), { status: 'complete', input_sha256: hash(readFileSync(join(root, 'input.json'))),
    formations_sha256: hash(readFileSync(join(root, 'formations.json'))), rows: refs,
    frozen_nominations: { artifact_sha256: hash(readFileSync(join(root, 'frozen-nominations.json'))), origin: frozen.origin, inherited_costs: frozen.inherited_costs } });
}

// Test-only external issuer. Production adapter deliberately cannot call this.
export function issueFixture(home, captureRoot, options = {}) {
  const executionRoot = join(home, 'ledger');
  const rootBinding = initializeExtractionTargetRoot({ cacheRoot: executionRoot, marker: FROZEN_ANSWER_ROOT_MARKER, purpose: 'authored external issuer' });
  const selected = config(), lines = materializeFrozenAnswers(captureRoot, selected, 128), lineage = hash(home);
  openExtractionAttemptLedger({ cacheRoot: executionRoot, lineageDigest: lineage, cacheIdentity: { model: selected.model, requestProfile: selected.requestProfile },
    startingMissing: lines.length, maximumAttempts: lines.length, successfulShardCeiling: lines.length, maximumAttemptsPerKey: 1 });
  const quote = nativeChatQuoteBasis(selected.requestProfile, selected.model, selected.providerUrl);
  const grant = { contract: 'frozen-delivery-answer.v1', issuer: 'authored-fixture-not-real-issuance', study_id: home,
    implementation_revision: readCurrentExtractionAuthorityRevision(), capture_root: captureRoot, execution_root: executionRoot,
    root_binding: rootBinding, lineage, model: selected.model, provider_url: selected.providerUrl, request_profile: selected.requestProfile,
    decoding: { temperature: 'provider-default', seed: 'provider-default' },
    limits: { max_output_tokens: 128, maximum_input_tokens_per_attempt: Math.max(...lines.map(line => line.inputByteUpper)),
      maximum_windows: 10, maximum_attempts: lines.length, maximum_attempts_per_key: 1, concurrency: 1,
      wall_ms: options.wallMs ?? 10000, spend_ceiling_usd: 1 },
    price: { input_usd_per_million: quote.input_usd_equivalent_per_million, output_usd_per_million: quote.output_usd_equivalent_per_million, quote_basis: quote },
    tasks: lines.map(line => ({ task: line.task, key: line.key, request_digest: line.requestDigest })),
    history: { scope: 'external-reviewed-known-closures-not-universal', evidence: [], closed_tasks: [], closed_keys: [] } };
  const path = join(home, 'external-grant.json');
  writeExtractionAuthorityReceiptArtifactExclusive(path, grant, lineage);
  return { grant, lines, selected, pin: { path, sha256: hash(readFileSync(path)) } };
}
