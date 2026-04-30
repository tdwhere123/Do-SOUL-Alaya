# Implementation Brief: Task P4-mcp-server — Implement real MCP server transport

> - **Phase**: 4
> - **Wave**: 4
> - **Card ID**: P4-mcp-server
> - **Port mode**: requires-redesign
> - **Source**: `n/a`
> - **Target**: `apps/core-daemon/src/mcp-server.ts`, `apps/core-daemon/src/__tests__/mcp-server.test.ts`
> - **Size**: M
> - **Prerequisite**: P4-mcp-tooling, P4-mcp-memory-tools, P4-daemon-startup-ordering
> - **Blocks**: P4-attach-codex, P4-attach-claude, Gate-4 demo
> - **Closing readiness label**: mcp-consumable
> - **Owner**: unassigned

## 0. Charter Authority

`docs/v0.1/phase-4-briefs/README.md` row "P4-mcp-server";
`docs/handbook/port-protocol.md §3 requires-redesign`;
`docs/handbook/invariants.md §21-§24` and `docs/handbook/architecture.md §Surface Shape`.

## 1. Background & Goal

**Background**: This card is part of the v0.1 port-first task-card set and exists to assign exact source ownership before implementation dispatch.

**Goal**: Deliver implement real MCP server transport and expose the
complete first-party memory tool catalog from P4-mcp-memory-tools.

## 2. Allowed Scope

### 2.1 File Ownership

| Source | Target | Port requirement |
|---|---|---|
| `n/a` | `apps/core-daemon/src/mcp-server.ts` | Alaya-specific redesign; tests must prove each behavior listed below. |
| `n/a` | `apps/core-daemon/src/__tests__/mcp-server.test.ts` | Alaya-specific redesign; tests must prove each behavior listed below. |
| `n/a` | `apps/core-daemon/src/cli/register.ts` (`createMcpCommand` block only) | Alaya-specific redesign; this card owns the `alaya mcp stdio` CLI subcommand registration that drives `runAlayaMcpStdioServer`. Other subcommand registrations in this file remain owned by P4-cli-bridge §8. |

### 2.2 Port Rules

- Port mode is `requires-redesign`; implementation must follow `docs/handbook/port-protocol.md` for that mode.
- Rewrite `@do-what/*` imports to `@do-soul/alaya-*` where applicable.
- Do not edit shared barrels unless this card explicitly owns that barrel.
- If a cited source path is missing or a source dependency forces files outside §2, return `BLOCKED` instead of expanding scope.

### 2.3 Required Behavior

- Expose P4-mcp-tooling over MCP stdio; optional HTTP must share the same contract and add no SSE.
- `tools/list` returns every P4-mcp-memory-tools first-party `soul.*`
  tool exactly once.
- `tools/call` routes first-party `soul.*` calls through the
  P4-mcp-memory-tools handler and fails closed for unsupported
  namespaces or unavailable startup state.
- Fail closed until daemon startup step 6 is complete.
- `alaya mcp stdio` CLI subcommand (registered via
  `createMcpCommand` in `apps/core-daemon/src/cli/register.ts`) is the
  process entry point for the stdio transport and MUST share the
  P4-mcp-memory-tools handler with HTTP transport. Argument shape is
  exactly `mcp stdio`; any other shape exits `EX_USAGE`. The
  subcommand requires daemon-ready state and shuts the server down
  when stdin closes.

## 3. Deferred

Nothing deferred.

## 4. Acceptance Criteria

| AC | Criteria | Evidence |
|---|---|---|
| AC1 | All behaviors in §2 are implemented exactly as the Alaya redesign states | Targeted tests from §5 prove every listed behavior |
| AC2 | Every source path cited by this card exists before dispatch | `rtk node -e "const fs=require('fs');const paths=[];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"` exits 0 |
| AC3 | Build succeeds after this card lands | `rtk pnpm build` is green |
| AC4 | Relevant targeted tests pass | `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon -t "mcp server|mcp memory tool"` |
| AC5 | Completion report captures source files, port mode, verification, deviations, and deferrals | `docs/v0.1/phase-4-briefs/reports/task-p4-mcp-server.md` exists and cites backlog issues for any deferred scope |
| AC6 | Closing readiness label is `mcp-consumable` | `docs/handbook/runtime-status.md` and `docs/v0.1/INDEX.md` are updated only after evidence supports the label |

## 5. Verification

1. `rtk node -e "const fs=require('fs');const paths=[];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"`
2. `rtk pnpm install`
3. `rtk pnpm build`
4. `rtk pnpm exec tsc --noEmit -p apps/core-daemon`
5. `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon -t "mcp server|mcp memory tool"`

## 6. Shared File Hazards & Dependencies

No shared-file hazards.

**Prerequisite**: P4-mcp-tooling, P4-mcp-memory-tools, P4-daemon-startup-ordering.
**Blocks**: P4-attach-codex, P4-attach-claude, Gate-4 demo.
