# SOUL Memory Product Local Prototype Review Closure

Date: 2026-04-27

Scope: `.` only. No tracked main-repo source, package,
workspace, docs, or gitignore files are part of this prototype deliverable.

Repository tracking note: `rtk git status --short --ignored . .gitignore`
shows `M .gitignore` and `!! .local/`. The `.gitignore` change was observed as
an existing/unowned tracked working-tree change during this implementation and
was not edited as part of the prototype. It is listed here so closeout does not
claim a fully clean tracked tree while also preserving the task boundary.

## Finding: Hidden do-what build/config dependency

Cause: The first prototype inherited the root TypeScript config and relied on
workspace assumptions.

Fix: Made `tsconfig.json` standalone, added local package engine and dev
dependency metadata, and added a boundary test that rejects runtime imports from
`@do-what/*` or root path aliases.

Verify:
- `rtk pnpm exec tsc -p tsconfig.json`
- `rtk pnpm exec vitest run --config vitest.config.mjs`
- `rtk rg -n "from ['\"]@do-what/|import\(['\"]@do-what/|better-sqlite3" src` returned no matches.

Follow-up: Future packaging should convert the private local package into an
actual publishable artifact before advertising global install.

## Finding: Durable memory could be created with placeholder or missing evidence

Cause: Runtime ingest accepted durable memories without enforcing supplied
evidence payloads for every `evidenceId`.

Fix: `previewIngest` and `ingestMemory` now require durable memory evidence to
be supplied and matching. CLI ingest emits an evidence-backed memory by default.

Verify:
- Runtime tests reject evidence-less durable ingest.
- CLI smoke `ingest` returned `reason: Evidence-backed memory ingested.`

Follow-up: Add file-backed evidence import when the prototype grows beyond
operator-statement evidence.

## Finding: Ingest was not atomic

Cause: Scope and memory creation could happen before evidence insertion failed.

Fix: Added storage transaction support and wrapped memory creation, evidence
insertion, and audit creation in one transaction.

Verify:
- Runtime test duplicates an evidence id and confirms the second memory is not
persisted after the failed evidence write.

Follow-up: Extend transaction coverage to multi-memory import replace mode when
replace import is implemented.

## Finding: Session lifecycle was prematurely finished

Cause: `assembleContextForSession`, `recordMemoryUsage`, and `recordMemoryIngest`
used the finish path while updating in-flight state.

Fix: Added `updateMemorySession` and switched in-flight updates to preserve
`finishedAt` until explicit `finishMemorySession`.

Verify:
- Runtime tests assert `finishedAt` remains unset after context assembly and
usage recording, then is set by `finishMemorySession`.
- Gateway smoke created and explicitly finished a session.

Follow-up: Record richer violation rows for missing usage proof instead of only
summary state.

## Finding: Export/import overstated portability

Cause: `includeSessions` exported empty arrays even when sessions existed, and
duplicate merge import reported all bundle ids as imported. Follow-up review also
found scoped exports leaked other scopes through audit/context/session/graph
sections, and merge import was only per-memory transactional.

Fix: Added storage listing for sessions and context packs, exported them when
requested, filtered export side-channel sections to the selected memory/scope
set, and made merge import report only newly imported ids plus skipped counts.
Merge import now wraps the whole bundle operation in one transaction.

Verify:
- Runtime tests assert exported sessions/context packs are present and duplicate
import returns an empty `importedMemoryIds`.
- Runtime tests assert scoped export does not include excluded scope memory,
scope, evidence, audit, context-pack, session, or graph data.
- Runtime tests assert a later import failure rolls back earlier bundle memories.
- CLI smoke `export --include-sessions` included real session/context-pack data
after gateway smoke.

Follow-up: Add replace import with a dry-run plan before destructive behavior.

## Finding: Sensitive retention policy was not enforced on reads/exports

Cause: Sensitive metadata was stored but not applied when listing or exporting
memory and evidence. Follow-up review found hidden memory was still visible
through exported graph nodes.

Fix: Stored sensitivity policy in memory metadata, hid `do-not-export` memories
from exports and export graphs, and redacted `redact-on-export` memory/evidence
payloads.

Verify:
- Runtime tests assert `do-not-export` memory is absent from export and
export graph, and `redact-on-export` memory/evidence are redacted.

Follow-up: Add UI affordances in inspector for why sensitive items are hidden or
redacted.

## Finding: HTTP and backup validation were too loose

