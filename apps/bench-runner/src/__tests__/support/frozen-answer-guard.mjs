// Shared pre-import loopback/no-redirect and credential-file/environment isolation.
// Unlike the historical CLI fixture bootstrap, this creates no credential sentinel.
import { installProviderFreeBoundary } from './provider-free-boundary.ts';
export const isolation = installProviderFreeBoundary({ ownedTemporaryFixtures: true });
process.on('exit', () => { if (isolation.violations.length) process.exitCode = 1; });
