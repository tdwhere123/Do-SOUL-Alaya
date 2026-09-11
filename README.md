<div align="right">

**English** | [简体中文](README.zh-CN.md)

</div>

# Do-SOUL Alaya

A local-first memory plane for CLI coding agents (`@do-soul/alaya-*`).
MCP and CLI only. No chat UI. No telemetry.

Current in-repo truth lives in the handbook. This README does not claim
a completed recall landing or a published KPI.

## Handbook

| File | Owns |
|---|---|
| [`docs/handbook/README.md`](docs/handbook/README.md) | Handbook index |
| [`docs/handbook/invariants.md`](docs/handbook/invariants.md) | Rules that always win |
| [`docs/handbook/architecture.md`](docs/handbook/architecture.md) | Package shape, surfaces, write model, governance routes |
| [`docs/handbook/recall.md`](docs/handbook/recall.md) | Recall contract and live versus historical path |
| [`docs/handbook/runtime-snapshot.md`](docs/handbook/runtime-snapshot.md) | Readiness vocabulary and dated snapshots |
| [`docs/handbook/backlog.md`](docs/handbook/backlog.md) | Open issues that are not the recall field |
| [`docs/handbook/glossary.md`](docs/handbook/glossary.md) | Stable vocabulary |

Agent working copy: [`AGENTS.md`](AGENTS.md).

## Quickstart

Requires Node 24+ and pnpm 12.3.4 (see `packageManager`). From a source checkout:

```bash
pnpm install
pnpm build
pnpm exec alaya doctor
pnpm exec alaya install
pnpm exec alaya attach codex
pnpm exec alaya status
pnpm exec alaya tools list
pnpm exec alaya tools call --json
```

`alaya install` takes optional JSON answers as
`--non-interactive '<answers-json>'` (`db_path`, `embedding_enabled`,
and related fields). Bare `alaya install` prints usage.

License: [AGPL-3.0](LICENSE).