Cause: Static inspector serving could mask API misses, invalid recall/malformed
ingest bodies could throw generic errors, and HTTP backup accepted arbitrary or
symlink-escaped paths, including final-target symlinks.

Fix: Restricted inspector static paths, added query/body validation, mapped
runtime/storage errors to JSON error responses, and constrained HTTP backups to
the real storage directory. Backup now rejects symlinked path components and
the final backup target when it is a symlink.

Verify:
- Adapter tests assert invalid recall returns `VALIDATION_FAILED` and unknown
API routes return 404.
- Adapter tests assert malformed ingest returns `VALIDATION_FAILED`.
- Adapter tests assert HTTP backup rejects both directory symlink escapes and
final-target symlink escapes.

Follow-up: Add end-to-end server subprocess tests for malformed JSON and backup
path rejection.

## Finding: Session finish could overstate memory usage

Cause: `finishMemorySession` and `recordMemoryUsage` could accept
caller-supplied `used` state without non-empty usage proof.

Fix: `recordMemoryUsage` downgrades `used` events without non-empty proof to
`unverifiable` and records a session contract violation. Finish counts only
proven used events before preserving `usageState: used`.

Verify:
- Runtime tests assert a bare `finishMemorySession(... usageState: used)` returns
`usageState: unverifiable` and records an Important violation.
- Runtime tests assert a delivered memory with a `used` event but no proof is
downgraded to `unverifiable` and cannot finish as `used`.

Follow-up: Add richer violation types for skipped and unverifiable evidence
quality once gateway usage proof grows beyond the minimal local slice.

## Finding: MCP and install docs were thinner than the public API claims

Cause: MCP only exposed a subset of the product API, `mcp config` was documented
before it existed, and help/config commands loaded SQLite at startup.

Fix: Added MCP tools for ingest, explain recall, and session violations; added
CLI `mcp config`; clarified docs to use the local `dist/cli/index.js` command;
lazy-loaded `node:sqlite` so help/config do not trigger storage loading; aligned
docs around the current single `soul_memory.governance` tool and future
packaging being out of scope for this ignored prototype.

Verify:
- Adapter tests assert MCP tool listing and calls for ingest, recall, explain,
session start, and list session violations.
- `rtk node dist/cli/index.js help --data-dir /tmp/soul-memory-product-help-check`
- `rtk node dist/cli/index.js mcp config --agent codex --name soul-memory --data-dir /tmp/soul-memory-product-smoke-closeout`

Follow-up: Add agent-specific config writers only with explicit user consent.

## Finding: Benchmark was not rooted in the public runtime API

Cause: The scripted benchmark used a bespoke API surface instead of the same
public calls as runtime, HTTP, MCP, and CLI.

Fix: Reworked the benchmark adapter around `assembleContext`,
`recordMemoryUsage`, `rejectMemory`, and `listAuditEvents` public API shapes.

Verify:
- Benchmark test asserts deterministic output and false-recall correction
through governance audit events.

Follow-up: Add a second benchmark mode that runs against a real SQLite runtime
seeded through import.

## Final Verification

- `rtk pnpm exec tsc -p tsconfig.json`
- `rtk pnpm exec vitest run --config vitest.config.mjs` passed with 6 files and 20 tests.
- `rtk node dist/cli/index.js doctor --data-dir /tmp/soul-memory-product-smoke-final2`
- `rtk node dist/cli/index.js ingest --data-dir /tmp/soul-memory-product-smoke-final2 --id mem-smoke-final2 --evidence-id evidence-smoke-final2 --summary "smoke memory for final verification" --body "SOUL Memory final verification recall evidence." --scope-id smoke`
- `rtk node dist/cli/index.js recall --data-dir /tmp/soul-memory-product-smoke-final2 --query "final verification"`
- `rtk node dist/cli/index.js gateway --data-dir /tmp/soul-memory-product-smoke-final2 --query "final verification" -- node -e "process.exit(0)"`
- `rtk node dist/cli/index.js export --data-dir /tmp/soul-memory-product-smoke-final2 --include-sessions`
- `rtk node dist/cli/index.js help --data-dir /tmp/soul-memory-product-help-check`
- `rtk node dist/cli/index.js mcp config --agent codex --name soul-memory --data-dir /tmp/soul-memory-product-smoke-closeout`
- `rtk rg -n "from ['\"]@do-what/|import\(['\"]@do-what/|better-sqlite3" src` returned no matches.
- `rtk git status --short --ignored . .gitignore` showed `M .gitignore` and `!! .local/`; the tracked `.gitignore` delta is treated as existing/unowned, not as a prototype deliverable.
