# P1-migrations Completion Report

## Scope Compliance

- Card: `P1-migrations`
- Closing readiness label: `implementation-ready`
- Owned targets changed:
  - `packages/storage/src/migrations/*.sql`
  - `docs/v0.1/phase-1-briefs/reports/task-p1-migrations.md`
- No storage barrels, shared status docs, root build/test config, other
  packages, or unrelated files were edited.

## Port Mode And Sources

Port mode: `trivial-copy`.

Source directory:

- `vendor/do-what-new-snapshot/packages/storage/src/migrations/`

Target directory:

- `packages/storage/src/migrations/`

Copied source range:

- 55 SQL files, `001-initial.sql` through
  `055-global-memory-recall-cache-global-object-index.sql`.

No package-name, path, or SQL rewrites were required. The target SQL
files are byte-for-byte copies of the cited vendor files.

## Source / Target Parity

```bash
rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/packages/storage/src/migrations/\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}console.log('source directory exists:',paths[0]);"
```

Result:

```text
source directory exists: vendor/do-what-new-snapshot/packages/storage/src/migrations/
```

```bash
rtk node -e "const fs=require('fs'),crypto=require('crypto'),path=require('path');const src='vendor/do-what-new-snapshot/packages/storage/src/migrations';const dst='packages/storage/src/migrations';const list=d=>fs.readdirSync(d).filter(f=>f.endsWith('.sql')).sort();const s=list(src),t=list(dst);console.log('source_count',s.length);console.log('target_count',t.length);console.log('first',s[0]);console.log('last',s[s.length-1]);const namesEqual=JSON.stringify(s)===JSON.stringify(t);console.log('filename_parity',namesEqual);let bad=[];for(const f of s){const a=fs.readFileSync(path.join(src,f));const b=fs.readFileSync(path.join(dst,f));const ah=crypto.createHash('sha256').update(a).digest('hex');const bh=crypto.createHash('sha256').update(b).digest('hex');if(ah!==bh)bad.push(f);}console.log('checksum_mismatches',bad.length);if(s.length!==55||t.length!==55||s[0]!=='001-initial.sql'||s[s.length-1]!=='055-global-memory-recall-cache-global-object-index.sql'||!namesEqual||bad.length){if(bad.length)console.error(bad.join('\\n'));process.exit(1);}"
```

Result:

```text
source_count 55
target_count 55
first 001-initial.sql
last 055-global-memory-recall-cache-global-object-index.sql
filename_parity true
checksum_mismatches 0
```

## Verification

```bash
rtk pnpm install
```

Result:

```text
+++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
+ @types/node 22.19.17
+ typescript 5.9.3
+ vitest 4.1.5
```

Exit code: 0.

```bash
rtk pnpm build
```

Result:

```text
> do-soul-alaya@ build /home/tdwhere/vibe/Do-SOUL Alaya/.worktrees/p1-migrations
> node ./scripts/build-existing.mjs
```

Exit code: 0.

```bash
rtk pnpm exec tsc --noEmit -p packages/storage
```

Result: passed with no output.

Exit code: 0.

```bash
rtk pnpm exec vitest run --project @do-soul/alaya-storage --passWithNoTests
```

Result:

```text
RUN  v4.1.5 /home/tdwhere/vibe/Do-SOUL Alaya/.worktrees/p1-migrations

No test files found, exiting with code 0

projects: @do-soul/alaya-storage

|@do-soul/alaya-storage|

include: /home/tdwhere/vibe/Do-SOUL Alaya/.worktrees/p1-migrations/packages/storage/src/__tests__/**/*.{test,spec}.ts
exclude:  **/dist/**
```

Exit code: 0.

```bash
rtk git diff --check
```

Result: passed with no output.

Exit code: 0.

## Architecture Compliance

- Dependency direction is unchanged; SQL migrations do not add imports
  or package dependencies.
- This card does not author runtime transitions, EventLog producers,
  daemon wiring, MCP surface, CLI surface, or Garden behavior.
- The migration sequence range remains vendor-defined and owned by
  `P1-migrations`: `001` through `055`.
- No live-ready, MCP-consumable, or CLI-consumable claim is made.

## Deviations

None.

## Deferred Issues

None. The task card lists no deferred scope, and this report introduces
no backlog issue.

## Review Checklist

- AC1: satisfied by byte-for-byte checksum parity for all 55 SQL files.
- AC2: satisfied by source directory existence check.
- AC3: satisfied by `rtk pnpm build`.
- AC4: satisfied by storage Vitest project run with `--passWithNoTests`;
  no storage test files exist in this lane yet.
- AC5: satisfied by this report.
- AC6: no status-document edits were made because this lane's explicit
  ownership forbids shared status docs.
- Review result: zero Blocking findings and zero Important findings.

## Post-Landing Note

Any later edit to this report or the task card must land as a separate
`docs(P1-migrations): ...` commit per workflow rule R4.
