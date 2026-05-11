# Implementation Brief: Task P4-cli-install — Implement alaya install

> - **Phase**: 4
> - **Wave**: 4
> - **Card ID**: P4-cli-install
> - **Port mode**: requires-redesign
> - **Source**: `n/a`
> - **Target**: `apps/core-daemon/src/cli/install.ts`, `apps/core-daemon/src/__tests__/cli-install.test.ts`
> - **Size**: M
> - **Prerequisite**: P4-cli-bridge, P4-daemon-startup-ordering, P4-secrets
> - **Blocks**: P4-attach-codex, P4-attach-claude, P4-cli-detach, Gate-4 demo
> - **Closing readiness label**: cli-consumable
> - **Owner**: unassigned

## 0. Charter Authority

`docs/v0.1/phase-4-briefs/README.md` row "P4-cli-install";
`docs/handbook/port-protocol.md §3 requires-redesign`;
`docs/handbook/invariants.md §21-§24` and `docs/handbook/architecture.md §Surface Shape`.

## 1. Background & Goal

**Background**: `alaya install` is the first-run interactive setup
command. It bootstraps every runtime input the daemon needs from a
fresh machine: durable storage location, provider configuration
skeleton (with secret-refs, never plaintext keys), embedding feature
flag, and the initial audit log row. Every subsequent CLI command
(`attach`, `inspect`, `tools call`, `doctor`) assumes `install` has
run successfully on the same machine.

**Goal**: A fresh machine running `rtk pnpm exec alaya install` can
produce, via interactive prompts, the on-disk state required by the
daemon at next boot (DB file, config dir, `.env` with secret-refs,
audit init), and re-running it patches existing values without
clobbering unset ones.

## 2. Allowed Scope

### 2.1 File Ownership

| Source | Target | Port requirement |
|---|---|---|
| `n/a` | `apps/core-daemon/src/cli/install.ts` | Alaya-specific redesign; tests must prove each behavior listed below. |
| `n/a` | `apps/core-daemon/src/__tests__/cli-install.test.ts` | Alaya-specific redesign; tests must prove each behavior listed below. |

### 2.2 Port Rules

- Port mode is `requires-redesign`; implementation must follow `docs/handbook/port-protocol.md` for that mode.
- Rewrite `@do-what/*` imports to `@do-soul/alaya-*` where applicable.
- Do not edit shared barrels unless this card explicitly owns that barrel.
- If a cited source path is missing or a source dependency forces files outside §2, return `BLOCKED` instead of expanding scope.

### 2.3 Required Behavior

**v0.1 sanctioned narrowing — interactive path deferred.** v0.1 only
implements the `--non-interactive --json` path. The interactive
`alaya install` flow described in the prompts table below is the
target behavior but its TTY layer is intentionally deferred to a
post-v0.1 follow-up; on v0.1 the CLI MUST exit `EX_USAGE` with a
single-line stderr `interactive install is not implemented in this
build; use --non-interactive <json>` and write no files. The JSON
answer envelope is therefore the explicit confirmation that replaces
the `[y/N]` confirm gate in v0.1; the audit-precedes-mutation
ordering required by §10 is preserved by writing the `started` audit
row before any filesystem write and the `succeeded` / `failed` row
after. The prompts table below remains the authoritative input
schema for `--non-interactive --json` and the future interactive
implementation.

**Config dir resolution.** Use XDG conventions:
- `${ALAYA_CONFIG_DIR}` when set (escape hatch for tests).
- Otherwise `${XDG_CONFIG_HOME:-$HOME/.config}/alaya/` on Linux/macOS.
- Otherwise `%APPDATA%/alaya/` on Windows.

The CLI MUST `mkdir -p` this directory (mode `0700`) before writing
any file inside it.

**Files written.**
- `<config-dir>/alaya.toml` — non-secret runtime config (DB path,
  worktree flag, embedding feature flag, default workspace id).
  Initial section list: `[storage]`, `[runtime]`, `[embedding]`.
- `<config-dir>/.env` — secret-ref envelope only. Mode `0600`. Each
  line is `KEY=<secret-ref>` where `<secret-ref>` follows the syntax
  defined by P4-secrets §2.3 (`env:NAME` or `file:/abs/path`).
  Plaintext keys MUST NOT be written here; if the user pastes one,
  the installer offers to write it to `<config-dir>/secrets/openai`
  (mode `0600`) and store `file:<path>` in `.env`.
- `<config-dir>/audit/install-<UTC-iso>.json` — single-line JSON
  describing the install event for the daemon's audit log to
  reconcile on next boot.

