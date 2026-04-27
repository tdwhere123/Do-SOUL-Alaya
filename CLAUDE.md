# CLAUDE.md

## File Rules

- Keep this file English-only.
- Read and write repository files as UTF-8 without BOM.
- Localized product content, fixtures, and tests may use non-English text when behavior requires it.
- Do not read files larger than 30 KB in full. Use `rg`, `sed`, `head`, or `tail` for targeted section reads.

## Project Context

This is a standalone local prototype for a SOUL-centered memory product. The
final name is still open. Do not rename the package, CLI, MCP tools, or docs
until the user explicitly decides the product name.

Important invariants:

- Runtime is the semantic root. HTTP, CLI, MCP, inspector, and benchmark call runtime APIs.
- SQLite storage persists truth; UI and benchmark projections are not truth.
- Durable memories require source and evidence.
- Governance, import/export, backup, and session trust changes must be auditable.
- No runtime dependency on `@do-what/*` or `do-what-new/packages/*`.

## Before You Code

Read in this order:

1. `RTK.md`
2. `README.md`
3. `docs/README.md`
4. `src/README.md`
5. The specific file or doc being changed
6. `docs/reviews/final-review.md` for behavior already covered by prior review

## Workflow

- Reply in Chinese unless the user asks otherwise.
- Think before coding and state assumptions when scope is ambiguous.
- Keep edits inside this package unless the user explicitly widens scope.
- Use fresh review after meaningful implementation or trust-boundary changes.
- For behavior changes, run build and relevant tests before claiming completion.

## Commands

```bash
rtk pnpm install
rtk pnpm exec tsc -p tsconfig.json
rtk pnpm exec vitest run --config vitest.config.mjs
rtk pnpm build
rtk pnpm test
rtk node dist/cli/index.js doctor --data-dir /tmp/soul-memory-product-smoke
```

## Generated Paths

- `dist/`: TypeScript build output.
- `var/`: local runtime data.
- `node_modules/`: local package dependencies.

Do not treat generated paths as source truth.
