# Implementation Brief: Task P4-cli-bridge — Implement Alaya CLI subcommand bridge

> - **Phase**: 4
> - **Wave**: 4
> - **Card ID**: P4-cli-bridge
> - **Port mode**: requires-redesign
> - **Source**: `n/a`
> - **Target**: `bin/alaya.mjs`, `apps/core-daemon/src/cli/bridge.ts`, `apps/core-daemon/src/__tests__/cli-bridge.test.ts`
> - **Size**: M
> - **Prerequisite**: P4-daemon-startup-ordering
> - **Blocks**: P4-mcp-memory-tools, P4-cli-doctor, P4-cli-install, P4-cli-status, P4-attach-codex, P4-attach-claude, P4-profile-mutation, P4-secrets, P4-operations
> - **Closing readiness label**: cli-consumable
> - **Owner**: unassigned

## 0. Charter Authority

`docs/v0.1/phase-4-briefs/README.md` row "P4-cli-bridge";
`docs/handbook/port-protocol.md §3 requires-redesign`;
`docs/handbook/invariants.md §21` (Alaya has no GUI/TUI; CLI is one of two surfaces),
`docs/handbook/invariants.md §22` (MCP and CLI fallback share one runtime contract);
`docs/handbook/architecture.md §Surface Shape` and `§Daemon Startup Ordering` step 7 (CLI bridge wires after MCP transport binds).

This card is `requires-redesign` because upstream `bin/do-what.mjs` only knows `cli` / `app` for upstream-specific surfaces (GUI app dev server, TUI dev server) — none of which exist in Alaya. The Alaya CLI shell is greenfield.

## 1. Background & Goal

**Background**: This card is part of the v0.1 port-first task-card set and exists to assign exact source ownership before implementation dispatch.

**Goal**: Deliver implement Alaya CLI subcommand bridge, including the
dispatch hook used later by `alaya tools list` and
`alaya tools call --json`.

## 2. Allowed Scope

### 2.1 File Ownership

| Source | Target | Port requirement |
|---|---|---|
| `n/a` | `bin/alaya.mjs` | Alaya-specific redesign; tests must prove each behavior listed below. |
| `n/a` | `apps/core-daemon/src/cli/bridge.ts` | Alaya-specific redesign; tests must prove each behavior listed below. |
| `n/a` | `apps/core-daemon/src/__tests__/cli-bridge.test.ts` | Alaya-specific redesign; tests must prove each behavior listed below. |

### 2.2 Port Rules

- Port mode is `requires-redesign`; implementation must follow `docs/handbook/port-protocol.md` for that mode.
- Rewrite `@do-what/*` imports to `@do-soul/alaya-*` where applicable.
- Do not edit shared barrels unless this card explicitly owns that barrel.
- If a cited source path is missing or a source dependency forces files outside §2, return `BLOCKED` instead of expanding scope.

### 2.3 Subcommand Registration API (the contract that 9 downstream cards depend on)

Public exports from `apps/core-daemon/src/cli/bridge.ts`:

```ts
import { z } from "zod";

export interface AlayaCliContext {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly argv: readonly string[];        // post-subcommand-name args
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly isTTY: boolean;
  readonly daemon: AlayaDaemonHandle;       // typed handle from P4-daemon-skeleton
}

export interface AlayaCliResult {
  readonly exitCode: number;                // 0 success; non-zero per §2.4 exit code table
  readonly json?: unknown;                  // populated when --json was passed
}

export interface AlayaSubcommandSpec<TArgs = unknown> {
  readonly name: string;                    // e.g. "doctor", "attach", "tools"
  readonly description: string;             // one-line for --help
  readonly argsSchema: z.ZodType<TArgs>;    // parsed from argv after the subcommand name
  readonly handler: (ctx: AlayaCliContext, args: TArgs) => Promise<AlayaCliResult>;
  readonly requiresDaemonReady: boolean;    // if true, dispatch fails closed before daemon startup step 6
}

export interface AlayaCliBridge {
  registerSubcommand<TArgs>(spec: AlayaSubcommandSpec<TArgs>): void;
  dispatch(argv: readonly string[]): Promise<AlayaCliResult>;
  list(): readonly { name: string; description: string }[];
}

export function createAlayaCliBridge(daemon: AlayaDaemonHandle): AlayaCliBridge;
```

**Mandatory behaviors**:

