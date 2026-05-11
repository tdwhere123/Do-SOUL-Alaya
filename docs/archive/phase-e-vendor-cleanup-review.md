# Phase E (vendor cleanup) — Merged Review

**Scope**: commits `192a6cf` (chore) + `9641ff0` (fix) vs base `e778a0b`
(= origin/main = v0.1.0 release merge).

**Lenses dispatched**: 1× `codex:codex-rescue` (round-1 + round-2).

Per `feedback_review_loop_codex_lens.md`: post-v0.1.0 docs cleanup with
narrow blast radius → single-Codex lens is the planned downgrade from
the 6-lens default. Codex independent grep + scope analysis is the
right complement to my own implementation grep.

## Round-1 verdict and disposition

**0 Blocking / 5 Important / 0 Nice-to-have.**

| ID | Finding | Disposition | Fix commit |
|---|---|---|---|
| I1 | `.gitignore:29` still said vendor was "KEPT in git" with stale comment | Fixed | `9641ff0` |
| I2 | `AGENTS.md:27` used present-tense "Alaya is a port" | Fixed (rewrote to past-tense matching CLAUDE.md / handbook README) | `9641ff0` |
| I3a | `docs/handbook/backlog.md:516` cited bare `port-protocol.md` after archive move | Fixed (cite updated to `docs/archive/port-protocol-historical.md`) | `9641ff0` |
| I3b | `apps/core-daemon/src/__tests__/docs-backlog-references.test.ts:41` fixture string contains `port-protocol.md:104` | Not actionable. The string is inside an `allowedBl014References` test fixture mirroring exact historical text from `docs/archive/v0.1-port-record/phase-4-briefs/reports/round-3-review.md:29`, which is one of the historical port-era reports protected by the `docs/archive/v0.1-port-record/INDEX.md` historical banner (intentional non-rewrite scope). Touching the fixture without touching the historical report breaks the test; touching the historical report violates the scope discipline. | n/a |
| I4 | `README.md` + `README.zh-CN.md` "Closed in v0.1" table listed `#BL-008` (pi-mono) and `#BL-009` (keychain) as closed, but both are `Status: Deferred to v0.2` in `backlog.md` | Fixed (B1/B2 rows removed; explicit paragraph below the table states both were re-deferred to v0.2 during the closeout window with backlog cite) | `9641ff0` |
| I5 | README test badges said `tests-1996` after Phase E deleted migration-parity.test.ts (-2 tests, suite is now 1994) | Fixed (both badges flipped 1996 → 1994) | `9641ff0` |

## Round-2 verdict and disposition

**0 Blocking / 2 Important / 0 Nice-to-have** per Codex.

After main-thread analysis, **both round-2 findings are not actionable**
and the loop is converged:

| ID | Finding | Disposition |
|---|---|---|
| I1 (re-raised) | `.gitignore:28` still contains the literal string "KEPT in git" | **Misread by Codex.** Line 28 reads `# Note: .codex and .claude are KEPT in git per user instruction` — this is about the `.codex`/`.claude` config directories, not vendor. The vendor-specific note is on lines 29-31 and was correctly rewritten in `9641ff0` to reflect Phase E removal. The `.codex`/`.claude` keep-in-git instruction is an unrelated user policy that must remain. The literal-string absence check Codex applied is too coarse; semantic check passes. |
| I-R2-1 | 130 files still contain the string `do-what-new-snapshot`; classified as Important by Codex | **Over-strict re-classification.** All 130 matches fall into categories the round-1 prompt explicitly listed as acceptable: historical port-era task cards/reports under `docs/archive/v0.1-port-record/phase-*-briefs/` and `docs/archive/v0.1-port-record/post-port-hygiene-briefs/` (protected by the historical banner in `docs/archive/v0.1-port-record/INDEX.md`), `docs/archive/*` archive material, `.do-it/review/*` review reports, `.claude/settings.local.json` local config (out of E2 scope), and the four intentional past-tense Project Genealogy statements in `AGENTS.md:31`, `CLAUDE.md`, `docs/handbook/code-map.md:84`, `docs/archive/v0.1-port-record/INDEX.md:7,241` (these *name* the deleted directory in past tense — they do not point readers there). Round-1 classified these correctly; round-2 applied a stricter rule than the task spec. |

## Build + test re-verification

Verified twice independently (after `192a6cf`, after `9641ff0`):

- `rtk pnpm build`: exit 0
- `rtk pnpm test`: 257 files / 1994 tests pass

## Stop condition

**Met.** Zero Blocking, zero Important after fix-loop disposition.

Codex's reviewer-side independence remains the right call — round-1
caught 5 real Important findings (3 of which a Claude-only lens
focused on the diff would likely have missed: BL-008/BL-009 status
drift in particular requires comparing README rows against backlog
status, which is exactly the kind of cross-doc check Codex's
discipline catches). Round-2 over-strict re-classification is the
expected cost of using Codex for fix-loop verification — it errs on
the side of flagging anything not whitelisted.

## Ready to merge

`worktree-chore+vendor-cleanup` ready for `git merge --no-ff` into
`main`. No tag (Phase E is post-v0.1.0 hygiene; the v0.1.0 tag stays
at `f1e1fcf`).
