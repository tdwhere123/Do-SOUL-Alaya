# Documentation Maintenance

## Directory Roles

- `docs/handbook/`: maintained implementation handbook (Alaya's own
  rules and maps).
- `docs/archive/v0.1-port-record/`: historical v0.1 port-era task cards, phase READMEs,
  completion reports (preserved as record after v0.1.0).
- `docs/archive/`: retired-but-preserved discipline documents
  (port-protocol, port-era task-card template).
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
- Update the relevant `docs/archive/v0.1-port-record/` task card or report if the change
  belongs to a v0.1 delivery card.

When dependencies or readiness gates change:

- Update `Prerequisite`, `Blocks`, `Depends` in the affected task
  cards.
- Update `docs/archive/v0.1-port-record/INDEX.md` status table.
- Use one of: `not-started`, `schema-ready`, `implementation-ready`,
  `live-event-ready`, `mcp-callable`, `agent-used`, `host-worker-ready`,
  `cli-consumable`. Definitions in `runtime-status.md`. The legacy
  label `mcp-consumable` is a deprecated alias for `mcp-callable` and
  must not be used in new claims (retained one release for compat).

When contracts change:

- Update schema snippets.
- Update interface signatures.
- Update enum values.
- Update acceptance criteria and test expectations.
- Update downstream consumer assumptions.

## Large File Rule

Do not create new handbook files that require full reads over 30 KB
for routine agent work. Split volatile or lookup-heavy material into
smaller pages.

## Drift Sweep

After doc edits, run targeted sweeps for changed symbols, events,
dependencies, and readiness labels. Useful commands:

```bash
rtk rg -n "schema-ready|implementation-ready|live-event-ready|mcp-callable|mcp-consumable|agent-used|host-worker-ready|cli-consumable|ready|unblocked" docs AGENTS.md CLAUDE.md README.md
rtk rg -n "@do-soul/alaya-(protocol|core|soul|engine-gateway|storage)" docs AGENTS.md CLAUDE.md README.md
rtk rg -n "docs/[A-Za-z0-9._-]+\\.md" docs AGENTS.md CLAUDE.md README.md
rtk find docs -type f -name '*.md' -size +30k -print
```
