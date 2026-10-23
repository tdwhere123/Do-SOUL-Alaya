// Install transport/credential guards and a model-construction tripwire before
// importing application modules. This never replaces a changed navigation owner.
await import('./strict-provider-free-cli-bootstrap.mjs');
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';
import childProcess from 'node:child_process';
registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (!url.endsWith('/embedding-recall/local-onnx-embedding-client.js')) return result;
  const source = String(result.source), marker = 'constructor(options = {}) {';
  if (!source.includes(marker)) throw new Error('model constructor guard did not bind');
  return { ...result, source: source.replace(marker, `${marker} throw new Error('frozen entry constructed a model client');`) };
} });
const { SourceIndexAcquisition, LocalOnnxEmbeddingClient } = await import('@do-soul/alaya-core');
const { SqliteSourceIndexRepository, SqliteFieldSourceRecordRepo } = await import('@do-soul/alaya-storage');
const forbidden = [], trace = [];
const deny = name => () => { forbidden.push(name); throw new Error(`frozen entry touched ${name}`); };
SourceIndexAcquisition.prepareQuery = deny('prepareQuery');
SourceIndexAcquisition.prototype.captureNative = deny('captureNative');
LocalOnnxEmbeddingClient.prototype.bindSourceEmbedding = deny('bindSourceEmbedding');
for (const name of ['readLexicalCandidates', 'readVectorCandidates', 'begin', 'select', 'capturePage', 'writeDocument', 'writeLexical', 'writeVector', 'activate']) {
  if (typeof SqliteSourceIndexRepository.prototype[name] === 'function') SqliteSourceIndexRepository.prototype[name] = deny(name);
}
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[name] = deny(name);
const originalWrite = fs.writeFileSync;
const fault = process.env.ALAYA_AUTHORED_FROZEN_FAULT;
let located = false, prefixes = 0;
for (const method of ['findCurrentBounded', 'findByIdBounded']) {
  const original = SqliteFieldSourceRecordRepo.prototype[method];
  SqliteFieldSourceRecordRepo.prototype[method] = function(...args) {
    const result = original.apply(this, args);
    const entry = { method, requested_bytes: args[2], offset: args[3], native_bytes: result?.nativeBytes,
      metadata_bytes: result?.metadataBytes, dependency_work: result?.dependencyWork };
    trace.push(entry);
    if (method === 'findCurrentBounded' && args[2] === 1) located = true;
    if (method !== 'findByIdBounded') return result;
    if (args[2] === 4096 && ++prefixes === 2 && fault === 'prefix-null') return null;
    if (located && args[3] > 0 && fault === 'anchor-throw') throw new Error('authored located hydration lost its final meter');
    return result;
  };
}
if (fault === 'publication') fs.writeFileSync = function(path, ...args) {
  if (String(path).endsWith('/002-window-native-anchor.json')) throw new Error('authored frozen capture publication failure');
  return originalWrite.call(this, path, ...args);
};
syncBuiltinESMExports();
process.on('exit', () => {
  const path = process.env.ALAYA_AUTHORED_FROZEN_TRACE;
  if (path) originalWrite(path, JSON.stringify({ forbidden, trace }));
  if (forbidden.length) process.exitCode = 1;
});
