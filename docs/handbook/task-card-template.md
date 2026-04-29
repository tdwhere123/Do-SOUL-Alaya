# Task Card Template

This file is the authoritative spec for Alaya v0.1 task cards. Every
card under `docs/v0.1/phase-{1..5}-briefs/` MUST follow this layout
exactly. Section order, field names, and capitalization are fixed.

## File Layout

- File path: `docs/v0.1/phase-N-briefs/task-pN-<short-id>.md`
  - `N` is the phase number (1, 2, 3, 4, 5).
  - `<short-id>` is a kebab-case short name (`protocol`,
    `repos-batch-1`, `svc-memory`, `garden-batch-1`,
    `daemon-core`, `cli-bridge`, `attach-codex`, etc.).
  - Examples: `task-p1-protocol.md`, `task-p2-svc-memory.md`,
    `task-p4-attach-codex.md`.
- File MUST be UTF-8 without BOM, English-only, < 30 KB.

## Section Order

```
# Implementation Brief: Task <CARD-ID> — <Title>

> Frontmatter (block-quoted bullet list, fields below)

## 0. Charter Authority
## 1. Background & Goal
## 2. Allowed Scope
## 3. Deferred
## 4. Acceptance Criteria
## 5. Verification
## 6. Shared File Hazards & Dependencies
```

There are 7 numbered sections (§0..§6). The "6-section" shorthand in
the handbook refers to §1..§6; §0 is metadata.

## Frontmatter Fields

The frontmatter is a single block-quote at the top of the file,
formatted as bullet lines. Required fields, in this exact order:

```markdown
> - **Phase**: <1 | 2 | 3 | 4 | 5>
> - **Wave**: <1 | 2 | 3 | 4 | 5>
> - **Card ID**: <PN-short-id, e.g. P1-protocol>
> - **Port mode**: <trivial-copy | adapt-and-port | requires-redesign>
> - **Source**: `vendor/do-what-new-snapshot/<path>` (or `n/a` for requires-redesign cards with no upstream source)
> - **Target**: `<destination path inside repo, e.g. packages/protocol/src/>`
> - **Size**: <S | M | L | XL>
> - **Prerequisite**: <comma-separated card IDs, or `none`>
> - **Blocks**: <comma-separated card IDs, or `none`>
> - **Closing readiness label**: <not-started | schema-ready | implementation-ready | live-event-ready | mcp-consumable | cli-consumable>
> - **Owner**: <`unassigned` until claimed>
```

`Size` heuristic: S ≤ 5 files, M ≤ 20 files, L ≤ 100 files, XL > 100
files. Single-file ports of ≤ 200 LOC are S; ≤ 1000 LOC are M.

## §0 Charter Authority

The "why this card is allowed to exist" cite. Per port mode:

- **trivial-copy**: cite the phase README row that allocates this work
  AND `docs/handbook/port-protocol.md §1`. Example:
  > `docs/v0.1/phase-1-briefs/README.md` row "P1-protocol";
  > `docs/handbook/port-protocol.md §1 trivial-copy`.

- **adapt-and-port**: cite the phase README row AND
  `docs/handbook/port-protocol.md §2` AND the specific
  `docs/handbook/invariants.md` rule(s) that make adaptation necessary
  (e.g. invariant §20 "no GUI/TUI" forces removing GUI-only branches).

- **requires-redesign**: cite the phase README row AND
  `docs/handbook/port-protocol.md §3` AND the specific Alaya invariant
  or architecture section that drives the divergence. Example:
  > `docs/v0.1/phase-4-briefs/README.md` row "P4-attach-codex";
  > `docs/handbook/port-protocol.md §3 requires-redesign`;
  > `docs/handbook/invariants.md §22 attach changes write only after
  > preview + explicit confirm`.

If a `requires-redesign` card has no upstream source at all (Alaya-
original feature), §0 MUST also reference `docs/handbook/architecture.md
§Surface Shape` or the relevant Alaya-specific design section.

## §1 Background & Goal

Two short paragraphs:

1. **Background**: why this work matters in the v0.1 plan; what
   subsystem it belongs to; what depends on it later.
2. **Goal**: a single sentence stating the one outcome this card
   delivers. Avoid lists; one card = one goal.

## §2 Allowed Scope

The exhaustive enumeration of files the card touches. Use
sub-sections per file or per file group.

For trivial-copy, a typical sub-section:

