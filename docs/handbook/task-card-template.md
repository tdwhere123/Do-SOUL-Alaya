# Task Card Template (post-v0.1.0)

A lightweight template for non-trivial work that benefits from a
written brief — typically multi-file changes, multi-day efforts,
sub-agent dispatches, or anything that needs review-loop discipline.

For one-shot fixes, just describe scope in the PR body and skip this.

## File Layout

- File path: pick a folder appropriate to the work area:
  - Backlog cards: cite `#BL-NNN` from `docs/handbook/backlog.md` and
    optionally write a brief next to the card if it grows past a few
    paragraphs.
  - Wave / multi-card initiatives: create a folder under
    `docs/<initiative>/` and write each card as
    `task-<short-id>.md` next to a `README.md` that lists the cards.
- File MUST be UTF-8 without BOM, English-only, < 30 KB. Localized
  product fixtures inside the card are fine.

## Section Order

```
# Implementation Brief: <CARD-ID> — <Title>

> Frontmatter (block-quoted bullet list, fields below)

## 1. Background & Goal
## 2. Allowed Scope
## 3. Deferred
## 4. Acceptance Criteria
## 5. Verification
## 6. Shared File Hazards & Dependencies
```

## Frontmatter Fields

```markdown
> - **Card ID**: <short kebab-case id>
> - **Source/Background**: <link or one-liner>
> - **Target**: `<destination paths inside the repo>`
> - **Size**: <S | M | L | XL>  (S ≤ 5 files, M ≤ 20, L ≤ 100, XL > 100)
> - **Prerequisite**: <comma-separated card IDs, or `none`>
> - **Blocks**: <comma-separated card IDs, or `none`>
> - **Owner**: <`unassigned` until claimed>
```

## §1 Background & Goal

Two short paragraphs:

1. **Background**: why this work matters; what subsystem it touches;
   what depends on it.
2. **Goal**: a single sentence stating the one outcome this card
   delivers. One card = one goal.

## §2 Allowed Scope

The exhaustive enumeration of files the card touches. Use
sub-sections per file or per file group. For each file include:

- **Target**: repo-relative path
- **Change**: brief description of what changes and why
- **Adapter Points** (only when porting/refactoring an existing
  service): a small table noting before/after at line ranges

## §3 Deferred

Anything intentionally NOT in this card. Each deferral MUST cite a
backlog issue per the `feedback_no_backlog` rule:

```markdown
- Multi-reviewer quorum — deferred to backlog #BL-NNN with close
  condition "<one-liner>".
```

If nothing is deferred, write `Nothing deferred.` exactly.

## §4 Acceptance Criteria

A markdown table. Each row has a stable AC ID (AC1, AC2, ...) and an
Evidence column that names a verifiable artifact.

```markdown
| AC | Criteria | Evidence |
|---|---|---|
| AC1 | … | … |
| AC2 | TypeScript compiles | `rtk pnpm exec tsc --noEmit -p packages/<pkg>` is clean |
| AC3 | Unit tests pass | `rtk pnpm exec vitest run --project @do-soul/alaya-<pkg>` is green |
```

## §5 Verification

Concrete shell commands a reviewer can run to verify §4. Order them
build → test → lint → integration.

## §6 Shared File Hazards & Dependencies

A short list of shared files this card writes that may collide with
other cards in the same wave (consult `docs/v0.1/INDEX.md §Shared
File Conflict Table` for the historical list of high-risk files; new
shared files should be added there as they are discovered). If none,
write `No shared-file hazards.` exactly.

Plus a short dependency restatement (mirrors frontmatter):

```markdown
**Prerequisite**: <card IDs>.
**Blocks**: <card IDs>.
```

## Completion Reports

When a card warrants a completion report (for review-loop
traceability or because the work spanned multiple sessions), write
it next to the card as `reports/<card-id>.md` and include:

- Reviewed by, closed at commit, scope compliance, build/test
  evidence, intentional deviations, deferred issues (with backlog
  IDs), follow-up readiness impact.

## Path Style

All paths are repository-relative
(e.g. `packages/core/src/recall-service.ts`), never absolute.

## Backlog Issue Numbering

Per `docs/handbook/backlog.md`, issues are numbered `#BL-NNN` in
plain decimal sequence. The next available number is at the top of
`backlog.md`. When deferring something, append a new issue to
`backlog.md` first, then cite it in §3 with an explicit close
condition.

## Historical Reference

The original v0.1 port-era template (with `trivial-copy` /
`adapt-and-port` / `requires-redesign` framing and vendor source
paths) is preserved at
`docs/archive/task-card-template-historical.md`. Reference it only
when reading port-era cards under `docs/v0.1/phase-*-briefs/`.
