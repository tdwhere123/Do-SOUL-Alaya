# Post-Port Hygiene Closeout

Status: implementation-ready.

## Scope

- Card: `docs/v0.1/post-port-hygiene-briefs/task-postv01-hygiene-wave.md`
- Port mode: `adapt-and-port`
- Source lineage:
  - `vendor/do-what-new-snapshot/packages/protocol/src/events/phase-*.ts`
  - Current Alaya production files listed in task section 2.2
- Durable contract guard: no event string values, SQLite schemas,
  MCP/CLI wire contracts, or durable EventLog data changed.

## Delivered

- Renamed 17 protocol event modules from upstream `phase-*` names to
  Alaya domain names, including exported enums, schemas, parser helpers,
  protocol event tests, root exports, and downstream imports.
  `@do-soul/alaya-protocol` is private, so no legacy `Phase*` aliases
  were retained; any out-of-repo TypeScript consumer must switch imports
  to the domain-named exports in this wave.
- Split the eight listed production TypeScript files to the 800-line
  hygiene threshold or below:
  - `apps/core-daemon/src/index.ts` -> 797 lines
  - `apps/core-daemon/src/tool-runtime.ts` -> 453 lines
  - `apps/core-daemon/src/routes/runs.ts` -> 177 lines
  - `apps/core-daemon/src/mcp-catalog.ts` -> 622 lines
  - `packages/storage/src/repos/memory-entry-repo.ts` -> 794 lines
  - `packages/storage/src/repos/garden-data-ports.ts` -> 592 lines
  - `packages/core/src/recall-service.ts` -> 768 lines
  - `packages/core/src/serial-delegation-recovery.ts` -> 793 lines
- Added pinned `knip` (`6.11.0`), root `hygiene:unused`, and
  `knip.json`.
- Removed command-proven unused dependencies:
  - root `zod-to-json-schema`
  - `apps/inspector/web` `@testing-library/jest-dom`
- Refreshed `docs/v0.1/INDEX.md`, backlog, runtime status, code map,
  phase-to-domain mapping, and README wording from future-scheduled
  cleanup to executed cleanup.

## Verification

- `rtk pnpm install --frozen-lockfile` - passed.
- `rtk pnpm build` - passed.
- Event string comparison against `HEAD` - passed:
  `event_value_compare=ok domains=17`.
- Stale source sweep for `Phase*`, `phase-*` event imports, and
  `events/phase` - no stale event symbols/imports; remaining matches are
  docs-path strings inside docs-lock tests.
- Line-count gate for the eight listed production files - all at or
  below 800 lines.
- `rtk pnpm exec vitest run --project @do-soul/alaya-protocol` - passed;
  61 files / 520 tests.
- `rtk pnpm exec vitest run --project @do-soul/alaya-core` - passed;
  68 files / 599 tests.
- `rtk pnpm exec vitest run --project @do-soul/alaya-storage` - passed;
  45 files / 324 tests.
- `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon` -
  failed once on a docs-lock expectation after the Phase 4 README wording
  changed, then passed after updating the expected line; 44 files /
  242 tests.
- `rtk pnpm run hygiene:unused` - passed with no knip residue.
- Worker 4 independently ran `rtk pnpm run hygiene:unused` and
  `rtk git diff --check`; both passed with no removal proposal.
- `rtk pnpm exec vitest run` - passed; 248 files / 1917 tests.

## Doctor Caveat

`rtk pnpm alaya doctor` was executed and returned exit 75:
`doctor overall: degraded`. A second run with
`ALAYA_OPENAI_SECRET_REF=env:OPENAI_API_KEY OPENAI_API_KEY=test-openai-key`
still returned exit 75 because the fresh CLI runtime had no Garden
background pass yet:

- runtime ready: yes
- storage schema_ok: yes (`persisted=57`, `expected=57`)
- MCP transport: ready
- embedding provider_configured: yes in the seeded run
- garden status: degraded

This wave did not change doctor semantics. The full E2E suite still
proves `alaya doctor --workspace workspace-1 --json` exits 0 after an
in-process Garden pass.

## Review Status

- Spec compliance review: 0 Blocking / 0 Important.
- TypeScript/interface review: 0 Blocking / 0 Important; one
  nice-to-have migration note addressed in this report.
- PR-style correctness review: initial pass found one Important docs
  drift in `#BL-016`; it was fixed in `docs/handbook/backlog.md` and
  targeted re-review closed with 0 Blocking / 0 Important.

## Deferred

No implementation scope is deferred from this hygiene wave.
