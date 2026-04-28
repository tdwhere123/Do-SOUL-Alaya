# Review Protocol

Use reviewer mode before the next batch and after every fix loop. A
worker report is never acceptance by itself.

For parallel or repeated-failure work, also follow
[`subagent-dispatch.md`](./subagent-dispatch.md).

## Findings First

Report findings before summaries:

- **Blocking**: unmet acceptance criteria, broken build/test,
  architecture violation, data/state risk, port logic divergence from
  source, or execution-changing doc contradiction.
- **Important**: likely bug, regression, missing meaningful coverage,
  misleading status/docs, or unjustified port-mode escalation
  (e.g. `adapt-and-port` used where `trivial-copy` would have worked).
- **Nice-to-have**: low-risk cleanup (redundant code, dead branches,
  minor readability loss).

All three severities are fixed by default. Severity controls re-review
weight (see §Atomic Fix Commits) and close-gate order — not whether
the finding may be skipped. Skipping any finding requires a backlog
issue per R2.

## Evidence Expectations

- cite the file and line range for every finding,
- cite the acceptance-criteria row when the reviewed artifact has
  one,
- for port tasks, cite the source file under
  `vendor/do-what-new-snapshot/` against which the port is verified,
- for diff-only, handbook, workflow, or other reviews without an AC
  table, cite the governing document section, rule, or diff context
  that establishes the requirement,
- every finding must be expressed through the Review Finding Record
  shape below (§Review Finding Record) so the fixer can quote fields
  verbatim into the Fix Commit Body Template without manual backfill.

## Review Finding Record

Every reviewer finding — at any severity — must carry these fields.
Reviewers emit the record as a code-indented block under the
Findings-First list. The fixer quotes `ID` + `Headline` verbatim into
the Fix Commit Body Template's `Finding` field; `Cause Class` seeds
the fix commit's `Cause`; `Repro / Witness` seeds the regression test
that must appear in `Verify`.

Required fields:

    ID:             <B1 / I1 / N1 ... per-card counter. Use the B/I/N
                    prefix matching severity. Numbering resets per
                    review pass.>
    Severity:       <Blocking | Important | Nice-to-have>
    Headline:       <one sentence. Quoted verbatim by the fix commit's
                    `Finding` field, so write it as a self-contained
                    claim.>
    Location:       <file:line range + nearby symbol. For multi-site
                    findings, list every site.>
    Observed:       <what currently happens / what the diff shows is
                    wrong.>
    Expected:       <what should happen instead. Cite the invariant,
                    AC row, port-protocol rule, or source-file
                    location that establishes the expectation.>
    Repro / Witness:<minimum repro steps, an asserting test case that
                    currently fails, or a concrete scenario that would
                    expose the bug if exercised. "Inspection only" is
                    rejected except for pure documentation findings.>
    Cause Class:    <optional. Map to a numbered failure mode from
                    subagent-dispatch.md §Failure Modes when one fits;
                    leave blank otherwise.>

## Read Before Reviewing

- relevant task card or phase README,
- relevant diff or changed files,
- `docs/handbook/invariants.md`,
- `docs/handbook/port-protocol.md` (every Phase 1+ review is a port
  review),
- affected handbook page,
- the source file under `vendor/do-what-new-snapshot/` for port
  verification.

## Checklist

- acceptance criteria are fully met,
- live path and surface (MCP or CLI) behavior match the card,
- architecture and dependency rules still hold,
- imports, exports, routes, and event names are real,
- non-trivial behavior has runnable tests,
- docs, readiness labels, and dependency language agree,
- **port verification**: target file matches source in
  `vendor/do-what-new-snapshot/` per the card's declared port mode,
- **port-mode justification**: any `adapt-and-port` lists every
  adapter point in §2; any `requires-redesign` cites an Alaya
  invariant in §0,
- for stateful mutation tasks, the diff satisfies the
  [Stateful Mutation Checklist](./agent-workflow.md#stateful-mutation-checklist)
  with evidence for EventLog-first ordering, audit-before-broadcast,
  rollback / compensation, delete / cascade, idempotency / retry,
  shutdown / cleanup, and live wiring proof. A missing or unsatisfied
  item on that checklist is **Blocking**, and the live-wiring item
  inherits R5's integration / E2E evidence bar,
- for every fix commit (any severity), the body template in §Atomic
  Fix Commits is filled with no empty or vacuous fields,
- every finding this review emits carries a complete Review Finding
  Record (§Review Finding Record); `Repro / Witness` is runnable or
  observable, not "inspection only" (documentation findings excepted).

## Atomic Fix Commits (R1)

All fixes — Blocking, Important, and Nice-to-have — must not be
bundled into the originating feature commit, the wave-closing commit,
or the next feature commit. Reject closure when the commit history
shows a single feature commit that also resolves review findings.

A valid fix commit:

- stands alone (only the files needed for that finding),
- uses message shape `fix(<card-id>): <finding> [review <severity>]`,
- carries the Fix Commit Body Template below (§Fix Commit Body
  Template),
- goes through re-review before the card closes (weight depends on
  severity, see below).

### Re-Review Weight By Severity

Re-review is mandatory for every fix, but the pass cost differs by
severity so the discipline does not starve low-risk cleanups of a
close gate.

- **Blocking / Important** — fresh reviewer-agent pass. Acceptance
  requires zero `Blocking` / `Important` findings on the fix commit
  itself and a fully-filled body template.
- **Nice-to-have** — lightweight in-session re-review by the main
  thread walking the §Checklist against the fix commit. Record outcome
  as a short `re-review: [checklist items passed; remaining notes]`
  line appended to the original review. No fresh reviewer-agent spawn
  required. Escalate to a full re-review when the Nice-to-have fix
  touches non-trivial live-path code (daemon wiring, EventLog
  emission, MCP transport, snapshot alignment) or drags in files
  beyond the original finding's `Location`.

A worker's `DONE` or `FIXED` message is never closure — only the
matching re-review pass is.

### Fix Commit Body Template

Every fix commit (any severity) must include this body. Keep each
field to 1-3 lines. A missing, blank, or vacuous field ("n/a", "see
diff", "addressed review") blocks closure; the reviewer must reject
re-review and request a `git commit --amend` (or a follow-up
`fix(<card-id>):` if the commit is already on a shared branch) before
acceptance.

Required fields:

    Finding:   <quote the Review Finding Record's `ID` + `Headline`
                verbatim, e.g. `N3 "redundant nullish-coalescing in
                stanceResolve"`. If the finding originated outside the
                in-tree review (codex audit, handbook rule), cite its
                section instead. Never write "see review".>
    Cause:     <root cause in plain language: WHY the bug existed,
                not what the diff does. Carry forward the Review
                Finding Record's `Cause Class` when it was set
                (e.g. "Failure mode 12 — idempotent overwrite broke
                under deletion"). When the reviewer left `Cause
                Class` blank, the fixer names the cause in their own
                words.>
    Fix:       <what changed, in one or two sentences. If more than
                one approach was permitted by the card, say which one
                was picked and why.>
    Verify:    <commands run + new or updated tests that satisfy the
                reviewer record's `Repro / Witness`. Cite the test
                file path. If the only proof is "build passes", flag
                it — that is not regression coverage.>
    Follow-up: <`none`, a residual-risk note, or a backlog issue
                number. Deferrals still need a reopener per R2.>

Git note: use a HEREDOC or `git commit -F <file>` when writing the
body so indentation and field order survive. Avoid `-m "…"` multi-line
strings.
