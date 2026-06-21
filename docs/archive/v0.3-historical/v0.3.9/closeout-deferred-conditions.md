# v0.3.9 Closeout — Deferred Conditions

This file names the conditions under which deferred v0.3.9 decisions
flip from "held on schema" to "executed". The per-decision recap and
the consolidated carry-forward live in
`reports/v0.3.9-closeout.md`; this file is the single source of truth
for the close-condition language that follow-on releases must read
before changing the deferred slot.

## Cat-H.3 — `UpgradeAssessmentAxis` (5 fields)

**Affected schema.** `GapRecord` and `HandoffRecord` each carry
five `UpgradeAssessmentAxis` fields:

- `recurrence_runs`
- `recurrence_surfaces`
- `governance_impact`
- `unresolved_age_ms`
- `upgrade_candidate`

**v0.3.9 state.** All five are persisted but always written as `null`
at creation. No producer exists. No consumer reads them. They occupy
the schema slot for future meta-cognitive gap aggregation.

**Why deferred and not retired.** Retiring without a replacement
loses the documented slot. The L2 lens did not ship the
upgrade-candidate computer (per `path.governance_promoted`
carry-forward); the in-codebase signal we would need to populate
`upgrade_candidate` does not exist yet.

**Target release for closure.** **v0.3.10** owns the cutover decision.
If v0.3.10 does not land an upgrade-assessment producer, the closure
slides to the earliest v0.4.x release that does. Either way, the
release that flips the decision MUST answer both questions below
before changing the schema:

1. **Producer question.** What observable, in-codebase signal
   populates `upgrade_candidate`? Candidates surfaced so far:
   - Garden re-extraction recurrence (the same memory triggered by
     multiple Garden compile passes against fresh turn text).
   - Inspector operator review-count crossing a threshold.
   - HealthIssueGroup `(target_memory_id, cause_kind)` growth rate
     crossing a threshold.
2. **Consumer question.** Which downstream module reads the field and
   acts on it? Candidates surfaced so far:
   - HealthIssueGroup severity boost (raise display priority in
     `/health-inbox`).
   - Promotion-ladder gating (a non-zero `upgrade_candidate` becomes
     a soft precondition for `stable → pinned`).
   - Recall-time priority boost (mark candidates with
     `upgrade_candidate > 0` for early surfacing).

If either answer at decision-time is "nobody", the slot is removed
via a drop-columns migration (sequence number TBD by the v0.3.10
plan) and the rationale lands in `docs/handbook/maintenance.md`. The
removal must follow the deprecation-then-remove cadence in
invariant §25: deprecate the schema field in the release before
removal, then remove in the subsequent minor release.

**Until the closure release.** No producer should be added that writes
non-null values; no consumer should be added that branches on
non-null values. Doing either prematurely loses the option to choose
between "wire" and "remove" cleanly.
