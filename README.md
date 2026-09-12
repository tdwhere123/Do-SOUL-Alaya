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

## GitHub installer vs this tree

[`scripts/install.sh`](scripts/install.sh) without `ALAYA_VERSION`
downloads GitHub `releases/latest`. That published tarball is **not**
this source tree and is **not** git HEAD. This checkout's app version is
`package.json` (currently `0.3.11`). Pin `ALAYA_VERSION=vX.Y.Z` to a
matching tag, or run the Quickstart commands from this checkout.

```bash
curl -fsSL https://raw.githubusercontent.com/tdwhere123/Do-SOUL-Alaya/main/scripts/install.sh \
  | ALAYA_VERSION=v0.3.11 bash
```

`alaya update` follows the same latest-release channel unless
`ALAYA_VERSION` is set.

## Optional local ONNX embeddings

Default `pnpm install` does not install `@huggingface/transformers` or
ONNX Runtime (~640MiB, including a web `-dev` runtime the Node embedding
path does not use). The extra is not a package.json peer: this workspace
auto-installs peers, which would pull the runtimes on every default
install. Local `local_onnx` recall is an explicit add:

```bash
pnpm add @huggingface/transformers --filter @do-soul/alaya-core
node scripts/fetch-local-embedding-model.mjs
```

CI and default developer installs stay on the slim path. Install the
extra only when you want on-device embeddings.

Inspector SPA is still compiled by `pnpm build` (`apps/inspector/web`).
A prebuilt `web/dist` in a future release tarball would skip that Vite
step; this tree does not ship a separate Inspector tarball.

License: [AGPL-3.0](LICENSE).
