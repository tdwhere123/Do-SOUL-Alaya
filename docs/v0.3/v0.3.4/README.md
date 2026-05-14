# v0.3.4 Wave — Public Release + Documentation Closeout + Engineering Transparency

v0.3.4 is the first publicly released v0.3.x line. It closes
v0.3.0 → v0.3.3 against an actual `git tag` + `release.yml`
workflow + GitHub Release, fixes documentation drift that
accumulated during the v0.3.x patch run, and adds doctor build-info
plus a candidate-set boundary test for cold graph/path
reallocation.

## Version Boundary

v0.3.4 is patch-internal relative to MCP / protocol / EventLog /
runtime config surfaces — no new tool names, no new payload
fields, no new migrations.

`v0.4.0` is reserved for a larger change wave (see README "Where
it is going" for the five candidate threads). The v0.3.x line
itself technically introduced an additive enum value (`"recalls"`
in `MemoryGraphEdgeTypeSchema`) which is logically a minor bump
trigger under invariants §25; v0.3.4 keeps the patch stamp because
v0.3.x was never publicly released until this wave, so all four
patches collapse into one first-public-release event. The next
public schema-additive change must bump 0.4.0.

## Slices

| Slice | Scope | Commit |
|---|---|---|
| 6 | Refresh host-autonomy live-usage witness (18 chains, codex + claude-code labels) | `f1dcdf5` |
| 2 | `alaya doctor` reports `version` / `git_head` / `built_at`; build-info.json stamp in dist | `a1eae9b` |
| 3 | Mixed-cold candidate-set reallocation boundary test | `99a3c6b` |
| 1 | README P1 shrink (MCP/CLI tables, troubleshooting, project tree) + Current state cumulative rewrite (both EN + zh-CN) | `05a4d8e` |
| 4 | This wave's closeout docs | (this commit) |
| 5 | Workspace bump `0.3.3` → `0.3.4`, git tag, release workflow trigger, GitHub Release verification | (chore + tag) |

## Required Verification

```bash
rtk pnpm build
rtk pnpm test
rtk pnpm alaya doctor    # expect: version: 0.3.4 git_head: <sha7> built_at: <iso>

# After workspace bump + git tag push:
git tag --list 'v0.3*'                                # contains v0.3.4
gh run list --limit 5                                 # release.yml run completed
gh release view v0.3.4                                # tarball + SHA256SUMS attached
```

Clean-environment install smoke (separate temporary `ALAYA_HOME`)
runs `scripts/install.sh` against the just-published v0.3.4
tarball and confirms `alaya doctor` exits with `version: 0.3.4`.

## Dogfood Production Evidence

See `reports/v0.3.4-closeout.md` for the production-evidence
summary inherited from the v0.3.3 dogfood pass, including the
end-to-end RECALLS cross-link path observed on the maintainer's
WSL2 host (`~/.config/alaya/alaya.db`).
