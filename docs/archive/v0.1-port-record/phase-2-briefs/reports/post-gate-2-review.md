# Phase 2 Post-Gate-2 Aggregate Review Report

## Scope

After Gate-2 closed at commit `0aab73f`, all 32 Phase 2 task cards were
re-reviewed by 6 read-only sub-agents to surface anything that the
per-card review loop missed. This report aggregates the sub-agent
findings. **No code or test files were modified by this review pass.**

Per user direction, this round is report-only: each finding lists
`Suggested Disposition` for later action. No fix commits were created.

Source planning artifact: `~/.claude/plans/phase-2-review-dapper-hopcroft.md`.

## Method

- 6 review clusters dispatched in parallel; each cluster's prompt cited
  `docs/handbook/workflow/review-protocol.md`,
  `docs/handbook/port-protocol.md`,
  `docs/handbook/invariants.md`,
  `docs/handbook/workflow/agent-workflow.md` (R1–R5), and
  `docs/handbook/workflow/subagent-dispatch.md` failure modes 1–16 as
  the `Cause Class` enum.
- Each sub-agent ran `git diff` against the frozen vendor snapshot for
  every ported file, audited adapter-point tables for `adapt-and-port`
  cards, and verified the `requires-redesign` invariant cite for
  `event-publisher`.
- The main thread spot-verified 3 of the 4 substantive findings against
  raw `git show` output to confirm they are real.

## Cluster Roll-up

| Cluster | Cards | PASS | FINDINGS | Sub-agent type |
|---|---|---|---|---|
| R1 Storage repos | 7 | 7 | 0 | general-purpose |
| R2 Core trivial services | 7 | 7 | 0 | general-purpose |
| R3 Core memory chain (adapt) | 5 | 5 | 0 | general-purpose |
| R4 Core recall + synthesis (adapt) | 5 | 3 | 3 (I:2 / N:1) | general-purpose |
| R5 Garden + Barrel + EventPublisher | 6 | 6 | 1 (I:1) | general-purpose |
| R6 Security | 2 | 2 | 0 | security-reviewer |
| **Total** | **32** | **30** | **4** | — |

Severity totals: **Blocking 0 / Important 3 / Nice-to-have 1**.

Gate-2 closure status is unchanged by this report: zero Blocking
findings, and every Important finding is procedural (commit hygiene),
not behavioral.

## Findings By Severity

### Important

#### I1 — `P2-svc-synthesis` SSE-to-runtime-notifier reclassification bundled into Gate-2 wave commit

- **Location**: commit `0aab73f` (`packages/core/src/synthesis-service.ts +483`,
  `packages/core/src/__tests__/synthesis-service.test.ts +548`,
  `docs/v0.1/phase-2-briefs/task-p2-svc-synthesis.md +21`,
  `docs/v0.1/phase-2-briefs/reports/task-p2-svc-synthesis.md +74`,
  alongside 11 other cards' worth of feature code, totaling 48 files /
  +11098 lines).
- **Observed**: `gate-2-closeout.md` §"Review And Fix Loop" classifies
  the synthesis SSE → runtime-notifier rename as a fix produced during
  the Gate-2 review/fix loop. That fix and the first-time landing of
  `synthesis-service.ts` arrived together in `0aab73f` with no
  preceding `feat(P2-svc-synthesis):` or `fix(P2-svc-synthesis):`
  commit on `main`.
- **Expected**: `agent-workflow.md` Anti-Tail R1 — fix commits must not
  be bundled into feature commits. `review-protocol.md` §"Atomic Fix
  Commits" — a fix commit must stand alone with the message shape
  `fix(<card-id>): <finding> [review <severity>]`.
