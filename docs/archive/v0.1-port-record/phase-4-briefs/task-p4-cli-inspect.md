# Implementation Brief: Task P4-cli-inspect — Implement alaya inspect

> - **Phase**: 4
> - **Wave**: 4
> - **Card ID**: P4-cli-inspect
> - **Port mode**: requires-redesign
> - **Source**: `n/a`
> - **Target**: `apps/core-daemon/src/cli/inspect.ts`, `apps/core-daemon/src/__tests__/cli-inspect.test.ts`
> - **Size**: S
> - **Prerequisite**: P4-cli-bridge, P4-daemon-startup-ordering, P4-inspector-server
> - **Blocks**: P4-attach-codex, P4-attach-claude, P4-cli-detach, Gate-4 demo
> - **Closing readiness label**: cli-consumable
> - **Owner**: unassigned

## 0. Charter Authority

`docs/v0.1/phase-4-briefs/README.md` row "P4-cli-inspect";
`docs/handbook/port-protocol.md §3 requires-redesign`;
`docs/handbook/invariants.md §21` (narrowed 2026-04-29 to permit the
Memory Inspector as a memory-tooling surface) and
`docs/handbook/architecture.md §Surface Shape`.

## 1. Background & Goal

**Background**: The Memory Inspector is a separate process
(`apps/inspector`) authorized by the 2026-04-29 narrowing of
invariant §21. `alaya inspect` is the CLI entry point that starts
the Inspector server, generates a per-launch random token, prints a
URL containing the token, and optionally opens the user's default
browser. Without this command, the Inspector server has no operator-
facing way to launch.

**Goal**: `rtk pnpm exec alaya inspect [--open] [--port N]` starts
the Inspector server bound to `127.0.0.1:5174` with a freshly
generated random token, prints `http://127.0.0.1:5174/?token=<token>`
to stdout, and (when `--open` is passed) calls the platform's
"open URL" helper to launch the default browser. The command keeps
the Inspector process attached until Ctrl-C; on Ctrl-C the Inspector
is signaled to shut down cleanly.

## 2. Allowed Scope

### 2.1 File Ownership

| Source | Target | Port requirement |
|---|---|---|
| `n/a` | `apps/core-daemon/src/cli/inspect.ts` | Alaya-specific redesign; tests must prove each behavior listed below. |
| `n/a` | `apps/core-daemon/src/__tests__/cli-inspect.test.ts` | Alaya-specific redesign; tests must prove each behavior listed below. |

### 2.2 Port Rules

- Port mode is `requires-redesign`; implementation must follow `docs/handbook/port-protocol.md` for that mode.
- Rewrite `@do-what/*` imports to `@do-soul/alaya-*` where applicable.
- Do not edit shared barrels unless this card explicitly owns that barrel.
- If a cited source path is missing or a source dependency forces files outside §2, return `BLOCKED` instead of expanding scope.

### 2.3 Required Behavior

**Subcommand registration.** Registers via `AlayaCliBridge.registerSubcommand`
(P4-cli-bridge §2.3). Subcommand name is `inspect`.

**Flags.**
- `--open` (boolean, default `false`) — open the printed URL in the
  default browser via the platform "open URL" helper. On Linux this
  is `xdg-open`, on macOS `open`, on Windows `start`. If the helper
  is missing, the command MUST still print the URL and continue;
  `--open` is best-effort, not a hard requirement.
- `--port N` (integer, default `5174`) — Inspector listen port. The
  CLI MUST bind to `127.0.0.1` only; binding to `0.0.0.0` is
  forbidden. Tests assert this.
- `--token <hex>` (test-only override, not documented in user help)
  — accept a pre-generated token instead of generating one. Allows
  deterministic tests; in user help text this flag is hidden.

**Token generation.** Per-launch random token, ≥ 256 bits of entropy
from `crypto.randomBytes(32).toString("hex")`. Token is unique per
process; restarting the Inspector generates a new one (no
persistence). Token is NOT logged anywhere except the printed URL.

**URL printing.** Exactly one line on stdout, ending with a
newline:

```
http://127.0.0.1:<port>/?token=<token>
```