```markdown
### 2.1 packages/protocol/src/event-log.ts

- **Source**: `vendor/do-what-new-snapshot/packages/protocol/src/event-log.ts`
- **Target**: `packages/protocol/src/event-log.ts`
- **Mechanical changes**:
  - rewrite import `@do-what/protocol` → `@do-soul/alaya-protocol` (none in this file; verify and report)
  - none other
```

For adapt-and-port, add an Adapter Points table:

```markdown
### 2.1 packages/core/src/conversation-service.ts

- **Source**: `vendor/do-what-new-snapshot/packages/core/src/conversation-service.ts`
- **Target**: `packages/core/src/conversation-service.ts`
- **Adapter Points**:

  | # | Source line(s) | Change | Justification |
  |---|---|---|---|
  | 1 | 412-487 (worker-dispatch block) | Delete entire block | Alaya has no chat surface; per invariant §20 |
  | 2 | 891-934 (tool-substrate hook) | Delete | Same as above |
  | 3 | imports of `runtime-adapter` | Delete | downstream of removed worker-dispatch |
```

For requires-redesign, document the Alaya-original design:

```markdown
### 2.1 apps/core-daemon/src/cli-attach.ts (NEW FILE — Alaya-original)

- **Source**: `n/a` (Alaya-original feature; see §0 Charter Authority)
- **Target**: `apps/core-daemon/src/cli-attach.ts`
- **Design** (in detail):
  - Read current Codex/Claude config file path from env or default.
  - Generate diff of intended config additions.
  - Print diff to stdout, ask `[y/N]` on stdin.
  - On `y`, write atomically (temp file + rename).
  - On `n`, exit 0 with no mutation.
  - Audit-record the attach action via RuntimeNotifier.
- **Why no upstream port**: do-what-new is a workspace tool; it does
  not attach to other agents. This is a v0.1 Alaya invariant (§20-22).
```

For large file sets (e.g. 55 SQL migrations, 124 protocol files), use
a range + count + spot-check format:

```markdown
### 2.1 packages/storage/src/migrations/*.sql (55 files)

- **Source range**: `vendor/do-what-new-snapshot/packages/storage/src/migrations/001-*.sql` through `055-*.sql`
- **Target range**: `packages/storage/src/migrations/001-*.sql` through `055-*.sql`
- **Count check**: `rtk find vendor/do-what-new-snapshot/packages/storage/src/migrations -maxdepth 1 -name '*.sql' | rtk wc -l` MUST equal 55.
- **Mechanical changes**: none (SQL files are content-stable).
- **Spot-check files for review**:
  - `001-initial.sql`
  - `040-events-phase-c.sql`
  - `055-<latest>.sql`
```

## §3 Deferred

Anything intentionally NOT in this card. Each deferral MUST cite a
backlog issue per Anti-Tail Rule R2:

```markdown
- Snapshot table refresh logic — deferred to backlog #BL-12 (target v0.2).
- LLM provider HTTP client adapters — deferred to backlog #BL-13.
```

If nothing is deferred, write `Nothing deferred.` exactly.

## §4 Acceptance Criteria

A markdown table. Each row has a stable AC ID (AC1, AC2, ...) and an
Evidence column that names a verifiable artifact. The final row MUST
restate the closing readiness label from frontmatter.

```markdown
| AC | Criteria | Evidence |
|---|---|---|
| AC1 | All files in §2 are copied or adapted per the declared port mode | `rtk git diff vendor/do-what-new-snapshot/<src> packages/<target>` reports only mechanical changes (or matches the Adapter Points table for adapt-and-port) |
| AC2 | All ported `__tests__/` pass | `rtk pnpm exec vitest run --project @do-soul/alaya-<package>` is green |
| AC3 | TypeScript compiles | `rtk pnpm exec tsc --noEmit -p packages/<package>` is clean |
| AC4 | Public exports match source surface | `rtk pnpm exec tsc --noEmit -p packages/<package>` plus `rtk node -e "console.log(Object.keys(require('@do-soul/alaya-<package>')))"` matches the source's exported names |
| AC5 | Closing readiness label is `<label>` per §0 | `docs/handbook/runtime-status.md` row updated; INDEX status table updated |
```

For trivial-copy ports, AC1 is the canonical "diffs cleanly" check.
For adapt-and-port, AC1 is "diffs match the declared Adapter Points
exactly". For requires-redesign, AC1 enumerates the design behaviors
each test case proves.

## §5 Verification

Concrete shell commands a reviewer can run to verify §4. Order them
by build → test → lint → integration. Use absolute paths or
`rtk pnpm --dir`. If a command requires a package skeleton that this card
itself creates, list the skeleton creation as command 1.

