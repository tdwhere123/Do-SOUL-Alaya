# SOUL Memory Product Prototype

Status: standalone local prototype. This folder is currently parked outside the main `do-what-new` repository while the SOUL memory product boundary is explored. The final product name is intentionally not settled yet.

## Boundary

- Keep implementation work inside this package.
- Do not import `@do-what/*` packages from this prototype.
- Do not treat this folder as a hidden implementation branch for the main repo.
- Public API names mirror the product specs, but server, runtime, storage, CLI, and MCP adapters are separate slices.
- Durable memory truth belongs to the runtime API and SQLite storage layer. Inspector and benchmark code must not infer or duplicate storage semantics.

## Layout

- `src/contracts/`: public SOUL Memory contracts and runtime validation.
- `src/storage/`: Node 24 `node:sqlite` baseline schema and repository.
- `src/runtime/`: semantic root used by every adapter.
- `src/server/`: localhost HTTP API and inspector asset server.
- `src/cli/`: setup, doctor, serve, ingest, recall, context, session, govern, import/export, backup, gateway, and inspector commands.
- `src/mcp/`: minimal MCP stdio JSON-RPC tool surface.
- `src/inspector/`: dependency-free graph-first static inspector assets.
- `src/bench/`: deterministic benchmark/demo harness.
- `docs/product/`: product boundary, memory planes, public API, positioning, completeness.
- `docs/interfaces/`: CLI, MCP, activation, and integration surfaces.
- `docs/implementation/`: extraction notes, storage/recall design, inspector model, benchmark plan.
- `docs/reviews/`: review and verification closure records.
- `dist/`: generated TypeScript output.
- `var/`: generated local runtime data.

## Commands

Run from this package root:

```bash
cd /home/tdwhere/vibe/soul-ledger
rtk pnpm exec tsc -p tsconfig.json
rtk pnpm exec vitest run --config vitest.config.mjs
```

Package scripts are also available from this directory:

```bash
rtk pnpm build
rtk pnpm test
```

## Smoke Flow

```bash
rtk node dist/cli/index.js doctor --data-dir /tmp/soul-memory-product-smoke
rtk node dist/cli/index.js ingest --data-dir /tmp/soul-memory-product-smoke --summary "smoke memory test"
rtk node dist/cli/index.js recall --data-dir /tmp/soul-memory-product-smoke --query "smoke memory"
rtk node dist/cli/index.js export --data-dir /tmp/soul-memory-product-smoke --file /tmp/soul-memory-product-smoke/export.json
rtk node dist/cli/index.js gateway --data-dir /tmp/soul-memory-product-smoke --query "smoke memory" -- node -e "process.exit(0)"
```

Start the HTTP API and inspector with:

```bash
rtk node dist/cli/index.js serve --data-dir /tmp/soul-memory-product-smoke --host 127.0.0.1 --port 8787
```

The inspector is then available at `http://127.0.0.1:8787/`.

## Agent And Operator Files

- `AGENTS.md`: Codex/operator rules for this standalone package.
- `CLAUDE.md`: Claude-oriented operator rules adapted from the main repo.
- `RTK.md`: command-prefix rule for local shell work.

## Docs Index

Start with [docs/README.md](docs/README.md), then read the relevant product, interface, or implementation folder. Current review closure lives at [docs/reviews/final-review.md](docs/reviews/final-review.md).

## Conceptual Invariants

The main repo SOUL invariants still apply conceptually: memory objects are ontology, projections and context packs are not durable truth, evidence and governance changes must be explicit and auditable, and UI state must not infer backend truth.
