# Port Protocol

This document defines the v0.1-specific Port-First discipline. It is
the single most important rule for Alaya v0.1 work and overrides any
implementation instinct toward "let me write a better version".

## The Rule

> **Port first; do not clean-room rewrite.**

The full memory plugin system already exists at
`vendor/do-what-new-snapshot/`. Each port task card MUST cite which
source files it ports and which port mode it uses.

This rule exists because the previous v0.1 attempt (codex R1-R9)
rebuilt every subsystem as a contract-only validation layer instead of
porting the working code, and that work was discarded.

## Three Port Modes

### 1. trivial-copy (default)

Direct file copy with only mechanical changes:

- Update `import` paths (`@do-what/<pkg>` → `@do-soul/alaya-<pkg>` or
  relative paths inside the same package).
- Update `package.json` `name` field.
- Rename a constant if the source uses a `do-what`-specific name that
  no longer applies (rare).

**Forbidden under trivial-copy:**

- Rewriting the function body.
- "Improving" the type signatures.
- Adding null-checks the source did not have.
- Splitting a function into smaller helpers because that "feels
  cleaner".
- Skipping the source `__tests__/` and writing your own.

**Verification for trivial-copy:**

- The ported file diffs cleanly against the source modulo the
  enumerated mechanical changes.
- The ported `__tests__/` pass after the same mechanical adaptations.

This is the default port mode. Roughly 80%+ of files should land
through trivial-copy.

### 2. adapt-and-port (limited)

Allowed only when the target interface differs from the source in a
way that makes a literal copy non-functional. Typical legitimate
reasons:

- The source takes a `SqliteConnection` directly while Alaya wires
  through a different DI shape.
- The source consumes a sibling package whose name has changed.
- The source uses a deprecated upstream API and the deprecation note
  is in the source comments.

**Required for adapt-and-port:**

- The task card §2 Allowed Scope MUST list every adapter point with
  before/after.
- The logic must remain semantically equivalent. Tests from the source
  `__tests__/` MUST pass after adaptation.
- The task card MUST justify why trivial-copy was insufficient.

**Forbidden under adapt-and-port:**

- Behavioral changes ("while I was here I made it stricter").
- Adding new code paths that did not exist in the source.
- Removing code paths that exist in the source ("I do not think this
  branch is reachable").

### 3. requires-redesign (rare)

Default-prohibited. Allowed only when:

- The source feature does not exist (Alaya needs something new that
  upstream never built).
- The source design conflicts with an Alaya invariant that has no
  upstream equivalent (e.g. `delivered ≠ used` trust model has no
  exact upstream counterpart and may need re-shaping).

**Required for requires-redesign:**

- The task card §0 Charter Authority MUST cite the specific Alaya
  invariant or design document that drives the divergence.
- Explicit user approval before the task card is dispatched.
- The completion report MUST log the divergence and link the upstream
  file the new design replaces.

If you find yourself reaching for `requires-redesign`, stop and ask
whether the divergence really needs to be in v0.1 or whether it can be
deferred to v0.2 with a backlog issue.

## Anti-Patterns

Reviewers reject the following on sight:

- A task card that copies a file but rewrites the function body
  ("here is my version of `assemble-context-pack.ts`").
- A task card that creates a parallel "alaya version" of a service
  alongside the ported one.
- Splitting source logic into "your-own-style smaller helpers" when
  copy-paste would have worked.
- Skipping the source's `__tests__/` and writing a new test set.
- Using `adapt-and-port` to slip in scope expansion ("while adapting,
  I also added X").
- Citing `requires-redesign` without an Alaya invariant or design
  charter to back it.

## Source Path Discipline

All references to source files go through `vendor/do-what-new-snapshot/`.

**Correct:**

```
Source: vendor/do-what-new-snapshot/packages/core/src/recall-service.ts
Target: packages/core/src/recall-service.ts
Port mode: trivial-copy
```

**Wrong:**

```
Source: /home/tdwhere/vibe/do-what-new/packages/core/src/recall-service.ts
```

The vendor snapshot is frozen at a known commit (see
`vendor/do-what-new-snapshot/SNAPSHOT_REF.md`). Referencing the
absolute upstream path breaks reproducibility because that path may
move under unrelated upstream iteration.

## Verification Checklist (Reviewer)

For every port task card, the reviewer confirms:

- [ ] Source path is under `vendor/do-what-new-snapshot/`.
- [ ] Port mode is one of the three legal values.
- [ ] If `trivial-copy`: target diffs cleanly against source modulo
      mechanical changes.
- [ ] If `adapt-and-port`: every adapter point is enumerated in §2.
- [ ] If `requires-redesign`: §0 cites the driving Alaya invariant or
      charter.
- [ ] The source's `__tests__/` were ported (or adapted), not
      replaced with a new test set.
- [ ] The PR did not silently expand scope beyond the listed source
      files.
