<div align="right">

**English** | [简体中文](README.zh-CN.md)

</div>

# Do-SOUL Alaya

A local-first memory plane for CLI coding agents (`@do-soul/alaya-*`).
MCP and CLI only. No chat UI. No telemetry.

Workspace packages are `private: true` with `workspace:*` dependencies.
They are **not** published to npm — `npm install @do-soul/alaya-*` is
not a supported distribution path. Install from a source checkout or
from a GitHub Release tarball via [`scripts/install.sh`](scripts/install.sh).

Current in-repo truth lives in the handbook. This README does not claim
a completed recall landing or a published KPI.

## Handbook

| File | Owns |
|---|---|
| [`docs/handbook/README.md`](docs/handbook/README.md) | Handbook index |
| [`docs/handbook/invariants.md`](docs/handbook/invariants.md) | Rules that always win |
| [`docs/handbook/architecture.md`](docs/handbook/architecture.md) | Package shape, surfaces, write model, governance routes |
| [`docs/handbook/recall.md`](docs/handbook/recall.md) | Recall contract, live path, readiness vocabulary |
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
pnpm exec alaya tools call soul.recall '{"query":"project decisions"}' --json
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

`alaya update` prints the same latest-release channel unless
`ALAYA_VERSION` is set. Rerunning `scripts/install.sh` snapshots the
live `alaya.db` with `VACUUM INTO` before swapping binaries. The live
default file is `<config-dir>/alaya.db`, where config directory selection is
`ALAYA_CONFIG_DIR`, then `$XDG_CONFIG_HOME/alaya`, then `~/.config/alaya`.
TOML `storage.db_path` and then `DATA_DIR` override the database location.
Relative values resolve against the launch working directory, so installer
and daemon must use the same working directory to select the same file.
The installer captures its launch directory and resolved config directory, then
runs the staged CLI bootstrap from that same context as the live locator and
snapshot, not from the build directory. Relative paths are supported throughout
that upgrade. Use an absolute configured path when subsequent daemon launches
must be independent of their working directory.
Snapshots land separately in `<config-dir>/backups/`. See
[Rollback an upgrade](#rollback-an-upgrade) to restore the paired version and
pre-migration database without discarding the current installation. The installer
refuses to overwrite an existing `.bak`; archive that retained version explicitly
before another upgrade. `scripts/uninstall.sh` keeps `.bak` unless
`--remove-bak` is passed. Install and uninstall share one path-admission guard. Before
detaching or deleting anything, uninstall rejects an `ALAYA_HOME`,
`${ALAYA_HOME}.bak` (when `--remove-bak` is used), or `ALAYA_CONFIG_DIR`
(when `--purge` is used) that is `$HOME`, an ancestor of `$HOME`, a system
path, or a bare shared root, and rejects a system `ALAYA_BIN_DIR`. It
unlinks a contained `ALAYA_HOME` symlink instead of following it.

`better-sqlite3` 13 loads bundled native prebuilds for Linux glibc/musl,
macOS, and Windows on x64 or arm64. Its install path has no automatic
source-build fallback, so other operating-system or architecture combinations
are not supported by the default Alaya install.

## Developing the daemon

Run `pnpm install --frozen-lockfile && pnpm build` from the source checkout first.
`pnpm --filter @do-soul/alaya dev` watches the **built** `dist/index.js` daemon
entry; it does not compile TypeScript. Re-run `pnpm build` after source changes
(the watcher restarts when the built entry changes). Normal HTTP startup still
requires the configured request token; this command does not bypass startup
validation or provision embedding models.

## Rollback an upgrade

Stop **all** Alaya daemon/MCP/CLI processes first. Select the `.bak` installation
and the database snapshot printed by the **same upgrade**; a current migrated DB
is not a substitute for its pre-migration snapshot. Record the retained version:
`node -p 'require(process.argv[1]).version' "$ALAYA_HOME.bak/package.json"`.
Use absolute paths below, with `LIVE_DB` resolved using the same launch directory,
TOML and `DATA_DIR` as the daemon, and `DB_BACKUP` set to that snapshot.

For a database outside both installation directories (the default layout), run
these steps one at a time, stopping on any error:

```bash
# Never move .bak onto an existing directory: mv would nest it, not replace it.
test -d "$ALAYA_HOME.bak" && test -f "$DB_BACKUP"
ROLLBACK_STATE="$(mktemp -d "${ALAYA_HOME}.rollback-XXXXXX")"
# Retain the current database and its WAL tuple; do not leave old WAL beside
# the restored main file. Keep this archive until rollback is verified.
for suffix in '' -wal -shm -journal; do
  if [ -e "${LIVE_DB}${suffix}" ]; then
    mv "${LIVE_DB}${suffix}" "$ROLLBACK_STATE/current.db${suffix}"
  fi
done
cp -p "$DB_BACKUP" "$LIVE_DB"
mv "$ALAYA_HOME" "$ROLLBACK_STATE/install"
mv "$ALAYA_HOME.bak" "$ALAYA_HOME"
node -p 'require(process.argv[1]).version' "$ALAYA_HOME/package.json"
```

Confirm the final version matches the recorded retained version before restarting
with the restored DB. The launcher still points at the same `ALAYA_HOME`. Preserve
`ROLLBACK_STATE` and the original snapshot; no recursive deletion is needed. If a
step fails, keep the daemon stopped and recover from these retained paths rather
than repeating moves blindly. If the database or backup lives inside either
installation directory, first archive it outside both trees and explicitly map
its restored location before moving the directories; do not use the above layout
recipe unchanged. A temporal-cutover database additionally requires the verified
schema/EventLog/projection tuple described in the
[architecture handbook](docs/handbook/architecture.md#temporal-migration-cutover-and-rollback).

## Local ONNX embeddings

`pnpm install` installs the required, version-pinned
`@huggingface/transformers@4.3.1` runtime. Provision the model artifacts before
using `local_onnx`; runtime startup never downloads models implicitly:

```bash
node scripts/fetch-local-embedding-model.mjs
```

Release installs print the same provisioning command using the installed path.
`pnpm-workspace.yaml` overrides `onnxruntime-web` away; the Node embedding path
does not use it.

The runtime is required in CI and default developer installs; default installs
do not download model weights. CI provisions a pinned model for one Linux native
canary, verifies its artifact tree before loading, and runs inference offline;
the other platform shards do not require that cache.

Inspector SPA is compiled by `pnpm build` (`apps/inspector/web`) unless
`ALAYA_BUILD_INSPECTOR_WEB=0` and `apps/inspector/web/dist/index.html`
already exists. This tree does not ship a separate Inspector tarball.

License: [AGPL-3.0](LICENSE).
