# Gate-6 Closeout Report

Status: PASS for Gate-6 release acceptance.
Date: 2026-05-06.
Controller branch: `p6-closeout-review` from `main` at `592a7a5`.

This report closes the Phase 6 MCP Agent-Use Protocol + Trustworthy
Memory Loop acceptance scope. It proves the release-acceptance state for
the v0.1.1 scope; npm publish/version stamping was not performed in this
branch.

## Scope

- Backfilled eight active task cards under `docs/v0.1/phase-6-briefs/`.
- Backfilled eight completion reports under
  `docs/v0.1/phase-6-briefs/reports/`.
- Kept benchmark cards archived-only under `_archive/`; active Gate-6
  acceptance uses no benchmark leaderboard or harness requirement.
- Reviewed Phase 6 commits `b443c89` and `592a7a5`, plus current
  README, runtime-status, INDEX, task-card, report, package, and CLI/MCP
  claims.

## Review/Fix Loop

Round 1 produced six Blocking findings and one Important finding:
`MF-B1` through `MF-B6` and `MF-I1`. Root causes and fix ownership are
tracked in ignored review files:

- `.do-it/phase-6-review/merged-findings.md`
- `.do-it/phase-6-review/fix-plan.md`

Fix closure:

- `MF-B3`: storage accept/apply now reloads the pending proposal row and
  validates workspace, target object, and persisted `proposed_changes`
  before mutation.
- `MF-B5`: cwd local workspace startup now converges on duplicate
  first-start create races.
- `MF-B2`: profile launcher resolution covers repo source, repo dist,
  and installed package dist layouts.
- `MF-B4` and Round-2 `RT-B1`: trusted run validation is centralized in
  `resolveTrustedCliRunId` and used by `mcp stdio`, `tools call`,
  explicit/default run ids, `ALAYA_RUN_ID`, and `review --run`.
- `MF-B6`: attached `mcp stdio` startup/close and Garden background
  lifecycle are covered through `cli-register` tests and live smoke.
- `MF-I1`: README and README.zh-CN now use the recall-first operator
  sequence: recall delivery -> usage receipt -> candidate signal ->
  proposal -> accepted proposal -> durable memory application ->
  post-apply recall / usage proof.

Round-2 re-review closed domain-language and correctness findings.
Round-3 red-team re-review closed `RT-B1` with zero Blocking /
Important findings. Final spec/install re-review is recorded under
`.do-it/phase-6-review/round-4/` after this report was added.

Residual deferrals: none. Nice-to-have findings: none.

## Verification

Branch verification:

- `rtk pnpm build` passed.
- `rtk pnpm test` passed: 266 files, 2081 tests.
- `rtk git diff --check` passed.
- `rtk pnpm --dir apps/core-daemon pack --dry-run --json` passed after
  build; package contents include `bin/alaya.mjs` and `dist/**`.

Targeted verification:

- `rtk pnpm exec vitest run --project @do-soul/alaya-protocol -- mcp-types`
  passed: 63 files, 535 tests.
- `rtk pnpm exec vitest run --project @do-soul/alaya-storage -- proposal`
  passed: 46 files, 344 tests.
- `rtk pnpm exec vitest run --project @do-soul/alaya-core -- memory-service recall workspace-service`
  passed: 70 files, 637 tests.
- `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon -- cli-tools cli-review cli-register`
  passed after the shared run-validation fix: 55 files, 317 tests.
- Round-3 red-team verification also passed:
  `cli-tools.test.ts`, `cli-review.test.ts`, and `cli-register.test.ts`
  at 3 files / 25 tests; `mcp-memory-tool-handler.test.ts` and
  `phase6-agent-use-protocol.test.ts` at 2 files / 9 tests.

Isolated CLI/profile smoke used fresh `/tmp` paths:

- `ALAYA_CONFIG_DIR=/tmp/do-soul-alaya-p6-final-config-20260506-a`
- `DATA_DIR=/tmp/do-soul-alaya-p6-final-data-20260506-a`
- `CODEX_HOME=/tmp/do-soul-alaya-p6-final-codex-20260506-a`

Smoke results:

- `rtk pnpm exec alaya --help` exited 0.
- `rtk pnpm exec alaya install --non-interactive --json '{"db_path":"/tmp/do-soul-alaya-p6-final-data-20260506-a/alaya.db","embedding_enabled":false}'`
  exited 0 and wrote isolated config/audit files.
- `rtk pnpm exec alaya attach codex --yes --json` exited 0 and wrote
  isolated Codex profile files.
- `rtk pnpm exec alaya tools list --json` exited 0 and listed the nine
  first-party `soul.*` MCP memory tools.
- `rtk pnpm exec alaya mcp stdio` exited 0 and started Janitor,
  Auditor, Librarian, and GardenScheduler background services.
- `rtk pnpm exec alaya doctor` exited 75 only because the embedding
  provider is not configured. It reported runtime ready, storage
  writable, schema_ok `persisted=63, expected=63`, MCP transport ready,
  Garden healthy, and embedding mode `keyword_only
  (provider_configured=no)`.

Docs verification:

- `rtk rg -n "P6-|Gate-6|benchmark|current-directory|Garden startup|usage receipt|durable memory" docs/v0.1/phase-6-briefs docs/v0.1/INDEX.md docs/handbook/runtime-status.md README.md README.zh-CN.md`
  passed and showed benchmark references only in archived/boundary
  wording.
- `find docs -type f -name '*.md' -size +30k -print` found only the
  historical Phase 5 system review report:
  `docs/v0.1/phase-5-briefs/reports/p5-system-review-round-1.md`.
  The RTK `find` wrapper does not support the compound predicate, so the
  direct POSIX `find` command was used for this check.

## Acceptance Mapping

- MCP/CLI agent-use loop: `phase6-agent-use-protocol` proof, MCP memory
  handler tests, tools list smoke, and CLI fallback tests.
- Recall delivery / usage receipt / proposal / review / apply /
  post-apply recall: Phase 6 proof plus governance tests.
- Accept-as-apply governance: storage proposal tests and MCP governance
  tests prove accepted proposals apply persisted changes while reject
  leaves durable memory unchanged.
- CWD workspace startup: `workspace-service` tests and CLI/MCP context
  tests prove cwd-derived local workspace registration and run binding.
- Attach/profile/package: profile-mutation tests, package dry-run, and
  isolated `attach codex` smoke prove profile launch readiness.
- Garden startup/cleanup: `cli-register` tests and isolated `mcp stdio`
  smoke prove attached MCP starts Garden services.
- Docs parity: README, README.zh-CN, INDEX, runtime-status, glossary,
  task cards, and reports align on MCP Agent-Use Protocol +
  Trustworthy Memory Loop.
- Benchmark boundary: active Gate-6 acceptance excludes benchmark
  numbers, benchmark harness execution, and benchmark leaderboard
  publication.

## Closure

Gate-6 has zero unresolved Blocking or Important findings after the
Phase 6 review/fix loop. The only degraded runtime health observed in
CLI smoke is the expected missing embedding provider configuration; it
does not block MCP/CLI memory-plane readiness because keyword-only recall
mode remains available and Garden is healthy after attached MCP startup.
