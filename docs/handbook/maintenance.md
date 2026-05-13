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

## Host Version Notes

### #BL-037 — Codex `/alaya-inspect` Slash Recognition

Tested Codex CLI version: `codex-cli 0.130.0`.

Outcome: negative proof. The Alaya-managed Codex profile writer can
write `[slash_commands.alaya-inspect]` with
`node <repo>/bin/alaya.mjs inspect --open`, and the local Codex profile
file contains that entry, but the tested Codex CLI help, feature list,
installed package files, and local config docs do not expose or document
a third-party fixed slash-command registry. Do not claim
`/alaya-inspect` as Codex `cli-consumable` on this version.

Supported fallback: run `alaya inspect --open` directly, or use the
MCP / CLI fallback paths documented in `runtime-status.md`.

### #BL-009 — OS keychain platform coverage

Runtime-verified: Linux (incl. WSL2) via `secret-tool` —
`alaya install --keychain` migration + `alaya doctor` keychain readiness;
transcript under `docs/v0.3/v0.3.0/keychain-transcripts/`.

macOS (`security -i` stdin write / `find-generic-password -w` read) and
Windows (PowerShell `PasswordVault` read+write over stdin) adapters are
**code-reviewed, runtime verification deferred** — no maintainer has a
macOS or Windows host to capture a real write/read transcript. Code-review
state as of v0.3.0: secrets are passed via stdin (not argv) on every write
path; all keychain subprocess calls are bounded by
`KEYCHAIN_SUBPROCESS_TIMEOUT_MS` (10s) and map ENOENT / timeout to
`keychain_tooling_unavailable`. Known untested edge: macOS
`find-generic-password` returns non-zero for a *locked* keychain, which the
adapter currently reports as `keychain_entry_not_found` rather than a
distinct "locked" state — a real macOS transcript should confirm or refine
this. When a macOS / Windows host becomes available, capture the transcript
and update this note + `runtime-status.md`.

## Deprecated public symbols

No public MCP, EventLog, or runtime-control-plane symbols are
deprecated as of v0.2.0. `ConversationProvider` was deleted rather
than deprecated because it was a workspace-internal placeholder with
no production consumer and is outside invariant §25's public surface.

Future deprecation entries use this shape:

```text
<symbol> — deprecated in vX.Y, removal in vX.(Y+1) — see <migration link>
```

Each entry must name the covered surface, the replacement, the
earliest removal version, and the sibling-compat smoke test that
keeps the old shape parsing during the deprecation minor.

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
