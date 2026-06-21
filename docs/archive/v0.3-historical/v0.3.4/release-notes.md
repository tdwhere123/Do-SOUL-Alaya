# v0.3.4 Release Notes

v0.3.4 is the first publicly released v0.3.x line. It bundles
public-release plumbing (git tag, GitHub Release workflow, README
narrative refresh) with two small engineering-transparency
improvements.

## Added

- `alaya doctor` now reports the running daemon's `version`,
  `git_head`, and `built_at` on a dedicated line right after
  `doctor overall`, so an operator can tell at a glance which
  binary a daemon is built from. The build stamp lives in
  `apps/core-daemon/dist/build-info.json` (written by
  `scripts/build-existing.mjs` after every successful build) and
  is read by `apps/core-daemon/src/build-info.ts`. Source / unit-
  test runs without `dist/build-info.json` see a `0.0.0-dev /
  unknown / unknown` sentinel.
- A mixed-cold candidate-set test
  (`packages/core/src/__tests__/recall-8factor.test.ts`) pins the
  v0.3.3 cold graph/path reallocation boundary: when even one
  candidate has non-zero `graph_support`, the whole set must not
  be classified as cold and reallocation must stay off. This is
  the production state most natural recall traffic lands in, and
  was the only path the v0.3.3 dogfood pass did not exercise from
  natural data.

## Changed

- README.md and README.zh-CN.md shrunk (P1):
  - MCP tools and CLI verbs detailed tables collapsed into grouped
    bullets + pointers to `alaya tools list --json` and `alaya
    --help` (the maintained source of truth);
  - Quickstart troubleshooting block reduced to a single `alaya
    doctor` pointer;
  - Project layout file tree replaced with a link to
    `docs/handbook/code-map.md`.
- README "Current state" section rewritten cumulatively to cover
  v0.3.0 → v0.3.4 (host autonomy live witness, server-side
  capture, RECALLS cross-link + cold reallocation, honest
  bootstrap, keychain secret refs, doctor build-info, first
  triggered `release.yml`).
- README status badge bumped to `v0.3.4` and tests badge to the
  v0.3.4 test count (the v0.3.3 badge values were already corrected
  in commit `f90d742`).

## Compatibility

- No MCP tool surface change.
- No protocol zod schema change.
- No EventLog payload schema change.
- No runtime config schema change.
- No SQLite migration.

## Distribution

- `v0.3.4` is the first git tag in the v0.3.x line. Pushing the
  tag to GitHub triggers `.github/workflows/release.yml`, which
  builds the source tarball + `SHA256SUMS`, runs the install.sh
  smoke against the just-built tarball, and uploads both as a
  GitHub Release.
- After the workflow completes, `scripts/install.sh` without
  `ALAYA_VERSION` set will resolve `latest` to `v0.3.4` instead of
  `v0.1.3`, so the README quickstart `curl ... | bash` line
  delivers the actual current binary.

## Verification

See `reports/v0.3.4-closeout.md` for the verification command
chain and the dogfood production evidence inherited from the
v0.3.3 wave.
