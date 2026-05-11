# Alaya v0.2.1 — OS Keychain Adapter (#BL-009 close path)

> Briefer plan. Detailed task cards are written when v0.2.0 lands and
> v0.2.1 becomes the active wave.

## 1. Goal

Close `#BL-009` (OS Keychain for secrets). Extend `secret_ref` syntax
to support `keychain:<service>:<account>` and resolve through the
platform-native API on macOS, Linux, and Windows.

After v0.2.1, an operator does not need to keep an API key in a
plaintext config file or environment variable; the same `secret_ref`
machinery the daemon already uses transparently picks up a keychain
entry.

## 2. Scope

- `apps/core-daemon/src/secrets.ts` gains a `keychain:` branch in
  `resolveSecretRef`. The parser accepts
  `keychain:<service>:<account>` and routes to one of three new
  adapter modules.
- New files `apps/core-daemon/src/secrets/keychain/{macos,linux,windows}.ts`
  implement each platform.
  - **macOS**: prefer the `security find-generic-password -s <service>
    -a <account> -w` CLI (zero new native deps); fall back to a
    documented "keychain not available" error rather than silently
    succeeding.
  - **Linux**: `secret-tool lookup service <service> account
    <account>` via libsecret. Document the `libsecret-tools` package
    dependency.
  - **Windows**: PowerShell `Get-StoredCredential` or `cmdkey`
    invocation; document the prerequisite credential-manager state.
- `alaya doctor` adds a check: when a `keychain:` ref is configured,
  verify the adapter for the host platform is callable and the entry
  resolves, surfacing a clear remediation message if not.
- `alaya install --keychain` is a new flag that triggers an
  onboarding migration: prompts the operator for the secret value,
  writes it into the platform keychain, and rewrites the runtime
  config to a `keychain:<service>:<account>` ref. The previous file
  or env ref is unchanged on disk; the operator can revert by
  reverting the config patch.

## 3. Release condition

- All three platform adapters land with at least one platform-correct
  manual-test record (the CI image owns the Linux path; macOS and
  Windows ship with a manually-recorded transcript).
- `alaya doctor` integration verifies the active platform's adapter
  is callable on a fresh install.
- `secret_ref` migration is reversible: the operator can replace a
  `keychain:` ref with a previously-working `env:` or `file:` ref
  without rebuilding the daemon.
- §25 SemVer step: adding `keychain:` to the union of accepted
  `secret_ref` shapes is an additive minor.

## 4. Out of scope

- OS-level secret rotation policies.
- Bulk migration of historical config snapshots; only the current
  runtime config is rewritten.
- A native binding (`node-keytar` etc.) — the CLI approach keeps the
  dependency surface zero-cost and matches the local-first posture.

## 5. Critical files

```
apps/core-daemon/src/secrets.ts                                      (keychain: branch)
apps/core-daemon/src/secrets/keychain/macos.ts                       (new)
apps/core-daemon/src/secrets/keychain/linux.ts                       (new)
apps/core-daemon/src/secrets/keychain/windows.ts                     (new)
apps/core-daemon/src/cli/install.ts                                  (--keychain flag)
apps/core-daemon/src/cli/doctor.ts                                   (keychain availability check)
docs/handbook/backlog.md                                             (#BL-009 Resolved)
docs/handbook/runtime-status.md                                      (secret_ref readiness)
docs/handbook/invariants.md                                          (§25 entry for keychain: minor bump)
```
