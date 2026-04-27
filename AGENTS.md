# AGENTS.md

## File Rules

- Keep this file English-only.
- Read and write repository files as UTF-8 without BOM.
- Localized product content, fixtures, and tests may use non-English text when the behavior under test requires it.
- Do not read files larger than 30 KB in full. Use `rg`, `sed`, `head`, or `tail` for targeted section reads.
- Treat `dist/`, `var/`, `node_modules/`, and coverage output as generated state.

## Repository Context

This package is a standalone local prototype for a SOUL-centered memory product.
The final product name is intentionally not settled yet. Do not rename package
metadata, CLI commands, MCP namespaces, or docs titles until the naming decision
is made explicitly.

Core product invariants:

- Memory objects are ontology; projections, context packs, inspector state, and benchmark views are not durable truth.
- Durable memories require explicit source and evidence.
- Governance, import/export, backup, and session trust changes must be explicit and auditable.
- Adapters call `src/runtime`; they do not bypass it to mutate storage directly.
- This package must not import `@do-what/*` or rely on runtime code from `do-what-new/packages/*`.

## Before You Code

Read in this order:

1. `RTK.md` for command wrapping rules.
2. `README.md` for package layout and smoke commands.
3. `docs/README.md` for product/interface/implementation document ownership.
4. `src/README.md` before changing runtime, adapters, storage, or tests.
5. The specific doc or source module you are touching.
6. `docs/reviews/final-review.md` when changing behavior previously covered by review findings.

## Role Framing

Agents implement and review in this package.

- Default to implementation, debugging, and verification when the user gives a build or fix task.
- When the user asks for review, switch to reviewer mode and report findings first, ordered by severity, with precise file references.
- Severity meanings:
  - **Blocking**: architecture violation, unmet acceptance criteria, broken build/test, data or state risk, trust/audit risk, or cross-document contradiction that changes execution.
  - **Important**: likely bug, regression, missing meaningful coverage, misleading status, or local usability issue that affects operators.
  - **Nice-to-have**: optional cleanup or follow-up.
- Worker `DONE` is not acceptance. Use fresh review for meaningful implementation changes.

## Code Quality

- State assumptions explicitly when scope is ambiguous.
- Keep changes surgical and inside this package unless the user explicitly widens scope.
- Preserve the runtime boundary: contracts -> storage -> runtime -> HTTP/CLI/MCP/inspector/bench.
- Add tests when changing runtime semantics, storage schema/repository behavior, HTTP/CLI/MCP contracts, session trust, import/export, backup, or governance.
- Do not add dependencies without a clear local package reason. This prototype currently relies on Node 24 `node:sqlite`, TypeScript, and Vitest.
- Build + test is a hard gate for behavior changes. Do not claim done until the relevant commands pass or you report exactly why they could not run.

## Commands

Run from the package root:

```bash
rtk pnpm install
rtk pnpm exec tsc -p tsconfig.json
rtk pnpm exec vitest run --config vitest.config.mjs
rtk node dist/cli/index.js doctor --data-dir /tmp/soul-memory-product-smoke
rtk node dist/cli/index.js ingest --data-dir /tmp/soul-memory-product-smoke --summary "smoke memory test"
rtk node dist/cli/index.js recall --data-dir /tmp/soul-memory-product-smoke --query "smoke memory"
rtk node dist/cli/index.js gateway --data-dir /tmp/soul-memory-product-smoke --query "smoke memory" -- node -e "process.exit(0)"
```

Package scripts:

```bash
rtk pnpm build
rtk pnpm test
```

## Pointers

- `README.md` - package entry point, layout, smoke flow.
- `docs/README.md` - documentation map.
- `src/README.md` - source ownership map.
- `docs/product/public-api.md` - public API contract intent.
- `docs/interfaces/cli-surface.md` - CLI expectations.
- `docs/interfaces/mcp-surface.md` - MCP surface expectations.
- `docs/implementation/sql-and-recall-upgrade.md` - storage and recall design notes.
- `docs/reviews/final-review.md` - latest review closure and known verification evidence.