```markdown
1. `rtk pnpm install` (root) — installs workspace dependencies
2. `rtk pnpm exec tsc --noEmit -p packages/<package>`
3. `rtk pnpm exec vitest run --project @do-soul/alaya-<package>`
4. `rtk diff -u vendor/do-what-new-snapshot/<src> packages/<target>` — reports only mechanical changes
5. (integration only when the card claims `live-event-ready` or above)
```

## §6 Shared File Hazards & Dependencies

A short list of the shared files this card writes that may collide
with other cards in the same wave:

```markdown
- Writes `packages/protocol/src/index.ts` (barrel) — coordinate with INDEX §Shared File Conflict Table.
- Writes `packages/storage/src/repos/shared/event-log-writer.ts` — must land BEFORE any P2 repo card starts.
```

If none, write `No shared-file hazards.` exactly.

Plus a short dependency restatement (mirrors frontmatter):

```markdown
**Prerequisite**: P0-2 (workspace skeleton).
**Blocks**: P2-repos-batch-1, P2-repos-batch-2, ..., P2-svc-evidence (all consumers of `@do-soul/alaya-protocol`).
```

---

## Worked Example A — trivial-copy

```markdown
# Implementation Brief: Task P1-protocol — Port @do-soul/alaya-protocol leaves

> - **Phase**: 1
> - **Wave**: 1
> - **Card ID**: P1-protocol
> - **Port mode**: trivial-copy
> - **Source**: `vendor/do-what-new-snapshot/packages/protocol/src/`
> - **Target**: `packages/protocol/src/`
> - **Size**: L
> - **Prerequisite**: none
> - **Blocks**: P1-storage-shared, P1-config, P2-repos-batch-1..6, P2-svc-*, P2-garden-batch-*
> - **Closing readiness label**: schema-ready
> - **Owner**: unassigned

## 0. Charter Authority

`docs/v0.1/phase-1-briefs/README.md` row "P1-protocol";
`docs/handbook/port-protocol.md §1 trivial-copy`.

## 1. Background & Goal

**Background**: protocol is the zod-only leaf the entire memory
subsystem depends on. Phase 1+ work cannot start until protocol types
are present. Per invariant §1, protocol depends only on `zod`; no
internal redefinition allowed elsewhere (§2).

**Goal**: bring all upstream protocol types into Alaya as
`@do-soul/alaya-protocol`, with the source `__tests__/` passing
unchanged.

## 2. Allowed Scope

### 2.1 Package skeleton

- **Target**: `packages/protocol/{package.json, tsconfig.json}`
- **Content**: name `@do-soul/alaya-protocol`, dep on `zod`,
  references `../../tsconfig.base.json`. Mirror the upstream
  `vendor/do-what-new-snapshot/packages/protocol/{package.json, tsconfig.json}`
  with name renamed.

### 2.2 packages/protocol/src/* (root files)

- **Source range**: `vendor/do-what-new-snapshot/packages/protocol/src/*.ts` (root level only, ~41 files including `event-log.ts`, `runtime-port.ts`, `auditor-ports.ts`, `engine-port.ts`, `worker-*-port.ts`, `dynamics-constants.ts`, `consolidation-trigger-budget.ts`, `index.ts`, etc.)
- **Target range**: `packages/protocol/src/*.ts`
- **Count check**: `rtk find vendor/do-what-new-snapshot/packages/protocol/src -maxdepth 1 -name '*.ts' | rtk wc -l` (record actual count in completion report).
- **Mechanical changes**: any `import "@do-what/<x>"` rewritten to `@do-soul/alaya-<x>` (none expected at protocol level since it has no internal cross-imports beyond zod).

### 2.3 packages/protocol/src/soul/

- **Source**: `vendor/do-what-new-snapshot/packages/protocol/src/soul/`
- **Target**: `packages/protocol/src/soul/`
- **Recursive copy**, no mechanical changes inside.
- **Spot-check files**: `evidence-capsule.ts`, `memory-entry.ts`, `path-relation.ts`, `claim-form.ts`.

### 2.4 packages/protocol/src/events/

- **Source**: `vendor/do-what-new-snapshot/packages/protocol/src/events/`
- **Target**: `packages/protocol/src/events/`
- **Recursive copy**, no mechanical changes.
- **Note**: includes large `phase-c.ts` (~30KB); reviewer verifies file size and SHA without full read.

### 2.5 packages/protocol/src/__tests__/

- **Source**: `vendor/do-what-new-snapshot/packages/protocol/src/__tests__/`
- **Target**: `packages/protocol/src/__tests__/`
- Recursive copy.

## 3. Deferred

Nothing deferred.

## 4. Acceptance Criteria

| AC | Criteria | Evidence |
|---|---|---|
| AC1 | All files in §2 ported per trivial-copy rules | `rtk diff -ru vendor/do-what-new-snapshot/packages/protocol packages/protocol -- '*.ts' '*.json'` reports only `name` field rename in package.json |
| AC2 | Ported `__tests__/` pass | `rtk pnpm exec vitest run --project @do-soul/alaya-protocol` green |
| AC3 | TypeScript compiles | `rtk pnpm exec tsc --noEmit -p packages/protocol` clean |
| AC4 | Public exports match source | `rtk node -e "console.log(Object.keys(require('@do-soul/alaya-protocol')).sort())"` matches source's exported names |
| AC5 | Closing readiness label is `schema-ready` | `docs/handbook/runtime-status.md` updated; `docs/v0.1/INDEX.md` updated |

## 5. Verification

1. `rtk pnpm install`
2. `rtk pnpm exec tsc --noEmit -p packages/protocol`
3. `rtk pnpm exec vitest run --project @do-soul/alaya-protocol`
4. `rtk diff -ru vendor/do-what-new-snapshot/packages/protocol/src packages/protocol/src` — review for any unexpected delta
5. `rtk find packages/protocol/src -maxdepth 1 -name '*.ts' | rtk wc -l` matches recorded count in §2.2

## 6. Shared File Hazards & Dependencies

- Writes `packages/protocol/src/index.ts` (barrel). No other Phase 1 card touches protocol/src/index.ts.
- Writes `packages/protocol/{package.json, tsconfig.json}`. No other card touches these.

**Prerequisite**: P0-2 (workspace skeleton already done).
**Blocks**: every Phase 1+ port card that imports `@do-soul/alaya-protocol`.
```

## Worked Example B — adapt-and-port

```markdown
# Implementation Brief: Task P3-conversation — Port ConversationService (memory orchestration only)

> - **Phase**: 3
> - **Wave**: 3
> - **Card ID**: P3-conversation
> - **Port mode**: adapt-and-port
> - **Source**: `vendor/do-what-new-snapshot/packages/core/src/conversation-service.ts`
> - **Target**: `packages/core/src/conversation-service.ts`
> - **Size**: L
> - **Prerequisite**: P2-svc-memory, P2-svc-recall, P2-svc-evidence, P2-svc-green, P2-svc-governance-lease, P2-svc-session-override, P2-svc-output-shaping
> - **Blocks**: P4-daemon-startup-ordering
> - **Closing readiness label**: implementation-ready
> - **Owner**: unassigned

## 0. Charter Authority

`docs/v0.1/phase-3-briefs/README.md` row "P3-conversation";
`docs/handbook/port-protocol.md §2 adapt-and-port`;
`docs/handbook/invariants.md §20` (no chat surface);
user decision 2026-04-28: "ConversationService = adapt-and-port, retain memory-orchestration only".

## 1. Background & Goal

**Background**: ConversationService in upstream is the entry point that
orchestrates Memory + Recall + Evidence + Green + Governance + Output
shaping for a chat turn. Alaya has no chat surface; what we need is
the same orchestration for the path candidate-submit → recall →
governance-gate → durable. The chat-specific paths (worker-dispatch,
runtime-adapter, tool-substrate) are dead in Alaya.

**Goal**: port ConversationService with chat-specific orchestration
removed, keeping only the candidate→recall→govern→durable memory path.

## 2. Allowed Scope

### 2.1 packages/core/src/conversation-service.ts

- **Source**: `vendor/do-what-new-snapshot/packages/core/src/conversation-service.ts` (2,133 LOC)
- **Target**: `packages/core/src/conversation-service.ts`
- **Adapter Points**:

  | # | Source line range | Change | Justification |
  |---|---|---|---|
  | 1 | (TBD by card author after reading file) worker-dispatch entry block | Delete | Alaya has no agent worker dispatch; per invariant §20 |
  | 2 | imports of `runtime-adapter` | Delete | downstream of removed worker-dispatch |
  | 3 | tool-substrate hook block | Delete | same as above |
  | 4 | `@do-what/*` imports throughout | Rewrite to `@do-soul/alaya-*` | trivial mechanical change |
  | 5 | (TBD) any chat-specific message threading code | Delete | Alaya routes via MCP tool calls, not message threads |

  Each row of the adapter table MUST be filled in concretely (with
  actual source line ranges) before the card is dispatched.

### 2.2 packages/core/src/__tests__/conversation-service.test.ts

- **Source**: `vendor/do-what-new-snapshot/packages/core/src/__tests__/conversation-service.test.ts`
- **Target**: same path
- **Adapter Points**: drop test cases that exercise deleted blocks; keep memory-orchestration test cases.

## 3. Pruned

- Chat-specific orchestration (worker-dispatch, tool-substrate,
  runtime-adapter integration) is product-scope pruned. Alaya memory is
  consumed through MCP and plain CLI, not upstream chat runtime sessions.

## 4. Acceptance Criteria

| AC | Criteria | Evidence |
|---|---|---|
| AC1 | Adapter Points table is fully filled with concrete source line ranges | reviewer reads §2 |
| AC2 | Each Adapter Point's deletion is justified by an invariant cite | §2 table inspection |
| AC3 | Memory-orchestration tests pass; chat-specific tests removed (not skipped) | `rtk pnpm exec vitest run --project @do-soul/alaya-core -t "conversation"` |
| AC4 | TypeScript compiles | `rtk pnpm exec tsc --noEmit -p packages/core` |
| AC5 | candidate-submit → recall → govern → durable path proven by an integration test | `packages/core/src/__tests__/integration/memory-orchestration.test.ts` exists and is green |
| AC6 | Closing readiness label is `implementation-ready`; daemon/MCP live proof waits for Phase 4 | docs updated |

## 5. Verification

1. `rtk pnpm install`
2. `rtk pnpm exec tsc --noEmit -p packages/core`
3. `rtk pnpm exec vitest run --project @do-soul/alaya-core`
4. Reviewer reads §2 Adapter Points table and confirms each deletion against the cited invariant.

## 6. Shared File Hazards & Dependencies

- Writes only `packages/core/src/conversation-service.ts` and its test.
  No barrel touched.

**Prerequisite**: P2-svc-* (per frontmatter).
**Blocks**: P4-daemon-startup-ordering.
```

## Worked Example C — requires-redesign (Alaya-original)

```markdown
# Implementation Brief: Task P4-attach-codex — alaya attach codex (Alaya-original CLI)

> - **Phase**: 4
> - **Wave**: 4
> - **Card ID**: P4-attach-codex
> - **Port mode**: requires-redesign
> - **Source**: `n/a` (no upstream equivalent)
> - **Target**: `apps/core-daemon/src/cli-attach.ts` (NEW), `bin/alaya.mjs` (extended)
> - **Size**: M
> - **Prerequisite**: P4-daemon-skeleton, P4-cli-bridge
> - **Blocks**: Gate-4 demo
> - **Closing readiness label**: cli-consumable
> - **Owner**: unassigned

## 0. Charter Authority

`docs/v0.1/phase-4-briefs/README.md` row "P4-attach-codex";
`docs/handbook/port-protocol.md §3 requires-redesign`;
`docs/handbook/invariants.md §22` ("Attach / Profile changes write only after preview + explicit confirm");
`docs/handbook/architecture.md §Surface Shape` (CLI commands `alaya install / attach / status / doctor`);
user decision 2026-04-28: "Alaya-original features must land in v0.1".

## 1. Background & Goal

**Background**: Alaya is consumed by external agents (Codex, Claude
Code). The user must be able to wire Alaya into those agents from one
command. do-what-new has no equivalent because it is a workspace tool,
not a memory plugin.

**Goal**: implement `alaya attach codex` and `alaya attach claude-code`
that write the target agent's MCP server config to point at Alaya, with
preview + explicit confirm before any file mutation, and an audit
record of the attach action.

## 2. Allowed Scope

### 2.1 apps/core-daemon/src/cli-attach.ts (NEW)

- **Design**:
  - Read target name (`codex` | `claude-code`); fail with usage if neither.
  - Resolve target's config path (Codex: `~/.codex/config.toml`; Claude Code: `~/.claude.json`); fail if no `$HOME`.
  - Compute the diff between current file and the intended additions
    (Alaya MCP server entry).
  - Print diff to stdout in unified format.
  - Prompt `[y/N]` on stdin (TTY-aware; in non-TTY mode require `--yes`).
  - On confirm: atomic write (temp file + rename); on decline: exit 0.
  - Always emit an audit row through RuntimeNotifier with action
    `attach.preview` (always) and `attach.commit` (on confirm).
- **Behaviors that MUST NOT be present**:
  - Silent mutation without preview.
  - Backups of the original file (the user owns their config; Alaya
    only writes the diff).

### 2.2 bin/alaya.mjs (extended)

- Add subcommand `attach <target>` that calls into
  `apps/core-daemon/src/cli-attach.ts` via the CLI bridge from
  P4-cli-bridge.

### 2.3 apps/core-daemon/src/__tests__/cli-attach.test.ts (NEW)

- Test cases: TTY confirm, TTY decline, non-TTY without `--yes`
  (rejected), non-TTY with `--yes` (proceed), missing `$HOME`,
  malformed target.

## 3. Deferred

- `alaya detach` — deferred to backlog #BL-15 (v0.2 cleanup tooling).

## 4. Acceptance Criteria

| AC | Criteria | Evidence |
|---|---|---|
| AC1 | `alaya attach codex` prints diff and asks for confirmation in TTY | manual smoke + e2e test |
| AC2 | `n` declines without mutation | e2e test |
| AC3 | `y` writes atomically via temp+rename | e2e test, file inode check |
| AC4 | Non-TTY without `--yes` exits non-zero | e2e test |
| AC5 | Audit rows recorded for both `attach.preview` and `attach.commit` | unit test |
| AC6 | Closing readiness label is `cli-consumable` | docs updated |

## 5. Verification

1. `rtk pnpm install`
2. `rtk pnpm exec tsc --noEmit -p apps/core-daemon`
3. `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon -t "cli-attach"`
4. Manual smoke: `rtk pnpm exec alaya attach codex` in a temp HOME with
   the daemon running.

## 6. Shared File Hazards & Dependencies

- Writes `bin/alaya.mjs` — coordinate with `P4-cli-bridge` (which owns
  the bin shell). Either dispatch sequentially, or P4-cli-bridge
  exposes a subcommand registration API and this card uses it.

**Prerequisite**: P4-daemon-skeleton, P4-cli-bridge.
**Blocks**: Gate-4 demo step 2 ("alaya attach codex writes preview
and on confirm writes config file").
```

---

## Completion Report Template

When a card requires a completion report, write it to
`docs/v0.1/phase-N-briefs/reports/task-pN-<short-id>.md`. Use this
exact layout:

```markdown
# Completion Report — Task P<N>-<short-id>

> - **Reviewed by**: <reviewer agent name or "main thread checklist">
> - **Closed at commit**: <commit hash>
> - **Closing readiness label**: <label>

## Scope Compliance

(Did the card touch only files in §2? Were any files unintentionally
expanded?)

## Port Mode Used

(`trivial-copy` / `adapt-and-port` / `requires-redesign`. List source
files copied. For adapt-and-port, attach the final Adapter Points
table with line numbers.)

## Build And Test Evidence

(Commands run, outcomes. Cite test file paths.)

## Architecture Compliance

(Which invariants were re-checked. Any §6 Stateful Mutation Checklist
items.)

## Intentional Deviations

(Anything done differently from the card. If none, write
`No intentional deviations.`.)

## Deferred Issues

(Per Anti-Tail R2: each deferral cites a backlog issue number, OR
write `Nothing deferred.`.)

## Follow-up Readiness Impact

(Per Anti-Tail R5: any live-ready label cites the integration / E2E
test that earned it.)

## Post-Landing Note

(Per Anti-Tail R4: any later edit lands as a separate `docs(<card-id>):`
commit. If none planned, write `No post-landing edits planned.`.)
```

## File Naming Conventions

- Task card file: `docs/v0.1/phase-N-briefs/task-pN-<short-id>.md`
- Completion report file: `docs/v0.1/phase-N-briefs/reports/task-pN-<short-id>.md`
- Card ID in commits: feature commits use `feat(pN-short-id): ...`;
  fix commits use `fix(pN-short-id): <finding> [review <severity>]`;
  doc-amendment commits use `docs(pN-short-id): ...`.

## Path Style

All paths are repository-relative (`vendor/do-what-new-snapshot/...`
NOT `./vendor/...` and NOT `/home/tdwhere/...`).

## Backlog Issue Numbering

Per `docs/handbook/backlog.md`, issues are numbered `#BL-001`,
`#BL-002`, ... in plain decimal sequence. The next available number
is at the top of `backlog.md`. When deferring something, append a new
issue to `backlog.md` first, then cite it in §3.
