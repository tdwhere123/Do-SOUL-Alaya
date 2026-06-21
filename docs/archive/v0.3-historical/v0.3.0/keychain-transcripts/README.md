# Keychain Platform Transcripts (#BL-009)

Real-system evidence that the OS-keychain secret adapter performs an
actual write→read against a platform keychain. **None captured yet** — the
runtime keychain path is deferred (see `docs/handbook/maintenance.md`
§ "#BL-009 — OS keychain platform coverage"):

- **Linux libsecret (`secret-tool`)**: the dev box runs under WSL2, which by
  default has no running gnome-keyring / DBus secret service, so
  `secret-tool store` and `alaya install --keychain` fail with "no secret
  service" — the libsecret adapter correctly reports
  `keychain_tooling_unavailable` / `keychain_write_failed`. To capture a
  Linux transcript you need a host with a running secret service (a normal
  desktop Linux session, or WSL2 set up with `gnome-keyring` +
  `dbus-launch` + `gnome-keyring-daemon --unlock`). Steps once one is
  available:

  ```bash
  export ALAYA_CONFIG_DIR=/tmp/alaya-keychain-check
  rm -rf "$ALAYA_CONFIG_DIR"
  node bin/alaya.mjs install --non-interactive '{}'
  node bin/alaya.mjs install --keychain          # paste the API key when prompted
  node bin/alaya.mjs doctor | grep -i keychain   # expect: keychain check ok, cred=keychain
  ```

  Save the session into `linux/transcript.txt` (or `linux-wsl2/...`).

- **macOS** (`security -i` stdin write / `find-generic-password -w` read)
  and **Windows** (PowerShell `PasswordVault`): no maintainer host. When
  one is available, add `macos/transcript.txt` / `windows/transcript.txt`
  and update the maintenance note + `runtime-status.md`.

The runtime-verified secret path on the dev box is `env:` / `file:` refs —
for a third-party provider, store the API key in a `0600` file and point
`ALAYA_OFFICIAL_GARDEN_SECRET_REF=file:/abs/path` (and set
`OFFICIAL_API_GARDEN_PROVIDER_URL` / `OFFICIAL_API_GARDEN_MODEL`); `alaya
doctor` then shows `garden compute: kind=official_api ... cred=file`,
`garden status: healthy`. See the main `README.md` § Perception.
