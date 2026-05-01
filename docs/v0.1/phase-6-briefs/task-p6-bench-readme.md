# Implementation Brief: Task P6-bench-readme — README leaderboard template + fill-in flow

> - **Phase**: 6
> - **Wave**: 6
> - **Card ID**: P6-bench-readme
> - **Port mode**: requires-redesign
> - **Source**: `n/a` (Alaya-original)
> - **Target**: `README.md`, `docs/v0.1/phase-6-briefs/reports/task-p6-bench-readme.md`
> - **Size**: S
> - **Prerequisite**: P6-bench-harness, P6-bench-baselines, P6-bench-resume
> - **Blocks**: Gate-6 (v0.1.1 release)
> - **Closing readiness label**: mcp-consumable
> - **Owner**: unassigned

## 0. Charter Authority

`docs/v0.1/phase-6-briefs/README.md` row "P6-bench-readme",
"Disclosure Standard" section, and the charter line "Phase 6 is
complete when the harness runs end-to-end and the README template is
in place with placeholders the user fills in after their run";
`docs/handbook/port-protocol.md §3 requires-redesign`.

## 1. Background & Goal

**Background**: Phase 6 produces the harness and runners; the
leaderboard table itself is text in `README.md` that the user updates
after running their own benchmark. This card adds the table template
and the fill-in / reproducibility documentation.

**Goal**:
1. Add a "Benchmarks" section to `README.md` with the table template
   and disclosure line.
2. Document the fill-in flow so the user knows exactly which cells to
   replace and what disclosure metadata to record.
3. Document reproducibility: env vars, model selection, suite
   selection, expected wall-clock at typical free-tier rate limits.

This card is **complete** when the README contains the template + the
flow is documented. The card does **not** require the user to have
filled in real numbers (that is post-Gate-6 work owned by the user).

## 2. Allowed Scope

### 2.1 File Ownership

| Source | Target | Port requirement |
|---|---|---|
| `n/a` | `README.md` (new "Benchmarks" section appended near the end) | Alaya-original; the section is the only README write owned by this card. |
| `n/a` | `docs/v0.1/phase-6-briefs/reports/task-p6-bench-readme.md` | Completion report. |

This card MUST NOT modify any other README section. If reorganizing
the existing README is necessary, open a follow-up card.

### 2.2 Port Rules

- Port mode is `requires-redesign`.
- The disclosure line format from
  `docs/v0.1/phase-6-briefs/README.md §Disclosure Standard` is
  authoritative — copy that format verbatim into the README template.
- The README MUST cite that the leaderboard is a single-run; if the
  user later adds multi-run aggregation, that is a separate v0.2 card.

### 2.3 Required Behavior

The new README "Benchmarks" section MUST contain (in order):

1. A one-paragraph framing: "Single-run marketing benchmark; numbers
   are illustrative, not statistically rigorous; we publish the
   harness so anyone can re-run and challenge the numbers."
2. A leaderboard table template (markdown):
   ```markdown
   | Runner       | LongMemEval recall (N=100) | SWE-bench-lite pass@1 (N=30) | Tokens / correct (LongMemEval) |
   |--------------|----------------------------|------------------------------|---------------------------------|
   | alaya        | <TBD>                      | <TBD>                        | <TBD>                           |
   | mem0@<ver>   | <TBD>                      | <TBD>                        | <TBD>                           |
   | no-memory    | <TBD>                      | <TBD>                        | <TBD>                           |
   ```
3. A disclosure line in the exact charter format:
   ```
   > Single run, N=100 (LongMemEval) + N=30 (SWE-bench-lite),
   > OpenRouter model <TBD>, run on <TBD>. Reproduce with
   > `rtk pnpm bench:run --suite=all --runner=all`.
   ```
4. A "How to fill in this table" subsection with:
   - The 4 env vars to set: `OPENAI_BASE_URL`, `OPENAI_API_KEY`,
     `OPENAI_MODEL_ID`, plus optional `OPENROUTER_REFERER`.
   - The two run commands: `rtk pnpm bench:run --suite=all --runner=all`
     and the resume command.
   - Where to find the per-question jsonl results
     (`var/benchmark/<suite>-<runner>.jsonl`) and how to derive each
     table cell from those records.
5. A "Reproducibility" subsection with:
   - Pinned Mem0 SDK version (filled from P6-bench-baselines completion
     report).
   - Subset construction rule for each suite (filled from
     `apps/core-daemon/src/benchmark/fixtures/README.md`).
   - Approximate wall-clock at OpenRouter free-tier rate (10-30 req/min).

The card is allowed to leave `<TBD>` literal placeholders in cells the
user must fill (cells 4-5 above use `<TBD>` rather than fictional
numbers).

## 3. Deferred

- Actually filling in the numbers — that is user-driven, post-Gate-6.
- Cross-vendor LLM comparison rows — single LLM only for v0.1.1.
- Localized README (zh / xiaohongshu copy) — user-handled, not in this
  card.

## 4. Acceptance Criteria

| AC | Criteria | Evidence |
|---|---|---|
| AC1 | All required subsections in §2.3 exist in README under the new "Benchmarks" section | `grep -c "^## Benchmarks" README.md` returns 1; reviewer reads each subsection |
| AC2 | The disclosure line uses the exact charter format from the phase-6 README | Reviewer compares the README disclosure line against `phase-6-briefs/README.md §Disclosure Standard` byte-for-byte (allowing the `<TBD>` substitutions) |
| AC3 | The table template has 3 runner rows (alaya / mem0 / no-memory) and 3 metric columns | Reviewer reads the table |
| AC4 | The fill-in flow lists the exact env vars + the run + resume commands from P6-bench-resume | Reviewer cross-references against `task-p6-bench-resume.md §2.3` |
| AC5 | Reproducibility subsection cites the Mem0 SDK pinned version | Reviewer cross-references against `task-p6-bench-baselines.md` completion report |
| AC6 | No other README section is modified | `git diff README.md` shows only the new "Benchmarks" section |
| AC7 | Build still succeeds | `rtk pnpm build` is green |
| AC8 | Closing readiness label is `mcp-consumable` only after the README template is in place AND the harness runs end-to-end on the smoke fixture set | `docs/handbook/runtime-status.md` and `docs/v0.1/INDEX.md` updated |

## 5. Verification

1. `rtk pnpm install`
2. `rtk pnpm build`
3. `grep -c "^## Benchmarks" README.md` returns `1`
4. Reviewer reads the new section against §2.3 and §4

## 6. Shared File Hazards & Dependencies

`README.md` — root-level file. This card owns one new top-level section
and MUST NOT touch any existing section. If a future card needs to
edit the new "Benchmarks" section, open a follow-up card; do not edit
in place from another card without an explicit hand-off.

**Prerequisite**: P6-bench-harness, P6-bench-baselines, P6-bench-resume.
**Blocks**: Gate-6 (v0.1.1 release).