| # | Behavior | Test name |
|---|---|---|
| B1 | `registerSubcommand` rejects duplicate `name` (case-sensitive); throws `DuplicateSubcommandError` | `register rejects duplicate name` |
| B2 | `dispatch(argv)` parses `argv[0]` as subcommand name; if unknown returns `{ exitCode: 64 }` (USAGE) and prints help to stderr | `unknown subcommand returns 64` |
| B3 | `dispatch` validates `argv[1..]` through `argsSchema`; on parse failure returns `{ exitCode: 64 }` and prints zod error to stderr | `args validation returns 64 on failure` |
| B4 | `dispatch` honors `--json` global flag: when set, the handler's `result.json` is serialized to stdout as a single line; when unset, the handler may write human-readable output to stdout directly | `--json flag round-trips json result` |
| B5 | `dispatch` honors `--help` / `-h` global flag: when set, prints subcommand help to stdout and returns `{ exitCode: 0 }` without invoking handler | `--help short-circuits` |
| B6 | If `spec.requiresDaemonReady` is true and daemon is not at startup step 6, dispatch returns `{ exitCode: 75 }` (TEMPFAIL) without invoking handler; prints `daemon not ready` to stderr | `pre-ready dispatch fails closed with 75` |
| B7 | Handler exceptions are caught: dispatch returns `{ exitCode: 70 }` (SOFTWARE) and prints sanitized error message to stderr (no stack traces by default; stack only when `process.env.ALAYA_DEBUG === "1"`) | `handler exception caught and sanitized` |
| B8 | `bin/alaya.mjs` (the binary entry) imports `createAlayaCliBridge` from `apps/core-daemon`, registers no subcommands itself, and exits with `result.exitCode` | `binary delegates to bridge cleanly` |
| B9 | `list()` returns subcommands in registration order (deterministic) | `list preserves registration order` |

### 2.4 Exit Code Table

Follow `sysexits.h` conventions for downstream tooling compat:

| Code | Meaning | When |
|---|---|---|
| 0 | OK | success |
| 64 | EX_USAGE | unknown subcommand, args parse failure, missing required arg |
| 65 | EX_DATAERR | input data invalid (e.g. malformed config file) |
| 66 | EX_NOINPUT | required input file missing |
| 70 | EX_SOFTWARE | handler threw an unhandled exception |
| 73 | EX_CANTCREAT | permission denied creating file (e.g. attach config write) |
| 75 | EX_TEMPFAIL | daemon not ready / transient failure |
| 77 | EX_NOPERM | permission denied reading file |

### 2.5 Downstream Card Conformance List

These 9 cards register subcommands through `AlayaCliBridge.registerSubcommand`. Each MUST conform to the API in §2.3 and use exit codes from §2.4:

1. P4-cli-doctor (`doctor`)
2. P4-cli-install (`install`)
3. P4-cli-status (`status`)
4. P4-attach-codex + P4-attach-claude (both register `attach` with `target` arg dispatch — coordinate so only one card owns the registration; the other extends via the target dispatcher)
5. P4-profile-mutation (no direct subcommand; library used by attach cards)
6. P4-secrets (no direct subcommand; library used by other cards)
7. P4-operations (`backup`, `export`, `import` — three subcommands)
8. P4-mcp-memory-tools (`tools list`, `tools call --json` — two subcommands or one with sub-dispatch)

Coordination note: `attach` is registered exactly once (the first attach card to land registers the dispatcher; the other adds a target handler via a shared registry pattern). Document this in both attach cards' §6.

### 2.6 API Freeze Gate

After this card lands, the §2.3 interface signatures are **frozen** for the remainder of v0.1. Downstream cards that need new fields on `AlayaCliContext` or `AlayaSubcommandSpec` MUST NOT modify this card; they must open a `P4-cli-bridge-followup` micro-card that lists exactly the additive fields and is reviewed against §28.

## 3. Deferred

Nothing deferred.

## 4. Acceptance Criteria

| AC | Criteria | Evidence |
|---|---|---|
| AC1 | All behaviors in §2 are implemented exactly as the Alaya redesign states | Targeted tests from §5 prove every listed behavior |
| AC2 | Every source path cited by this card exists before dispatch | `rtk node -e "const fs=require('fs');const paths=[];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"` exits 0 |
| AC3 | Build succeeds after this card lands | `rtk pnpm build` is green |
| AC4 | Relevant targeted tests pass | `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon -t "cli bridge"` |
| AC5 | Completion report captures source files, port mode, verification, deviations, and deferrals | `docs/v0.1/phase-4-briefs/reports/task-p4-cli-bridge.md` exists and cites backlog issues for any deferred scope |
| AC6 | Closing readiness label is `cli-consumable` | `docs/handbook/runtime-status.md` and `docs/v0.1/INDEX.md` are updated only after evidence supports the label |

## 5. Verification

1. `rtk node -e "const fs=require('fs');const paths=[];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"`
2. `rtk pnpm install`
3. `rtk pnpm build`
4. `rtk pnpm exec tsc --noEmit -p apps/core-daemon`
5. `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon -t "cli bridge"`

## 6. Shared File Hazards & Dependencies

- Touches `bin/alaya.mjs`; serialize through P4-cli-bridge.

**Prerequisite**: P4-daemon-startup-ordering.
**Blocks**: P4-mcp-memory-tools, P4-cli-doctor, P4-cli-install, P4-cli-status, P4-attach-codex, P4-attach-claude, P4-profile-mutation, P4-secrets, P4-operations.
