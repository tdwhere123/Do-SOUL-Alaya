// Install credential denial and loopback/no-redirect isolation before application imports.
import { isolation } from './frozen-answer-guard.mjs';
process.env.NODE_ENV = 'test';
process.env.ALAYA_ALLOW_PRIVATE_PROVIDER_URL = 'true';
const { default: assert } = await import('node:assert/strict');
const fs = await import('node:fs');
const { join } = await import('node:path');
const { tmpdir } = await import('node:os');
const { createServer } = await import('node:http');
const { captures, issueFixture } = await import('./frozen-answer-fixture.mjs');
const { materializeFrozenAnswers, FROZEN_ANSWER_KIND } = await import('../../../dist/runs/frozen-answer/input.js');
const { runFrozenAnswerCommand } = await import('../../../dist/runs/frozen-answer/command.js');
const { prepareSemanticProviderRequest } = await import('../../../dist/runs/compile-seed/http/semantic-provider-http.js');
const { executeProviderChatCompletion } = await import('@do-soul/alaya-engine-gateway');
const scratch = fs.mkdtempSync(join(tmpdir(), 'frozen-answer-request-capture-'));
const received = [], mutations = [];
let phase = 'idle', ready = () => {}, liveSchema;
const server = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  assert.equal(req.headers.authorization, 'Bearer');
  received.push(body);
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: '{"answer":"literal answer"}' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 17, completion_tokens: 9, total_tokens: 26 } }) + '\n\ndata: [DONE]\n\n');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
const make = name => {
  const home = join(scratch, name); fs.mkdirSync(home);
  const captureRoot = join(home, 'captures'); captures(captureRoot);
  return issueFixture(home, captureRoot);
};
const encode = (selected, line) => prepareSemanticProviderRequest(selected, { ...line, retryMode: 'disabled',
  outputTokenField: 'max_tokens', validateRawJson: () => undefined }, FROZEN_ANSWER_KIND);
async function command(fixture) {
  let stdout = ''; const output = process.stdout.write;
  process.stdout.write = chunk => { stdout += chunk; return true; };
  let exit;
  try {
    exit = await runFrozenAnswerCommand(['--grant', fixture.pin.path, '--grant-sha256', fixture.pin.sha256, '--mode', 'execute'], {
      loadConfig: () => fixture.selected,
      createExtractor: pinned => ({
        // Match the independent reproduction's readiness microtask timing.
        assertTransportReady: async () => { ready(); },
        extract: async input => {
          const prepared = prepareSemanticProviderRequest(pinned, input, FROZEN_ANSWER_KIND);
          liveSchema = input.responseJsonSchema; phase = 'prepared';
          const execution = await executeProviderChatCompletion({ ...prepared.gatewayRequest, apiKey: '',
            fetchImpl: async (url, init) => {
              assert.equal(url, `${pinned.providerUrl}/chat/completions`); assert.equal(init.redirect, 'error');
              phase = 'encoded'; return fetch(endpoint, init);
            } }, { maxRetries: 0, retryDelaysMs: [] });
          const result = execution.result;
          return { rawJson: result.text, responseMetadata: { finishReason: result.finishReason },
            usage: result.usage, httpResponse: result.httpResponse };
        }
      })
    });
  } finally { process.stdout.write = output; }
  return { exit, result: JSON.parse(stdout) };
}
try {
  const baseline = make('baseline'), originalConfig = structuredClone(baseline.selected);
  const expected = baseline.lines.map(line => encode(originalConfig, line).body);
  // Literal baseline pins are independent of any new capture implementation.
  assert.deepEqual(JSON.parse(expected[0]).response_format.json_schema.schema,
    { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false });
  assert.equal(baseline.lines[0].requestDigest, '84d72c5cd61dac96e6757f9088f6f59e7e5b1d8c68ded65977d608ff2dabd484');
  const control = await command(baseline);
  assert.equal(control.exit, 0); assert.deepEqual(received, expected);

  const fixture = make('alias-mutation'), alias = fixture.lines[0].responseJsonSchema;
  const independent = materializeFrozenAnswers(fixture.grant.capture_root, fixture.selected, 128);
  const selected = structuredClone(fixture.selected), start = received.length;
  ready = () => queueMicrotask(() => queueMicrotask(() => {
    const at = phase;
    const aliasChanged = Reflect.set(alias.properties.answer, 'description', 'MUTATED_AFTER_ADMISSION');
    // The directly reachable extractor consumer must not be able to alter the captured schema either.
    const liveChanged = Reflect.set(liveSchema.properties.answer, 'description', 'MUTATED_AFTER_ADMISSION');
    mutations.push({ phase: at, aliasChanged, liveChanged });
    fixture.selected.model = 'caller-still-owns-config';
    phase = 'mutation-attempted';
  }));
  const changed = await command(fixture);
  ready = () => {};
  const sent = received.slice(start), fresh = materializeFrozenAnswers(fixture.grant.capture_root, selected, 128);
  const report = { status: sent.length === 2 && sent.every((body, i) => body === expected[i]) ? 'passed' : 'failed',
    mutations, loopback_requests: received.length, command_exit: changed.exit,
    rows: changed.result.rows.map(row => row.status), successful_shards: changed.result.ledger.successfulShards,
    old_request_digest: fixture.lines[0].requestDigest, recorded_request_digest: changed.result.rows[0].terminal?.request_digest,
    exact_authorized_bodies: sent.length === 2 && sent.every((body, i) => body === expected[i]),
    natural_calls: 0, credential_reads: 0, isolation_violations: isolation.violations };
  console.log(JSON.stringify(report));
  assert.equal(changed.exit, 0); assert.deepEqual(sent, expected);
  assert.equal(changed.result.ledger.successfulShards, 2);
  assert.deepEqual(mutations, [{ phase: 'prepared', aliasChanged: false, liveChanged: false },
    { phase: 'prepared', aliasChanged: false, liveChanged: false }]);
  for (const line of [...fixture.lines, ...independent, ...fresh]) {
    assert.ok([line, line.responseJsonSchema, line.responseJsonSchema.properties,
      line.responseJsonSchema.properties.answer, line.responseJsonSchema.required].every(Object.isFrozen));
  }
  assert.notEqual(alias, fixture.lines[1].responseJsonSchema);
  assert.notEqual(alias, independent[0].responseJsonSchema);
  assert.notEqual(alias.properties.answer, independent[0].responseJsonSchema.properties.answer);
  for (const lines of [independent, fresh]) {
    assert.deepEqual(lines.map(line => encode(selected, line).body), expected);
    assert.deepEqual(lines.map(line => [line.key, line.requestDigest, line.inputByteUpper]),
      baseline.lines.map(line => [line.key, line.requestDigest, line.inputByteUpper]));
  }
  assert.equal(Object.isFrozen(fixture.selected), false);
  assert.equal(fixture.selected.model, 'caller-still-owns-config');
  assert.deepEqual(isolation.violations, []);
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  fs.rmSync(scratch, { recursive: true, force: true }); isolation.restore();
}
