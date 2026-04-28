// Vitest workspace shell for Do-SOUL Alaya monorepo.
// Each package adds its own vitest.config.* under packages/<pkg>/ during port.
// The workspace entry list is intentionally empty here and grows as P1+ port
// task cards land each package's test config.

export default [
  // "packages/protocol/vitest.config.ts",   // populated by P1-protocol
  // "packages/storage/vitest.config.ts",    // populated by P1-storage-shared / P2-repos-*
  // "packages/core/vitest.config.ts",       // populated by P2-svc-*
  // "packages/soul/vitest.config.ts",       // populated by P2-garden-*
  // "packages/engine-gateway/vitest.config.ts",  // populated by P1-engine-gateway
  // "apps/core-daemon/vitest.config.ts",         // populated by P4-daemon-core
];