- **Repro / Witness**: `rtk git show --stat 0aab73f` shows the bundle.
  `rtk git log --all --oneline -- packages/core/src/synthesis-service.ts`
  returns only `0aab73f`, confirming no preceding atomic commit.
  **Spot-verified by main thread** ✓ (synthesis-service.ts +483 and
  task-p2-svc-synthesis.md +21 both appear in 0aab73f's stat).
- **Cause Class**: R1 atomic-fix-commit discipline.
- **Suggested Disposition**: Open backlog issue. The behavior is
  correct (verified by clean diff against vendor + adapter-point map +
  passing tests), so no source-code fix is needed; the gap is in
  commit history. Future phases should adopt a stricter wave-merge policy
  (per `agent-workflow.md` Phase Worktree And Merge Pipeline) that
  preserves per-card review-fix commits instead of silently accepting a
  wave-close carve-out.
- **Fix-Loop Disposition**: Commit `2dde29d`
  (`fix(post-gate-2-review): record Gate-2 R1 prevention [review important]`)
  records prevention without history rewrite or R1 exemption. `#BL-014`
  tracks the historical Gate-2 gap and `agent-workflow.md` now requires
  future phase/wave closeout to preserve standalone review-fix commits or
  document a parent-approved exception before gate closeout while keeping
  R1/R4 strict.

#### I2 — `P2-svc-proposal` SSE-to-runtime-notifier reclassification bundled into Gate-2 wave commit

- **Location**: commit `0aab73f` (`packages/core/src/proposal-service.ts +586`,
  `packages/core/src/__tests__/proposal-service.test.ts +573`,
  `docs/v0.1/phase-2-briefs/task-p2-svc-proposal.md +21`,
  `docs/v0.1/phase-2-briefs/reports/task-p2-svc-proposal.md +74`).
- **Observed**: Same pattern as I1. The proposal SSE → runtime-notifier
  rename was a Gate-2 fix-loop output that landed bundled with the
  first-time feature landing of `proposal-service.ts` in `0aab73f`.
  No preceding atomic commit exists.
- **Expected**: Same as I1 (R1).
- **Repro / Witness**: `rtk git show --stat 0aab73f` and
  `rtk git log --all --oneline -- packages/core/src/proposal-service.ts`.
  **Spot-verified by main thread** ✓.
- **Cause Class**: R1 atomic-fix-commit discipline.
- **Suggested Disposition**: Same as I1 — single backlog issue covering
  both synthesis and proposal would consolidate the policy decision.
- **Fix-Loop Disposition**: Same as I1; commit `2dde29d` and `#BL-014`
  cover both I1 and I2. No runtime/source fix and no history rewrite are
  planned.

#### I3 — `P2-svc-event-publisher` post-landing docs commits do not co-touch the task card

- **Location**: commits `535d52f`, `487599b`, `292d618`.
- **Observed**: All three `docs(P2-svc-event-publisher):` commits modify
  only `docs/v0.1/phase-2-briefs/reports/task-p2-svc-event-publisher.md`.
  The task card at `docs/v0.1/phase-2-briefs/task-p2-svc-event-publisher.md`
  was last touched in `61018fb` and was never co-touched by these three
  post-landing amendments.
- **Expected**: `agent-workflow.md` Anti-Tail R4 — "Edits to a task card
  or completion report after the closing commit must land as a separate
  commit prefixed `docs(<card-id>):` that touches the card and the
  report in the same commit."
- **Repro / Witness**: `rtk git show --stat 535d52f 487599b 292d618`
  shows only the report file path; the card was not co-touched.
  **Spot-verified by main thread** ✓ (each commit changes exactly 1
  file: the report).
- **Cause Class**: #16 — Misleading availability docs (residual).
- **Suggested Disposition**: Open backlog issue. The 3 docs commits
  together added 30 lines to the report (2 review-fix evidence
  records + 1 concurrency note + 1 failed-retry note) without
  reflecting any of those review-fix outcomes back into the task card's
  Acceptance Criteria, Verification, or Adapter Points sections. Issue a
  single follow-up `docs(P2-svc-event-publisher):` commit that mirrors
  the report's review-fix narrative back into the card; do not relax R4
  to allow report-only post-landing amendments.
- **Fix-Loop Disposition**: Commit `ff3aedd`
  (`fix(P2-svc-event-publisher): mirror post-landing report fixes [review important]`)
  chose option (a). The EventPublisher card and report are co-touched in
  this docs-only fix loop; R4 is not relaxed.

### Nice-to-have

#### N1 — `P2-svc-proposal` §2.3 Adapter Points table omits cascading internal renames

- **Location**: `docs/v0.1/phase-2-briefs/task-p2-svc-proposal.md` §2.3
  (lines 45-49) vs the diff in `packages/core/src/proposal-service.ts`
  (line 308 `broadcastDeferredEvents` → `notifyDeferredEvents`, lines
  462-467) and `packages/core/src/__tests__/proposal-service.test.ts`
  (lines 106, 125, 173, 521-572 — `broadcastSpy` → `notifySpy`,
  `broadcastOrder` → `notificationOrder`).
- **Observed**: §2.3 lists 3 public-API adapter rows. The diff also
  contains private-method, local-variable, comment-text, and test-name
  renames that map directly to the SSE → runtime-notifier rule but are
  not enumerated as separate rows.
- **Expected**: `port-protocol.md` §adapt-and-port — "The task card §2
  Allowed Scope MUST list every adapter point with before/after."
- **Repro / Witness**: documentation finding (table inspection).
- **Cause Class**: none (table completeness).
- **Suggested Disposition**: Add a single footnote row to the §2.3
  table reading "all derived internal symbols (private methods, local
  variables, comment text, test names) follow the same SSE →
  runtime-notifier rename rule as rows 1-3 above." The same gap
  exists in the synthesis card by extension — fix both in one
  `docs(P2-svc-synthesis,P2-svc-proposal):` commit.
- **Fix-Loop Disposition**: Commit `6181343`
  (`fix(P2-svc-synthesis,P2-svc-proposal): document derived notifier renames [review nice-to-have]`)
  fixed both synthesis and proposal cards/reports with one derived
  internal rename row/note covering private methods, local variables,
  comments, and tests.

## Cross-Cutting Observations

These are not Review Findings but are worth surfacing to the team:

