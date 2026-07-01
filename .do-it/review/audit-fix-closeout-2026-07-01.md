# Audit-fix closeout — 2026-07-01

Branch: `recall/conformant-audit-fix`  
Worktree: `.worktrees/recall-conformant-audit-fix`

## Backlog items closed

| ID | Item | Resolution |
|----|------|------------|
| I4 | `memory-entry-read-queries.ts` SRP split | Split into `memory-entry-read-queries.ts` (408L), `memory-entry-conflict-read-queries.ts`, `memory-entry-dynamic-read-queries.ts`, `memory-entry-read-page.ts`. Constructor no longer stores unused `db` field; passes `db` only to dynamic submodule. |
| I3 | Inspector web test script | `apps/inspector/web/package.json` `test` script points at root `vitest.config.mjs` with `--project @do-soul/alaya-inspector-web`. |
| N3 | PATCH `api.test` envelope | `api.test.ts` retains `requires_daemon_restart` on PATCH config responses instead of unwrapping away. |
| N2 | Config toast restart hint | `config-section.tsx` shows "daemon restart pending" toast only when `requires_daemon_restart` is true. |
| Spec N3 | `POST /files` upload tests | `routes-files.test.ts` `files upload route` describe: missing file (400), unsupported MIME (422), missing scope (400), successful workspace upload (201). Mocks `mkdir`/`writeFile` and `createWithEvent`. |
| N2-if | `app.test` PATCH envelope | `app.test.ts` asserts full PATCH embedding-config response envelope including `requires_daemon_restart`. |
| — | Workspace conflict list extraction | `memories-workspace-conflict-list.ts` extracted; `memories-workspace-list.ts` delegates conflict listing. |

## Verification (2026-07-02)

```bash
rtk pnpm build
rtk pnpm exec vitest run --project @do-soul/alaya-storage          # 76 files, 567 tests passed
rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon \
                         --project @do-soul/alaya-inspector          # 196 files, 978 tests passed
rtk pnpm exec vitest run --config vitest.config.mjs \
                         --project @do-soul/alaya-inspector-web     # 20 files, 111 tests passed
```

`routes-files.test.ts`: 10 tests (4 upload + 6 download).

## Nice-to-have closed (2026-07-02)

| Item | Resolution |
|------|------------|
| fusion-delivery unit tests | `fusion-delivery-lexical-rerank.test.ts`, `fusion-delivery-session-coverage.test.ts`, `fusion-delivery-adaptive-scoring.test.ts` cover split delivery modules. |
| Dynamic prepared statements | `DynamicPreparedStatementCache` + `dynamic-prepared-statement-cache.test.ts`; `MemoryEntryDynamicReadQueries` routes dynamic SQL through the cache. |
