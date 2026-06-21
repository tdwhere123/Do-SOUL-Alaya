# Alaya v0.3.0 — Release Notes (2026-05-13)

Workspace packages: `0.2.0` → `0.3.0`.

v0.3.0 closes the three long-open backlog items `#BL-009`, `#BL-037`, and
`#BL-038`, and fixes the operator path to host-worker Garden compute.

## Highlights

### OS keychain secret refs (`#BL-009`)

- Garden / embedding `secret_ref` accepts `keychain:<service>:<account>`,
  resolved through the platform-native keychain (Linux libsecret /
  macOS Keychain / Windows Credential Manager).
- `alaya install --keychain` runs the interactive migration: prompts for
  the secret, writes the keychain entry, verifies it reads back, and
  writes `ALAYA_OFFICIAL_GARDEN_SECRET_REF=keychain:alaya:openai` to the
  config `.env`.
- `alaya doctor` reports keychain readiness on the `garden compute:` line
  plus a per-entry keychain check.
- Adds the `secret_ref_kind: "keychain"` value to config-change EventLog
  audits — a public-surface change, hence the SemVer minor bump.
- **Coverage**: the Linux libsecret / macOS `security` / Windows
  `PasswordVault` adapters are code-reviewed (secrets via stdin not argv;
  subprocess calls bounded; degrades correctly when no secret service is
  running). An actual keychain write→read is **not** runtime-exercised yet —
  the dev box is WSL2 with no running secret service (`secret-tool` /
  `install --keychain` fail there with "no secret service"), and no
  maintainer has a macOS/Windows host. Use `env:` / `file:` secret refs
  there; that path is runtime-verified. See `docs/handbook/maintenance.md`.

### Host-worker Garden compute is now reachable from the CLI

`provider_kind=host_worker` (the mode where the attached CLI agent itself
drains the `POST_TURN_EXTRACT` queue via `garden.list_pending_tasks` /
`garden.claim_task` / `garden.complete_task`) used to be settable only
through the Memory Inspector form. Now also:

- `ALAYA_GARDEN_PROVIDER_KIND=host_worker` in `~/.config/alaya/.env`, or
- `alaya install --non-interactive '{"garden_provider_kind":"host_worker"}'`.

These set the env-derived *default*; the Inspector form still writes the
authoritative persisted runtime row which, once present, takes precedence.
`alaya doctor` prints the live mode.

### Telemetry attributes to the right host (`#BL-038`)

- `alaya attach claude` / `alaya attach codex` now stamp
  `ALAYA_AGENT_TARGET` into the launched `alaya mcp stdio` env, so
  `soul.recall` / `soul.report_context_usage` telemetry attributes to the
  `claude-code` / `codex` trust surface instead of the generic `mcp`
  bucket — `alaya status` counters now reflect real host usage.
- `alaya doctor` flags a profile attached before this change as
  *drifted* (missing the stamp), with a hint to re-run `alaya attach`.
- `#BL-038` (a real host autonomously using `soul.recall` +
  `soul.report_context_usage` during a normal conversation) closes with a
  **live-usage EventLog witness**: `scripts/export-host-autonomy-witness.mjs`
  snapshots the linked recall→usage(`used`) chains from a live EventLog
  into `docs/archive/v0.3-historical/v0.3.0/host-autonomy-fixtures/<host>-live/`, and
  `host-autonomy-witness.test.ts` pins that chain offline. (The earlier
  plan's synthetic-stdio-replay fixture was dropped — the daemon doesn't
  record raw stdio frames, and a hand-built transcript is exactly the
  fabricated proof `#BL-038` rejects.) Autonomous use of
  `soul.emit_candidate_signal` / `soul.propose_memory_update` remains
  narrower and unobserved.

### Codex `/alaya-inspect` slash recognition (`#BL-037`)

Closed as negative proof: Codex CLI `0.130.0` exposes no third-party
fixed slash-command registry, so `/alaya-inspect` is not `cli-consumable`
for Codex on this version. The Alaya-managed `[slash_commands.alaya-inspect]`
profile entry stays written; `alaya inspect --open` (or the MCP/CLI
fallback) is the supported path. Version-limitation note in
`docs/handbook/maintenance.md`.

## Upgrade notes

- After upgrading, **re-run `alaya attach claude` and `alaya attach codex`**
  so the MCP entry gets the `ALAYA_AGENT_TARGET` stamp (otherwise telemetry
  keeps going to the `mcp` bucket; `alaya doctor` will report the profile
  as drifted until you do).
- To put Garden compute in `host_worker` mode on an existing install, set
  `ALAYA_GARDEN_PROVIDER_KIND=host_worker` in `~/.config/alaya/.env` and
  restart the daemon, or use the Garden Compute form in `alaya inspect
  --open`. If you've previously saved a Garden compute setting through the
  Inspector, that persisted value wins — change it there.
- For a provider-API setup (`official_api`): the API key is the only
  secret — store it with `alaya install --keychain` (or `env:` / `file:`
  refs); the endpoint and model are the non-secret
  `OFFICIAL_API_GARDEN_PROVIDER_URL` / `OFFICIAL_API_GARDEN_MODEL`
  (plain `.env` or the Inspector form).

## Verification

```bash
rtk pnpm exec tsc -b
rtk pnpm build
rtk pnpm test
rtk git diff --check
```

296 test files / 2428 tests passing as of closeout. Review: Claude
reviewer + Codex independent lens, zero Blocking / zero Important after
the fix-loop — see `reports/v0.3.0-closeout-review.md`.