1. **`rtk diff` may falsely report file equality.** The R6 reviewer
   noticed that `rtk diff` returned `[ok] Files are identical` for two
   files (`cross-cutting-permission-service.ts` and its test) that
   contained genuine adapter-point changes (SSE → runtime-notifier).
   The system `diff` (GNU 3.10) confirmed the actual deltas. R1–R5 all
   relied on `rtk diff` for byte-equality checks, so it is possible
   (though we have no specific evidence of it) that some subtle
   adapter-point drift in those clusters was masked. **Recommended**:
   when running future port-verification reviews, use system `diff`
   directly rather than `rtk diff`, OR confirm with `rtk` maintainers
   that mechanical-rewrite collapsing is in scope of the proxy and
   document it in `RTK.md`.

2. **Wave-close commits as a structural R1 merge risk.** Both I1 and I2
   stem from the same root: the Gate-2 closeout commit `0aab73f`
   batched together (a) first-time landings for `synthesis-service.ts`,
   `proposal-service.ts`, `recall-service.ts`, `manifestation-resolver.ts`,
   `task-surface-builder.ts` and 4+ Garden files, AND (b) review-fix
   output from the synthesis/proposal SSE-reclassification loop.
   Whether this is acceptable depends on whether the phase worktree
   merge model preserves per-card commits or squashes them. The
   post-review fix-loop disposition below chooses the stricter merge
   model and does not formalize an R1 exemption.

3. **All 5 R3 (memory-chain) cards held EventLog-first ordering and
   audit-before-broadcast invariants under fresh inspection.** This is
   the most security-relevant chain in Phase 2 and it came through
   clean: no failure mode #11 (EventLog reorder under retry) or #12
   (audit-after-broadcast) instances observed.

4. **Stateful Mutation Checklist live-wiring item correctly NOT
   triggered for any Phase 2 card.** Every card closes as
   `implementation-ready`, with daemon / MCP / CLI wiring deferred to
   Phase 4. Zero R5 over-claims (no `live-event-ready`,
   `mcp-consumable`, or `cli-consumable` strings) across all 32 cards.

5. **Zero residual `@do-what/` namespace and zero SSE strings**
   (`SseBroadcaster`, `EventSource`, `text/event-stream`) across all
   reviewed packages (`packages/storage/src/`, `packages/core/src/`,
   `packages/soul/src/`). The Alaya namespace migration and SSE strip
   (invariant §11) are both complete.

6. **Three R3 fix commits (`f6d0a67`, `c900ef4`, `d3e60b2`) and one R4
   fix commit (`166f736`) all carry the full Fix Commit Body Template**
   (Finding / Cause / Fix / Verify / Follow-up). R1 commit hygiene is
   solid for the in-execution review-fix loops; the failures are only
   on the Gate-2 closeout edge.

## Post-Review Fix-Loop Disposition

This docs-only fix loop records the disposition of all four post-Gate-2 findings
without runtime, protocol, schema, or vendor changes. Finding-cluster commit
evidence: `2dde29d` for I1/I2, `ff3aedd` for I3, and `6181343` for N1.

- **I1/I2**: Disposition is historical R1 commit hygiene gap, no history
  rewrite. Added backlog issue `#BL-014` and tightened
  `docs/handbook/workflow/agent-workflow.md` so future phase/wave closeout must
  confirm standalone review-fix commits survived the merge path, or document a
  parent-approved exception before gate closeout. R1 and R4 remain strict.
- **I3**: Disposition is fixed by a single docs update that co-touches the
  EventPublisher card and report. The card now mirrors the report-only
  review-fix outcomes: batch propagation failure evidence, normalizer pending
  retry behavior, single-flight retry, and failed-retry recovery.
- **N1**: Disposition is fixed by adding one derived internal rename row/note to
  both synthesis and proposal cards and reports for private methods, local
  variables, comments, and tests.

## Verification

This review pass verified:

- 32 / 32 Phase 2 task cards reviewed by 6 read-only sub-agents.
- 4 findings landed (0 Blocking / 3 Important / 1 Nice-to-have).
- 3 of 4 findings spot-verified by the main thread against raw
  `git show --stat` output.
- No source code or test files modified during this pass
  (`rtk git status` should show only this report and an INDEX update).
- Zero stale `@do-what/` references, zero SSE strings, zero R5
  over-claims.

## Out-of-Scope (Per User Direction)

This pass deliberately did NOT:

- Open fix commits for the 3 Important findings (deferred to user
  decision, with `Suggested Disposition` recorded above).
- Open backlog issues (deferred per same).
- Touch any source code, test, or task-card file.
- Block Phase 3 work — Gate-2 remains passed, and no Blocking finding
  was surfaced.

## Pointers

- Per-cluster cards: see [INDEX](../../INDEX.md) Phase 2 §Card Closeout
  Status table for individual completion reports
  (`task-p2-*.md`).
- Gate-2 closeout: [`gate-2-closeout.md`](./gate-2-closeout.md).
- Plan that drove this pass:
  `~/.claude/plans/phase-2-review-dapper-hopcroft.md` (local, not in
  repo).
