# CLAUDE.md

All agent instructions: **`AGENTS.md`**.

## Plan mode

- Reply in Chinese.
- Plan Mode requires explicit user approval via `ExitPlanMode` before executing.
- The only file Claude may edit in Plan Mode is the plan file named in the
  plan-mode system message.

## CodeGraph (worktrees)

Every new git worktree must run `codegraph init -i` in that tree before using
CodeGraph. Details: `AGENTS.md` § CodeGraph.
