# v0.3.0 Wave — Task Cards

Six cards. Group A (keychain, `#BL-009`) is the §25 minor driver and
runs strictly sequential. Group B (host autonomy evidence, `#BL-037`
/ `#BL-038`) is independent of group A. Slice 6 closes the wave.

| Slice | Card | Issue | Size | Prereq | Status |
|---|---|---|---|---|---|
| 1 | [`keychain-resolver`](v0.3.0-slice-1-keychain-resolver.md) | `#BL-009` | M | none | done — report: [`v0.3.0-slice-1.md`](reports/v0.3.0-slice-1.md) |
| 2 | [`keychain-doctor`](v0.3.0-slice-2-keychain-doctor.md) | `#BL-009` | S | slice 1 | done — report: [`v0.3.0-slice-2.md`](reports/v0.3.0-slice-2.md) |
| 3 | [`keychain-install`](v0.3.0-slice-3-keychain-install.md) | `#BL-009` | M | slices 1, 2 | done — review fixes landed; report: [`v0.3.0-slice-3.md`](reports/v0.3.0-slice-3.md) |
| 4 | [`host-autonomy-replay`](v0.3.0-slice-4-host-autonomy-replay.md) | `#BL-038` | M | none (external dep) | done — live-usage witness; report: [`v0.3.0-slice-4.md`](reports/v0.3.0-slice-4.md) |
| 5 | [`codex-slash-recognition`](v0.3.0-slice-5-codex-slash-recognition.md) | `#BL-037` | S | none (external dep) | done — negative proof; report: [`v0.3.0-slice-5.md`](reports/v0.3.0-slice-5.md) |
| 6 | [`closeout`](v0.3.0-slice-6-closeout.md) | `#BL-009` / `#BL-037` / `#BL-038` | S | slices 1–5 | done — merged to `main`; report: [`v0.3.0-closeout.md`](reports/v0.3.0-closeout.md) |

## Cross-card constraints

1. **Group A is a chain, not a fan-out.** Slices 1 → 2 → 3 land in
   order. Slices 2 and 3 both depend on slice 1's `resolveSecretRef`
   `keychain:` branch, the new `ResolvedSecret.origin`, and the new
   `ResolveSecretError` kinds. Slice 3's migration E2E exercises
   `alaya doctor` after migration, so it also wants slice 2 in.
2. **Group B is independent.** Slices 4 and 5 touch
   `apps/core-daemon/src/__tests__/host-autonomy-replay.test.ts`,
   new fixtures under `docs/archive/v0.3-historical/v0.3.0/host-autonomy-fixtures/`, the
   attach/profile path, and handbook docs — no overlap with group
   A's `secrets/index.ts` / `cli/` / `packages/protocol/` blast radius.
   They may proceed in parallel with group A; the main thread runs
   them sequentially for review-loop simplicity.
3. **Only slice 6 edits the readiness / §25 / version layer.**
   `docs/handbook/backlog.md`, `docs/handbook/runtime-status.md`,
   `docs/handbook/invariants.md` (§25), and the workspace
   `package.json` files are slice 6's exclusive territory at the
   close-out level. Slices 1–5 do not touch them there. (Slice 1's
   card *cites* §25 and declares the SemVer step in its own card
   text; it does not edit invariants.md.) This mirrors the
   v0.2.0-slice-10 hazard note and avoids merge churn.
4. **The renumber decision is binding.** v0.2.1 → v0.3.0 because
   adding `keychain:` to the `secret_ref` accepted shapes
   (`packages/protocol/src/app-config.ts`) and `keychain` to the
   `secret_ref_kind` EventLog enum (`packages/protocol/src/events/garden.ts`)
   is an additive change on two §25-covered surfaces, which §25
   defines as a minor bump; `semver-surface.test.ts` enforces it.
   Slice 1's card text and slice 6's release notes both state this.
5. **`SecretRefReader` widening.** Slice 1 adds a non-optional
   `readKeychain(service, account)` to `SecretRefReader`. That makes
   the compiler flag every hand-constructed reader; slice 1 sweeps
   them (`secrets/index.ts`, `secrets/index.test.ts`, `daemon-runtime-support.ts`,
   `index.ts`, `garden-credential.ts`, `ai/daemon-embedding-runtime.ts`,
   `cli/register.ts`, `cli/install.ts`, test stubs). `SecretRefReader`
   has no MCP/EventLog/config surface, so this internal-type widening
   is out of §25 scope per the §25 carve-out.

## Workflow reminders (per `docs/handbook/workflow/`)

- Freeze each card's §2–§5 before its implementation starts (R1).
- Build + test is a hard gate per card before review
  (`rtk pnpm build` + the card's §5 vitest scope; `rtk pnpm exec
  tsc -b` where the card widens a shared type).
- Every review finding (Blocking / Important / Nice-to-have) lands as
  a separate `fix(v0.3.0-slice-N): <finding> [review <severity>]`
  commit with the Fix Commit Body Template; loop until no Blocking /
  Important remain; convergence needs an independent reviewer pass on
  the fix commits.
- Each card that runs a review-loop gets a completion report at
  `docs/archive/v0.3-historical/v0.3.0/reports/v0.3.0-slice-N.md`.
- Platform manual-test transcripts for the keychain adapters live at
  `docs/archive/v0.3-historical/v0.3.0/reports/` (or a `manual-transcripts/` subdir):
  Linux is CI-eligible when `secret-tool` is on the image; macOS and
  Windows ship a recorded transcript.
