# v0.3.5 Release Notes

v0.3.5 is a patch-internal hardening release for CLI startup, MCP
stdio startup diagnostics, background logging, and local child-process
execution support.

## Added

- Regression coverage for fixed CLI shim module slots, so the root
  and packaged `bin/alaya.mjs` paths keep loading only the explicit
  bridge, register, and daemon modules while tests can still inject
  loaders.
- Regression coverage for MCP stdio startup write failures. Startup
  failures now surface a direct stderr diagnostic and exit with a
  deterministic software error instead of collapsing into an opaque
  transport close for the host. Server creation failures also prove
  that background services are not started first.
- Background service manager tests for injected logging, overlapping
  task skips, and task failure diagnostics.
- Regression coverage for `tools.exec_shell` argv execution, ambient
  env filtering, non-zero exit handling, and timeout mapping.
- Regression coverage for keychain subprocess env filtering.

## Changed

- CLI shims use explicit module loader slots rather than passing
  arbitrary dynamic-import paths through one generic import callback.
- The MCP stdio command wraps workspace/run/session bootstrap and
  server connection in a startup diagnostic boundary. Stdout remains
  reserved for JSON-RPC frames, and background services start only
  after the stdio server is ready.
- Garden background services and related runtime warnings now route
  through injected warn loggers.
- Environment status probes no longer shell out through `bash -lc
  command -v`; they resolve executable candidates from `PATH` directly
  and keep git worktree counting on `execFile` with timeout and env
  allowlist.
- Keychain subprocesses run with a minimal environment allowlist while
  preserving the variables needed by platform keychain tooling.
- README install guidance now leads with a release/tag-pinned installer
  fetch. The pipe-to-bash form remains documented as a faster shortcut
  with its risk tradeoff stated.
- Root `package.json` now carries `version: 0.3.5` while remaining
  `private: true`; workspace packages are aligned to `0.3.5`.

## Compatibility

- No MCP tool surface change.
- No protocol zod schema change.
- No EventLog payload schema change.
- No runtime config schema change.
- No SQLite migration.

## SafeSkill And PR #1

The stale SafeSkill badge-only PR #1 should be closed, not merged. A
future badge must come from a fresh scan of v0.3.5 HEAD after this
hardening work, not from the old scan.

## Verification

See `reports/v0.3.5-closeout.md` for command evidence.
