// The guard is installed before ANY application import; there are no credential sentinels.
import { isolation } from './frozen-answer-guard.mjs';
process.env.NODE_ENV = 'test';
process.env.ALAYA_ALLOW_PRIVATE_PROVIDER_URL = 'true';
const { default: assert } = await import('node:assert/strict');
const fs = await import('node:fs');
const { default: mutableFs } = await import('node:fs');
const { syncBuiltinESMExports } = await import('node:module');
const { join } = await import('node:path');
const { tmpdir } = await import('node:os');
const { createServer } = await import('node:http');
const { config, captures, issueFixture, hash, json, write } = await import('./frozen-answer-fixture.mjs');
const { runFrozenAnswerCommand } = await import('../../../dist/runs/frozen-answer/command.js');
const { consumeFrozenAnswers } = await import('../../../dist/runs/frozen-answer/execute.js');
const { materializeFrozenAnswers, FROZEN_ANSWER_KIND } = await import('../../../dist/runs/frozen-answer/input.js');
const { readFrozenAnswerResult } = await import('../../../dist/runs/frozen-answer/persist.js');
const { prepareSemanticProviderRequest } = await import('../../../dist/runs/compile-seed/http/semantic-provider-http.js');
const { executeProviderChatCompletion, ProviderChatCompletionError, providerExecutionFailureOf } = await import('@do-soul/alaya-engine-gateway');
const { mapGardenHttpAttemptFailure, toBenchTransportFailureAttempt } = await import('../../../dist/runs/compile-seed/http/garden-http-failure-attempt.js');
const { wrapGardenHttpTransportError } = await import('../../../dist/runs/compile-seed/http/garden-http-terminal-error.js');
const { providerRawAttemptPath } = await import('../../../dist/runs/extraction/fill/provider-raw-attempt.js');
const root = fs.mkdtempSync(join(tmpdir(), 'authored-frozen-answer-'));
const checks = [], received = [];
let response = 'success', ready = () => {}, onRequest = () => {};
const server = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  assert.equal(req.headers.authorization, 'Bearer');
  received.push({ url: req.url, body }); onRequest();
  if (response === 'hang') return;
  const answer = response === 'rejected' ? '{"not_answer":"no"}' : '{"answer":"  Cedar; partial evidence.\\n"}';
  const packet = { choices: [{ delta: { content: answer }, finish_reason: response === 'incomplete' ? 'length' : 'stop' }],
    ...(response === 'unknown' ? {} : { usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } }) };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(`data: ${JSON.stringify(packet)}\n\ndata: [DONE]\n\n`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
// Test dependency adapter: credential-free native encoder + native zero-retry HTTP
// sender. Only transport destination is redirected to the authored server, before
// the mandatory loopback/no-redirect fetch guard. Production secret loading is not used.
function dependencies(selected) {
  return { loadConfig: () => selected, createExtractor: pinned => ({
    assertTransportReady: async () => { await ready(); },
    extract: async input => {
      const request = prepareSemanticProviderRequest(pinned, input, FROZEN_ANSWER_KIND).gatewayRequest;
      try {
        const execution = await executeProviderChatCompletion({ ...request, apiKey: '',
          fetchImpl: async (url, init) => {
            assert.equal(url, `${selected.providerUrl}/chat/completions`);
            assert.equal(init.redirect, 'error');
            return fetch(endpoint, init);
          } }, { maxRetries: 0, retryDelaysMs: [] });
        const result = execution.result;
        return { rawJson: result.text, responseMetadata: { finishReason: result.finishReason },
          usage: result.usage, httpResponse: result.httpResponse };
      } catch (cause) {
        const error = mapGardenHttpAttemptFailure(cause, cause instanceof ProviderChatCompletionError ? cause.httpStatus : null,
          { timedOut: cause.kind === 'timeout', aborted: cause.kind === 'aborted' });
        const failure = toBenchTransportFailureAttempt(error, 0);
        throw wrapGardenHttpTransportError(error, providerExecutionFailureOf(cause)?.retryClassification ?? 'failure_non_retryable_response',
          0, 0, failure ? [failure] : []);
      }
    }
  }) };
}
const make = (name, options) => {
  const home = join(root, name); fs.mkdirSync(home);
  const captureRoot = join(home, 'captures'); captures(captureRoot);
  return issueFixture(home, captureRoot, options);
};
const consume = (fixture, mode = 'execute', signal) => consumeFrozenAnswers({ grantPin: fixture.pin, mode,
  ...(signal ? { abortSignal: signal } : {}) }, dependencies(fixture.selected));
try {
  const cohortRoot = join(root, 'all-eight-authored'); captures(cohortRoot, 8);
  const cohort = materializeFrozenAnswers(cohortRoot, config(), 128);
  assert.equal(cohort.length, 16); assert.equal(new Set(cohort.map(line => line.key)).size, 16);
  assert.ok(cohort.every(line => line.inputByteUpper > 24 + 256));
  assert.equal(JSON.parse(cohort[0].userPrompt).question, 'What is in authored box 1?');
  assert.equal(JSON.parse(cohort[0].userPrompt).windows[0].text, 'User: cedar.   END FIRST');
  checks.push('all-eight authored paired admission; exact question/windows and metadata accounting');

  const good = make('success');
  const originalBodies = good.lines.map(line => prepareSemanticProviderRequest(good.selected, { ...line, retryMode: 'disabled',
    outputTokenField: 'max_tokens', validateRawJson: () => undefined }, FROZEN_ANSWER_KIND).body);
  let stdout = ''; const output = process.stdout.write;
  process.stdout.write = chunk => { stdout += chunk; return true; };
  try { assert.equal(await runFrozenAnswerCommand(['--grant', good.pin.path, '--grant-sha256', good.pin.sha256, '--mode', 'execute'],
    dependencies(good.selected)), 0); } finally { process.stdout.write = output; }
  const completed = JSON.parse(stdout);
  assert.equal(completed.ledger.attempts, 2); assert.equal(completed.ledger.successfulShards, 2);
  assert.equal(completed.rows[0].terminal.outcome.answer, '  Cedar; partial evidence.\n');
  assert.deepEqual(received.map(row => row.body), originalBodies);
  assert.equal(completed.ledger.telemetry.inputTokens, 22);
  const raw = json(providerRawAttemptPath(good.grant.execution_root, good.lines[0].key, 1));
  assert.equal(raw.kind, 'frozen_delivery_answer'); assert.ok(raw.http_response.bodyComplete);
  assert.equal((await consume(good)).attempts_this_invocation, 0); assert.equal(received.length, 2);
  const terminalPath = join(good.grant.execution_root, `${good.lines[0].key}.answer.json`), originalTerminal = json(terminalPath);
  const missingUsage = { ...originalTerminal }; delete missingUsage.usage; write(terminalPath, missingUsage);
  assert.throws(() => readFrozenAnswerResult(good.grant.execution_root, good.grant, good.lines[0]), /terminal\/raw binding/);
  write(terminalPath, originalTerminal);
  checks.push('compiled CLI arguments -> admission -> native loopback HTTP -> raw/ledger/terminal; exact bodies; no trim/retry');

  const selectedPath = join(good.grant.capture_root, '1-window-prefix.json');
  const selectedCapture = json(selectedPath); selectedCapture.labels = { answer: 'LABEL_POISON' };
  selectedCapture.windows[0].reviewer_advice = 'LABEL_POISON'; write(selectedPath, selectedCapture);
  const receiptPath = join(good.grant.capture_root, 'receipt.json'), receipt = json(receiptPath);
  receipt.rows[0].sha256 = hash(fs.readFileSync(selectedPath)); write(receiptPath, receipt);
  assert.deepEqual(materializeFrozenAnswers(good.grant.capture_root, good.selected, 128).map(line => line.key), good.lines.map(line => line.key));
  assert.ok(!good.lines.some(line => line.userPrompt.includes('LABEL_POISON')));
  selectedCapture.windows[0].end++; write(selectedPath, selectedCapture);
  receipt.rows[0].sha256 = hash(fs.readFileSync(selectedPath)); write(receiptPath, receipt);
  assert.throws(() => materializeFrozenAnswers(good.grant.capture_root, good.selected, 128), /literal window/);
  checks.push('label/advice isolation; resealed malformed capture refused by semantic pre-label admission');

  const refusal = make('refusal');
  await assert.rejects(consume({ ...refusal, pin: { ...refusal.pin, sha256: '0'.repeat(64) } }), /pin mismatch/);
  const badGrant = structuredClone(refusal.grant); badGrant.history.closed_tasks = [badGrant.tasks[0].task];
  write(refusal.pin.path, badGrant);
  await assert.rejects(consume({ ...refusal, pin: { ...refusal.pin, sha256: hash(fs.readFileSync(refusal.pin.path)) } }), /known closed/);
  write(refusal.pin.path, { ...refusal.grant, limits: { ...refusal.grant.limits, max_output_tokens: 64 } });
  await assert.rejects(consume({ ...refusal, pin: { ...refusal.pin, sha256: hash(fs.readFileSync(refusal.pin.path)) } }), /request binding/);
  checks.push('external pin required; known closures and request/cap drift refused before HTTP');

  const moved = make('root-refusal'), movedRoot = `${moved.grant.execution_root}-moved`;
  fs.renameSync(moved.grant.execution_root, movedRoot); fs.mkdirSync(moved.grant.execution_root);
  await assert.rejects(consume(moved), /root changed/);
  fs.rmSync(moved.grant.execution_root, { recursive: true }); fs.renameSync(movedRoot, moved.grant.execution_root);
  fs.unlinkSync(join(moved.grant.execution_root, `extraction-attempt-ledger.${moved.grant.lineage}.json`));
  await assert.rejects(consume(moved), /ledger missing/);
  const duringWait = make('root-during-readiness');
  ready = async () => {
    fs.renameSync(duringWait.grant.execution_root, `${duringWait.grant.execution_root}-moved`);
    fs.mkdirSync(duringWait.grant.execution_root);
  };
  const attemptsBefore = received.length;
  await assert.rejects(consume(duringWait), /root|lease|changed/);
  assert.equal(json(join(`${duringWait.grant.execution_root}-moved`, `extraction-attempt-ledger.${duringWait.grant.lineage}.json`)).attempts, 0);
  assert.equal(received.length, attemptsBefore); ready = () => {};
  checks.push('same grant root replacement, async root drift and deleted-ledger reset refused');

  const mutation = make('async-mutation');
  const before = received.length;
  ready = async () => {
    await Promise.resolve(); mutation.selected.model = 'mutated-model'; mutation.pin.path = '/mutated-grant';
    // The source path changes after validation. Already bound request bytes win.
    write(join(mutation.grant.capture_root, 'input.json'), {});
  };
  const stableConfig = { ...mutation.selected };
  const mutated = await consumeFrozenAnswers({ grantPin: mutation.pin, mode: 'execute' }, {
    loadConfig: () => mutation.selected, createExtractor: pinned => dependencies(stableConfig).createExtractor(pinned) });
  assert.equal(mutated.rows.filter(row => row.status === 'answered').length, 2);
  assert.equal(received.length - before, 2); ready = () => {};
  checks.push('async caller config/grant-path/capture mutation cannot change captured send material');

  for (const outcome of ['unknown', 'rejected', 'incomplete']) {
    response = outcome; const fixture = make(outcome), count = received.length;
    const result = await consume(fixture);
    assert.equal(result.ledger.attempts, 1); assert.equal(received.length - count, 1);
    assert.equal(result.rows[1].status, 'unattempted');
    assert.equal(result.rows[0].status, outcome === 'unknown' ? 'unknown_usage' : outcome);
    assert.equal((await consume(fixture)).ledger.attempts, 1);
    assert.equal(received.length - count, 1);
    if (outcome === 'unknown') assert.equal(result.ledger.telemetry.usageUnknownAttempts, 1);
    if (outcome === 'rejected') {
      const path = join(fixture.grant.execution_root, `${fixture.lines[0].key}.answer.json`), terminal = json(path);
      write(path, { ...terminal, outcome: { status: 'answered', answer: 'forged terminal' } });
      assert.equal(readFrozenAnswerResult(fixture.grant.execution_root, fixture.grant, fixture.lines[0]).status, 'rejected');
      write(path, terminal);
    }
  }
  checks.push('unknown usage stops new dispatch; schema rejection/noncomplete remain distinct; no retry');

  response = 'hang';
  const cancelled = make('cancel'), controller = new AbortController();
  onRequest = () => controller.abort();
  const cancellation = await consume(cancelled, 'execute', controller.signal);
  assert.equal(cancellation.ledger.attempts, 1); assert.equal(cancellation.ledger.successfulShards, 0);
  assert.equal(cancellation.rows[1].status, 'unattempted'); onRequest = () => {};
  const deadline = await consume(make('deadline', { wallMs: 100 }));
  assert.equal(deadline.ledger.attempts, 1); assert.equal(deadline.rows[1].status, 'unattempted');
  checks.push('caller cancellation and phase deadline cover in-flight native HTTP; reservations/cost unknown survive');

  response = 'success';
  const partial = make('publication'), originalLink = mutableFs.linkSync;
  mutableFs.linkSync = function(from, to) {
    if (String(to).endsWith('.answer.json')) throw Object.assign(new Error('authored publication interruption'), { code: 'EACCES' });
    return originalLink(from, to);
  }; syncBuiltinESMExports();
  let interrupted;
  try { interrupted = await consume(partial); } finally { mutableFs.linkSync = originalLink; syncBuiltinESMExports(); }
  assert.equal(interrupted.ledger.attempts, 1); assert.equal(interrupted.ledger.unresolvedAttempts.length, 1);
  assert.equal(interrupted.rows[0].status, 'pending');
  const prior = received.length, recovered = await consume(partial, 'recover');
  assert.equal(received.length, prior); assert.equal(recovered.rows[0].status, 'answered');
  assert.equal(recovered.rows[1].status, 'unattempted'); assert.equal(recovered.ledger.telemetry.inputTokens, 11);
  fs.unlinkSync(providerRawAttemptPath(partial.grant.execution_root, partial.lines[0].key, 1));
  assert.equal(readFrozenAnswerResult(partial.grant.execution_root, partial.grant, partial.lines[0]).status, 'incomplete');
  await assert.rejects(consume(partial), /closure drifted/); assert.equal(received.length, prior);
  checks.push('raw-first partial publication recovers only with native replay; missing raw never success or replacement send');

  const loader = make('loader'); let errorText = ''; const errorOutput = process.stderr.write;
  process.stderr.write = chunk => { errorText += chunk; return true; };
  try { assert.equal(await runFrozenAnswerCommand(['--grant', loader.pin.path, '--grant-sha256', loader.pin.sha256, '--mode', 'execute']), 2); }
  finally { process.stderr.write = errorOutput; }
  assert.match(errorText, /credential loader refuses test context/);
  checks.push('default credential loader refuses test context before credential access');
  assert.deepEqual(isolation.violations, []);
  console.log(JSON.stringify({ status: 'passed', checks, loopback_requests: received.length, natural_calls: 0,
    credential_reads: 0, index_builds: 0, isolation_violations: isolation.violations }));
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true }); isolation.restore();
}
