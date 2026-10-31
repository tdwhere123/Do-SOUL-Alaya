import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runExtractionFill } from '../../../../runs/extraction/extraction-fill.js';
import { inspectExtractionAuthority, readCurrentExtractionAuthorityRevision } from '../../../../runs/extraction/authority/inspection.js';
import { createExtractionAuthorityReceipt, writeExtractionAuthorityReceipt } from '../../../../runs/extraction/authority/receipt.js';
import { inspectExtractionAttemptLedger, readExtractionAttemptLedger } from '../../../../runs/extraction/authority/attempt-ledger.js';
import { EXTRACTION_OPEN_SEMANTICS_GENERATION } from '../../../../runs/extraction/request-artifact.js';
import { cacheFilePath, inspectCachedExtractionArtifact } from '../../../../runs/compile-seed/cache/cache-shard.js';
import { buildAuthorityQuestion, registerExtractionFillHooks, setExtractionCredentialFixture, buildGroundedInterpretationResponse } from '../../extraction-fill/fixture.js';
import { createGardenHttpExtractor } from '../../../../runs/compile-seed/compile-seed-http.js';
import { buildOfficialApiSourceCorpus, parseOfficialApiSourcePacketRequest, parseSourceSemanticRequest } from '@do-soul/alaya-soul';
import { sourceReferenceResolver } from '@do-soul/alaya-protocol';
import { fieldContractSha256 } from '@do-soul/alaya-core';
import { preflightExtractionBatch } from '../../../../runs/extraction/fill/batch-preflight.js';
import { tableCompletedResponse } from '../../extraction-fill/source-semantic-table-response.test-support.js';
import { authoredSourceCorpusFromRequest, writeAuthoredHistoricalBatchArtifacts } from '../../extraction-fill/historical-extraction-test-support.js';
import type { GeminiBatchLimits } from '../../../../runs/extraction/fill/batch/contract.js';

const MODEL = 'gemini-2.5-flash-lite';
const REQUEST_PROFILE = 'gemini-2.5-nonthinking-v1';
const PROFILE = { contract: 'source-interpretation-profile-v1' as const, description: 'Completed event structure',
  predicates: [{ symbol: 'complete', meaning: 'An actor completed a theme.', governing_roles: [] }],
  roles: [{ symbol: 'theme', meaning: 'The thing completed.' }] };
let cacheRoot: string, dataDir: string, pinnedMetaRoot: string;
const writeDataset = registerExtractionFillHooks(roots => ({ cacheRoot, dataDir, pinnedMetaRoot } = roots), 'longmemeval_s');
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function packetResponse(userPrompt: string) {
  const request = parseOfficialApiSourcePacketRequest(JSON.parse(userPrompt));
  const assertion = request.source_request.source_assertions.find(row => row.text.includes('completed'))!;
  const resolver = sourceReferenceResolver(request.source_catalog, fieldContractSha256);
  const theme = assertion.text.includes('alpha') ? 'alpha' : 'decoy';
  const mention = (id: string, text: string) => { const start = assertion.text.indexOf(text);
    return { id, assertion_id: assertion.assertion_id, source_ref: resolver.referenceForSpan(assertion.assertion_id, [start, start + text.length]) }; };
  return JSON.stringify({ contract: 'source-interpretation-response-v2', packet: {
    contract: 'source-interpretation-v2', profile_id: request.profile_id, source_catalog_id: request.source_catalog.catalog_id,
    mentions: [mention('m0', 'completed'), mention('m1', theme)], referents: [{ id: 'r0', mentions: ['m1'] }],
    propositions: [{ id: 'p0', predicate: 'complete', implicit: false, predicate_mentions: ['m0'],
      assertion_ids: [assertion.assertion_id], arguments: [{ role: 'theme', target: 'r0' }] }], operators: [], roots: ['p0'] } });
}

function semanticResponse(userPrompt: string) {
  const request = parseSourceSemanticRequest(JSON.parse(userPrompt));
  const assertion = request.source_request.source_assertions.find(row => row.text.includes('completed'))!;
  const theme = assertion.text.includes('alpha') ? 'alpha' : 'decoy';
  return JSON.stringify(tableCompletedResponse(assertion.assertion_id, theme));
}