**Interactive prompts (in order).**

| # | Prompt | Default | Writes to |
|---|---|---|---|
| 1 | DB file path | `<config-dir>/alaya.db` | `alaya.toml` `[storage].db_path` |
| 2 | Enable embedding supplement? (y/N) | `N` | `alaya.toml` `[embedding].enabled` and `.env` `ALAYA_ENABLE_EMBEDDING_SUPPLEMENT` |
| 3 | (only if 2 = y) Embedding provider URL or `keep` to use OpenAI default | `keep` | `alaya.toml` `[embedding].provider_base_url` (omitted when `keep`) and `.env` `OPENAI_EMBEDDING_PROVIDER_URL` when set |
| 4 | (only if 2 = y) Embedding model id | `text-embedding-3-small` | `alaya.toml` `[embedding].model_id` and `.env` `OPENAI_EMBEDDING_MODEL` |
| 5 | (only if 2 = y) API key source: `env`, `file`, `paste` | `env` | `.env` `ALAYA_OPENAI_SECRET_REF=<secret-ref>` |
| 6 | (only if 2 = y AND 5 = `env`) Env var name | `OPENAI_API_KEY` | `.env` records `env:<name>` |
| 7 | (only if 2 = y AND 5 = `file`) Path to existing key file | (no default) | `.env` records `file:<path>` |
| 8 | (only if 2 = y AND 5 = `paste`) Key value | (hidden input) | written to `<config-dir>/secrets/openai` with `0600`, `.env` records `file:<that path>` |
| 9 | Default workspace id | `default` | `alaya.toml` `[runtime].default_workspace` |
| 10 | Worktree feature on? (y/N) | `N` | `alaya.toml` `[runtime].worktree_enabled` |

**Re-run mode (patch, do not clobber).** When `alaya.toml` already
exists, every prompt's default switches to the existing value. If the
user accepts every default, the only thing written is a fresh audit
row. Tests MUST prove this idempotency.

**Non-interactive mode.** `alaya install --non-interactive --json
<inline-json>` accepts the full answer set as a JSON object using the
same field names as the prompts table. Used by tests and by the
attach flow if it ever needs to reprovision.

**Failure modes.**
- Existing config dir with insufficient permissions: print remediation
  and exit non-zero. Do not attempt to chmod.
- Pasted key but `<config-dir>/secrets/` cannot be created at `0700`:
  abort before any `.env` write so partial state is impossible.
- Any write step fails: write the audit row with `status: "failed"`
  and the partial state list, then exit non-zero. Reviewers MUST be
  able to read this audit row to diagnose.

**Out of scope (will be rejected at review).**
- OS keychain integration (deferred to backlog #BL-009).
- Non-OpenAI provider templates (deferred; pi-mono integration in
  v0.2 per #BL-008).
- Writing any field that does not appear in the prompts table.
- Calling the daemon process; install operates on filesystem only.

## 3. Deferred

- OS keychain support deferred to backlog #BL-009.
- Non-OpenAI provider templates deferred to backlog #BL-008 (pi-mono
  integration in v0.2).

## 4. Acceptance Criteria

| AC | Criteria | Evidence |
|---|---|---|
| AC1 | All behaviors in §2 are implemented exactly as the Alaya redesign states | Targeted tests from §5 prove every listed behavior |
| AC2 | Every source path cited by this card exists before dispatch | `rtk node -e "const fs=require('fs');const paths=[];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"` exits 0 |
| AC3 | Build succeeds after this card lands | `rtk pnpm build` is green |
| AC4 | Relevant targeted tests pass | `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon -t "cli install"` |
| AC5 | Completion report captures source files, port mode, verification, deviations, and deferrals | `docs/v0.1/phase-4-briefs/reports/task-p4-cli-install.md` exists and cites backlog issues for any deferred scope |
| AC6 | Closing readiness label is `cli-consumable` | `docs/handbook/runtime-status.md` and `docs/v0.1/INDEX.md` are updated only after evidence supports the label |

## 5. Verification

1. `rtk node -e "const fs=require('fs');const paths=[];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"`
2. `rtk pnpm install`
3. `rtk pnpm build`
4. `rtk pnpm exec tsc --noEmit -p apps/core-daemon`
5. `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon -t "cli install"`

## 6. Shared File Hazards & Dependencies

No shared-file hazards.

**Prerequisite**: P4-cli-bridge, P4-daemon-startup-ordering, P4-secrets.
**Blocks**: P4-attach-codex, P4-attach-claude, P4-cli-detach, Gate-4 demo.
