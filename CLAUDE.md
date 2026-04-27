# CLAUDE.md

## File Rules

- Keep this file English-only.
- Read and write repository files as UTF-8 without BOM.
- Localized product content, fixtures, and tests may use non-English text when
  behavior requires it.
- Do not read files larger than 30 KB in full. Use `rg`, `sed`, `head`, or
  `tail` for targeted section reads.

## Project Context

This repository is the reset-and-extraction workspace for Do-SOUL Alaya.

Do-SOUL Alaya is a local-first memory core for CLI agents and targets the
package namespace `@do-soul/alaya`. The prior local prototype implementation was
intentionally removed. Do not restore deleted package or source files unless a
future task explicitly owns that migration.

Important invariants:

- Memory ontology is durable truth; projections and UI views are not truth.
- Durable memories require source and evidence.
- Governance, configuration, import/export, backup, and session trust changes
  must be auditable.
- Embedding affects recall. LLMs and connected agents propose candidates. Alaya
  decides durable truth.
- No runtime dependency on `@do-what/*` or
  `/home/tdwhere/vibe/do-what-new/packages/*`.

## Before You Code

Read in this order:

1. `RTK.md`
2. `README.md`
3. `docs/README.md`
4. `docs/handbook/README.md`
5. `docs/handbook/invariants.md`
6. The specific file or doc being changed

If source/package files are absent, do not claim build, test, CLI, MCP, or smoke
commands are available. Keep planned implementation commands in `docs/v0.1/`.

## Workflow

- Reply in Chinese unless the user asks otherwise.
- Think before coding and state assumptions when scope is ambiguous.
- Keep edits inside this package unless the user explicitly widens scope.
- Use fresh review after meaningful implementation or trust-boundary changes.
- For docs-only work before implementation exists, verify with path checks and
  stale-current-claim scans.

## Generated Paths

- `dist/`: generated build output, if reintroduced.
- `var/`: local runtime data, if reintroduced.
- `node_modules/`: local package dependencies.

Do not treat generated paths as source truth.
