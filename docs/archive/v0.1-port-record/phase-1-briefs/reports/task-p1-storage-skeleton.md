# P1-storage-skeleton Completion Report

## Scope Compliance

- Card: `P1-storage-skeleton`
- Closing readiness label: `schema-ready`
- Owned targets changed:
  - `packages/storage/package.json`
  - `packages/storage/tsconfig.json`
  - `packages/storage/src/db.ts`
  - `packages/storage/src/errors.ts`
  - `packages/storage/src/index.ts`
  - `pnpm-lock.yaml`
- No non-owned runtime files, handbook status files, phase status
  files, root config files, or package files outside `packages/storage`
  were edited.

## Port Mode And Sources

Port mode: `trivial-copy`.

Source files:

- `vendor/do-what-new-snapshot/packages/storage/package.json`
- `vendor/do-what-new-snapshot/packages/storage/tsconfig.json`
- `vendor/do-what-new-snapshot/packages/storage/src/db.ts`
- `vendor/do-what-new-snapshot/packages/storage/src/errors.ts`
- `vendor/do-what-new-snapshot/packages/storage/src/index.ts`

Target files:

- `packages/storage/package.json`
- `packages/storage/tsconfig.json`
- `packages/storage/src/db.ts`
- `packages/storage/src/errors.ts`
- `packages/storage/src/index.ts`

## Source / Target Parity

- `packages/storage/src/db.ts` is byte-for-byte identical to the
  cited vendor source.
- `packages/storage/src/errors.ts` is byte-for-byte identical to the
  cited vendor source.
- `packages/storage/package.json` matches the cited vendor source
  after mechanical package-name rewrites:
  `@do-what/storage` to `@do-soul/alaya-storage` and
  `@do-what/protocol` to `@do-soul/alaya-protocol`.
- `packages/storage/tsconfig.json` matches the cited vendor source
  after removing the source UTF-8 BOM to comply with repository file
  rules.
- `packages/storage/src/index.ts` intentionally exports only this
  card's owned files (`errors.ts`, `db.ts`). The vendor barrel also
  exports repository files owned by later P2 cards; exporting those
  here would make the target package unbuildable and would expand the
  card beyond its allowed scope.

Parity checks run:

```bash
rtk node -e "const fs=require('fs');const pairs=[['db.ts','vendor/do-what-new-snapshot/packages/storage/src/db.ts','packages/storage/src/db.ts'],['errors.ts','vendor/do-what-new-snapshot/packages/storage/src/errors.ts','packages/storage/src/errors.ts']];for (const [name,a,b] of pairs){console.log(name, fs.readFileSync(a,'utf8')===fs.readFileSync(b,'utf8')?'identical':'different');} const pkg=fs.readFileSync('vendor/do-what-new-snapshot/packages/storage/package.json','utf8').replaceAll('@do-what/storage','@do-soul/alaya-storage').replaceAll('@do-what/protocol','@do-soul/alaya-protocol');console.log('package.json', pkg===fs.readFileSync('packages/storage/package.json','utf8')?'mechanical-match':'different'); const ts=fs.readFileSync('vendor/do-what-new-snapshot/packages/storage/tsconfig.json','utf8').replace(/^\uFEFF/,'');console.log('tsconfig.json', ts===fs.readFileSync('packages/storage/tsconfig.json','utf8')?'mechanical-match':'different');"
```

Result:

```text
db.ts identical
errors.ts identical
package.json mechanical-match
tsconfig.json mechanical-match
```

```bash
rtk node -e "const fs=require('fs');const source=fs.readFileSync('vendor/do-what-new-snapshot/packages/storage/src/index.ts','utf8').split(/\r?\n/).slice(0,2).join('\n')+'\n';const target=fs.readFileSync('packages/storage/src/index.ts','utf8');console.log(source===target?'index.ts first-two-export subset match':'index.ts differs from first-two-export subset');"
```

Result:

```text
index.ts first-two-export subset match
```

## Verification

```bash
rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/packages/storage/package.json\",\"vendor/do-what-new-snapshot/packages/storage/tsconfig.json\",\"vendor/do-what-new-snapshot/packages/storage/src/db.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/errors.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/index.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"
```

Result: passed with no output.

```bash
rtk pnpm install
```

Result:

```text
ok
```

```bash
rtk pnpm build
```

Result:

```text
> do-soul-alaya@ build /home/tdwhere/vibe/Do-SOUL Alaya/.worktrees/p1-storage-skeleton
> node ./scripts/build-existing.mjs
```

Exit code: 0.

```bash
rtk pnpm exec tsc --noEmit -p packages/storage
```

Result: passed with no output.

```bash
rtk pnpm exec vitest run --project @do-soul/alaya-storage
```

Result after the full Phase 1 storage test surface landed: passed, 2
files / 3 tests.

## Architecture Compliance

- Dependency direction remains valid: storage depends on protocol and
  external SQLite packages only.
- The package does not import from `apps/*`, `packages/core`,
  `packages/soul`, or `packages/engine-gateway`.
- This card does not author business transitions or runtime truth; it
  only ports the mechanical storage package skeleton.
- No live-ready, MCP-consumable, or CLI-consumable claim is made.

## Deviations

- `packages/storage/src/index.ts` is a narrow buildable subset of the
  vendor barrel. The omitted exports point to repository files owned by
  later P2 cards and the P2 storage barrel-update card.
- The vendor `tsconfig.json` has a UTF-8 BOM. The target file omits the
  BOM per repository file rules.

## Deferred Issues

None. Future repository exports are already scheduled through Phase 2
task cards and the `P2-barrel-storage` owner; no new backlog item is
introduced by this card.

## Review Checklist

- Acceptance criteria AC1-AC5: satisfied by source parity checks,
  required verification commands, and this report.
- AC6 status-document updates: intentionally not performed in this
  feature commit because the user-owned closeout scope forbids edits
  to `docs/v0.1/INDEX.md`, Phase README, and runtime status docs.
- Review result: zero Blocking findings and zero Important findings.

## Post-Landing Note

Any later edit to this report or the task card must land as a separate
`docs(P1-storage-skeleton): ...` commit per workflow rule R4.
