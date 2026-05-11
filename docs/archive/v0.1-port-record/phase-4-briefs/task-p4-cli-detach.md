# Implementation Brief: Task P4-cli-detach — Implement alaya detach

> - **Phase**: 4
> - **Wave**: 4
> - **Card ID**: P4-cli-detach
> - **Port mode**: requires-redesign
> - **Source**: `n/a`
> - **Target**: `apps/core-daemon/src/cli/detach.ts`, `apps/core-daemon/src/__tests__/cli-detach.test.ts`
> - **Size**: S
> - **Prerequisite**: P4-cli-bridge, P4-profile-mutation, P4-attach-codex, P4-attach-claude
> - **Blocks**: Gate-4 demo
> - **Closing readiness label**: cli-consumable
> - **Owner**: unassigned

## 0. Charter Authority

`docs/v0.1/phase-4-briefs/README.md` row "P4-cli-detach";
`docs/handbook/port-protocol.md §3 requires-redesign`;
`docs/handbook/invariants.md §21-§24` (install/uninstall symmetry per
the 2026-04-29 backlog reshape that pulled #BL-010 into v0.1) and
`docs/handbook/architecture.md §Surface Shape`.

## 1. Background & Goal

**Background**: `alaya attach codex` and `alaya attach claude-code`
write two records into the target agent's profile (the MCP server
entry plus the `/alaya-inspect` slash alias). Without a symmetric
`detach`, users who want to remove Alaya from an agent — or move to a
new machine — must hand-edit those files. This is the missing half
of the user-facing install/uninstall loop. Closes backlog #BL-010.

**Goal**: `alaya detach <target>` produces a preview of the entries
that will be removed, asks for explicit confirm, and on `y` atomically
removes both the MCP server entry and the `/alaya-inspect` slash
alias from the named target's profile, recording an audit row.

## 2. Allowed Scope

### 2.1 File Ownership

| Source | Target | Port requirement |
|---|---|---|
| `n/a` | `apps/core-daemon/src/cli/detach.ts` | Alaya-specific redesign; tests must prove each behavior listed below. |
| `n/a` | `apps/core-daemon/src/__tests__/cli-detach.test.ts` | Alaya-specific redesign; tests must prove each behavior listed below. |

### 2.2 Port Rules

- Port mode is `requires-redesign`; implementation must follow `docs/handbook/port-protocol.md` for that mode.
- Rewrite `@do-what/*` imports to `@do-soul/alaya-*` where applicable.
- Do not edit shared barrels unless this card explicitly owns that barrel.
- If a cited source path is missing or a source dependency forces files outside §2, return `BLOCKED` instead of expanding scope.

### 2.3 Required Behavior

**Targets supported (v0.1).** `codex` and `claude-code`. Other names
return a typed error with a list of the two supported names. The
detach paths must mirror the paths chosen by P4-attach-codex and
P4-attach-claude (single source of truth for "where is the profile";
do not duplicate the path-detection logic — depend on a shared helper
authored under one of those cards).

**Preview content.** The preview block prints both removals together:
1. The MCP server block that will be removed (TOML block for Codex,
   JSON sub-tree for Claude Code).
2. The `/alaya-inspect` slash alias that will be removed and the
   command it currently maps to. If the slash maps to a command other
   than `alaya inspect --open` (i.e. the user customized it),
   surface this fact and require explicit confirm before removing.

**Confirm gate.** Same `[y/N]` prompt as attach. Default is `N`. The
implementation MUST share the prompt rendering with attach so the
two preview blocks look consistent side-by-side.

**Atomic write.** Both removals are bundled. Implementation calls
`P4-profile-mutation` once per affected file, with `direction:
"remove"` semantics. If the second file's removal fails after the
first succeeded, the first is rolled back.

**No-op safety.** If the MCP entry is absent and the slash alias is
absent, the command prints `nothing to detach` and exits zero
without writing an audit row. If exactly one of the two is present,
the preview and confirm only show that one; the missing one is
reported as already absent.

**Audit row.** On any successful write (including partial: only one
of the two removed), a single audit row is written with the
`profile_mutation_detach` event kind and a payload listing the
removed records. Audit row content MUST NOT contain the user's API
key or any secret.

### 2.4 Out of Scope

- Removing `<config-dir>/.env`, `<config-dir>/alaya.toml`, the
  daemon DB, or the audit log. Those are owned by a future
  `alaya uninstall` card (not in v0.1).
- Removing other agents' profiles than the named target.
- Stopping the daemon process; detach is filesystem-only.

## 3. Deferred

- `alaya uninstall` (full removal of Alaya state) is out of v0.1.
  Tracked at follow-up; no backlog issue yet because nobody has
  requested it.

## 4. Acceptance Criteria

| AC | Criteria | Evidence |
|---|---|---|
| AC1 | All behaviors in §2 are implemented exactly as the Alaya redesign states | Targeted tests from §5 prove every listed behavior |
| AC2 | Every source path cited by this card exists before dispatch | `rtk node -e "const fs=require('fs');const paths=[];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"` exits 0 |
| AC3 | Build succeeds after this card lands | `rtk pnpm build` is green |
| AC4 | Relevant targeted tests pass | `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon -t "cli detach"` |
| AC5 | Completion report captures source files, port mode, verification, deviations, and deferrals | `docs/v0.1/phase-4-briefs/reports/task-p4-cli-detach.md` exists and cites #BL-010 as closed by this card |
| AC6 | Closing readiness label is `cli-consumable` | `docs/handbook/runtime-status.md` and `docs/v0.1/INDEX.md` are updated only after evidence supports the label |
| AC7 | Custom slash command body is detected and surfaced before removal | Targeted test seeds `/alaya-inspect` with a custom command and asserts the preview surfaces it and requires explicit confirm |
| AC8 | Rollback path is exercised | Targeted test injects a slash-file write failure after the MCP entry was already removed and asserts the MCP entry is restored |
| AC9 | No-op path does not write an audit row | Targeted test runs detach against a profile that has neither the MCP entry nor the slash alias and asserts zero audit writes |
| AC10 | Backlog #BL-010 status flips to Resolved on close | `docs/handbook/backlog.md` updated in the same PR / commit window |

## 5. Verification

1. `rtk node -e "const fs=require('fs');const paths=[];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"`
2. `rtk pnpm install`
3. `rtk pnpm build`
4. `rtk pnpm exec tsc --noEmit -p apps/core-daemon`
5. `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon -t "cli detach"`

## 6. Shared File Hazards & Dependencies

- Reuses the path-detection helper authored by P4-attach-codex /
  P4-attach-claude. Do not duplicate; if no helper exists, this card
  is BLOCKED until attach cards expose one.
- Uses `P4-profile-mutation` as the atomic-write engine; do not write
  files directly.

**Prerequisite**: P4-cli-bridge, P4-profile-mutation, P4-attach-codex, P4-attach-claude.
**Blocks**: Gate-4 demo.