it.each(['open_semantics', 'source_packet', 'ordinary'] as const)(
  'requires durable attempt and usage admission when reopening %s Batch artifacts', async mode => {
    setExtractionCredentialFixture();
    vi.stubEnv('OFFICIAL_API_GARDEN_MODEL', MODEL);
    vi.stubEnv('ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE', REQUEST_PROFILE);
    vi.stubEnv('OFFICIAL_API_GARDEN_PROVIDER_URL', 'https://fixture-provider.invalid');
    await writeDataset([buildAuthorityQuestion('authored', 'alpha', 'decoy')]);
    const extra = mode === 'open_semantics' ? { openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION, sourcePacking: 'reference-eight' as const }
      : mode === 'source_packet' ? { sourceInterpretationProfile: PROFILE, sourcePacking: 'reference-eight' as const }
        : { sourcePacking: 'reference-eight' as const };
    const inspection = await inspectExtractionAuthority({ variant: 'longmemeval_s', cacheRoot, dataDir, pinnedMetaRoot,
      ...extra, revision: readCurrentExtractionAuthorityRevision(), action: 'fill' });
    const receipt = createExtractionAuthorityReceipt({ action: 'fill', observation: inspection.observation,
      outputTokenCap: { field: 'maxOutputTokens', value: 4096 }, diskFloorBytes: 0,
      priceEstimate: { inputUsdPerMillion: 1, outputUsdPerMillion: 2, maximumInputTokensPerAttempt: 100000 }, inspection });
    const limits: GeminiBatchLimits = { maxJobs: 1, maxRequestsPerJob: 100, maxFileBytes: 1000000,
      maxInputTokensPerJob: 1000000, maxEnqueuedTokens: 1000000, maxOutputTokens: 4096,
      maxUsd: receipt.price.estimated_upper_usd, inputUsdPerMillion: 1, outputUsdPerMillion: 2,
      deadlineMs: 60000, requestTimeoutMs: 5000, maxPolls: 10 };
    const report = await preflightExtractionBatch({ variant: 'longmemeval_s', cacheRoot, dataDir, pinnedMetaRoot,
      ...extra, batch: { operation: 'prepare', limits } });
    const responses = new Map(report.planned_requests.map(line => [line.key,
      mode === 'open_semantics' ? semanticResponse(line.userPrompt)
        : mode === 'source_packet' ? packetResponse(line.userPrompt)
          : '{"interpretations":[{"assertion_id":1,"relations":[{"predicate":{"text":"completed"},"arguments":[],"qualifiers":[]}]}]}']));
    const facts = ['I completed alpha.', 'I completed decoy.'];
    const candidates = facts.flatMap(fact => {
      const messages = [{ role: 'user' as const, content: fact }, { role: 'assistant' as const, content: 'Acknowledged.' }];
      return [fact, `User: ${fact}`, `User: ${fact}\nAssistant: Acknowledged.`,
        buildOfficialApiSourceCorpus(fact, messages),
        buildOfficialApiSourceCorpus(fact, [{ role: 'user', content: fact }]),
        buildOfficialApiSourceCorpus(`${fact}\nAcknowledged.`, messages)];
    });
    writeAuthoredHistoricalBatchArtifacts({
      cacheRoot, receipt, lines: report.planned_requests, responses, limits,
      mode, sourcePacking: 'reference-eight',
      sourceCorpusForLine: line => mode === 'ordinary' ? '' : authoredSourceCorpusFromRequest(line.userPrompt, candidates),
      ...(mode === 'open_semantics' ? { generation: EXTRACTION_OPEN_SEMANTICS_GENERATION } : {}),
      ...(mode === 'source_packet' ? { sourceInterpretationProfile: PROFILE } : {})
    });
    const key = report.planned_requests[0]!.key;
    const ledgerPath = join(cacheRoot, `extraction-attempt-ledger.${receipt.lineage_digest}.json`);
    const ledgerInput = { cacheRoot, lineageDigest: receipt.lineage_digest,
      cacheIdentity: { model: MODEL, requestProfile: REQUEST_PROFILE } } as const;
    const typed = mode === 'ordinary' ? undefined : mode;
    const baseline = inspectCachedExtractionArtifact(cacheRoot, key, MODEL, REQUEST_PROFILE, typed);
    expect(baseline.status, JSON.stringify(baseline)).toBe('hit');
    const baselineBytes = readFileSync(ledgerPath, 'utf8');
    const results = [];
    for (const damage of ['usage_witness_missing', 'unresolved_original_attempt', 'ledger_missing'] as const) {
      const ledger = JSON.parse(baselineBytes);
      if (damage === 'usage_witness_missing') {
        for (const settled of ledger.settled_attempts) delete settled.usage_sha256;
      } else if (damage === 'unresolved_original_attempt') {
        const reservation = ledger.settled_attempts.find((row: { cache_key: string }) => row.cache_key === key);
        ledger.settled_attempts = ledger.settled_attempts.filter((row: { cache_key: string }) => row.cache_key !== key);
        ledger.unresolved_attempts = [{ cache_key: key, attempt_ordinal: reservation.attempt_ordinal }];
        ledger.successful_shards = ledger.successful_shards.filter((row: { cacheKey: string }) => row.cacheKey !== key);
        ledger.pending_keys = [key];
        ledger.telemetry.input_tokens -= 10; ledger.telemetry.output_tokens -= 20; ledger.telemetry.total_tokens -= 30;
      }
      if (damage === 'ledger_missing') {
        const { renameSync } = await import('node:fs');
        renameSync(ledgerPath, `${ledgerPath}.retained`);
      } else writeFileSync(ledgerPath, JSON.stringify(ledger));
      const cache = inspectCachedExtractionArtifact(cacheRoot, key, MODEL, REQUEST_PROFILE, typed);
      let durable, admission;
      try { durable = inspectExtractionAttemptLedger(ledgerInput); admission = readExtractionAttemptLedger(ledgerInput); }
      catch (cause) { admission = { error: String(cause) }; }
      results.push({ damage, status: cache.status, durable, admission });
      writeFileSync(ledgerPath, baselineBytes);
    }
    const shardPath = cacheFilePath(cacheRoot, key);
    const shardBytes = readFileSync(shardPath, 'utf8');
    for (const damage of ['changed_transport', ...(mode === 'ordinary' ?
      ['missing_attempt', 'missing_retained_batch'] as const : [])]) {
      const shard = JSON.parse(shardBytes);
      if (damage === 'changed_transport') shard.transport_provenance.provider_url_sha256 = `sha256:${'f'.repeat(64)}`;
      if (damage === 'missing_attempt') delete shard.provider_attempt;
      if (damage === 'missing_retained_batch') delete shard.provider_batch;
      writeFileSync(shardPath, JSON.stringify(shard));
      const inspected = inspectCachedExtractionArtifact(cacheRoot, key, MODEL, REQUEST_PROFILE, typed);
      results.push({ damage, status: inspected.status });
      expect(inspected.status).not.toBe('hit');
      writeFileSync(shardPath, shardBytes);
    }
    expect.soft(results.find(row => row.damage === 'usage_witness_missing')?.status).not.toBe('hit');
    expect.soft(results.find(row => row.damage === 'unresolved_original_attempt')?.status).not.toBe('hit');
    expect.soft(results.find(row => row.damage === 'ledger_missing')?.status).not.toBe('hit');
  }, 60000
);

