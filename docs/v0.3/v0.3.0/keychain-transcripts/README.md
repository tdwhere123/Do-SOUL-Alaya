# Keychain Platform Transcripts (#BL-009)

Real-system evidence that the OS-keychain secret adapter works end to end.
Each platform is a subdirectory holding the captured terminal session.

## Linux / WSL2 (`secret-tool`) — the v0.3.0 verified platform

In an isolated config dir, capture roughly this (commands + output) into
`linux-wsl2/transcript.txt`:

```bash
export ALAYA_CONFIG_DIR=/tmp/alaya-keychain-check
rm -rf "$ALAYA_CONFIG_DIR"
node bin/alaya.mjs install --non-interactive '{}'

# 1. write a secret via the OS keychain (libsecret)
secret-tool store --label="alaya garden" service alaya account openai
#   (prompts for the secret value on a TTY)

# 2. point Alaya's Garden credential at the keychain ref and run the install
#    migration interactively
node bin/alaya.mjs install --keychain
#   (enter the same secret when prompted; install writes
#    ALAYA_OFFICIAL_GARDEN_SECRET_REF=keychain:alaya:openai and verifies it)

# 3. doctor must report keychain readiness OK
node bin/alaya.mjs doctor | grep -i keychain
```

Expected: `alaya doctor` shows the keychain check `ok` for
`service=alaya account=openai`, and `garden compute: ... cred=keychain`.

## macOS / Windows

Deferred — see `docs/handbook/maintenance.md` § "#BL-009 — OS keychain
platform coverage". The adapters are code-reviewed; runtime verification
waits on a maintainer with a macOS or Windows host. When captured, add
`macos/transcript.txt` / `windows/transcript.txt` here and update the
maintenance note + `runtime-status.md`.
