# Do-SOUL Alaya v0.3 — Keychain + Host Autonomy Evidence

> Codename TBD (v0.2 was "distributed-falcon"; the v0.3 codename is
> chosen in the v0.3.0 close-out slice or left unset). v0.3 keeps
> invariant §21 intact (local-first memory plane; no chat UI, no
> agent UI).

## What v0.3.0 is

v0.3.0 is a single release that closes the three items v0.1/v0.2
left open, two of which had been parked as separate "v0.2.1" and
"v0.2.2" cadence buckets:

1. **OS keychain adapter for secrets (`#BL-009`).** `secret_ref`
   syntax gains `keychain:<service>:<account>` and resolves through
   the platform-native API on macOS, Linux, and Windows. `alaya
   doctor` learns to verify a configured keychain ref; `alaya
   install --keychain` adds an onboarding migration.

2. **Host autonomous use of `soul.*` tools (`#BL-038`).** A
   recording of a real Codex (or Claude Code) session that
   autonomously calls `soul.recall` and `soul.report_context_usage`,
   plus an offline replay regression so the daemon contract stays
   observable across host model upgrades.

3. **Codex `/alaya-inspect` host slash recognition (`#BL-037`).**
   Either positive proof that the active Codex CLI recognizes the
   Alaya-managed slash registry entry, or a written negative result
   retiring the `cli-consumable` expectation.

## Why this is a minor bump (v0.2.0 → v0.3.0), not a patch

Adding `keychain:` to the accepted `secret_ref` shapes touches two
surfaces that invariant §25 (MCP and Protocol SemVer Contract)
covers:

- `RuntimeSecretRefSchema` in `packages/protocol/src/app-config.ts`
  — the runtime control-plane config surface.
- `secret_ref_kind` (`z.enum(["env", "file"])`) in
  `packages/protocol/src/events/garden.ts` — an EventLog payload
  surface.

§25 defines an additive change on a covered surface (a new accepted
value / a new enum value that is not a discriminator key) as a
**minor** bump, and `packages/protocol/src/__tests__/semver-surface.test.ts`
enforces it: the only correct way to make that snapshot green again
is to update it in the same release that bumps the minor. So the
keychain work cannot ship as a patch — this release is v0.3.0.

The `#BL-037` / `#BL-038` evidence work does not change any public
surface; it rides along in v0.3.0 because the keychain change
already forces a minor and there is no value in two separate small
releases.

## What v0.3.0 is not

- **Not** a new user-facing surface (GUI, TUI, chat) — §21 forbids.
- **Not** OS-level secret rotation, native keychain bindings
  (`node-keytar` etc.), or bulk migration of historical config
  snapshots — see `v0.3.0/v0.3.0-slice-3-keychain-install.md §3`.
- **Not** host coverage beyond Codex / Claude Code for `#BL-037` /
  `#BL-038`; other hosts open separate backlog issues when a real
  need surfaces.

## External-dependency risk and fallback

Slices 4 and 5 depend on a real Codex/Claude session recording and a
Codex version handshake — the original reason v0.2.2 was a separate
cadence bucket. The fallback if those proofs cannot be obtained in a
reasonable window:

- `#BL-037` always has the negative-proof escape (test the current
  Codex version, document "not supported", close the issue with a
  `maintenance.md` version note). Slice 5 can always close.
- `#BL-038` strictly needs a real host recording for its fixture. If
  unobtainable: slice 4 delivers the offline-replay test harness +
  fixture schema only, the "real recording" requirement re-defers to
  a fresh `#BL-NNN`, and v0.3.0 ships with keychain (`#BL-009`)
  closed plus whatever host evidence landed. (Alternative — hold the
  v0.3.0 tag until the recording lands — is recorded but not the
  default.) The decision is taken before the close-out slice.

## Layout

```
docs/v0.3/
├── README.md                              ← this file (entry point)
└── v0.3.0/
    ├── README.md                          ← v0.3.0 wave index + cross-card constraints
    ├── v0.3.0-slice-1-keychain-resolver.md
    ├── v0.3.0-slice-2-keychain-doctor.md
    ├── v0.3.0-slice-3-keychain-install.md
    ├── v0.3.0-slice-4-host-autonomy-replay.md
    ├── v0.3.0-slice-5-codex-slash-recognition.md
    ├── v0.3.0-slice-6-closeout.md
    ├── release-notes.md                    ← written by slice 6
    ├── reports/                            ← per-card completion reports + platform transcripts
    └── host-autonomy-fixtures/             ← written by slice 4
```

The former `docs/v0.2/v0.2.1/` and `docs/v0.2/v0.2.2/` plan folders
were removed when their work was folded into this directory. The v0.2
line is archived under `docs/archive/v0.2/`; `docs/archive/v0.2/README.md`
records the fold-in.