it('retains an exact settled usage witness for each new ordinary interactive success', async () => {
  const interactiveModel = 'gpt-5.4-mini';
  const interactiveProfile = 'provider-default-v1' as const;
  setExtractionCredentialFixture();
  vi.stubEnv('OFFICIAL_API_GARDEN_MODEL', interactiveModel);
  vi.stubEnv('ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE', interactiveProfile);
  vi.stubEnv('OFFICIAL_API_GARDEN_PROVIDER_URL', 'https://fixture-provider.invalid/v1');
  await writeDataset([buildAuthorityQuestion('ordinary-authored', 'alpha', 'decoy')]);
  const inspection = await inspectExtractionAuthority({ variant: 'longmemeval_s', cacheRoot, dataDir, pinnedMetaRoot,
    revision: readCurrentExtractionAuthorityRevision(), action: 'fill' });
  const receipt = createExtractionAuthorityReceipt({ action: 'fill', observation: inspection.observation,
    outputTokenCap: { field: 'max_tokens', value: 4096 }, diskFloorBytes: 0,
    priceEstimate: { inputUsdPerMillion: 1, outputUsdPerMillion: 2, maximumInputTokensPerAttempt: 100000 }, inspection });
  const authorityPath = join(cacheRoot, 'authority.json');
  writeExtractionAuthorityReceipt(authorityPath, receipt);
  let calls = 0;
  await runExtractionFill({ variant: 'longmemeval_s', cacheRoot, dataDir, pinnedMetaRoot,
    authorityReceiptPath: authorityPath, log: () => undefined,
    extractorFactory: config => createGardenHttpExtractor(config, { fetch: vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: readonly { content: string }[] };
      const prompt = body.messages.at(-1)?.content;
      if (typeof prompt !== 'string') throw new Error('fixture transport lost the request prompt');
      calls++;
      return Response.json({ choices: [{ message: { content: buildGroundedInterpretationResponse(prompt) },
        finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } });
    }) }) });
  const ledger = inspectExtractionAttemptLedger({ cacheRoot, lineageDigest: receipt.lineage_digest,
    cacheIdentity: { model: interactiveModel, requestProfile: interactiveProfile } })!;
  expect(calls).toBe(2);
  expect(ledger.successfulShards).toBe(2);
  expect(ledger.telemetry.totalTokens).toBe(60);
  expect(ledger.settledAttempts.every(row => row.usageSha256 !== undefined)).toBe(true);
}, 60000);
