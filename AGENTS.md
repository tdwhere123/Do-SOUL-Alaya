# AGENTS.md

## File Rules

- Keep this file English-only.
- Read and write repository files as UTF-8 without BOM.
- Localized product content, fixtures, and tests may use non-English text when
  the behavior under test requires it.
- Do not read files larger than 30 KB in full. Use `rg`, `sed`, `head`, or
  `tail` for targeted section reads.
- Treat `dist/`, `var/`, `node_modules/`, and coverage output as generated
  state.

## Repository Context

This repository is the reset-and-extraction workspace for Do-SOUL Alaya.

Do-SOUL Alaya is a local-first memory core for CLI agents. It targets the
package namespace `@do-soul/alaya`. The previous local prototype source has
been intentionally removed; do not restore deleted implementation files
unless a later task explicitly owns that migration.

Core product invariants:

- Memory ontology is durable truth; projections, context packs, inspector
  state, benchmark views, topology views, and graph views are not durable truth.
- Durable memories require explicit source and evidence.
- Governance, import/export, backup, configuration, and session trust changes
  must be explicit and auditable.
- Embedding affects what can be found. LLM or connected agents propose what may
  become memory. Alaya decides what is durable truth.
- Do not import `@do-what/*` or rely on runtime code from
  `/home/tdwhere/vibe/do-what-new/packages/*`.

## Before You Code

Read in this order:

1. `RTK.md` for command wrapping rules.
2. `README.md` for repository state and product direction.
3. `docs/README.md` for documentation ownership.
4. `docs/handbook/README.md` for current truth hierarchy.
5. `docs/handbook/invariants.md` before changing architecture, contracts,
   runtime semantics, storage, recall, governance, or agent integration.
6. The specific doc or source module you are touching.

If implementation files are absent, do not invent current build, test, CLI,
MCP, or smoke commands. Document planned commands only in v0.1 planning docs.

## Role Framing

Agents implement and review in this package.

- Default to implementation, debugging, and verification when the user gives a
  build or fix task.
- When the user asks for review, switch to reviewer mode and report findings
  first, ordered by severity, with precise file references.
- Worker `DONE` is not acceptance. Use fresh review for meaningful
  implementation or documentation-truth changes.

Severity meanings:

- **Blocking**: architecture violation, unmet acceptance criteria, broken
  build/test, data or state risk, trust/audit risk, or cross-document
  contradiction that changes execution.
- **Important**: likely bug, regression, missing meaningful coverage,
  misleading status, or local usability issue that affects operators.
- **Nice-to-have**: optional cleanup or follow-up.

## Current Worktree Discipline

- The deleted old prototype source is user-owned state. Do not revert it.
- Keep docs that describe current truth separate from archived historical
  prototype notes.
- Keep implementation plans under `docs/v0.1/` until code is reintroduced.
- Keep current architecture rules under `docs/handbook/`.
- Build and test gates apply only after an implementation/package surface
  exists again. Until then, verify docs with stale-term scans and link/path
  checks.

## Pointers

- `README.md` - repository entry point.
- `docs/README.md` - documentation map.
- `docs/handbook/architecture.md` - architecture baseline.
- `docs/handbook/invariants.md` - rules that always win.
- `docs/v0.1/README.md` - first product-loop plan.
- `docs/archive/2026-04-27-old-prototype/` - historical prototype
  material only.