No banner, no leading whitespace, no extra characters. This format
is what the `/alaya-inspect` slash alias parses; tests pin the
format with a regex.

**Process model.** `alaya inspect` spawns the Inspector server as a
child process (per the 2026-04-29 decision: `apps/inspector` is a
separate process, not a route inside `core-daemon`). The CLI:
1. Starts the child with token in env var `ALAYA_INSPECTOR_TOKEN`.
2. Waits for the child's "ready" signal (single line on the child's
   stdout: `inspector_ready`).
3. Prints the URL (per "URL printing" above).
4. Forwards the child's stdout/stderr to the CLI's, prefixed with
   `[inspector] ` so logs are distinguishable.
5. On SIGINT / SIGTERM, sends SIGTERM to the child, waits up to
   2000 ms, then sends SIGKILL.

**Non-running daemon is OK.** `alaya inspect` does NOT require
`core-daemon` to be running. The Inspector server proxies HTTP
requests to the daemon; if the daemon is down, the Inspector still
starts and the SPA renders an error page on each request. This lets
users open the Inspector to fix a broken provider config without
booting the daemon first.

**Reentrancy.** If port `5174` is already bound, the CLI prints a
remediation line (`port 5174 in use; try alaya inspect --port 5175`)
and exits non-zero. Tests assert this.

### 2.4 Out of Scope

- HTTPS / TLS. The Inspector listens on plain HTTP; token is the
  only auth. Any network exposure beyond loopback is a config error
  caught by the `127.0.0.1`-only bind.
- Persistent token (token survives restart). Token regeneration is a
  feature.
- Daemon health check. `alaya inspect` does not poll the daemon; the
  SPA does.

## 3. Deferred

Nothing deferred.

## 4. Acceptance Criteria

| AC | Criteria | Evidence |
|---|---|---|
| AC1 | All behaviors in §2 are implemented exactly as the Alaya redesign states | Targeted tests from §5 prove every listed behavior |
| AC2 | Every source path cited by this card exists before dispatch | `rtk node -e "const fs=require('fs');const paths=[];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"` exits 0 |
| AC3 | Build succeeds after this card lands | `rtk pnpm build` is green |
| AC4 | Relevant targeted tests pass | `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon -t "cli inspect"` |
| AC5 | Completion report captures source files, port mode, verification, deviations, and deferrals | `docs/v0.1/phase-4-briefs/reports/task-p4-cli-inspect.md` exists and cites #BL-012 as the issue this card partially closes |
| AC6 | Closing readiness label is `cli-consumable` | `docs/handbook/runtime-status.md` and `docs/v0.1/INDEX.md` are updated only after evidence supports the label |
| AC7 | Token is ≥ 256 bits of entropy and printed only inside the URL | Test asserts token byte length and asserts the token does not appear in any other stdout / stderr line |
| AC8 | Inspector binds to `127.0.0.1` only | Test asserts a connect to `0.0.0.0:<port>` from a non-loopback interface fails |
| AC9 | Ctrl-C cleanly stops the child Inspector process | Test sends SIGINT to the CLI and asserts the child receives SIGTERM and exits within 2000 ms |
| AC10 | Reentry on a busy port produces remediation line + non-zero exit | Test pre-binds the port and asserts the message and exit code |

## 5. Verification

1. `rtk node -e "const fs=require('fs');const paths=[];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"`
2. `rtk pnpm install`
3. `rtk pnpm build`
4. `rtk pnpm exec tsc --noEmit -p apps/core-daemon`
5. `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon -t "cli inspect"`

## 6. Shared File Hazards & Dependencies

- `bin/alaya.mjs` subcommand registration goes through
  `AlayaCliBridge.registerSubcommand` (P4-cli-bridge §2.3 frozen
  interface). Do NOT edit `bin/alaya.mjs` directly.
- The Inspector server child is owned by P4-inspector-server. This
  card spawns it but does not author any inspector source.

**Prerequisite**: P4-cli-bridge, P4-daemon-startup-ordering, P4-inspector-server.
**Blocks**: P4-attach-codex (which also registers the slash alias pointing at this command), P4-attach-claude (same), P4-cli-detach (slash alias removal), Gate-4 demo (step 11).
