// Authored encoder substitution only; application binding, loaded runtime and IPC remain real.
import childProcess from 'node:child_process';
import workerThreads from 'node:worker_threads';
import { appendFileSync } from 'node:fs';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { installProviderFreeBoundary } from './provider-free-boundary.ts';
import { installStrictProviderFreeBoundary } from './strict-provider-free-boundary.ts';
const safe = installProviderFreeBoundary();
// Real credentials are removed before imports. Daemon may inspect absent credential names
// and install its synthetic local fixture authentication; no real credential is accessible.
const filtered = process.env;
const strict = installStrictProviderFreeBoundary();
process.env = filtered;
const encoder = new URL('../../../../../packages/core/src/__tests__/embedding-recall/local-onnx-authored-transformers.mjs', import.meta.url).href;
registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@huggingface/transformers' && context.conditions.includes('import')) {
    return { url: encoder, shortCircuit: true };
  }
  return next(specifier, context);
} });
const log = row => {
  if (process.env.ALAYA_AUTHORED_ENCODER_LOG) appendFileSync(process.env.ALAYA_AUTHORED_ENCODER_LOG,
    JSON.stringify({ pid: process.pid, ...row }) + '\n');
};
log({ kind: 'guard_installed', credential_names: Object.keys(process.env).filter(key => /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/iu.test(key)) });
const fork = childProcess.fork;
childProcess.fork = function(script, args, options) {
  if (!String(script).endsWith('/local-onnx-process/child.js')) throw new Error('unexpected authored proof fork');
  const child = fork(script, args, { ...options, execArgv: ['--import', import.meta.url] });
  log({ kind: 'fork', child: child.pid, script: String(script) });
  child.on('message', message => log({ kind: 'ipc_response', child: child.pid, message }));
  child.on('exit', (code, signal) => log({ kind: 'child_exit', child: child.pid, code, signal }));
  return child;
};
const Worker = workerThreads.Worker;
workerThreads.Worker = class extends Worker {
  constructor(script, options) { super(script, { ...options, execArgv: ['--import', import.meta.url] }); }
};
syncBuiltinESMExports();
process.on('exit', () => {
  log({ kind: 'guard_exit', violations: [...safe.violations, ...strict.forbidden] });
  if (safe.violations.length || strict.forbidden.length) process.exitCode = 1;
});
