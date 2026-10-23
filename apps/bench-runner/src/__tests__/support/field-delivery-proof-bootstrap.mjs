// Authored numerical inputs only. No model, embedding runtime or transport is invoked.
// Native SQLite scoring, nomination, source admission and byte locations are untouched.
await import('./strict-provider-free-cli-bootstrap.mjs');
import { writeFileSync } from 'node:fs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const { SourceIndexAcquisition, fieldContractSha256 } = await import('@do-soul/alaya-core');
const { unavailableSourceQueryPreparation } = await import('@do-soul/alaya-protocol');
const { SqliteFieldSourceRecordRepo, SqliteSourceIndexRepository } = await import('@do-soul/alaya-storage');
const originalPrepare = SourceIndexAcquisition.prepareQuery;
SourceIndexAcquisition.prepareQuery = async function(input, control) {
  if (control === 'lexical') return originalPrepare.call(this, input, control);
  if (input.selection?.configuration.profile.provider_kind !== 'authored-numerical-fixture') {
    throw new Error('Only independently authored numerical profiles are permitted');
  }
  return { vector: { status: 'available', profile: input.selection.configuration.profile, profile_id: input.selection.profile_id,
    input_digest: `sha256:${fieldContractSha256(input.navigation)}`, embedding: new Float32Array([1, 0, 0]) },
    receipt: { ...unavailableSourceQueryPreparation('authored-numerical-input', 'not_requested'),
      status: 'ready', reason: 'authored_numerical_fixture_no_inference', navigation_digest: `sha256:${fieldContractSha256(input.navigation)}` } };
};
const fault = process.env.ALAYA_AUTHORED_DELIVERY_FAULT;
if (fault?.startsWith('composed-')) {
  const trace = [], save = () => writeFileSync(process.env.ALAYA_AUTHORED_DELIVERY_TRACE, JSON.stringify(trace));
  let located = 0;
  for (const method of ['findCurrentBounded', 'findByIdBounded']) {
    const original = SqliteFieldSourceRecordRepo.prototype[method];
    SqliteFieldSourceRecordRepo.prototype[method] = function(...args) {
      // Acquisition's independent four-byte qualification probes are not part of
      // the observation/seed/delivery ledger. Native hydration probes one byte.
      if (method === 'findCurrentBounded' && args[2] !== 1) return original.apply(this, args);
      if (method === 'findCurrentBounded') located++;
      const result = original.apply(this, args);
      trace.push({ method, located, requested_bytes: args[2], offset: args[3], native_bytes: result?.nativeBytes,
        metadata_bytes: result?.metadataBytes, dependency_work: result?.dependencyWork }); save();
      if (located !== 2 || !result?.record) return result;
      if (method === 'findCurrentBounded' && fault === 'composed-stale') {
        return { ...result, record: { ...result.record, source_version: 'changed' } };
      }
      if (method !== 'findByIdBounded') return result;
      if (fault === 'composed-throw') throw new Error('authored located read meter lost');
      if (fault === 'composed-null') return null;
      if (fault === 'composed-limited') return { ...result, resourceLimited: true };
      return result;
    };
  }
  if (fault === 'composed-capture') {
    const original = fs.writeFileSync;
    fs.writeFileSync = function(path, ...args) {
      if (String(path).endsWith('/001.json')) throw new Error('authored composed capture publication failure');
      return original.call(this, path, ...args);
    };
    syncBuiltinESMExports();
  }
  if (fault === 'composed-unknown') {
    const original = SqliteSourceIndexRepository.prototype.readLexicalCandidates;
    SqliteSourceIndexRepository.prototype.readLexicalCandidates = function(...args) {
      const result = original.apply(this, args);
      return args[1] === 'unmatchablequartzsentinel' ? { ...result, completion: 'partial', reason: 'authored incomplete original' } : result;
    };
  }
} else if (['partial-location', 'original-location', 'compared-location'].includes(fault)) {
  const original = SourceIndexAcquisition.prototype.captureNative;
  let acquisitions = 0;
  SourceIndexAcquisition.prototype.captureNative = function(...args) {
    const captured = original.apply(this, args);
    acquisitions++;
    // Remove a location only after actual capture; other arms retain their native witnesses.
    if (fault === 'original-location' && acquisitions !== 1 || fault === 'compared-location' && acquisitions === 1) return captured;
    const first = captured.retained.find(hit => hit.route.kind === 'vector')?.source.target.root_id;
    return { ...captured, retained: captured.retained.map(hit => hit.source.target.root_id === first && hit.route.kind === 'vector'
      ? { ...hit, route: { ...hit.route, window: { status: 'unavailable', reason: 'authored_lost_location_after_native_capture' } } } : hit) };
  };
} else if (fault === 'capture' || fault === 'capture-second') {
  const original = fs.writeFileSync;
  fs.writeFileSync = function(path, ...args) {
    if (String(path).endsWith(fault === 'capture' ? '/001.json' : '/002.json')) throw new Error('authored capture publication failure');
    return original.call(this, path, ...args);
  };
  syncBuiltinESMExports();
} else if (fault) {
  const original = SqliteFieldSourceRecordRepo.prototype.findByIdBounded;
  SqliteFieldSourceRecordRepo.prototype.findByIdBounded = function(...args) {
    const result = original.apply(this, args);
    // Actual read costs exist before an injected boundary failure hides/changes the result.
    if (args[2] <= 1 || !result?.record) return result;
    writeFileSync(process.env.ALAYA_AUTHORED_DELIVERY_TRACE, JSON.stringify({ native_bytes: result.nativeBytes,
      metadata_bytes: result.metadataBytes, dependency_work: result.dependencyWork }));
    if (fault === 'throw') throw new Error('authored lost read meter');
    if (fault === 'null') return null;
    if (fault === 'scope') return { ...result, record: { ...result.record, scope_class: 'global_core' } };
    if (fault === 'content') return { ...result, record: { ...result.record, content_digest: `sha256:${'0'.repeat(64)}` } };
    throw new Error('unknown authored failure');
  };
}
