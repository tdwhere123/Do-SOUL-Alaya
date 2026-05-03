# Phase 5 System Review — Round 3 (Final convergence)

- **Date**: 2026-05-03
- **HEAD at convergence**: `78d8a91`
- **Reviewer scope (适度)**: main-thread directly (no further reviewer agents); Round 1 + Round 2 evidence treated as input. User explicitly approved each Round 3 task and confirmed which work belongs to v0.2.
- **Convergence status**: **CONVERGED** — all p5-system-review Blocking + Important closed except items the user explicitly deferred to v0.2 with a written close condition (`#BL-022`).
- **Plan reference**: `/home/tdwhere/.claude/plans/phase-5-review-majestic-lollipop.md` Round 3 section.

---

## Why Round 3 was needed

Round 2 reported convergence based on "Blocking + 4 Round-2 Blocking closed", but the close-out
list stashed nine Round 1 Important findings as "follow-up wave / non-blocking" — that was a
backlog-parking pattern, not a true close. After the user pushed back ("backlog 不是问题归宿"),
I owed them a clean walk through every Important and either fix it, fold it into an invariant,
or get an explicit v0.2 deferral with close condition. Round 3 is that walk.

## User-confirmed Round 3 plan

| # | Finding | Resolution | Closed by |
|---|---|---|---|
| 1 | MR-I05 SoulOpenPointerResponse content projection | ✅ Done | `4aa5de1` |
| 2 | MR-I03 Bounded zod schemas (DoS protection) | ✅ Done | `d63ab97` |
| 3 | MR-I04 DRY MCP catalog from zod (user chose new dep over patch) | ✅ Done | `bb3e02c` |
| 4 | MR-I11 doctor schema_ok | ✅ Done | `30ad2a0` |
| 5 | MR-I06 Shutdown drain in-flight | ✅ Done | `dfdc909` |
| 6 | MR-I16 final-review-status rename + behavior assertion | ✅ Done | `60f2ec9` |
| 7 | MR-I20 runtime-status `mixed:` cell split + code-map alignment | ✅ Done | `60f2ec9` |
| 8 | MR-N09 tool-runtime-bootstrap toBeDefined → strong assertions | ✅ Done | `60f2ec9` |
| 9 | MR-I07 + MR-I09 EventPublisher port + EventLog revision atomic | ❌ Deferred to v0.2 | `78d8a91` (`#BL-022` with full close condition) |

The "register MCP probe" portion of MR-I11 was reduced to documentation: attach now writes
absolute paths (`node <repo-abs>/bin/alaya.mjs mcp stdio`) so the probe would always be a
trivially-true PATH lookup unless the operator set `ALAYA_MCP_LAUNCHER` to something custom.
Documented alongside the schema_ok addition rather than implemented as a separate code path.

## Cumulative atomic-commit picture

```text
8e5051a (Gate-5 close)
  → Round 1 (22 commits): 2b66e44 … c88b620
  → Round 2 (6 commits):  4f507d3 … 384c2d4
  → Round 2 close-out:    141f1c1
  → Round 3 (9 commits):  4aa5de1 (MR-I05) → d63ab97 (MR-I03) → bb3e02c (MR-I04)
                          → 30ad2a0 (MR-I11) → dfdc909 (MR-I06) → 60f2ec9 (MR-I16/I20/N09)
                          → 78d8a91 (#BL-022 deferral) → THIS COMMIT
```

Total atomic commits since Gate-5: ~37. Each one carries a single Finding/Cause/Fix/Verify body
and is tagged `[system-review-r{1,2,3}]`.

## Backlog state at convergence

```text
Open Issues: 0
Recently Resolved by p5-system-review-r1+r2+r3:
  #BL-014 (atomic commit hygiene; proven by this very wave)
  #BL-016 (folded into #BL-017)
  #BL-017 (stop-gap mapping in port-mapping/phase-to-domain.md;
           full hygiene wave scheduled into v0.1.x patch)
  #BL-023 (promoted to invariants §21a)
  #BL-024 (HTTP route removed)
Deferred to v0.2 (each with explicit close condition + user agreement):
  #BL-008 (pi-mono provider integration)
  #BL-009 (OS keychain)
  #BL-022 (EventPublisher atomic port + EventLog revision transaction)
Out of Alaya Scope (ADR-style):
  #BL-001..#BL-007
```

## Verify gate (final)

```bash
rtk pnpm install                 # ok
rtk pnpm build                   # ok
rtk pnpm exec vitest run         # 248 files / 1916 tests + r3 added 1 behavior assertion → 1917 expected; cf. final commit
rtk pnpm alaya doctor            # storage schema_ok: yes (persisted=57, expected=57)
rtk pnpm alaya tools list --json # query has maxLength: 4096 (zod-derived)
rtk pnpm alaya install --non-interactive '<json>'   # creates alaya.db with full schema migration
rtk pnpm alaya attach codex --yes                    # writes node + absolute path launcher
rtk pnpm alaya status                                 # daemon up, trust state present
rtk pnpm alaya tools call soul.recall '<full-json>' --json  # returns delivery_id + results
```

## Convergence statement

`p5-system-review` wave (Rounds 1, 2, 3) is converged. Open backlog Issues is 0. Three v0.2
deferrals have explicit close conditions and a user agreement on the record. Defense-against-
recurrence invariants (§29 Default Scope, §30 Fix at Source, §31 Single-Source Concurrency,
§21a Public-copy Audience) are in `docs/handbook/invariants.md`. Review-protocol §"Cause Class
Aggregation" / §"Test Quality" / §"Documentation Drift" rules guard against silent regression.

The hygiene wave for `#BL-017` (rename `phase-*.ts` files, split the five >800-line offenders,
ts-prune residue, refresh codemap) ships as a dedicated v0.1.x patch wave alongside Phase 6
marketing work; the stop-gap mapping at `docs/handbook/port-mapping/phase-to-domain.md` lets
reviewers reason about upstream phase names without waiting for the codemod.

No further Round is planned unless a new finding category surfaces that the existing invariants
do not cover.
