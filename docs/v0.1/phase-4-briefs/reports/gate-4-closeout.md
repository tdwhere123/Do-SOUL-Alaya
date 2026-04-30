# Gate-4 Closeout — partial close (2026-04-30)

> Gate definition: `docs/handbook/runtime-status.md §Gate Definitions Gate-4`.
> Authority: this report consolidates the three close conditions into one
> place; readers cross-link to the per-card reports below.

## TL;DR

Gate-4 is **not** fully closed in v0.1-alpha.4. One of the three close
conditions is independently complete; the other two are blocked on a
single missing test/demo harness, tracked as `#BL-018`.

| # | Close condition | State | Authority |
|---|---|---|---|
| 1 | `P4-inspector-frontend` live-event-ready | **CLOSED 2026-04-30** | `reports/task-p4-inspector-frontend.md` |
| 2 | attached-agent MCP proof | **BLOCKED** by `#BL-018` | `reports/gate-4-mcp-proof.md` |
| 3 | final review (zero Blocking / zero Important) | **CLOSED for the inspector card**; **BLOCKED for #2** | `reports/task-p4-inspector-frontend.md §Findings` |

## What landed (this closeout window)

- **ui-orbs / p4-recovery-controller worktrees deleted** — the team
  picked the Ink & Fiber Gemini variant over the Orbs variant after the
  2026-04-30 owner review; `p4-recovery-controller` had already been
  merged into main.
- **P4-inspector-frontend implementation pass** on `feat/ui-ink`:
  - 3 routes + spotlight Memory Graph + dirty-tracked Config + healthy
    Status indicator.
  - `RuntimeEmbeddingConfig` exposed as a sub-form on the Config page,
    closing the long-standing user complaint of "no place to fill in
    the embedding API key".
  - 18/18 RTL tests green; backend 8/8 still green; Reviewer Gate
    G1–G8 all green; built bundle 138 KB gzipped (budget 500 KB).
- **Documents flipped**:
  - `docs/v0.1/INDEX.md` row for `P4-inspector-frontend` →
    `live-event-ready`.
  - `docs/handbook/runtime-status.md` Phase 4 row + Memory Inspector
    subsystem row + Known Wiring Gaps section all updated.
  - `docs/handbook/backlog.md` `#BL-012` → Resolved; new `#BL-018`
    (attached-agent MCP proof harness) and `#BL-019`
    (embedding-supplement paste secret_ref pipeline) opened.

## Why Gate-4 is not yet fully closed

The Gate-4 spec (`docs/handbook/runtime-status.md:98-104`) requires the
full sequence `alaya install → alaya attach codex → tools/list shows the
full soul.* catalog → soul.recall → soul.open_pointer →
soul.report_context_usage → candidate signal → proposal → governance
reject → Garden background pass` to run **end-to-end against a real
daemon**.

We were able to validate items 1–4 of that sequence offline (see
`reports/gate-4-mcp-proof.md`). The break is at `soul.recall` →
`soul.report_context_usage`: each `alaya tools call …` invocation spawns
a fresh daemon, so the `delivery_id` from `soul.recall` is unknown to
the next process. That's not a bug in the contract — it's the v0.1
trust-state in-memory choice plus the lack of a single-process Gate-4
demo harness.

The fix is a focused harness/test that:

1. Boots the daemon once.
2. Drives the seven-step sequence in-process (or via a single MCP
   session against the running daemon).
3. Captures stdout per step into a deterministic transcript.

That work is `#BL-018`. It does NOT require any new schema, route, or
service — only a new test harness or scripted demo wrapper.

## Next-up follow-ups

- `#BL-018` — attached-agent MCP proof harness (Gate-4 blocker).
- `#BL-019` — embedding-supplement paste secret_ref pipeline (Inspector
  v0.2; deviation from card §2.3 #4).
- Optional `/schedule` agent in 1–2 weeks: re-check if `#BL-018`
  landed and post the Gate-4 transcript to a closeout amendment of this
  file.

## Reference

- `~/.claude/plans/feat-ui-ink-gate-4-inherited-moon.md` — approved
  execution plan that produced this closeout.
- `apps/inspector/web/scripts/gate-check.sh` — reproducible Reviewer
  Gate G2/G3/G4/G5 self-check.
- `docs/v0.1/phase-4-briefs/task-p4-inspector-frontend.md` — card.
- `docs/superpowers/specs/2024-05-20-ink-ui.md` — visual contract the
  frontend implements.
