import { parentPort, workerData } from 'node:worker_threads';
import { initDatabase, SqliteSourceIndexRepository, SqliteSignalRepo, SqliteMemoryEntryRepo } from '@do-soul/alaya-storage';
import { fieldContractSha256 } from '@do-soul/alaya-core';
const database = initDatabase({ filename: workerData.filename });
try {
  const index = new SqliteSourceIndexRepository(database, fieldContractSha256);
  const lexical = index.readLexicalCandidates(workerData.workspace, workerData.query, 10,
    { work_units: 1000000, memory_bytes: 16 * 1024 * 1024 });
  const admitted = lexical.candidates.map(({ source }) => ({ source,
    result: index.admitQueryCandidate(source, null, { work_units: 1000000, memory_bytes: 16 * 1024 * 1024 }) }));
  const memories = [];
  for (const id of workerData.memoryIds ?? []) {
    try {
      const memory = await new SqliteMemoryEntryRepo(database).findById(id);
      memories.push({ object_id: id, status: 'available', content: memory?.content, lifecycle_state: memory?.lifecycle_state });
    } catch (error) { memories.push({ object_id: id, status: 'unavailable', code: error.code }); }
  }
  parentPort.postMessage({ targets: admitted.filter(row => row.result.status === 'ready').map(row => row.source), memories,
    statementCandidateStates: admitted.filter(row => row.source.auxiliary !== undefined).map(row => row.result.status),
    ...(workerData.signalRunId === undefined ? {} : { signals: await new SqliteSignalRepo(database).listByRun(workerData.signalRunId) }),
    raw: database.connection.prepare('SELECT source_body FROM source_records WHERE record_id=?').get(workerData.rootId) });
} finally { database.close(); }
