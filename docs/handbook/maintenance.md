# Documentation Maintenance

## Directory Roles

- `docs/handbook/`: maintained implementation handbook (Alaya's own
  rules and maps).
- `docs/v0.1/`: active v0.1 task cards, phase READMEs, completion
  reports.
- `vendor/do-what-new-snapshot/`: frozen upstream source reference;
  read-only, not Alaya truth.
- Root `README.md`, `CLAUDE.md`, `AGENTS.md`: project entry points
  only — they delegate detail to the handbook.

## Update Rules

When implementation changes:

- Update `docs/handbook/code-map.md` if files, packages, routes,
  repos, migrations, or service ownership changed.
- Update `docs/handbook/runtime-status.md` if wiring, phase readiness,
  or known runtime gaps changed.
- Update `docs/handbook/backlog.md` only for unresolved issues. Keep it
  as a short cross-phase issue index with owner docs and close
  conditions; task-level acceptance detail belongs in the owning phase
  README or task card.
- Update the relevant `docs/v0.1/` task card or report if the change
  belongs to a v0.1 delivery card.

When dependencies or readiness gates change:

- Update `Prerequisite`, `Blocks`, `Depends` in the affected task
  cards.
- Update `docs/v0.1/INDEX.md` status table.
- Use one of: `not-started`, `schema-ready`, `implementation-ready`,
  `live-event-ready`, `mcp-consumable`, `cli-consumable`. Definitions
  in `runtime-status.md`.

When contracts change:

- Update schema snippets.
- Update interface signatures.
- Update enum values.
- Update acceptance criteria and test expectations.
- Update downstream phase assumptions.
- If the contract was already ported from upstream, note the
  divergence in `port-protocol.md` Anti-Patterns or escalate to
  `requires-redesign` with an Alaya invariant cite.

## Vendor Snapshot Maintenance

The vendor snapshot is frozen by design. Refresh only when:

- A port wave needs upstream changes that landed after the snapshot
  commit.
- An upstream bug fix is required for a port task to function.

To refresh:

1. Update `Source HEAD commit` in
   `vendor/do-what-new-snapshot/SNAPSHOT_REF.md`.
2. Re-run the rsync used in P0-5 (see plan file in
   `~/.claude/plans/`).
3. Note any deltas in a follow-up section of `SNAPSHOT_REF.md` so port
   task cards can re-verify their referenced files.
4. Commit as `chore(vendor): refresh do-what-new snapshot to <commit>`.

## Large File Rule

Do not create new handbook files that require full reads over 30 KB
for routine agent work. Split volatile or lookup-heavy material into
smaller pages.

## Drift Sweep

After doc edits, run targeted sweeps for changed symbols, events,
dependencies, and readiness labels. Useful commands:

```bash
rg -n -g '!vendor/**' "schema-ready|implementation-ready|live-event-ready|mcp-consumable|cli-consumable|ready|unblocked" docs AGENTS.md CLAUDE.md README.md
rg -n -g '!vendor/**' "@do-soul/alaya-(protocol|core|soul|engine-gateway|storage)" docs AGENTS.md CLAUDE.md README.md
rg -n -g '!vendor/**' "docs/[A-Za-z0-9._-]+\\.md" docs AGENTS.md CLAUDE.md README.md
find docs -type f -name '*.md' -size +30k -print
```
